import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunOptions, Runner } from '../platform/process-runner.js';
import { mirror } from './mirror.js';
import { RefreshError, type RefreshLog, type RefreshOptions } from './refresh.types.js';

const CODE = ['mcp_server.py', 'asm_text.py', 'lifecycle.py'];
const HOOKS = ['asm-activity-hook.js', 'asm-session-start.js', 'asm-prompt-recall.js', 'asm-memory-gate.js', 'asm-skill-router.js', 'asm-lifecycle.js'];
const SKILLS = ['agent-shared-memory', 'asm-review'];

/** The code half of a full refresh: the MCP server, hooks, jobs and skills every agent runs. */
export class CodeDeploy {
  constructor(
    private readonly runner: Runner,
    private readonly log: RefreshLog,
  ) {}

  async run(options: RefreshOptions): Promise<void> {
    const { repo, runtime } = options;
    await mkdir(join(runtime, 'hooks'), { recursive: true });
    for (const file of CODE) await copyFile(join(repo, file), join(runtime, file));
    if (existsSync(join(repo, 'pyproject.toml'))) await copyFile(join(repo, 'pyproject.toml'), join(runtime, 'pyproject.toml'));
    for (const hook of HOOKS) await copyFile(join(repo, 'hook', hook), join(runtime, 'hooks', hook));
    await this.deployJobs(options);
    await this.deploySkillRouter(options);
    await publishSkills(repo, options.home);
  }

  // The jobs deploy as built JavaScript plus their production modules. Their state under the
  // runtime's jobs folder (config, trust, proposals, runs, logs) is never touched here.
  private async deployJobs(options: RefreshOptions): Promise<void> {
    const source = join(options.repo, 'jobs');
    if (!existsSync(join(source, 'package.json'))) return;
    if (!existsSync(join(source, 'dist', 'runner', 'cli.js'))) {
      this.log.warn('   !! jobs/dist is missing — the runtime keeps its previous jobs (build them: npm --prefix jobs run build)');
      return;
    }
    const target = join(options.runtime, 'jobs');
    await mkdir(target, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) await copyFile(join(source, file), join(target, file));
    // Modules first, code second: new code whose modules failed to install would crash at import
    // on every launch, and the jobs would never report why.
    const lock = await readFile(join(source, 'package-lock.json'));
    const deployed = await readFile(join(target, '.deployed-lock')).catch(() => undefined);
    const fresh = !deployed?.equals(lock);
    if (fresh) await this.installModules(options, target);
    await mirror(join(source, 'dist'), join(target, 'dist'));
    if (fresh) await copyFile(join(source, 'package-lock.json'), join(target, '.deployed-lock'));
  }

  private async installModules(options: RefreshOptions, target: string): Promise<void> {
    let code: number | null;
    try {
      code = (await this.runner.run('npm', ['ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--silent'], this.stream(options, target))).code;
    } catch (error: unknown) {
      throw new RefreshError(`npm ci could not start in ${target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (code !== 0) throw new RefreshError(`npm ci failed in ${target} (exit ${code}): the new jobs were not deployed`);
  }

  // The curated routing rules are private runtime data (they name products and paths): the
  // example seeds them once and never overwrites them. The map is derived from every installed
  // SKILL.md, and a refresh is exactly when skills tend to have changed.
  private async deploySkillRouter(options: RefreshOptions): Promise<void> {
    const rules = join(options.runtime, 'skill-map.overrides.json');
    if (!existsSync(rules)) await copyFile(join(options.repo, 'hook', 'skill-map.overrides.example.json'), rules);
    const result = await this.runner.run(join(options.runtime, 'hooks', 'asm-skill-router.js'), ['--build'], this.stream(options, options.runtime));
    if (result.code !== 0) this.log.warn('   !! skill map build failed — the router stays silent until it succeeds');
  }

  private stream(options: RefreshOptions, cwd: string): RunOptions {
    return { cwd, env: options.env, onOutput: (text) => this.log.output(text) };
  }
}

// One cross-agent copy under ~/.agents/skills (Codex, Cursor, Kimi Code, Grok Build) plus Claude
// Code's own. The Codex-native graph-mission goes only under ~/.agents/skills: clients that scan
// ~/.codex/skills too would otherwise show two selectors with the same name.
async function publishSkills(repo: string, home: string): Promise<void> {
  for (const root of [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')]) {
    for (const skill of SKILLS) {
      await mkdir(join(root, skill), { recursive: true });
      await copyFile(join(repo, 'skills', skill, 'SKILL.md'), join(root, skill, 'SKILL.md'));
    }
  }
  await retireLegacyCodexSkill(repo, home);
  await cp(join(repo, 'skills', 'codex', 'graph-mission'), join(home, '.agents', 'skills', 'graph-mission'), { recursive: true, force: true });
}

// Older refreshes also wrote the skill under ~/.codex/skills. Only a byte-identical managed copy
// goes; a copy the owner changed or extended stays.
async function retireLegacyCodexSkill(repo: string, home: string): Promise<void> {
  const legacy = join(home, '.codex', 'skills', 'agent-shared-memory');
  const shipped = await readFile(join(repo, 'skills', 'agent-shared-memory', 'SKILL.md'));
  const copy = await readFile(join(legacy, 'SKILL.md')).catch(() => undefined);
  if (!copy?.equals(shipped)) return;
  await rm(join(legacy, 'SKILL.md'));
  await rmdir(legacy).catch(() => undefined);
}
