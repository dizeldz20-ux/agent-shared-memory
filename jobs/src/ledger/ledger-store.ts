import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { opId } from './canonical.js';
import { InvalidLedgerOpError } from './ledger.errors.js';
import { invalidFields, parseLedgerOp } from './ledger.schema.js';
import type { LedgerOp, NewLedgerOp } from './ledger.types.js';

/** Reads and appends ~/.asm/lifecycle.jsonl, the same file lifecycle.py writes. */
export class LedgerStore {
  constructor(readonly path: string) {}

  async load(): Promise<LedgerOp[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const ops: LedgerOp[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue; // one bad line is not fatal, as in the other two readers
      }
      const op = parseLedgerOp(value);
      if (op !== undefined) ops.push(op);
    }
    return ops;
  }

  /** Validate, stamp and append one operation: O_APPEND and fsync, like memory.jsonl. */
  async append(op: NewLedgerOp): Promise<LedgerOp> {
    const body: Record<string, unknown> = { ...op, ts: op.ts ?? new Date().toISOString() };
    const invalid = invalidFields(body);
    if (invalid.length > 0) throw new InvalidLedgerOpError(invalid);
    const stamped = { ...body, id: opId(body) } as unknown as LedgerOp;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(stamped)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return stamped;
  }
}
