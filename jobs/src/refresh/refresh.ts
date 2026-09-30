import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CodeDeploy } from './code-deploy.js';
import type { GraphRefresh } from './graph-refresh.js';
import type { RefreshLog, RefreshOptions, RefreshResult } from './refresh.types.js';

const RELOAD_URL = 'http://127.0.0.1:8930/api/reload';

/** One refresh, the same on every platform: the graph, then (unless brain-only) the code. */
export class Refresh {
  constructor(
    private readonly graph: GraphRefresh,
    private readonly code: CodeDeploy,
    private readonly log: RefreshLog,
    private readonly reload: () => Promise<string> = () => reloadServer(RELOAD_URL),
  ) {}

  async run(options: RefreshOptions): Promise<RefreshResult> {
    const vault = await vaultOf(options.repo);
    const stats = await this.graph.run(options, vault);
    if (!options.brainOnly) await this.code.run(options);
    // The deployed hooks cannot see sources.json: they read the resolved paths from here, and
    // without it the documentation gate has no vault to point at.
    await writeFile(resolve(options.runtime, 'asm-paths.json'), JSON.stringify({ vault, repo: options.repo }, null, 2));
    const reload = await this.reload();
    (reload.startsWith('RELOAD FAILED') ? this.log.warn : this.log.info).call(this.log, reload);
    this.log.info('done.');
    return { stats, reload };
  }
}

/** The vault named by sources.json, resolved against it; empty for a code-only setup. */
export async function vaultOf(repo: string): Promise<string> {
  const config = JSON.parse(await readFile(resolve(repo, 'sources.json'), 'utf8')) as { vault?: unknown };
  return typeof config.vault === 'string' && config.vault ? resolve(dirname(resolve(repo, 'sources.json')), config.vault) : '';
}

/**
 * A connection failure means the UI server is not running, which is fine. An HTTP error means
 * the running server rejected the new graph and still serves the old one — never the same thing.
 */
export async function reloadServer(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    return response.ok
      ? `server reloaded (HTTP ${response.status})`
      : `RELOAD FAILED - server is up but rejected the new graph (HTTP ${response.status}); it is still serving the OLD graph`;
  } catch (error: unknown) {
    const cause = error instanceof Error && error.cause instanceof Error && 'code' in error.cause ? String(error.cause.code) : '';
    if (cause === 'ECONNREFUSED' || (error instanceof Error && error.name === 'TimeoutError')) return 'server not running - skipped reload';
    return `RELOAD FAILED: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ''}`;
  }
}

export function parseRefreshArgs(argv: readonly string[]): { changedOnly: boolean; brainOnly: boolean } {
  const flags = { changedOnly: false, brainOnly: false };
  for (const arg of argv) {
    if (arg === '--changed') flags.changedOnly = true;
    else if (arg === '--brain-only') flags.brainOnly = true;
    else throw new Error(`unknown option: ${arg} (supported: --changed, --brain-only)`);
  }
  return flags;
}
