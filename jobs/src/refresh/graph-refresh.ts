import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunOptions, RunResult, Runner } from '../platform/process-runner.js';
import { extractIsFresh } from './freshness.js';
import { RefreshError, type ExtractStats, type RefreshLog, type RefreshOptions } from './refresh.types.js';

/** brain.json goes last: a running MCP reloads when it changes, and by then the page bodies
 * and the index it reads with it are already the new ones. */
export const BRAIN_FILES = ['brain.pages.json', 'brain.index.json', 'brain.json'] as const;

interface Source {
  readonly raw: string;
  readonly base: string;
}

const isSource = (value: unknown): value is Source =>
  typeof value === 'object' && value !== null && typeof (value as Source).raw === 'string' && typeof (value as Source).base === 'string';

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The graph half of a refresh: okf bundle, code extracts, merge, and the brain files deployed. */
export class GraphRefresh {
  constructor(
    private readonly runner: Runner,
    private readonly log: RefreshLog,
    private readonly now: () => number = Date.now,
  ) {}

  async run(options: RefreshOptions, vault: string): Promise<ExtractStats> {
    await this.rebuildOkf(options, vault);
    const stats = await this.extract(options);
    this.log.info('== merge -> brain.json ==');
    await this.must('uv', ['run', 'python', 'merge.py'], options, 'merge.py');
    this.log.info('== deploy runtime copies ==');
    await mkdir(options.runtime, { recursive: true });
    for (const file of BRAIN_FILES) {
      // A plain copy truncates in place, and a session starting inside that window gets an
      // MCP server that cannot parse the file and fails to boot.
      await copyFile(join(options.repo, 'data', file), join(options.runtime, `${file}.tmp`));
      await rename(join(options.runtime, `${file}.tmp`), join(options.runtime, file));
    }
    return stats;
  }

  // okf-build.mjs is the canonical generator (split index, restore snapshot, health block);
  // build_okf.py is the older one, kept for vaults that do not carry the Node generator.
  private async rebuildOkf(options: RefreshOptions, vault: string): Promise<void> {
    if (!vault) return;
    const node = join(vault, 'okf', 'okf-build.mjs');
    if (existsSync(node)) {
      this.log.info('== rebuild okf bundle from the vault (okf-build.mjs) ==');
      await this.must(node, [], options, 'okf-build.mjs', vault);
    } else if (existsSync(join(vault, 'tools', 'build_okf.py'))) {
      this.log.info('== rebuild okf bundle from the vault (build_okf.py fallback) ==');
      await this.must('uv', ['run', '--no-project', 'python', join('tools', 'build_okf.py')], options, 'build_okf.py', vault);
    }
  }

  private async extract(options: RefreshOptions): Promise<ExtractStats> {
    this.log.info('== graphify extract (code-only, local AST) ==');
    const stats: ExtractStats = { extracted: [], failed: [], missing: [], unchanged: [] };
    const manifest = await this.must('uv', ['run', 'python', 'source_manifest.py', 'sources.json'], options, 'source_manifest.py', options.repo, true);
    const sources: unknown = JSON.parse(manifest.stdout);
    if (!Array.isArray(sources)) throw new RefreshError('source_manifest.py did not answer a list of sources');
    for (const source of sources.filter(isSource)) {
      this.log.info(`-- ${source.raw}`);
      // A tree that is gone (a deleted worktree, a moved repo) must not stop the run: the merge
      // would never happen, and brain.json would silently stop tracking every other source.
      if (!isDirectory(source.base)) {
        this.log.warn(`   !! base not found: ${source.base} — skipping (data/raw/${source.raw} keeps its last extract, now STALE)`);
        stats.missing.push(source.raw);
        continue;
      }
      const out = join(options.repo, 'data', 'raw', source.raw);
      if (options.changedOnly && (await extractIsFresh(join(out, 'graphify-out', 'graph.json'), source.base, this.now()))) {
        this.log.info('   unchanged since the last extract — skipped');
        stats.unchanged.push(source.raw);
        continue;
      }
      (await this.extractOne(source, out, options) ? stats.extracted : stats.failed).push(source.raw);
    }
    return stats;
  }

  // One source failing (a parse error, an odd file) keeps the run going. graphify that cannot start
  // at all stops it: every source would keep its old extract, and the run would still look fine.
  private async extractOne(source: Source, out: string, options: RefreshOptions): Promise<boolean> {
    // graphify writes its stat cache into the scanned project even with --out: a graphify-out/
    // this run created is removed, so no project shows an untracked folder it never asked for.
    const litter = join(source.base, 'graphify-out');
    const hadLitter = existsSync(litter);
    let code: number | null;
    try {
      code = (await this.runner.run('graphify', ['extract', source.base, '--code-only', '--out', out], this.stream(options, options.repo))).code;
    } catch (error: unknown) {
      throw new RefreshError(`graphify could not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (!hadLitter && resolve(litter) !== resolve(out, 'graphify-out')) await rm(litter, { recursive: true, force: true });
    }
    if (code === 0) return true;
    this.log.warn(`   !! extraction failed: ${source.base} — merge will retain a previous extract or mark this source empty`);
    return false;
  }

  private async must(name: string, args: readonly string[], options: RefreshOptions, label: string, cwd = options.repo, quiet = false): Promise<RunResult> {
    const result = await this.runner.run(name, args, quiet ? { cwd, env: options.env } : this.stream(options, cwd));
    if (result.code !== 0) throw new RefreshError(`${label} failed (exit ${result.code}): ${result.output.slice(-600)}`);
    return result;
  }

  private stream(options: RefreshOptions, cwd: string): RunOptions {
    return { cwd, env: options.env, onOutput: (text) => this.log.output(text) };
  }
}
