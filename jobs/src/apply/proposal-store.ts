import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Proposal, ProposalStatus } from './proposal.types.js';

const runSchema = z.object({ run_id: z.string(), created_at: z.string(), proposals: z.array(z.unknown()) });

/** Proposals waiting for the owner, one file per run under ~/.asm/jobs/proposals/. */
export class ProposalStore {
  constructor(readonly dir: string) {}

  /** Add proposals to a run's file: the janitor and the curator of one run save into the same file. */
  async save(runId: string, proposals: readonly Proposal[]): Promise<void> {
    if (proposals.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const incoming = new Set(proposals.map((p) => p.id));
    const merged = [...(await this.run(runId)).filter((p) => !incoming.has(p.id)), ...proposals];
    const body = { run_id: runId, created_at: new Date().toISOString(), proposals: merged };
    await writeFile(this.file(runId), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  async run(runId: string): Promise<Proposal[]> {
    try {
      const parsed = runSchema.parse(JSON.parse(await readFile(this.file(runId), 'utf8')));
      return parsed.proposals as Proposal[];
    } catch {
      return [];
    }
  }

  async pending(): Promise<Proposal[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: Proposal[] = [];
    for (const name of names) out.push(...(await this.run(name.slice(0, -5))).filter((p) => p.status === 'pending'));
    return out;
  }

  async decide(runId: string, ids: readonly string[], status: ProposalStatus): Promise<void> {
    const wanted = new Set(ids);
    const decided_at = new Date().toISOString();
    const next = (await this.run(runId)).map((p) => (wanted.has(p.id) ? { ...p, status, decided_at } : p));
    const body = { run_id: runId, created_at: decided_at, proposals: next };
    await writeFile(this.file(runId), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  private file(runId: string): string {
    return join(this.dir, `${runId.replace(/[^\w.-]/g, '')}.json`);
  }
}
