// The stores the jobs read. Field names stay snake_case where the files are shared with the
// Python server and the hooks.

export interface MemoryRecord {
  readonly id: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly agent: string;
  readonly summary: string;
  readonly details: string;
  readonly files: readonly string[];
  readonly decisions: readonly string[];
  readonly open_threads: readonly string[];
  readonly supersedes?: readonly string[];
}

export interface VaultPage {
  /** The frontmatter id, or `file:<rel>` for a page without one (the graph's vault:file: ids). */
  readonly id: string;
  readonly path: string;
  readonly rel: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly type: string;
  readonly description: string;
  readonly size: number;
  /** The first 1,500 characters after the frontmatter: where pages keep their status line. */
  readonly head: string;
  /** The sha256 of the text read: a proposal is built on it, so an edit made after the read defers it. */
  readonly sha256: string;
}
