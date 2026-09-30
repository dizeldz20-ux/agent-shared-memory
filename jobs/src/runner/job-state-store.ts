import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JobState {
  readonly last_success: string | null;
  readonly last_error: string | null;
  readonly error_text: string | null;
  readonly consecutive_failures: number;
  readonly last_run_id: string | null;
  readonly last_summary: unknown;
}

const EMPTY: JobState = { last_success: null, last_error: null, error_text: null, consecutive_failures: 0, last_run_id: null, last_summary: null };

/** ~/.asm/jobs/state.json: when each job last succeeded and why it last failed. The banner reads it. */
export class JobStateStore {
  constructor(readonly path: string) {}

  async load(): Promise<Record<string, JobState>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, JobState>;
    } catch {
      return {};
    }
  }

  async success(job: string, runId: string, summary: unknown): Promise<void> {
    await this.update(job, (state) => ({ ...state, last_success: new Date().toISOString(), consecutive_failures: 0, last_run_id: runId, last_summary: summary }));
  }

  async failure(job: string, runId: string, error: string): Promise<void> {
    await this.update(job, (state) => ({
      ...state, last_error: new Date().toISOString(), error_text: error.slice(0, 500),
      consecutive_failures: state.consecutive_failures + 1, last_run_id: runId,
    }));
  }

  private async update(job: string, change: (state: JobState) => JobState): Promise<void> {
    const all = await this.load();
    const next = { ...all, [job]: change({ ...EMPTY, ...(all[job] ?? {}) }) };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }
}
