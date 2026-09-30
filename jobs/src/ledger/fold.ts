import { Lifecycle } from './lifecycle.js';
import type { LedgerOp, MemoryRecordLike, OpKind, TargetState, VisibilityState } from './ledger.types.js';

const VISIBILITY: Partial<Record<OpKind, VisibilityState>> = {
  close_thread: 'closed',
  mark_done: 'done',
  retire: 'retired',
};

const keyOf = (op: LedgerOp): string => `${op.target.kind}:${op.target.id}`;

function supersessions(records: readonly MemoryRecordLike[]): Map<string, TargetState> {
  const states = new Map<string, TargetState>();
  for (const record of records) {
    for (const old of record.supersedes ?? []) {
      states.set(`record:${old}`, {
        state: 'retired', op_id: `supersedes:${record.id}`, at: record.created_at ?? '',
        reason: 'superseded by a later record', superseded_by: `memory:${record.id}`,
      });
    }
  }
  return states;
}

/**
 * Replay the operations in file order, exactly as lifecycle.fold does. A record's
 * `supersedes` list is read first as an implicit retire; `restore` reinstates what its
 * undone operation replaced, and only while that operation is still in force.
 */
export function fold(ops: readonly LedgerOp[], records: readonly MemoryRecordLike[] = []): Lifecycle {
  const states = supersessions(records);
  const requested = new Map<string, LedgerOp>();
  const before = new Map<string, TargetState | undefined>();
  const seen = new Map<string, LedgerOp>();
  for (const op of ops) {
    if (seen.has(op.id)) continue; // a line written twice is one operation
    seen.set(op.id, op);
    const visibility = VISIBILITY[op.op];
    if (visibility !== undefined) {
      before.set(op.id, states.get(keyOf(op)));
      states.set(keyOf(op), {
        state: visibility, op_id: op.id, at: op.ts ?? '', reason: op.reason,
        superseded_by: op.superseded_by ?? null,
      });
    } else if (op.op === 'restore') {
      const undone = seen.get(op.undoes ?? '');
      if (undone === undefined || VISIBILITY[undone.op] === undefined) continue;
      if (states.get(keyOf(undone))?.op_id !== undone.id) continue; // already restored or overtaken
      const previous = before.get(undone.id);
      if (previous === undefined) states.delete(keyOf(undone));
      else states.set(keyOf(undone), previous);
    } else if (op.op === 'correct') {
      if (op.mode === 'requested') requested.set(op.id, op);
      else if (op.applies !== undefined) requested.delete(op.applies);
    }
  }
  return new Lifecycle(states, requested);
}
