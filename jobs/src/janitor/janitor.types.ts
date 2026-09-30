import type { MemoryRecord, VaultPage } from '../store/store.types.js';

export interface ThreadCandidate {
  readonly kind: 'thread';
  /** `<record id>#<index>` */
  readonly id: string;
  readonly text: string;
  readonly record: MemoryRecord;
  readonly index: number;
}

export interface RecordCandidate {
  readonly kind: 'record';
  readonly id: string;
  readonly text: string;
  readonly record: MemoryRecord;
}

export interface PageCandidate {
  readonly kind: 'page';
  /** `vault:<page id>` */
  readonly id: string;
  readonly text: string;
  readonly page: VaultPage;
}

export type Candidate = ThreadCandidate | RecordCandidate | PageCandidate;

export interface EvidenceItem {
  /** `memory:<record id>` */
  readonly id: string;
  readonly created_at: string;
  readonly summary: string;
  /** The head of the record's details: where the deciding sentence often is. */
  readonly details: string;
  readonly files: readonly string[];
  /** The record's threads still open (by the ledger, when the caller has it). */
  readonly threads: readonly string[];
}

export type Verdict = 'resolved' | 'still_open' | 'not_actionable' | 'unknown';

export interface Judgement {
  readonly item_id: string;
  readonly verdict: Verdict;
  readonly resolved_by: string | null;
  readonly reason: string;
}
