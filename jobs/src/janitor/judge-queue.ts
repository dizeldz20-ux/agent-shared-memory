import type { Lifecycle } from '../ledger/lifecycle.js';
import type { MemoryRecord } from '../store/store.types.js';
import { evidencePack } from './evidence.js';
import type { ItemState } from './item-state-store.js';
import type { Candidate, EvidenceItem } from './janitor.types.js';

export interface QueuedItem {
  readonly candidate: Candidate;
  readonly evidence: readonly EvidenceItem[];
  /** The evidence ids the verdict will rest on; the same key next run means nothing new to judge. */
  readonly key: string;
}

export interface JudgeQueue {
  readonly queue: readonly QueuedItem[];
  readonly skippedNoEvidence: number;
  readonly skippedSameEvidence: number;
  readonly quarantined: number;
}

/** What is worth a model call this run: never a quarantined item, never one without evidence,
 *  never one already judged on exactly this evidence — and items never judged before come first,
 *  so re-judging on changed evidence cannot starve the backlog. */
export function buildJudgeQueue(
  candidates: readonly Candidate[],
  records: readonly MemoryRecord[],
  states: ReadonlyMap<string, ItemState>,
  life?: Lifecycle,
): JudgeQueue {
  const fresh: QueuedItem[] = [];
  const again: QueuedItem[] = [];
  let skippedNoEvidence = 0;
  let skippedSameEvidence = 0;
  let quarantined = 0;
  for (const candidate of candidates) {
    const state = states.get(candidate.id);
    if (state?.quarantined) {
      quarantined += 1;
      continue;
    }
    const evidence = evidencePack(candidate, records, 6, life);
    if (evidence.length === 0) {
      skippedNoEvidence += 1;
      continue;
    }
    const key = evidence.map((item) => item.id).join(',');
    if (state !== undefined && state.verdict !== '' && state.evidence_key === key) {
      skippedSameEvidence += 1;
      continue;
    }
    (state === undefined || state.verdict === '' ? fresh : again).push({ candidate, evidence, key });
  }
  return { queue: [...fresh, ...again], skippedNoEvidence, skippedSameEvidence, quarantined };
}

export function candidateTime(candidate: Candidate): number {
  const at = Date.parse(candidate.kind === 'page' ? candidate.page.updatedAt : candidate.record.created_at);
  return Number.isFinite(at) ? at : 0;
}
