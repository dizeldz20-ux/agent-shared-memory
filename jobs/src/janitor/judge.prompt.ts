import type { Candidate, EvidenceItem } from './janitor.types.js';

const KIND: Readonly<Record<Candidate['kind'], string>> = {
  thread: 'open thread left in a work record',
  record: 'work record whose summary states a status',
  page: 'plan page whose status says work is still to be done',
};

const RULES = `You judge a shared memory used by coding agents. Each ITEM below is something an agent left
open or described as not finished. For each item, decide from its EVIDENCE (later work records only)
whether it has since been settled.

Verdicts:
- "resolved": a later record explicitly says the item was done, deployed, answered, decided or
  abandoned. Put that record's id in resolved_by. Use only ids listed in that item's own EVIDENCE.
- "still_open": a later record explicitly says the item is still pending.
- "not_actionable": the item is a caveat or note that asks for no action (for example "human
  evaluation remains", "the rollback tag is kept"). Never for a dated deadline or expiry, a release step still to do
  (push, merge, deploy), or an approval or decision someone still owes: those are "still_open" or "unknown".
- "unknown": anything else. A later record that does not mention the item is not evidence.
When unsure, answer "unknown": a wrong "resolved" hides live work; a wrong "unknown" costs nothing.
Items and records may be in Hebrew or English; judge the meaning.

Answer with JSON only — no prose, no code fence — exactly this shape, one entry per item:
{"items":[{"item_id":"<id>","verdict":"resolved|still_open|not_actionable|unknown","resolved_by":"memory:<id>" or null,"reason":"<one sentence>"}]}`;

function evidenceLines(evidence: readonly EvidenceItem[]): string {
  if (evidence.length === 0) return '  (none)';
  return evidence.map((item) => {
    const files = item.files.length ? ` | files: ${item.files.join(', ')}` : '';
    const details = item.details ? ` — ${item.details}` : '';
    const threads = item.threads.length ? ` | still open there: ${item.threads.join(' ; ')}` : '';
    return `  - ${item.id} (${item.created_at}): ${item.summary}${details}${files}${threads}`;
  }).join('\n');
}

function origin(candidate: Candidate): string {
  if (candidate.kind === 'page') return `page ${candidate.page.rel}, updated ${candidate.page.updatedAt || 'unknown'}`;
  return `${candidate.record.created_at} by ${candidate.record.agent} — the record says: ${candidate.record.summary}`;
}

export function buildJudgePrompt(items: readonly { candidate: Candidate; evidence: readonly EvidenceItem[] }[]): string {
  const blocks = items.map(({ candidate, evidence }, index) => [
    `[${index + 1}] item_id: ${candidate.id}`,
    `kind: ${KIND[candidate.kind]}`,
    `text: ${candidate.text}`,
    `written: ${origin(candidate)}`,
    'EVIDENCE:',
    evidenceLines(evidence),
  ].join('\n'));
  return `${RULES}\n\nITEMS:\n\n${blocks.join('\n\n')}\n`;
}
