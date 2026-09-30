// The stale-recall benchmark: realistic prompts, the ids whose recall gives the current
// answer, and the ids that state a finished or superseded status as if it were current.
// The cases and the frozen snapshot are private and live under ~/.asm/bench/.

export interface BenchCase {
  readonly id: string;
  readonly query: string;
  readonly topic?: string;
  readonly current_ids: readonly string[];
  readonly stale_ids: readonly string[];
  readonly evidence?: string;
}

export interface BenchCases {
  readonly version: number;
  readonly cases: readonly BenchCase[];
}

export type Channel = 'hook' | 'search';

export interface CaseScore {
  readonly case_id: string;
  readonly channel: Channel;
  readonly top: readonly string[];
  readonly current_hit: boolean;
  readonly stale_hit: boolean;
  readonly stale_next_to_current: boolean;
  readonly stale_only: boolean;
}

export interface ChannelSummary {
  readonly cases: number;
  readonly current_hit: number;
  readonly stale_hit: number;
  readonly stale_next_to_current: number;
  readonly stale_only: number;
}

export interface SnapshotManifest {
  readonly created_at: string;
  readonly source: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface BenchReport {
  readonly created_at: string;
  readonly snapshot: string;
  /** The sha256 of the snapshot's manifest.json and the time recall ran at (ASM_NOW). */
  readonly manifest_sha256: string;
  readonly clock: string | null;
  readonly code: string;
  /** `git rev-parse HEAD` of the code directory, when it is a checkout. */
  readonly code_commit: string;
  readonly summary: Readonly<Record<Channel, ChannelSummary>>;
  readonly scores: readonly CaseScore[];
}
