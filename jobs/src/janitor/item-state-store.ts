import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const entrySchema = z.object({
  last_checked_at: z.string().catch(''),
  verdict: z.string().catch(''),
  evidence_key: z.string().catch(''),
  failures: z.number().catch(0),
  quarantined: z.boolean().catch(false),
});
export type ItemState = z.infer<typeof entrySchema>;

/** Per-item processing state (~/.asm/jobs/items.json): what was judged, on which evidence, how often it failed. */
export class ItemStateStore {
  constructor(readonly path: string) {}

  async load(): Promise<Map<string, ItemState>> {
    try {
      const parsed = z.record(entrySchema).parse(JSON.parse(await readFile(this.path, 'utf8')));
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }

  async save(states: ReadonlyMap<string, ItemState>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(Object.fromEntries(states), null, 2)}\n`, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.path);
  }
}
