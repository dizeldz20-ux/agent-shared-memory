import type { Lifecycle } from '../ledger/lifecycle.js';
import { normalizeStatus } from '../store/status.js';
import type { MemoryRecord, VaultPage } from '../store/store.types.js';
import type { PageCandidate, RecordCandidate, ThreadCandidate } from './janitor.types.js';
import { isNegativeStatus } from './status-phrases.js';

// Statuses that describe work still to be done; a plan page carrying one is checked against
// later evidence. `active`, `paused` and `research` are states, not promises of work.
const PLAN_LIKE = /plan|round/i;
const OPEN_PLAN_STATUSES = new Set([
  'proposed', 'planning', 'planned', 'open', 'candidate', 'ready-for-review', 'needs-review',
  'discovery', 'pending', 'draft', 'in-progress', 'awaiting-approval',
]);
const DAILY = /^daily-\d{4}-\d{2}-\d{2}$/;

const since = (record: MemoryRecord, from: Date): boolean => {
  const at = Date.parse(record.created_at);
  return Number.isFinite(at) && at >= from.getTime();
};

export function openThreads(records: readonly MemoryRecord[], life: Lifecycle, from: Date): ThreadCandidate[] {
  const out: ThreadCandidate[] = [];
  for (const record of records) {
    if (!since(record, from) || life.hidden('record', record.id)) continue;
    record.open_threads.forEach((text, index) => {
      if (life.threadOpen(record.id, index)) out.push({ kind: 'thread', id: `${record.id}#${index}`, text, record, index });
    });
  }
  return out;
}

/**
 * Status records a later record may have overtaken. A record with an open thread is not one: retiring
 * it would hide the thread too, and nothing judged the thread (silence is not evidence). It becomes a
 * candidate once its threads are closed.
 */
export function statusSnapshots(records: readonly MemoryRecord[], life: Lifecycle, from: Date): RecordCandidate[] {
  return records
    .filter((record) => since(record, from) && !life.hidden('record', record.id) && isNegativeStatus(record.summary)
      && life.openThreads([record]).length === 0)
    .map((record) => ({ kind: 'record', id: record.id, text: record.summary, record }));
}

export function planPages(
  pages: readonly VaultPage[],
  life: Lifecycle,
  excluded: (page: VaultPage) => boolean,
): PageCandidate[] {
  const out: PageCandidate[] = [];
  for (const page of pages) {
    const id = `vault:${page.id}`;
    const status = normalizeStatus(page.status);
    if (excluded(page) || DAILY.test(page.id) || life.state('page', id) !== undefined) continue;
    if (status === 'done' || status === 'retired') continue;
    // A status phrase in the body marks a plan only on a plan page: gotchas, runbooks and concepts
    // quote "not deployed" as knowledge, not as work still to do.
    if (OPEN_PLAN_STATUSES.has(status) || (PLAN_LIKE.test(`${page.type} ${page.rel.split('/').pop() ?? ''}`) && isNegativeStatus(page.head))) {
      out.push({ kind: 'page', id, text: `${page.title} — status: ${page.status || '(none)'}\n${page.head.slice(0, 600)}`, page });
    }
  }
  return out;
}
