import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RunOptions, RunResult, Runner } from '../platform/process-runner.js';
import type { RefreshLog, RefreshOptions } from './refresh.types.js';

export interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly runtime: string;
  readonly home: string;
  readonly vault: string;
  options(overrides?: Partial<RefreshOptions>): RefreshOptions;
  write(rel: string, text: string): string;
}

/** A throwaway ASM checkout, runtime, home and vault; `write` takes paths relative to the root. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'asm-refresh-'));
  const at = (rel: string): string => join(root, rel);
  const write = (rel: string, text: string): string => {
    mkdirSync(dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
    return at(rel);
  };
  write('repo/sources.json', JSON.stringify({ vault: '../vault', layers: {}, sources: [] }));
  for (const file of ['mcp_server.py', 'asm_text.py', 'lifecycle.py', 'pyproject.toml', 'merge.py', 'source_manifest.py']) write(`repo/${file}`, `# ${file}\n`);
  for (const hook of HOOKS) write(`repo/hook/${hook}`, `// ${hook}\n`);
  write('repo/hook/skill-map.overrides.example.json', '{"example": true}\n');
  for (const skill of ['agent-shared-memory', 'asm-review']) write(`repo/skills/${skill}/SKILL.md`, `# ${skill}\n`);
  write('repo/skills/codex/graph-mission/SKILL.md', '# graph-mission\n');
  write('repo/skills/codex/graph-mission/tasks/run.md', '# run\n');
  write('repo/jobs/package.json', '{"name":"asm-jobs"}\n');
  write('repo/jobs/package-lock.json', '{"lockfileVersion":3}\n');
  write('repo/jobs/dist/runner/cli.js', '// cli\n');
  write('repo/jobs/dist/refresh/cli.js', '// refresh\n');
  mkdirSync(at('runtime'), { recursive: true });
  mkdirSync(at('home'), { recursive: true });
  mkdirSync(at('vault'), { recursive: true });
  return {
    root, repo: at('repo'), runtime: at('runtime'), home: at('home'), vault: at('vault'), write,
    options: (overrides = {}) => ({
      repo: at('repo'), runtime: at('runtime'), home: at('home'), changedOnly: false, brainOnly: false, env: process.env, ...overrides,
    }),
  };
}

export const HOOKS = ['asm-activity-hook.js', 'asm-session-start.js', 'asm-prompt-recall.js', 'asm-memory-gate.js', 'asm-skill-router.js', 'asm-lifecycle.js'];

export interface Call { readonly name: string; readonly args: readonly string[]; readonly cwd: string | undefined }

/**
 * Plays the tools a refresh starts: the source manifest answers `sources`, merge.py writes the
 * three brain files, graphify writes an extract, npm ci writes a module, the skill router a map.
 * `exit` makes one tool fail by the name the refresh gives it.
 */
export class FakeRunner implements Runner {
  readonly calls: Call[] = [];
  sources: { raw: string; base: string }[] = [];
  readonly exit = new Map<string, number>();

  async run(name: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const tool = basename(name);
    this.calls.push({ name: tool, args, cwd: options.cwd });
    const key = args.find((arg) => /\.(py|mjs|js)$/.test(arg)) ?? tool;
    const code = this.exit.get(basename(key)) ?? this.exit.get(tool) ?? 0;
    if (code !== 0) return { code, output: `${tool} broke`, stdout: '' };
    if (args.includes('source_manifest.py')) return { code: 0, output: '', stdout: JSON.stringify(this.sources) };
    if (args.includes('merge.py') && options.cwd) {
      for (const file of ['brain.json', 'brain.index.json', 'brain.pages.json']) {
        mkdirSync(join(options.cwd, 'data'), { recursive: true });
        writeFileSync(join(options.cwd, 'data', file), JSON.stringify({ file }));
      }
    }
    if (tool === 'graphify') {
      const out = args[args.indexOf('--out') + 1] ?? '';
      mkdirSync(join(out, 'graphify-out'), { recursive: true });
      writeFileSync(join(out, 'graphify-out', 'graph.json'), '{}');
      // graphify 0.9 writes its stat cache into the scanned tree even with --out.
      const base = args[1] ?? '';
      mkdirSync(join(base, 'graphify-out', 'cache'), { recursive: true });
      writeFileSync(join(base, 'graphify-out', 'cache', 'stat-index.json'), '{}');
    }
    if (tool === 'npm' && args[0] === 'ci' && options.cwd) {
      mkdirSync(join(options.cwd, 'node_modules', 'zod'), { recursive: true });
    }
    return { code: 0, output: '', stdout: '' };
  }

  names(): string[] {
    return this.calls.map((call) => [call.name, ...call.args.map((arg) => basename(arg))].join(' '));
  }
}

export class MemoryLog implements RefreshLog {
  readonly lines: string[] = [];
  info(line: string): void { this.lines.push(line); }
  warn(line: string): void { this.lines.push(`WARN ${line}`); }
  output(): void { /* tool output is not asserted */ }
}
