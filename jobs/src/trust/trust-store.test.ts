import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrustStore } from './trust-store.js';

describe('TrustStore', () => {
  let dir = '';
  let store: TrustStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-trust-')); store = new TrustStore(join(dir, 'trust.json')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('lets a content class run automatically after three clean approvals, and resets on an edit', async () => {
    expect(await store.modeFor('page.mark_done')).toBe('propose');
    await store.recordReview('page.mark_done', 'approved_clean', '2026-09-26');
    await store.recordReview('page.mark_done', 'edited', '2026-09-26');
    await store.recordReview('page.mark_done', 'approved_clean', '2026-09-27');
    await store.recordReview('page.mark_done', 'approved_clean', '2026-09-28');
    expect(await store.modeFor('page.mark_done')).toBe('propose');
    await store.recordReview('page.mark_done', 'approved_clean', '2026-09-29');
    expect(await store.modeFor('page.mark_done')).toBe('auto');
  });

  it('counts at most one clean run a day: a backlog approved at once is one review, not three', async () => {
    for (let i = 0; i < 3; i += 1) await store.recordReview('block.refresh', 'approved_clean', '2026-09-29');
    expect(await store.modeFor('block.refresh')).toBe('propose');
    await store.recordReview('block.refresh', 'approved_clean', '2026-09-30');
    await store.recordReview('block.refresh', 'approved_clean', '2026-10-01');
    expect(await store.modeFor('block.refresh')).toBe('auto');
  });

  it('keeps thread closures as proposals until the judge gate passes', async () => {
    expect(await store.modeFor('thread.close.resolved')).toBe('propose');
    await store.setGate({ precision: 0.9, sample_size: 60, judged: 20, passed: false, at: 't', model: 'sonnet' });
    expect(await store.modeFor('thread.close.not_actionable')).toBe('propose');
    await store.setGate({ precision: 0.97, sample_size: 60, judged: 30, passed: true, at: 't', model: 'sonnet' });
    expect(await store.modeFor('thread.close.resolved')).toBe('auto');
  });

  it('keeps a thread class that failed its own gate as proposals, even when the overall gate passed', async () => {
    await store.setGate({ precision: 0.96, sample_size: 60, judged: 25, passed: true, at: 't', model: 'sonnet', classes: {
      resolved: { judged: 22, precision: 1, passed: true }, not_actionable: { judged: 3, precision: 0.67, passed: false } } });
    expect(await store.modeFor('thread.close.resolved')).toBe('auto');
    expect(await store.modeFor('thread.close.not_actionable')).toBe('propose');
    expect(await store.modeFor('thread.close.duplicate')).toBe('auto');
  });

  it('closes verbatim duplicate threads automatically from the start (owner, 29/09), and demotes them on a restore', async () => {
    expect(await store.modeFor('thread.close.duplicate')).toBe('auto');
    await store.recordReview('thread.close.duplicate', 'restored');
    expect(await store.modeFor('thread.close.duplicate')).toBe('propose');
  });

  it('runs hygiene automatically from the start, and demotes any class the owner had to restore', async () => {
    expect(await store.modeFor('hygiene.archive')).toBe('auto');
    await store.recordReview('hygiene.archive', 'restored');
    expect(await store.modeFor('hygiene.archive')).toBe('propose');
  });
});
