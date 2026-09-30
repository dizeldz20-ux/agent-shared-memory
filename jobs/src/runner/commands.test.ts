import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../apply/files.js';
import type { Proposal } from '../apply/proposal.types.js';
import { apply, reject, restore, review, show } from './commands.js';
import { compose } from './compose.js';

describe('review commands', () => {
  let home = '';
  let page = '';
  const text = '---\nid: plan-a\nstatus: planning\n---\nbody\n';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'asm-commands-'));
    mkdirSync(join(home, 'jobs'), { recursive: true });
    mkdirSync(join(home, 'vault', 'wiki', 'main'), { recursive: true });
    page = join(home, 'vault', 'wiki', 'main', 'plan-a.md');
    writeFileSync(page, text);
    writeFileSync(join(home, 'asm-paths.json'), JSON.stringify({ vault: join(home, 'vault'), repo: '' }));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const proposals = (): Proposal[] => [
    { id: 'p_thread', run_id: 'r1', class: 'thread.close.resolved', summary: 's', created_at: 't', status: 'pending',
      op: { op: 'close_thread', target: { kind: 'thread', id: 'a000000000000001#0' }, reason: 'r' } },
    { id: 'p_page', run_id: 'r1', class: 'page.mark_done', summary: 's', created_at: 't', status: 'pending',
      op: { op: 'mark_done', target: { kind: 'page', id: 'vault:plan-a' }, reason: 'shipped', evidence: ['memory:x'] },
      file_edit: { kind: 'frontmatter', path: page, sha256: sha256(text), fields: { status: 'done' } } },
  ];

  it('applies a class, counts a clean approval, rejects the rest, and restores exactly', async () => {
    const c = await compose(home);
    await c.proposals.save('r1', proposals());
    const { results: applied, promoted } = (await apply(c, ['class:page.mark_done'])) as { results: { ok: boolean; detail: string }[]; promoted: string[] };
    expect(applied).toEqual([{ id: 'p_page', ok: true, detail: expect.stringMatching(/^lc_/) }]);
    expect(promoted).toEqual([]);
    expect(readFileSync(page, 'utf8')).toContain('status: done');
    await reject(c, ['all']);
    expect(await c.proposals.pending()).toEqual([]);
    const trust = JSON.parse(readFileSync(join(home, 'jobs', 'trust.json'), 'utf8'));
    expect(trust.classes['page.mark_done'].approved_runs).toBe(1);
    expect(trust.classes['thread.close.resolved'].approved_runs).toBe(0);
    await restore(c, applied[0]?.detail ?? '', 'checking the restore');
    expect(readFileSync(page, 'utf8')).toBe(text);
  });

  it('shows the lines a proposal removes and adds, in its file and its companions', async () => {
    const c = await compose(home);
    const notes = join(home, 'notes.md');
    writeFileSync(notes, 'a\nb\nc\n');
    await c.proposals.save('r3', [{ id: 'p_show', run_id: 'r3', class: 'index.rewrite', summary: 'one line of current state', created_at: 't', status: 'pending',
      op: { op: 'compact', target: { kind: 'page', id: 'vault:plan-a' }, reason: 'accreted', evidence: ['memory:x'] },
      file_edit: { kind: 'replace', path: page, sha256: sha256(text), after_text: text.replace('body', 'new body') },
      companions: [{ op: { op: 'compact', target: { kind: 'memory_file', id: 'mem:notes.md' }, reason: 'moved' },
        file_edit: { kind: 'replace', path: notes, sha256: 'stale', after_text: 'a\nB\nc\n' } }] }]);
    expect(await show(c, 'p_show')).toEqual({
      id: 'p_show', class: 'index.rewrite', summary: 'one line of current state', reason: 'accreted', evidence: ['memory:x'],
      files: [
        { path: page, changed_since: false, removed: ['body'], added: ['new body'] },
        { path: notes, changed_since: true, removed: ['b'], added: ['B'] },
      ],
    });
    expect(await show(c, 'p_none')).toEqual({ error: 'no pending proposal p_none' });
  });

  it('marks a proposal whose file changed as deferred, so the next run rebuilds it instead of retrying it forever', async () => {
    const c = await compose(home);
    await c.proposals.save('r1', proposals());
    writeFileSync(page, `${text}an edit from a live session\n`);
    const { results } = (await apply(c, ['p_page'])) as { results: { ok: boolean }[] };
    expect(results).toEqual([expect.objectContaining({ ok: false })]);
    expect((await c.proposals.pending()).map((p) => p.id)).toEqual(['p_thread']);
    expect((await c.proposals.run('r1')).find((p) => p.id === 'p_page')?.status).toBe('deferred');
  });

  it('shows only the lines that changed, however far apart', async () => {
    const c = await compose(home);
    const long = join(home, 'long.md');
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    writeFileSync(long, `${lines.join('\n')}\n`);
    const after = lines.map((line, i) => (i === 2 || i === 40 ? line.toUpperCase() : line)).join('\n');
    await c.proposals.save('r4', [{ id: 'p_far', run_id: 'r4', class: 'memfile.compact', summary: 's', created_at: 't', status: 'pending',
      op: { op: 'compact', target: { kind: 'memory_file', id: 'mem:long.md' }, reason: 'r' },
      file_edit: { kind: 'replace', path: long, sha256: sha256(readFileSync(long, 'utf8')), after_text: `${after}\n` } }]);
    expect(await show(c, 'p_far')).toMatchObject({ files: [{ removed: ['line 2', 'line 40'], added: ['LINE 2', 'LINE 40'] }] });
  });

  it('does not count a run the owner partly rejected as a clean review', async () => {
    const c = await compose(home);
    const other = join(home, 'vault', 'wiki', 'main', 'plan-b.md');
    writeFileSync(other, text.replace('plan-a', 'plan-b'));
    const done = (id: string, path: string, body: string): Proposal => ({ id, run_id: 'r5', class: 'page.mark_done', summary: 's', created_at: 't',
      status: 'pending', op: { op: 'mark_done', target: { kind: 'page', id: `vault:${id}` }, reason: 'shipped', evidence: ['memory:x'] },
      file_edit: { kind: 'frontmatter', path, sha256: sha256(body), fields: { status: 'done' } } });
    await c.proposals.save('r5', [done('p_one', page, text), done('p_two', other, text.replace('plan-a', 'plan-b'))]);
    await reject(c, ['p_one']);
    await apply(c, ['p_two']);
    expect(JSON.parse(readFileSync(join(home, 'jobs', 'trust.json'), 'utf8')).classes['page.mark_done'].approved_runs).toBe(0);
  });

  it('lists quarantined items in the review', async () => {
    writeFileSync(join(home, 'jobs', 'items.json'), JSON.stringify({ 'a000000000000001#0': {
      last_checked_at: '2026-09-29T10:00:00Z', verdict: '', evidence_key: 'k', failures: 3, quarantined: true } }));
    const groups = (await review(await compose(home))) as { class: string; count: number; items: { id: string }[] }[];
    expect(groups.find((g) => g.class === 'quarantined')).toMatchObject({ count: 1, items: [{ id: 'a000000000000001#0' }] });
  });

  it('closes a correction request the owner rejected, so it is not proposed again', async () => {
    const c = await compose(home);
    const request = await c.ledger.append({
      op: 'correct', mode: 'requested', target: { kind: 'page', id: 'vault:plan-a' }, claimed: 'body', truth: 'new body',
      reason: 'correction requested by memory:a000000000000001', actor: { kind: 'agent', name: 't' },
    });
    await c.proposals.save('r2', [{ id: 'p_fix', run_id: 'r2', class: 'correction.apply', summary: 's', created_at: 't', status: 'pending',
      op: { op: 'correct', target: request.target, applies: request.id, claimed: 'body', truth: 'new body', reason: `apply ${request.id}` } }]);
    await reject(c, ['all']);
    const { fold } = await import('../ledger/fold.js');
    expect(fold(await c.ledger.load()).requested.size).toBe(0);
    expect((await c.ledger.load()).at(-1)).toMatchObject({ op: 'correct', mode: 'rejected', applies: request.id, actor: { kind: 'owner', name: 'owner' } });
  });
});
