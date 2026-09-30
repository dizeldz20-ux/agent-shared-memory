import type { ClassGate, GateResult } from '../trust/trust-store.js';
import type { MemoryRecord } from '../store/store.types.js';
import { evidencePack } from './evidence.js';
import type { Judge, JudgeItem } from './judge.js';
import type { ThreadCandidate, Verdict } from './janitor.types.js';

export interface ThreadLabel {
  readonly thread_id: string;
  readonly text: string;
  readonly label: Verdict;
  readonly resolved_by: string | null;
}

export interface GateOptions {
  readonly threshold: number;
  readonly minJudged: number;
  readonly batchSize: number;
  readonly model: string;
}

export interface GateRow {
  readonly thread_id: string;
  readonly label: Verdict;
  readonly verdict: Verdict | 'no_evidence';
  readonly correct: boolean | null;
}

const CLOSING = new Set<Verdict>(['resolved', 'not_actionable']);

function candidateFor(label: ThreadLabel, records: readonly MemoryRecord[]): ThreadCandidate | undefined {
  const [recordId, rawIndex] = label.thread_id.split('#');
  const record = records.find((item) => item.id === recordId);
  const index = Number(rawIndex);
  if (record === undefined || !Number.isInteger(index)) return undefined;
  return { kind: 'thread', id: label.thread_id, text: record.open_threads[index] ?? label.text, record, index };
}

/**
 * The judge's precision on hand-labelled threads, measured exactly as the janitor would run:
 * the same evidence packs, the same batches. Only verdicts that would close a thread count;
 * "unknown" and "still_open" close nothing, so they can never be wrong here.
 */
export async function runGate(labels: readonly ThreadLabel[], records: readonly MemoryRecord[], judge: Judge,
  options: GateOptions): Promise<{ result: GateResult; rows: GateRow[] }> {
  const items: JudgeItem[] = [];
  const rows: GateRow[] = [];
  for (const label of labels) {
    const candidate = candidateFor(label, records);
    const evidence = candidate ? evidencePack(candidate, records) : [];
    if (candidate === undefined || evidence.length === 0) rows.push({ thread_id: label.thread_id, label: label.label, verdict: 'no_evidence', correct: null });
    else items.push({ candidate, evidence });
  }
  const byId = new Map(labels.map((label) => [label.thread_id, label]));
  for (let start = 0; start < items.length; start += options.batchSize) {
    const outcome = await judge.judgeBatch(items.slice(start, start + options.batchSize));
    for (const judgement of outcome.judgements) {
      const label = byId.get(judgement.item_id);
      if (label === undefined) continue;
      const correct = CLOSING.has(judgement.verdict) ? judgement.verdict === label.label : null;
      rows.push({ thread_id: judgement.item_id, label: label.label, verdict: judgement.verdict, correct });
    }
    for (const id of outcome.failed) {
      const label = byId.get(id);
      if (label !== undefined) rows.push({ thread_id: id, label: label.label, verdict: 'unknown', correct: null });
    }
  }
  const score = (subset: readonly GateRow[]): ClassGate => {
    const precision = subset.length === 0 ? null : subset.filter((row) => row.correct).length / subset.length;
    return { judged: subset.length, precision, passed: precision !== null && subset.length >= options.minJudged && precision >= options.threshold };
  };
  const judged = rows.filter((row) => row.correct !== null);
  const overall = score(judged);
  // Each closing verdict is gated on its own too: a strong "resolved" cannot carry a weak "not_actionable".
  const classes = Object.fromEntries([...CLOSING].map((verdict) => [verdict, score(judged.filter((row) => row.verdict === verdict))]));
  return {
    result: { precision: overall.precision, sample_size: labels.length, judged: overall.judged, passed: overall.passed,
      at: new Date().toISOString(), model: options.model, classes },
    rows,
  };
}
