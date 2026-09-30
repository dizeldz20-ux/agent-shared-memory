import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotExistsError } from './bench.errors.js';
import { createSnapshot } from './snapshot.js';

describe('createSnapshot', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-snap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('copies the stores and records their sha256, and never overwrites a frozen snapshot', async () => {
    const runtime = join(dir, 'runtime');
    mkdirSync(runtime);
    writeFileSync(join(runtime, 'memory.jsonl'), '{"id":"x"}\n');
    writeFileSync(join(runtime, 'brain.json'), '{}');
    const manifest = await createSnapshot(runtime, join(dir, 'snap'));
    expect(Object.keys(manifest.files).sort()).toEqual(['brain.json', 'memory.jsonl']);
    expect(manifest.files['brain.json']).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(JSON.parse(readFileSync(join(dir, 'snap', 'manifest.json'), 'utf8')).files).toEqual(manifest.files);
    await expect(createSnapshot(runtime, join(dir, 'snap'))).rejects.toBeInstanceOf(SnapshotExistsError);
  });
});
