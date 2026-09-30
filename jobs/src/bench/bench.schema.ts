import { z } from 'zod';
import type { BenchCases } from './bench.types.js';

const caseSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  topic: z.string().optional(),
  current_ids: z.array(z.string().min(1)).min(1),
  stale_ids: z.array(z.string().min(1)).min(1),
  evidence: z.string().optional(),
});

export const benchCasesSchema = z.object({ version: z.number(), cases: z.array(caseSchema).min(1) }).passthrough();

export function parseBenchCases(value: unknown): BenchCases {
  return benchCasesSchema.parse(value);
}
