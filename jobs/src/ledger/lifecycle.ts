import type { LedgerOp, MemoryRecordLike, TargetKind, TargetState } from './ledger.types.js';

const HIDDEN = new Set(['closed', 'retired']); // `done` stays visible, marked as finished

/** The folded ledger: the current state of every target an operation touched. */
export class Lifecycle {
  constructor(
    readonly states: ReadonlyMap<string, TargetState>,
    readonly requested: ReadonlyMap<string, LedgerOp>,
  ) {}

  state(kind: TargetKind, id: string): TargetState | undefined {
    return this.states.get(`${kind}:${id}`);
  }

  hidden(kind: TargetKind, id: string): boolean {
    const entry = this.state(kind, id);
    return entry !== undefined && HIDDEN.has(entry.state);
  }

  threadOpen(recordId: string, index: number): boolean {
    return !this.hidden('record', recordId) && !this.hidden('thread', `${recordId}#${index}`);
  }

  openThreads(records: readonly MemoryRecordLike[]): string[] {
    const open: string[] = [];
    for (const record of records) {
      (record.open_threads ?? []).forEach((_, index) => {
        if (this.threadOpen(record.id, index)) open.push(`${record.id}#${index}`);
      });
    }
    return open.sort();
  }
}
