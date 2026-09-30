import type { Lifecycle } from '../ledger/lifecycle.js';
import type { MemoryRecord } from '../store/store.types.js';
import type { Candidate, EvidenceItem } from './janitor.types.js';

// Identifiers two records can share: commit hashes (7–40 hex with a digit and a letter) and
// short task tags such as T7 or G9.
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const TAG = /\b[A-Z]{1,2}\d{1,2}\b/g;
const TAG_ONLY = /^[A-Z]{1,2}\d{1,2}$/;

export function anchorsOf(text: string): Set<string> {
  return new Set([...(text.match(HASH) ?? []), ...(text.match(TAG) ?? [])]);
}

const leaf = (path: string): string => path.replace(/\\/g, '/').toLowerCase().split('/').slice(-2).join('/');

function origin(candidate: Candidate): { at: number; session: string; files: Set<string>; anchors: Set<string>; own: string } {
  if (candidate.kind === 'page') {
    const at = Date.parse(candidate.page.updatedAt);
    return {
      at: Number.isFinite(at) ? at : 0, session: '', files: new Set(),
      anchors: new Set([...anchorsOf(`${candidate.page.title}\n${candidate.page.head}`), candidate.page.id]), own: '',
    };
  }
  const record = candidate.record;
  return {
    at: Date.parse(record.created_at), session: record.session_id, files: new Set(record.files.map(leaf)),
    anchors: anchorsOf(`${candidate.text}\n${record.summary}`), own: record.id,
  };
}

/**
 * The later records most likely to say what became of a candidate, strongest first. A shared session
 * or a shared commit hash is a real link; a short task tag (V3, Q1) recurs across projects, so one
 * shared tag alone does not make a record evidence.
 */
export function evidencePack(candidate: Candidate, records: readonly MemoryRecord[], limit = 6, life?: Lifecycle): EvidenceItem[] {
  const from = origin(candidate);
  const scored: { score: number; at: number; record: MemoryRecord }[] = [];
  for (const record of records) {
    const at = Date.parse(record.created_at);
    if (record.id === from.own || !Number.isFinite(at) || at <= from.at) continue;
    const text = `${record.summary}\n${record.details}\n${record.decisions.join('\n')}`;
    let score = from.session && record.session_id === from.session ? 3 : 0;
    score += 2 * record.files.map(leaf).filter((file) => from.files.has(file)).length;
    for (const anchor of from.anchors) if (text.includes(anchor)) score += TAG_ONLY.test(anchor) ? 1 : 3;
    if (score >= 2) scored.push({ score, at, record });
  }
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  return scored.slice(0, limit).map(({ record }) => ({
    id: `memory:${record.id}`, created_at: record.created_at, summary: record.summary, details: record.details.slice(0, 300),
    files: record.files.slice(0, 3),
    threads: record.open_threads.filter((_, index) => life === undefined || life.threadOpen(record.id, index))
      .slice(0, 10).map((thread) => thread.slice(0, 300)),
  }));
}
