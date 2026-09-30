import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProcessRunner } from '../platform/process-runner.js';
import { CodeDeploy } from '../refresh/code-deploy.js';
import { GraphRefresh } from '../refresh/graph-refresh.js';
import { Refresh } from '../refresh/refresh.js';
import type { RefreshLog, RefreshOptions, RefreshResult } from '../refresh/refresh.types.js';
import { withToolPath } from '../refresh/tool-path.js';

type RunRefresh = (options: RefreshOptions, log: RefreshLog) => Promise<RefreshResult>;

const runRefresh: RunRefresh = async (options, log) => {
  const runner = new ProcessRunner();
  return new Refresh(new GraphRefresh(runner, log), new CodeDeploy(runner, log), log).run(options);
};

export interface RefreshJobResult {
  readonly exit: 0;
  readonly extracted: number;
  readonly unchanged: number;
  readonly failed: readonly string[];
  readonly missing: readonly string[];
  readonly reload: string;
  /** The first warnings, so a partial refresh is visible in `status` rather than read as clean. */
  readonly warnings: readonly string[];
  /** Set when every due source failed: the runner records the run as a failure. */
  readonly degraded?: string;
}

/**
 * The daily graph refresh, run in process by the deployed jobs: changed sources only, and the
 * graph only — never code from the development checkout, where work may be half done. Its last
 * lines explain a failure.
 */
export async function refreshGraph(home: string, run: RunRefresh = runRefresh): Promise<RefreshJobResult> {
  const paths = JSON.parse(await readFile(join(home, 'asm-paths.json'), 'utf8')) as { repo?: unknown };
  const repo = typeof paths.repo === 'string' ? paths.repo : '';
  if (!repo) throw new Error('asm-paths.json names no source repo to refresh from');
  let tail = '';
  const warnings: string[] = [];
  const keep = (text: string): void => { tail = `${tail}${text}`.slice(-2_000); };
  const log: RefreshLog = {
    info: (line) => keep(`${line}\n`),
    warn: (line) => { keep(`${line}\n`); if (warnings.length < 20) warnings.push(line); },
    output: keep,
  };
  const user = homedir();
  let result: RefreshResult;
  try {
    result = await run({ repo, runtime: home, home: user, changedOnly: true, brainOnly: true, env: withToolPath(process.env, user) }, log);
  } catch (error: unknown) {
    throw new Error(`refresh failed: ${error instanceof Error ? error.message : String(error)}\n${tail.slice(-400)}`, { cause: error });
  }
  const { extracted, failed, missing, unchanged } = result.stats;
  const summary = { exit: 0 as const, extracted: extracted.length, unchanged: unchanged.length, failed, missing, reload: result.reload, warnings };
  // Sources failing one by one are a warning; all of them failing means the graph did not move.
  return failed.length > 0 && extracted.length === 0 ? { ...summary, degraded: `every due source failed to extract: ${failed.join(', ')}` } : summary;
}
