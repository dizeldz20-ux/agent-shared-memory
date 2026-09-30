import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../store/store.types.js';
import { buildJudgeQueue } from './judge-queue.js';
import type { ThreadCandidate } from './janitor.types.js';

const record = (id: string, day: number, session: string, threads: string[] = []): MemoryRecord => ({
  id, session_id: session, created_at: `2026-09-${day}T10:00:00+03:00`, agent: 't', summary: `work ${id}`, details: '',
  files: [], decisions: [], open_threads: threads,
});

describe('buildJudgeQueue', () => {
  it('puts items never judged before items judged again on changed evidence, so the backlog drains', () => {
    const records = [record('c000000000000001', 10, 'old', ['old item']), record('c000000000000002', 11, 'old'),
      record('c000000000000003', 20, 'new', ['new item']), record('c000000000000004', 21, 'new')];
    const thread = (r: MemoryRecord): ThreadCandidate => ({ kind: 'thread', id: `${r.id}#0`, text: r.open_threads[0] ?? '', record: r, index: 0 });
    const newest = thread(records[2] as MemoryRecord);
    const oldest = thread(records[0] as MemoryRecord);
    const states = new Map([[newest.id, { last_checked_at: 't', verdict: 'unknown', evidence_key: 'an older pack', failures: 0, quarantined: false }]]);
    expect(buildJudgeQueue([newest, oldest], records, states).queue.map((q) => q.candidate.id)).toEqual([oldest.id, newest.id]);
  });
});
