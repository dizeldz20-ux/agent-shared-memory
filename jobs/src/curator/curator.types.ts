import type { Proposal } from '../apply/proposal.types.js';
import type { Actor } from '../ledger/ledger.types.js';
import type { Lifecycle } from '../ledger/lifecycle.js';
import type { RuntimeLayout } from '../store/runtime-layout.js';
import type { MemoryRecord, VaultPage } from '../store/store.types.js';
import type { CuratedProject } from './scope.js';

export const CURATOR: Actor = { kind: 'curator', name: 'curator' };

export interface CuratorContext {
  readonly runId: string;
  readonly layout: RuntimeLayout;
  readonly records: readonly MemoryRecord[];
  readonly life: Lifecycle;
  readonly pages: readonly VaultPage[];
  readonly scope: readonly CuratedProject[];
  /** Session id → the absolute files that session touched: attributes records that name relative paths. */
  readonly sessionFiles: ReadonlyMap<string, readonly string[]>;
  readonly now: Date;
  /** `<class>|<target id>` of every proposal still waiting for the owner: never asked about again. */
  readonly waiting: ReadonlySet<string>;
  /** One model call; undefined when it failed or the model is unavailable for the rest of the run. */
  readonly ask: (prompt: string) => Promise<string | undefined>;
}

export interface Built {
  readonly proposal?: Proposal;
  /** A first build of a block always waits for the owner. */
  readonly firstBuild?: boolean;
  readonly skipped?: string;
}

export interface CuratorReport {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly dry_run: boolean;
  readonly calls: number;
  readonly failed_calls: number;
  readonly built: Readonly<Record<string, number>>;
  readonly proposals: { readonly total: number; readonly applied: number; readonly pending: number; readonly deferred: number };
  readonly skipped: readonly string[];
  readonly stopped: string | null;
  /** Why a run that finished did no work: the runner records it as a failure, so the banner shows it. */
  readonly degraded?: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly cost_usd: number };
}
