import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '../ledger/ledger-store.js';
import { Applier } from './applier.js';
import { DeferredError, DestinationExistsError } from './apply.errors.js';
import type { Proposal } from './proposal.types.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('Applier', () => {
  let dir = '';
  let ledger: LedgerStore;
  let applier: Applier;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asm-apply-'));
    ledger = new LedgerStore(join(dir, 'lifecycle.jsonl'));
    applier = new Applier(ledger);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const pagePath = (): string => join(dir, 'plan.md');
  const markDone = (text: string): Proposal => ({
    id: 'p_1', run_id: 'r1', class: 'page.mark_done', summary: 'plan shipped', created_at: 't', status: 'pending',
    op: { op: 'mark_done', target: { kind: 'page', id: 'vault:plan-a' }, reason: 'shipped', evidence: ['memory:x'] },
    file_edit: { kind: 'frontmatter', path: pagePath(), sha256: sha(text), fields: { status: 'done', done_at: '2026-09-29' } },
  });

  it('writes the ledger operation with the old text and then edits the page', async () => {
    const text = '---\nid: plan-a\nstatus: planning\n---\nbody\n';
    writeFileSync(pagePath(), text);
    const op = await applier.apply(markDone(text), 'approved');
    expect(readFileSync(pagePath(), 'utf8')).toContain('status: done');
    expect(op.before).toMatchObject({ path: pagePath(), sha256: sha(text), text });
    expect(op.after?.sha256).toBe(sha(readFileSync(pagePath(), 'utf8')));
    expect((await ledger.load()).map((item) => item.mode)).toEqual(['approved']);
  });

  it('defers a page a live session edited since the proposal, and writes nothing', async () => {
    const text = '---\nid: plan-a\nstatus: planning\n---\nbody\n';
    writeFileSync(pagePath(), `${text}an edit from a live session\n`);
    await expect(applier.apply(markDone(text), 'approved')).rejects.toBeInstanceOf(DeferredError);
    expect(await ledger.load()).toEqual([]);
  });

  it('moves a file into the archive and can restore it', async () => {
    const file = join(dir, 'mem', 'old.md');
    mkdirSync(join(dir, 'mem'));
    writeFileSync(file, 'stale fact\n');
    const archived = join(dir, 'archive', 'memory', 'old.md');
    const op = await applier.apply({
      id: 'p_2', run_id: 'r1', class: 'hygiene.archive', summary: 'backup copy', created_at: 't', status: 'pending',
      op: { op: 'retire', target: { kind: 'memory_file', id: 'mem:old.md' }, reason: 'an index backup copy' },
      file_edit: { kind: 'archive_move', path: file, sha256: sha('stale fact\n'), archive_to: archived },
    }, 'auto');
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(archived, 'utf8')).toBe('stale fact\n');
    await applier.restore(op.id, 'owner asked');
    expect(readFileSync(file, 'utf8')).toBe('stale fact\n');
    expect((await ledger.load()).map((item) => item.op)).toEqual(['retire', 'restore']);
  });

  it('never replaces a file: not at the archive, and not at the origin when restoring', async () => {
    const file = join(dir, 'mem', 'old.md');
    const archived = join(dir, 'archive', 'memory', 'old.md');
    mkdirSync(join(dir, 'mem'));
    mkdirSync(join(dir, 'archive', 'memory'), { recursive: true });
    writeFileSync(file, 'stale fact\n');
    writeFileSync(archived, 'an earlier archived copy\n');
    const proposal: Proposal = {
      id: 'p_4', run_id: 'r1', class: 'hygiene.archive', summary: 'backup copy', created_at: 't', status: 'pending',
      op: { op: 'retire', target: { kind: 'memory_file', id: 'mem:old.md' }, reason: 'an index backup copy' },
      file_edit: { kind: 'archive_move', path: file, sha256: sha('stale fact\n'), archive_to: archived },
    };
    await expect(applier.apply(proposal, 'auto')).rejects.toBeInstanceOf(DestinationExistsError);
    expect(readFileSync(archived, 'utf8')).toBe('an earlier archived copy\n');
    expect(readFileSync(file, 'utf8')).toBe('stale fact\n');
    expect(await ledger.load()).toEqual([]);
    rmSync(archived);
    const op = await applier.apply(proposal, 'auto');
    writeFileSync(file, 'a new file at the old path\n');
    await expect(applier.restore(op.id, 'owner asked')).rejects.toBeInstanceOf(DestinationExistsError);
    expect(readFileSync(file, 'utf8')).toBe('a new file at the old path\n');
    expect(readFileSync(archived, 'utf8')).toBe('stale fact\n');
  });

  it('writes a companion file with its own operation, and defers both when either file changed', async () => {
    const index = join(dir, 'MEMORY.md');
    const notes = join(dir, 'notes.md');
    writeFileSync(index, '- [N](notes.md) — 27/09: a; 28/09: b\n');
    writeFileSync(notes, 'Notes.\n');
    const proposal: Proposal = {
      id: 'p_3', run_id: 'r1', class: 'index.rewrite', summary: 'one line of current state', created_at: 't', status: 'pending',
      op: { op: 'compact', target: { kind: 'memory_file', id: 'mem:MEMORY.md' }, reason: 'accreted line' },
      file_edit: { kind: 'replace', path: index, sha256: sha('- [N](notes.md) — 27/09: a; 28/09: b\n'), after_text: '- [N](notes.md) — b\n' },
      companions: [{
        op: { op: 'compact', target: { kind: 'memory_file', id: 'mem:notes.md' }, reason: 'dated segments moved from the index line' },
        file_edit: { kind: 'replace', path: notes, sha256: sha('Notes.\n'), after_text: 'Notes.\n\n## History\n\n- 27/09: a; 28/09: b\n' },
      }],
    };
    writeFileSync(notes, 'Notes.\nedited by a live session\n');
    await expect(applier.apply(proposal, 'approved')).rejects.toBeInstanceOf(DeferredError);
    expect(readFileSync(index, 'utf8')).toContain('27/09');
    expect(await ledger.load()).toEqual([]);
    writeFileSync(notes, 'Notes.\n');
    await applier.apply(proposal, 'approved');
    expect(readFileSync(index, 'utf8')).toBe('- [N](notes.md) — b\n');
    expect(readFileSync(notes, 'utf8')).toContain('- 27/09: a; 28/09: b');
    expect((await ledger.load()).map((item) => [item.target.id, item.class, item.before?.path])).toEqual([
      ['mem:MEMORY.md', 'index.rewrite', index], ['mem:notes.md', 'index.rewrite', notes],
    ]);
  });
});
