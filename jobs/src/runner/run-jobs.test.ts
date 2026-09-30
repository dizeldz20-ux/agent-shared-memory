import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runJobs } from './run-jobs.js';

describe('runJobs', () => {
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'asm-runjobs-')); mkdirSync(join(home, 'jobs')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('records a failure before any job starts for every job it was asked to run', async () => {
    writeFileSync(join(home, 'jobs', 'config.json'), JSON.stringify({ janitor: { max_calls: '30' } }));
    await expect(runJobs(home, ['run', '--job', 'janitor,curator'])).rejects.toThrow();
    const state = JSON.parse(readFileSync(join(home, 'jobs', 'state.json'), 'utf8'));
    expect(state.janitor.error_text).toMatch(/^setup failed/);
    expect(state.curator.error_text).toMatch(/^setup failed/);
  });
});
