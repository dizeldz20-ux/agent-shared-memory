import { existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandUnavailableError } from '../platform/command-resolver.js';
import type { RunOptions, RunResult } from '../platform/process-runner.js';
import { BRAIN_FILES, GraphRefresh } from './graph-refresh.js';
import { RefreshError } from './refresh.types.js';
import { FakeRunner, MemoryLog, sandbox, type Sandbox } from './refresh.testkit.js';

const DAY = 86_400_000;

describe('GraphRefresh', () => {
  let box: Sandbox;
  let runner: FakeRunner;
  let log: MemoryLog;
  const now = Date.parse('2026-09-30T12:00:00Z');
  beforeEach(() => {
    box = sandbox();
    runner = new FakeRunner();
    log = new MemoryLog();
    box.write('vault/okf/okf-build.mjs', '// okf\n');
    runner.sources = [
      { raw: 'alpha', base: join(box.root, 'projects/alpha') },
      { raw: 'gone', base: join(box.root, 'projects/gone') },
    ];
    box.write('projects/alpha/src/main.py', 'print(1)\n');
  });
  afterEach(() => { rmSync(box.root, { recursive: true, force: true }); });

  const refresh = (changedOnly = false) => new GraphRefresh(runner, log, () => now).run(box.options({ changedOnly }), box.vault);

  it('rebuilds the okf bundle, extracts each source, merges, and deploys the three brain files', async () => {
    await refresh();
    expect(runner.names()).toEqual([
      'okf-build.mjs', 'uv run python source_manifest.py sources.json',
      `graphify extract alpha --code-only --out alpha`, 'uv run python merge.py',
    ]);
    for (const file of BRAIN_FILES) expect(JSON.parse(readFileSync(join(box.runtime, file), 'utf8'))).toEqual({ file });
    expect(log.lines).toContain(`WARN    !! base not found: ${join(box.root, 'projects/gone')} — skipping (data/raw/gone keeps its last extract, now STALE)`);
  });

  it('moves brain.json last, so a reloading server finds the pages and the index already new', () => {
    expect(BRAIN_FILES.at(-1)).toBe('brain.json');
    expect([...BRAIN_FILES].sort()).toEqual(['brain.index.json', 'brain.json', 'brain.pages.json']);
  });

  it('with --changed skips an extract that is fresh and older than nothing in its tree', async () => {
    const extract = box.write('repo/data/raw/alpha/graphify-out/graph.json', '{}');
    const source = join(box.root, 'projects/alpha/src/main.py');
    utimesSync(source, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
    utimesSync(extract, new Date(now - DAY), new Date(now - DAY));
    box.write('projects/alpha/node_modules/dep/index.js', '// newer, but a dependency\n');
    await refresh(true);
    expect(runner.names().filter((call) => call.startsWith('graphify'))).toEqual([]);
    expect(log.lines).toContain('   unchanged since the last extract — skipped');
  });

  it('with --changed extracts again when a file is newer than the extract, or the extract is over 3 days old', async () => {
    const extract = box.write('repo/data/raw/alpha/graphify-out/graph.json', '{}');
    utimesSync(extract, new Date(now - DAY), new Date(now - DAY));
    await refresh(true);
    expect(runner.names().filter((call) => call.startsWith('graphify'))).toHaveLength(1);
    runner.calls.length = 0;
    utimesSync(join(box.root, 'projects/alpha/src/main.py'), new Date(now - 10 * DAY), new Date(now - 10 * DAY));
    utimesSync(extract, new Date(now - 4 * DAY), new Date(now - 4 * DAY));
    await refresh(true);
    expect(runner.names().filter((call) => call.startsWith('graphify'))).toHaveLength(1);
  });

  it('keeps going when one extraction fails, and says which sources it extracted, failed or could not find', async () => {
    runner.exit.set('graphify', 1);
    const stats = await refresh();
    expect(log.lines).toContain(`WARN    !! extraction failed: ${join(box.root, 'projects/alpha')} — merge will retain a previous extract or mark this source empty`);
    expect(existsSync(join(box.runtime, 'brain.json'))).toBe(true);
    expect(stats).toEqual({ extracted: [], failed: ['alpha'], missing: ['gone'], unchanged: [] });
    runner.exit.clear();
    expect(await refresh()).toEqual({ extracted: ['alpha'], failed: [], missing: ['gone'], unchanged: [] });
  });

  it('stops the refresh when graphify cannot start at all: every source would silently keep its old extract', async () => {
    const missing = new (class extends FakeRunner {
      override async run(name: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
        if (name === 'graphify') throw new CommandUnavailableError('graphify was not found on PATH');
        return super.run(name, args, options);
      }
    })();
    missing.sources = runner.sources;
    await expect(new GraphRefresh(missing, log, () => now).run(box.options(), box.vault)).rejects.toThrow(/graphify was not found on PATH/);
    expect(missing.names()).not.toContain('uv run python merge.py');
    expect(existsSync(join(box.runtime, 'brain.json'))).toBe(false);
  });

  it('leaves no graphify-out folder behind in a project that did not have one', async () => {
    box.write('projects/kept/graphify-out/GRAPH_REPORT.md', '# the owner ran graphify here\n');
    box.write('projects/kept/main.py', 'x = 1\n');
    runner.sources = [...runner.sources, { raw: 'kept', base: join(box.root, 'projects/kept') }];
    await refresh();
    expect(existsSync(join(box.root, 'projects/alpha/graphify-out'))).toBe(false);
    expect(existsSync(join(box.root, 'projects/kept/graphify-out/GRAPH_REPORT.md'))).toBe(true);
  });

  it('stops before deploying anything when the okf build or the merge fails', async () => {
    runner.exit.set('okf-build.mjs', 1);
    await expect(refresh()).rejects.toThrow(RefreshError);
    expect(runner.names()).toEqual(['okf-build.mjs']);
    runner.exit.clear();
    runner.calls.length = 0;
    runner.exit.set('merge.py', 2);
    await expect(refresh()).rejects.toThrow(/merge\.py/);
    expect(existsSync(join(box.runtime, 'brain.json'))).toBe(false);
  });

  it('has no okf step without a vault', async () => {
    await new GraphRefresh(runner, log, () => now).run(box.options(), '');
    expect(runner.names()[0]).toBe('uv run python source_manifest.py sources.json');
  });
});
