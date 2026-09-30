import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../store/store.types.js';
import { evidencePack } from './evidence.js';
import type { ThreadCandidate } from './janitor.types.js';

const record = (id: string, created_at: string, fields: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, session_id: 'other', created_at, agent: 't', summary: 'unrelated', details: '', files: [], decisions: [], open_threads: [], ...fields,
});

describe('evidencePack', () => {
  const origin = record('b000000000000001', '2026-09-20T10:00:00+03:00', {
    session_id: 's1', files: ['/work/src/importer.ts'], open_threads: ['deploy commit 3fa9c21 after approval'],
  });
  const candidate: ThreadCandidate = { kind: 'thread', id: 'b000000000000001#0', text: 'deploy commit 3fa9c21 after approval', record: origin, index: 0 };
  const records = [
    origin,
    record('b000000000000002', '2026-09-19T10:00:00+03:00', { session_id: 's1', summary: 'earlier, same session' }),
    record('b000000000000003', '2026-09-21T10:00:00+03:00', { summary: 'Deployed 3fa9c21 to the host' }),
    record('b000000000000004', '2026-09-22T10:00:00+03:00', { files: ['/work/src/importer.ts'], summary: 'Touched the importer' }),
    record('b000000000000005', '2026-09-23T10:00:00+03:00', { summary: 'Nothing in common' }),
    record('b000000000000006', '2026-09-24T10:00:00+03:00', { session_id: 's1', summary: 'Later in the same session' }),
  ];

  it('keeps later related records, strongest first, and never the candidate itself', () => {
    const ids = evidencePack(candidate, records).map((item) => item.id);
    expect(ids).toEqual(['memory:b000000000000006', 'memory:b000000000000003', 'memory:b000000000000004']);
  });

  it('carries a details preview and every thread still open, not only the first three', () => {
    const later = record('b000000000000007', '2026-09-25T10:00:00+03:00', { session_id: 's1', summary: 'Worked on it',
      details: `The approval came in on Monday. ${'x'.repeat(400)}`, open_threads: ['one', 'two', 'three', 'four', 'five'] });
    const item = evidencePack(candidate, [origin, later])[0];
    expect(item?.details.startsWith('The approval came in on Monday.')).toBe(true);
    expect(item?.details.length).toBeLessThanOrEqual(300);
    expect(item?.threads).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('does not take a record that shares only one generic task tag', () => {
    const tagged: ThreadCandidate = { ...candidate, text: 'finish the V3 rollout', record: { ...origin, session_id: 'solo', files: [] } };
    const pack = evidencePack(tagged, [origin, record('b000000000000008', '2026-09-26T10:00:00+03:00', { summary: 'V3 of another product shipped' })]);
    expect(pack).toEqual([]);
  });

  it('caps the pack', () => {
    expect(evidencePack(candidate, records, 1)).toHaveLength(1);
  });
});
