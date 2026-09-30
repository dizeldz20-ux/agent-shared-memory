#!/usr/bin/env node
// asm-bench: freeze the recall stores, or measure stale recall on a frozen snapshot.
//   node dist/bench/cli.js snapshot --runtime ~/.asm --out ~/.asm/bench/snap-<date>
//   node dist/bench/cli.js run --snapshot <dir> --code <runtime-or-repo> --cases <file> --out <report.json> [--uv-dir <dir>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './bench.errors.js';
import { parseBenchCases } from './bench.schema.js';
import type { BenchReport, CaseScore } from './bench.types.js';
import { scoreCase, summarize } from './metrics.js';
import { RecallProbe } from './recall-probe.js';
import { createSnapshot } from './snapshot.js';

function option(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) throw new UsageError(`missing --${name}`);
  return value;
}

async function run(): Promise<BenchReport> {
  const cases = parseBenchCases(JSON.parse(await readFile(option('cases'), 'utf8')));
  const workDir = await mkdtemp(join(tmpdir(), 'asm-bench-'));
  const codeDir = option('code');
  const uvIndex = process.argv.indexOf('--uv-dir');
  const probe = new RecallProbe({
    codeDir, snapshotDir: option('snapshot'), workDir,
    uvDir: uvIndex > 0 ? process.argv[uvIndex + 1] ?? codeDir : codeDir,
  });
  const scores: CaseScore[] = [];
  await probe.start();
  try {
    for (const benchCase of cases.cases) {
      scores.push(scoreCase(benchCase, 'hook', await probe.hookTop(benchCase.id, benchCase.query)));
      scores.push(scoreCase(benchCase, 'search', await probe.searchTop(benchCase.query)));
    }
  } finally {
    await probe.stop();
    await rm(workDir, { recursive: true, force: true });
  }
  const manifest = await readFile(join(option('snapshot'), 'manifest.json')).catch(() => Buffer.from(''));
  return {
    created_at: new Date().toISOString(), snapshot: option('snapshot'),
    manifest_sha256: createHash('sha256').update(manifest).digest('hex'), clock: probe.clock ?? null,
    code: codeDir, code_commit: commitOf(codeDir), summary: summarize(scores), scores,
  };
}

function commitOf(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'snapshot') {
    const manifest = await createSnapshot(option('runtime'), option('out'));
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else if (command === 'run') {
    const report = await run();
    await writeFile(option('out'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } else {
    throw new UsageError('usage: cli.js snapshot|run …');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
