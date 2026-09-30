import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Proposal } from '../apply/proposal.types.js';
import { JobStateStore } from './job-state-store.js';
import { RunLock } from './lock.js';
import { Runner } from './runner.js';
import { selectProposals } from './select.js';

describe('RunLock', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('admits one runner, breaks a lock whose process is gone, and releases its own', async () => {
    const lock = new RunLock(join(dir, 'run.lock'));
    expect(await lock.acquire()).toBe(true);
    expect(await new RunLock(join(dir, 'run.lock')).acquire()).toBe(false);
    await lock.release();
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: 999_999_9, started_at: new Date().toISOString() }));
    expect(await new RunLock(join(dir, 'run.lock')).acquire()).toBe(true);
  });
});

describe('Runner', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-runner-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records success and failure per job, loudly, and runs nothing while another runner holds the lock', async () => {
    const state = new JobStateStore(join(dir, 'state.json'));
    const runner = new Runner(new RunLock(join(dir, 'run.lock')), state, join(dir, 'runs'), {
      janitor: async () => ({ applied: 2 }),
      refresh: async () => { throw new Error('graphify is not installed'); },
    });
    const summary = await runner.run(['janitor', 'refresh'], 'run-1');
    expect(summary).toMatchObject({ janitor: { ok: true }, refresh: { ok: false, error: 'graphify is not installed' } });
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(saved.janitor.last_success).toBeTruthy();
    expect(saved.refresh).toMatchObject({ last_error: expect.any(String), error_text: 'graphify is not installed', consecutive_failures: 1 });
    const busy = new RunLock(join(dir, 'run.lock'));
    await busy.acquire();
    expect(await runner.run(['janitor'], 'run-2')).toEqual({ skipped: 'another runner holds the lock' });
  });
});

describe('Runner outcomes', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-runner-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records a degraded run as a failure, and a dry run not at all', async () => {
    const state = new JobStateStore(join(dir, 'state.json'));
    const runner = new Runner(new RunLock(join(dir, 'run.lock')), state, join(dir, 'runs'), {
      janitor: async () => ({ calls: 3, degraded: 'every judge call failed' }),
    });
    expect(await runner.run(['janitor'], 'run-1')).toMatchObject({ janitor: { ok: false, error: 'every judge call failed', result: { calls: 3 } } });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).janitor).toMatchObject({ last_success: null, error_text: 'every judge call failed' });
    const dry = new Runner(new RunLock(join(dir, 'dry.lock')), new JobStateStore(join(dir, 'dry-state.json')), join(dir, 'runs'),
      { janitor: async () => ({ applied: 0 }) }, false);
    await dry.run(['janitor'], 'run-2');
    expect(existsSync(join(dir, 'dry-state.json'))).toBe(false);
  });
});

describe('selectProposals', () => {
  const p = (id: string, run: string, cls: string): Proposal => ({
    id, run_id: run, class: cls, summary: id, created_at: 't', status: 'pending',
    op: { op: 'close_thread', target: { kind: 'thread', id: `x#${id}` }, reason: 'r' },
  });
  const pending = [p('a', 'r1', 'thread.close.resolved'), p('b', 'r1', 'page.mark_done'), p('c', 'r2', 'page.mark_done')];

  it('selects by id, by class, or all', () => {
    expect(selectProposals(pending, ['a', 'c']).map((x) => x.id)).toEqual(['a', 'c']);
    expect(selectProposals(pending, ['class:page.mark_done']).map((x) => x.id)).toEqual(['b', 'c']);
    expect(selectProposals(pending, ['all']).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
