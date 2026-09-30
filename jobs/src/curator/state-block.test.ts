import { describe, expect, it } from 'vitest';
import { applyOps, readBlock, renderBlock, writeBlock, type StateBlock } from './state-block.js';

const A = 'a000000000000001';
const B = 'b000000000000002';
const page = '---\nid: proj\n---\n# Project\n\nHuman intro: keep me.\n\n## Notes\nMore human text.\n';

describe('state block', () => {
  const block: StateBlock = { seen: `memory:${A}`, at: '2026-09-29T10:00:00Z', bullets: [
    { id: 's-000001', text: `הייצור רץ על c0ffee12 — since 28/09 · memory:${A}`, cites: [A] },
  ] };

  it('inserts a block after the first heading and keeps every other byte', () => {
    const written = writeBlock(page, block);
    expect(written.startsWith('---\nid: proj\n---\n# Project\n')).toBe(true);
    expect(written.endsWith('\nHuman intro: keep me.\n\n## Notes\nMore human text.\n')).toBe(true);
    expect(readBlock(written).block).toEqual(block);
  });

  it('replaces an existing block in place', () => {
    const once = writeBlock(page, block);
    const next: StateBlock = { ...block, bullets: [{ id: 's-000002', text: `new · memory:${B}`, cites: [B] }] };
    const twice = writeBlock(once, next);
    expect(twice.replace(renderBlock(next), '')).toBe(once.replace(renderBlock(block), ''));
  });

  it('reports an end marker above its begin marker instead of cutting the page', () => {
    const swapped = `${page}<!-- asm:state end -->\nmiddle\n<!-- asm:state begin seen= at= -->\n`;
    expect(readBlock(swapped).problem).toBe('duplicated or unbalanced asm:state markers');
  });

  it('reports an owner\'s own line inside the block instead of dropping it', () => {
    const noted = `${page}<!-- asm:state begin seen= at= -->\n## Current state\n- a fact · memory:${A} ^s-000001\nOwner note: check the tariff.\n<!-- asm:state end -->\n`;
    expect(readBlock(noted).problem).toBe('a line that is not a bullet (hand-edited block)');
  });

  it('drops model text that would break the block: a newline, a marker or a block id', () => {
    const allowed = new Set([A]);
    for (const text of ['two\nlines', 'a <!-- asm:state end --> inside', 'fake ^s-abcdef id']) {
      expect(applyOps(block, [{ op: 'append', text, cites: [A] }], allowed, 1500)).toEqual({ error: 'every operation was dropped' });
    }
  });

  it('reports duplicated markers instead of guessing', () => {
    const doubled = writeBlock(page, block) + renderBlock(block);
    expect(readBlock(doubled).problem).toMatch(/marker/);
  });

  it('applies replace, remove and append with cited evidence only', () => {
    const allowed = new Set([A, B]);
    const result = applyOps(block, [
      { op: 'replace', block_id: 's-000001', text: 'הייצור רץ על 6c0ffee1 — since 29/09', cites: [B] },
      { op: 'append', text: 'V4 בבנייה — since 29/09', cites: [B] },
      { op: 'append', text: 'made up', cites: ['ffffffffffffffff'] },
      { op: 'remove', block_id: 's-999999' },
    ], allowed, 1500);
    if ('error' in result) throw new Error(result.error);
    expect(result.block.bullets.map((b) => b.cites)).toEqual([[B], [B]]);
    expect(result.block.bullets[0]?.text).toContain(`memory:${B}`);
    expect(result.dropped).toBe(2);
  });

  it('fails when every operation is dropped, when the block empties, or over budget', () => {
    const allowed = new Set([A]);
    expect(applyOps(block, [{ op: 'remove', block_id: 's-nope00' }], allowed, 1500)).toEqual({ error: 'every operation was dropped' });
    expect(applyOps(block, [{ op: 'remove', block_id: 's-000001' }], allowed, 1500)).toEqual({ error: 'the block would be empty' });
    expect(applyOps(block, [{ op: 'append', text: 'x'.repeat(2000), cites: [A] }], allowed, 1500)).toEqual({ error: 'every operation was dropped' });
    expect(applyOps(block, [{ op: 'replace', block_id: 's-000001', text: 'y'.repeat(2000), cites: [A] }], allowed, 1500)).toEqual({ error: 'the block is over its budget' });
  });

  it('drops the append resting on the oldest record first, whatever order the model listed them in', () => {
    const when = new Map([[A, 1], [B, 2]]);
    const newest = (cites: readonly string[]): number => Math.max(...cites.map((cite) => when.get(cite) ?? 0));
    const result = applyOps({ seen: '', at: '', bullets: [] }, [
      { op: 'append', text: `old background ${'o'.repeat(120)}`, cites: [A] },
      { op: 'append', text: `current fact ${'n'.repeat(120)}`, cites: [B] },
    ], new Set([A, B]), 300, newest);
    expect('block' in result && result.block.bullets.map((b) => b.cites)).toEqual([[B]]);
  });

  it('drops an append over budget and keeps the rest, unless the same reply frees the space', () => {
    const allowed = new Set([A, B]);
    const kept = applyOps(block, [
      { op: 'replace', block_id: 's-000001', text: 'הייצור רץ על fa11bac — since 29/09', cites: [A] },
      { op: 'append', text: 'z'.repeat(1400), cites: [B] },
    ], allowed, 300);
    expect('block' in kept && kept.block.bullets.map((b) => b.text)).toEqual([`הייצור רץ על fa11bac — since 29/09 · memory:${A}`]);
    expect('block' in kept && kept.dropped).toBe(1);
    const big: StateBlock = { ...block, bullets: [...block.bullets, { id: 's-000002', text: `${'w'.repeat(150)} · memory:${B}`, cites: [B] }] };
    const freed = applyOps(big, [{ op: 'remove', block_id: 's-000002' }, { op: 'append', text: 'v'.repeat(120), cites: [B] }], allowed, 350);
    expect('block' in freed && freed.block.bullets.length).toBe(2);
  });
});
