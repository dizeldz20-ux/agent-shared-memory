import { describe, expect, it } from 'vitest';
import { fold } from '../ledger/fold.js';
import type { LedgerOp } from '../ledger/ledger.types.js';
import type { MemoryRecord, VaultPage } from '../store/store.types.js';
import { openThreads, planPages, statusSnapshots } from './candidates.js';
import { duplicateThreads } from './prepass.js';

const record = (id: string, created_at: string, fields: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, session_id: 's', created_at, agent: 't', summary: 'work', details: '', files: [], decisions: [], open_threads: [], ...fields,
});
const page = (id: string, fields: Partial<VaultPage> = {}): VaultPage => ({
  id, path: `/v/${id}.md`, rel: `wiki/main/${id}.md`, title: id, status: '', updatedAt: '', type: '', description: '', size: 10, head: '', sha256: '', ...fields,
});
const close = (target: string): LedgerOp => ({ id: `lc_${target}`, op: 'close_thread', target: { kind: 'thread', id: target }, reason: 'r' });

describe('candidates', () => {
  const records = [
    record('a000000000000001', '2026-09-20T10:00:00+03:00', { open_threads: ['deploy the importer', 'add a retry test'] }),
    record('a000000000000002', '2026-08-01T10:00:00+03:00', { open_threads: ['too old'] }),
    record('a000000000000003', '2026-09-21T10:00:00+03:00', { summary: 'Importer built, not deployed' }),
    record('a000000000000004', '2026-09-22T10:00:00+03:00', { open_threads: ['deploy the importer'] }),
  ];
  const life = fold([close('a000000000000001#1')], records);
  const since = new Date('2026-09-01T00:00:00Z');

  it('lists open threads of recent live records only', () => {
    expect(openThreads(records, life, since).map((c) => c.id)).toEqual(['a000000000000001#0', 'a000000000000004#0']);
  });

  it('lists records whose summary is a negative status', () => {
    expect(statusSnapshots(records, life, since).map((c) => c.id)).toEqual(['a000000000000003']);
  });

  it('keeps the newest copy of a thread repeated verbatim', () => {
    const groups = duplicateThreads(openThreads(records, life, since));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.keep.id).toBe('a000000000000004#0');
    expect(groups[0]?.duplicates.map((c) => c.id)).toEqual(['a000000000000001#0']);
  });

  it('lists plan pages with an open status or a negative status line, skipping excluded ones', () => {
    const pages = [
      page('plan-a', { status: 'planning' }),
      page('plan-b', { head: 'Status: not pushed, not deployed — waiting on the owner' }),
      page('plan-c', { status: 'done — shipped' }),
      page('rules', { status: 'active' }),
      page('hub', { rel: 'wiki/main/syntheses/claude-memory-x.md', head: 'not deployed' }),
      page('daily-2026-09-01', { head: 'not deployed' }),
      page('gotcha-x', { type: 'gotcha', head: 'the build was not deployed, so the fix never ran' }),
      page('ship-importer', { type: 'feature-plan', head: 'not deployed yet' }),
    ];
    const ids = planPages(pages, fold([], []), (p) => p.rel.includes('claude-memory-')).map((c) => c.id);
    expect(ids).toEqual(['vault:plan-a', 'vault:plan-b', 'vault:ship-importer']);
  });
});
