import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecallProbe } from './recall-probe.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function writeSnapshot(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const page = {
    id: 'vault:deploy-rules', label: 'Deploy rules', layer: 'vault', kind: 'page', path: 'wiki/deploy-rules.md',
    abs: '', meta: { description: 'How the gateway deploy works', tags: ['deploy', 'gateway'] },
  };
  writeFileSync(join(dir, 'brain.json'), JSON.stringify({ generatedAt: new Date().toISOString(), nodes: [page], links: [] }));
  writeFileSync(join(dir, 'brain.index.json'), JSON.stringify([
    { i: page.id, l: page.label, k: 'page', p: page.path, d: page.meta.description, t: page.meta.tags },
  ]));
  writeFileSync(join(dir, 'brain.pages.json'), '{}');
  const record = (id: string, at: string, summary: string): string => JSON.stringify({
    id, session_id: 's', created_at: at, agent: 'test', summary, details: 'Checked on the live host after the deploy.',
    files: [], decisions: [], open_threads: [],
  });
  writeFileSync(join(dir, 'memory.jsonl'), [
    record('b000000000000001', '2029-12-30T10:00:00Z', 'Gateway deploy finished and verified'),
    record('b000000000000002', '2029-10-01T10:00:00Z', 'Lighthouse beacon calibration'),
    record('b000000000000003', '2029-12-31T10:00:00Z', 'Lighthouse beacon calibration'),
  ].join('\n'));
  // The probe runs recall at the snapshot's time, not today's.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ created_at: '2030-01-01T00:00:00Z', source: 'test', files: {} }));
}

describe('RecallProbe', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns node ids from both the prompt hook and brain_search', async () => {
    writeSnapshot(join(dir, 'snap'));
    const probe = new RecallProbe({ codeDir: REPO, snapshotDir: join(dir, 'snap'), workDir: join(dir, 'work'), uvDir: REPO });
    await probe.start();
    try {
      expect(await probe.hookTop('c1', 'gateway deploy rules')).toContain('vault:deploy-rules');
      const search = await probe.searchTop('gateway deploy');
      expect(search).toContain('vault:deploy-rules');
      expect(search).toContain('memory:b000000000000001');
      for (const top of [await probe.searchTop('lighthouse beacon calibration'), await probe.hookTop('c2', 'lighthouse beacon calibration')]) {
        const older = top.indexOf('memory:b000000000000002');
        expect(top.indexOf('memory:b000000000000003')).toBeGreaterThanOrEqual(0);
        expect(older === -1 || top.indexOf('memory:b000000000000003') < older).toBe(true);
      }
    } finally {
      await probe.stop();
    }
  }, 60_000);
});
