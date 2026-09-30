// The ledger file format, shared with lifecycle.py and hook/asm-lifecycle.js. Field names
// stay snake_case: the same JSON lines are read and written by Python and JavaScript too.

export const OP_KINDS = ['close_thread', 'mark_done', 'retire', 'restore', 'correct', 'compact'] as const;
export type OpKind = (typeof OP_KINDS)[number];

export const TARGET_KINDS = ['thread', 'record', 'page', 'memory_file', 'index_line'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export type OpMode = 'auto' | 'approved' | 'requested' | 'rejected';
export type ActorKind = 'agent' | 'janitor' | 'curator' | 'owner';
export type VisibilityState = 'closed' | 'done' | 'retired';

export interface Target {
  readonly kind: TargetKind;
  readonly id: string;
}

export interface Actor {
  readonly kind: ActorKind;
  readonly name: string;
  readonly session?: string;
}

export interface FileSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly text?: string;
}

export interface LedgerOp {
  readonly id: string;
  readonly ts?: string;
  readonly op: OpKind;
  readonly target: Target;
  readonly reason: string;
  readonly evidence?: readonly string[];
  readonly superseded_by?: string | null;
  readonly actor?: Actor;
  readonly mode?: OpMode;
  readonly class?: string;
  readonly before?: FileSnapshot;
  readonly after?: FileSnapshot;
  readonly undoes?: string;
  readonly applies?: string;
  readonly claimed?: string;
  readonly truth?: string;
}

/** An operation before the store stamps its id (and, when absent, its timestamp). */
export type NewLedgerOp = Omit<LedgerOp, 'id'>;

export interface TargetState {
  readonly state: VisibilityState;
  readonly op_id: string;
  readonly at: string;
  readonly reason: string;
  readonly superseded_by: string | null;
}

/** The fields of a memory.jsonl record the fold needs. */
export interface MemoryRecordLike {
  readonly id: string;
  readonly created_at?: string;
  readonly supersedes?: readonly string[];
  readonly open_threads?: readonly string[];
}
