import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MemoryRecord } from './store.types.js';

const list = z.array(z.unknown()).catch([]).transform((values) => values.map(String));

const recordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().catch(''),
  created_at: z.string().catch(''),
  agent: z.string().catch(''),
  summary: z.string().catch(''),
  details: z.string().catch(''),
  files: list.default([]),
  decisions: list.default([]),
  open_threads: list.default([]),
  supersedes: list.optional(),
});

/** Reads ~/.asm/memory.jsonl, the raw tier. A broken line is skipped, never fatal. */
export class MemoryStore {
  constructor(readonly path: string) {}

  async load(): Promise<MemoryRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const records: MemoryRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = recordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch {
        continue;
      }
    }
    return records;
  }
}
