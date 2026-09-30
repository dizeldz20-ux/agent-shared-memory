import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fold } from './fold.js';
import { parseLedgerOp } from './ledger.schema.js';
import type { LedgerOp, MemoryRecordLike } from './ledger.types.js';

interface Fixture {
  readonly records: readonly MemoryRecordLike[];
  readonly ops: readonly unknown[];
  readonly expected: { readonly states: Record<string, string>; readonly open_threads: string[]; readonly requested: string[] };
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/lifecycle.json', import.meta.url), 'utf8'),
) as Fixture;

describe('fold', () => {
  it('matches the fixture shared with lifecycle.py and hook/asm-lifecycle.js', () => {
    const ops = fixture.ops.map(parseLedgerOp).filter((op): op is LedgerOp => op !== undefined);
    const life = fold(ops, fixture.records);
    const states = Object.fromEntries([...life.states].map(([key, value]) => [key, value.state]));
    expect({
      states,
      open_threads: life.openThreads(fixture.records),
      requested: [...life.requested.keys()].sort(),
    }).toEqual(fixture.expected);
  });

  it('treats a done page as visible and a retired record as hiding its threads', () => {
    const ops = fixture.ops.map(parseLedgerOp).filter((op): op is LedgerOp => op !== undefined);
    const life = fold(ops, fixture.records);
    expect(life.hidden('page', 'vault:plan-a')).toBe(false);
    expect(life.threadOpen('a000000000000004', 0)).toBe(false);
    expect(life.threadOpen('a000000000000001', 1)).toBe(true);
  });
});
