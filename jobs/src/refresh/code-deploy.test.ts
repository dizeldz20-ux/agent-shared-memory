import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeDeploy } from './code-deploy.js';
import { RefreshError } from './refresh.types.js';
import { FakeRunner, HOOKS, MemoryLog, sandbox, type Sandbox } from './refresh.testkit.js';

describe('CodeDeploy', () => {
  let box: Sandbox;
  let runner: FakeRunner;
  let log: MemoryLog;
  beforeEach(() => { box = sandbox(); runner = new FakeRunner(); log = new MemoryLog(); });
  afterEach(() => { rmSync(box.root, { recursive: true, force: true }); });

  const deploy = () => new CodeDeploy(runner, log).run(box.options());
  const read = (...parts: string[]) => readFileSync(join(box.root, ...parts), 'utf8');

  it('deploys the MCP server, its modules and every hook', async () => {
    await deploy();
    for (const file of ['mcp_server.py', 'asm_text.py', 'lifecycle.py', 'pyproject.toml']) expect(read('runtime', file)).toBe(`# ${file}\n`);
    for (const hook of HOOKS) expect(read('runtime', 'hooks', hook)).toBe(`// ${hook}\n`);
  });

  it('mirrors jobs/dist, leaves the jobs state alone, and installs production modules only when the lock changed', async () => {
    box.write('runtime/jobs/dist/old/removed.js', '// stale\n');
    box.write('runtime/jobs/state.json', '{"kept":true}');
    box.write('runtime/jobs/proposals/run.json', '{}');
    await deploy();
    expect(read('runtime', 'jobs', 'dist', 'refresh', 'cli.js')).toBe('// refresh\n');
    expect(existsSync(join(box.runtime, 'jobs', 'dist', 'old'))).toBe(false);
    expect(read('runtime', 'jobs', 'state.json')).toBe('{"kept":true}');
    expect(existsSync(join(box.runtime, 'jobs', 'proposals', 'run.json'))).toBe(true);
    expect(read('runtime', 'jobs', '.deployed-lock')).toBe(read('repo', 'jobs', 'package-lock.json'));
    expect(runner.names()).toContain('npm ci --omit=dev --prefer-offline --no-audit --no-fund --silent');
    runner.calls.length = 0;
    await deploy();
    expect(runner.names().filter((call) => call.startsWith('npm'))).toEqual([]);
  });

  it('keeps the previous jobs when jobs/dist was never built, and says how to build it', async () => {
    rmSync(join(box.repo, 'jobs', 'dist'), { recursive: true });
    box.write('runtime/jobs/dist/runner/cli.js', '// previous\n');
    await deploy();
    expect(read('runtime', 'jobs', 'dist', 'runner', 'cli.js')).toBe('// previous\n');
    expect(log.lines.some((line) => line.startsWith('WARN') && line.includes('npm --prefix jobs run build'))).toBe(true);
  });

  it('stops before mirroring new jobs whose production modules failed to install, and records no lock', async () => {
    box.write('runtime/jobs/dist/runner/cli.js', '// previous\n');
    runner.exit.set('npm', 1);
    await expect(deploy()).rejects.toThrow(RefreshError);
    await expect(deploy()).rejects.toThrow(/npm ci/);
    expect(read('runtime', 'jobs', 'dist', 'runner', 'cli.js')).toBe('// previous\n');
    expect(existsSync(join(box.runtime, 'jobs', '.deployed-lock'))).toBe(false);
  });

  it('seeds the skill-router rules only when none exist, then rebuilds the skill map', async () => {
    await deploy();
    expect(read('runtime', 'skill-map.overrides.json')).toBe('{"example": true}\n');
    box.write('runtime/skill-map.overrides.json', '{"mine": true}\n');
    runner.calls.length = 0;
    await deploy();
    expect(read('runtime', 'skill-map.overrides.json')).toBe('{"mine": true}\n');
    expect(runner.names()).toContain('asm-skill-router.js --build');
  });

  it('publishes both skills to both skill folders and the Codex graph-mission beside the owner\'s files', async () => {
    box.write('home/.agents/skills/graph-mission/notes.md', 'my notes\n');
    await deploy();
    for (const root of ['.agents', '.claude']) {
      expect(read('home', root, 'skills', 'agent-shared-memory', 'SKILL.md')).toBe('# agent-shared-memory\n');
      expect(read('home', root, 'skills', 'asm-review', 'SKILL.md')).toBe('# asm-review\n');
    }
    expect(read('home', '.agents', 'skills', 'graph-mission', 'tasks', 'run.md')).toBe('# run\n');
    expect(read('home', '.agents', 'skills', 'graph-mission', 'notes.md')).toBe('my notes\n');
  });

  it('retires the legacy Codex copy of the skill only when it is byte-identical', async () => {
    box.write('home/.codex/skills/agent-shared-memory/SKILL.md', '# agent-shared-memory\n');
    await deploy();
    expect(existsSync(join(box.home, '.codex', 'skills', 'agent-shared-memory'))).toBe(false);
    box.write('home/.codex/skills/agent-shared-memory/SKILL.md', '# agent-shared-memory\nmy edit\n');
    await deploy();
    expect(read('home', '.codex', 'skills', 'agent-shared-memory', 'SKILL.md')).toContain('my edit');
  });
});
