import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefreshError, type RefreshOptions, type RefreshResult } from '../refresh/refresh.types.js';
import { refreshGraph } from './refresh-job.js';

describe('refreshGraph', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asm-refresh-'));
    writeFileSync(join(dir, 'asm-paths.json'), JSON.stringify({ vault: '', repo: '/x/asm' }));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('refreshes the graph only, in process: the daily job never deploys code from the development checkout', async () => {
    let seen: RefreshOptions | undefined;
    const result = await refreshGraph(dir, async (options) => { seen = options; return { stats: { extracted: ['a'], failed: [], missing: [], unchanged: ['b'] }, reload: 'server not running - skipped reload' }; });
    expect(result).toMatchObject({ exit: 0, extracted: 1, unchanged: 1, failed: [], missing: [], warnings: [] });
    expect(result).not.toHaveProperty('degraded');
    expect(seen).toMatchObject({ repo: '/x/asm', runtime: dir, brainOnly: true, changedOnly: true });
  });

  it('keeps the warnings in the job result, and calls a run in which every due source failed degraded', async () => {
    const partial = await refreshGraph(dir, async (_options, log) => {
      log.warn('   !! extraction failed: /x/b');
      return { stats: { extracted: ['a'], failed: ['b'], missing: ['c'], unchanged: [] }, reload: 'RELOAD FAILED - server is up but rejected the new graph (HTTP 500); it is still serving the OLD graph' };
    });
    expect(partial).toMatchObject({ failed: ['b'], missing: ['c'], warnings: ['   !! extraction failed: /x/b'] });
    expect(partial).not.toHaveProperty('degraded');
    const none = await refreshGraph(dir, async () => ({ stats: { extracted: [], failed: ['a', 'b'], missing: [], unchanged: [] }, reload: 'done' }));
    expect(none).toMatchObject({ degraded: 'every due source failed to extract: a, b' });
  });

  it('reports a failed refresh with the cause first and the lines that explain it after', async () => {
    const failing = async (_options: RefreshOptions, log: { warn(line: string): void }): Promise<RefreshResult> => {
      log.warn('   !! extraction failed: /x/project');
      throw new RefreshError('merge.py failed (exit 1): boom');
    };
    await expect(refreshGraph(dir, failing)).rejects.toThrow(/^refresh failed: merge\.py failed \(exit 1\): boom\n[\s\S]*extraction failed/);
  });
});
