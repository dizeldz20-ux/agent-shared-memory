import { join } from 'node:path';
import { compose, curatorFor, janitorFor, type Composed } from './compose.js';
import { JobStateStore } from './job-state-store.js';
import { refreshGraph } from './refresh-job.js';
import { Runner, type JobFn, type RunSummary } from './runner.js';

const JOBS = ['janitor', 'curator', 'refresh'];

/** `run --job janitor|curator|refresh|all [--dry-run] [--max-calls N]`: the jobs, under the lock. */
export async function runJobs(home: string, args: readonly string[]): Promise<RunSummary> {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const wanted = flag('job') ?? 'all';
  const names = wanted === 'all' ? JOBS : wanted.split(',');
  let c: Composed;
  try {
    c = await compose(home);
  } catch (error: unknown) {
    // A broken setup (a bad config.json) fails before the runner exists: record it anyway, so the
    // banner shows it and the scheduler backs off instead of respawning at every session start.
    const text = `setup failed: ${error instanceof Error ? error.message : String(error)}`;
    const state = new JobStateStore(join(home, 'jobs', 'state.json'));
    if (!dryRun) for (const name of names) await state.failure(name, runId, text);
    throw error;
  }
  const janitor = janitorFor(c, {
    dryRun, maxCalls: Number(flag('max-calls') ?? c.layout.config.janitor.max_calls),
    batchSize: c.layout.config.janitor.batch_size, sinceDays: c.layout.config.janitor.since_days,
  });
  const curator = curatorFor(c, { dryRun, maxPages: c.layout.config.curator.max_pages });
  const jobs: Record<string, JobFn> = {
    janitor: () => janitor.run(runId), curator: () => curator.run(runId),
    refresh: async () => (dryRun ? { skipped: 'dry run: the graph is not refreshed' } : refreshGraph(home)),
  };
  return new Runner(c.lock, c.state, join(c.layout.jobs, 'runs'), jobs, !dryRun).run(names, runId);
}
