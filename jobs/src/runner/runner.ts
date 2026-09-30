import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobStateStore } from './job-state-store.js';
import type { RunLock } from './lock.js';

export type JobFn = () => Promise<unknown>;
export type RunSummary = Record<string, { ok: boolean; result?: unknown; error?: string }> | { skipped: string };

/** A job's result names why a run that finished did not do its work (every call failed, the model stopped). */
const degradedOf = (result: unknown): string | undefined =>
  typeof result === 'object' && result !== null && 'degraded' in result && typeof result.degraded === 'string'
    ? result.degraded : undefined;

/**
 * Runs the named jobs under the lock; every outcome — success, degraded run or error text — reaches
 * state.json, except in a dry run (`record` false), which must not look like a run to the scheduler.
 */
export class Runner {
  constructor(
    private readonly lock: RunLock,
    private readonly state: JobStateStore,
    private readonly runsDir: string,
    private readonly jobs: Readonly<Record<string, JobFn>>,
    private readonly record = true,
  ) {}

  async run(names: readonly string[], runId: string): Promise<RunSummary> {
    if (!(await this.lock.acquire())) return { skipped: 'another runner holds the lock' };
    const summary: Record<string, { ok: boolean; result?: unknown; error?: string }> = {};
    try {
      for (const name of names) {
        const job = this.jobs[name];
        if (job === undefined) continue;
        try {
          const result = await job();
          const degraded = degradedOf(result);
          summary[name] = degraded === undefined ? { ok: true, result } : { ok: false, result, error: degraded };
          if (this.record && degraded === undefined) await this.state.success(name, runId, result);
          if (this.record && degraded !== undefined) await this.state.failure(name, runId, degraded);
        } catch (error: unknown) {
          const text = error instanceof Error ? error.message : String(error);
          summary[name] = { ok: false, error: text };
          if (this.record) await this.state.failure(name, runId, text);
        }
      }
      await mkdir(this.runsDir, { recursive: true });
      await writeFile(join(this.runsDir, `${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      return summary;
    } finally {
      await this.lock.release();
    }
  }
}
