import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opId } from './canonical.js';
import { InvalidLedgerOpError } from './ledger.errors.js';
import { LedgerStore } from './ledger-store.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/lifecycle.json', import.meta.url), 'utf8'),
) as { ops: Record<string, unknown>[]; first_op_canonical_id: string };

describe('LedgerStore', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-ledger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('computes the same operation id as lifecycle.py', () => {
    const { id: _ignored, ...first } = fixture.ops[0] ?? {};
    expect(opId(first)).toBe(fixture.first_op_canonical_id);
  });

  it('appends an operation and reads it back', async () => {
    const store = new LedgerStore(join(dir, 'lifecycle.jsonl'));
    const written = await store.append({
      op: 'close_thread', target: { kind: 'thread', id: 'a000000000000001#0' },
      reason: 'answered by a later record', mode: 'auto', actor: { kind: 'janitor', name: 'janitor' },
    });
    expect(written.id).toMatch(/^lc_[0-9a-f]{16}$/);
    const loaded = await store.load();
    expect(loaded.map((op) => op.id)).toEqual([written.id]);
  });

  it('rejects an operation without a reason', async () => {
    const store = new LedgerStore(join(dir, 'lifecycle.jsonl'));
    await expect(store.append({ op: 'retire', target: { kind: 'record', id: 'a000000000000001' }, reason: '  ' }))
      .rejects.toBeInstanceOf(InvalidLedgerOpError);
  });

  it('reads a missing ledger as empty', async () => {
    expect(await new LedgerStore(join(dir, 'absent.jsonl')).load()).toEqual([]);
  });
});
