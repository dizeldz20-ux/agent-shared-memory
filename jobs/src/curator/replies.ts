import { z } from 'zod';
import type { BlockOp } from './state-block.js';

// Models cite either the bare id or the `memory:<id>` form the pages show; both mean the same record.
const cites = z.array(z.string().transform((cite) => cite.trim().replace(/^memory:/, '')));
const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), block_id: z.string(), text: z.string(), cites }),
  z.object({ op: z.literal('remove'), block_id: z.string() }),
  z.object({ op: z.literal('append'), text: z.string(), cites }),
]);

function jsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export function parseOps(text: string): BlockOp[] | undefined {
  const parsed = z.object({ ops: z.array(opSchema) }).safeParse(jsonObject(text));
  return parsed.success ? parsed.data.ops : undefined;
}

export function parseLine(text: string): string | undefined {
  const parsed = z.object({ line: z.string().min(1) }).safeParse(jsonObject(text));
  return parsed.success ? parsed.data.line : undefined;
}

export function parseCurrentState(text: string): string | undefined {
  const parsed = z.object({ current_state: z.string().min(1) }).safeParse(jsonObject(text));
  return parsed.success ? parsed.data.current_state : undefined;
}
