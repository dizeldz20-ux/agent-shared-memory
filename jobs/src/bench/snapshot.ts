import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotExistsError } from './bench.errors.js';
import type { SnapshotManifest } from './bench.types.js';

/** The stores recall reads. The ledger is optional: a runtime before Phase 1 has none. */
export const SNAPSHOT_FILES = ['brain.json', 'brain.index.json', 'brain.pages.json', 'memory.jsonl', 'lifecycle.jsonl'];

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Freeze the recall stores of a runtime. A snapshot is the benchmark's ground: it is never
 * overwritten, so every before/after report of one snapshot measures the same data.
 */
export async function createSnapshot(runtimeDir: string, outDir: string): Promise<SnapshotManifest> {
  if (existsSync(outDir)) throw new SnapshotExistsError(outDir);
  await mkdir(outDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of SNAPSHOT_FILES) {
    const from = join(runtimeDir, name);
    if (!existsSync(from)) continue;
    await copyFile(from, join(outDir, name));
    files[name] = await sha256File(join(outDir, name));
  }
  const manifest: SnapshotManifest = { created_at: new Date().toISOString(), source: runtimeDir, files };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
