import type { Verdict } from './janitor.types.js';

export interface JanitorReport {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly dry_run: boolean;
  readonly candidates: { readonly threads: number; readonly snapshots: number; readonly pages: number };
  readonly duplicates: number;
  readonly hygiene: {
    readonly archived_or_proposed: number;
    readonly stale_sessions_moved: number;
    readonly orphan_memory_files: readonly string[];
  };
  readonly judged: {
    readonly calls: number;
    readonly items: number;
    readonly verdicts: Readonly<Record<Verdict, number>>;
    readonly failed: number;
    readonly quarantined: number;
    readonly skipped_no_evidence: number;
    readonly skipped_same_evidence: number;
  };
  readonly proposals: { readonly total: number; readonly applied: number; readonly pending: number; readonly deferred: number };
  readonly stopped: string | null;
  /** Why a run that finished did no work: the runner records it as a failure, so the banner shows it. */
  readonly degraded?: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly cost_usd: number };
}
