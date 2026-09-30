import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProposalStore } from './proposal-store.js';
import type { Proposal } from './proposal.types.js';

const proposal = (id: string, cls: string): Proposal => ({
  id, run_id: 'r1', class: cls, summary: id, created_at: '2026-09-29T10:00:00Z', status: 'pending',
  op: { op: 'close_thread', target: { kind: 'thread', id: `x#${id}` }, reason: 'r' },
});

describe('ProposalStore', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-proposals-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('saves a run, lists what is pending, and records decisions', async () => {
    const store = new ProposalStore(dir);
    await store.save('r1', [proposal('a', 'thread.close.resolved'), proposal('b', 'page.mark_done')]);
    expect((await store.pending()).map((p) => p.id)).toEqual(['a', 'b']);
    await store.decide('r1', ['a'], 'applied');
    await store.decide('r1', ['b'], 'rejected');
    expect(await store.pending()).toEqual([]);
    expect((await store.run('r1')).map((p) => [p.id, p.status])).toEqual([['a', 'applied'], ['b', 'rejected']]);
  });

  it('keeps what an earlier job of the same run saved: the janitor and the curator share a run id', async () => {
    const store = new ProposalStore(dir);
    await store.save('r1', [proposal('a', 'thread.close.resolved')]);
    await store.save('r1', [proposal('b', 'block.refresh')]);
    await store.save('r1', [{ ...proposal('b', 'block.refresh'), summary: 'rebuilt' }]);
    expect((await store.run('r1')).map((p) => [p.id, p.summary])).toEqual([['a', 'a'], ['b', 'rebuilt']]);
  });
});
