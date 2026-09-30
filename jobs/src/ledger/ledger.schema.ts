import { z } from 'zod';
import { OP_KINDS, TARGET_KINDS, type LedgerOp } from './ledger.types.js';

// Boundary validation of a ledger line: the same rules as lifecycle.validate. Unknown
// fields pass through untouched, so a newer writer's extra fields survive a read.
const nonBlank = z.string().refine((value) => value.trim().length > 0, 'blank');

export const ledgerOpSchema = z
  .object({
    id: z.string().startsWith('lc_'),
    ts: z.string().optional(),
    op: z.enum(OP_KINDS),
    target: z.object({ kind: z.enum(TARGET_KINDS), id: nonBlank }).passthrough(),
    reason: nonBlank,
    undoes: z.string().optional(),
    applies: z.string().optional(),
  })
  .passthrough()
  .refine((op) => op.op !== 'restore' || (op.undoes ?? '').startsWith('lc_'), { path: ['undoes'] });

/** A valid ledger operation, or undefined for a line every reader skips. */
export function parseLedgerOp(value: unknown): LedgerOp | undefined {
  const parsed = ledgerOpSchema.safeParse(value);
  return parsed.success ? (parsed.data as unknown as LedgerOp) : undefined;
}

/** The names of the invalid fields of a new operation, as lifecycle.validate reports them. */
export function invalidFields(value: Readonly<Record<string, unknown>>): string[] {
  const parsed = ledgerOpSchema.safeParse({ ...value, id: 'lc_pending' });
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'op')))];
}
