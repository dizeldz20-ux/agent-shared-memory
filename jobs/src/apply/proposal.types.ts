import type { NewLedgerOp } from '../ledger/ledger.types.js';

export interface FileEdit {
  readonly kind: 'frontmatter' | 'archive_move' | 'replace';
  readonly path: string;
  /** The file's sha256 when the proposal was built; a different hash at apply time defers it. */
  readonly sha256: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly archive_to?: string;
  readonly after_text?: string;
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'deferred';

/** Another ledger operation the same change writes: with a second file it must touch (and so its
 *  own restore), or none (a further correction folded into the main file edit). */
export interface Companion {
  readonly op: Omit<NewLedgerOp, 'mode'>;
  readonly file_edit?: FileEdit;
}

export interface Proposal {
  readonly id: string;
  readonly run_id: string;
  readonly class: string;
  /** The ledger operation to write when the proposal is applied (its mode is set then). */
  readonly op: Omit<NewLedgerOp, 'mode'>;
  readonly file_edit?: FileEdit;
  /** Applied together with `file_edit`: a changed hash on any of the files defers them all. */
  readonly companions?: readonly Companion[];
  readonly summary: string;
  readonly created_at: string;
  readonly status: ProposalStatus;
  readonly decided_at?: string;
}
