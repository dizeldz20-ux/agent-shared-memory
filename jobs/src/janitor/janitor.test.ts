import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DeferredError } from '../apply/apply.errors.js';
import { Applier } from '../apply/applier.js';
import { ProposalStore } from '../apply/proposal-store.js';
import { LedgerStore } from '../ledger/ledger-store.js';
import type { ModelResult, ModelRunner } from '../model/model-runner.js';
import { MemoryStore } from '../store/memory-store.js';
import { loadLayout } from '../store/runtime-layout.js';
import { VaultStore } from '../store/vault-store.js';
import { TrustStore } from '../trust/trust-store.js';
import { ItemStateStore } from './item-state-store.js';
import { Janitor, type JanitorOptions } from './janitor.js';
import { Judge } from './judge.js';

/** Answers "resolved by the first evidence record" for every item, as a model might. */
class ResolvingRunner implements ModelRunner {
  calls = 0;
  constructor(private readonly prose = false) {}
  async run(prompt: string): Promise<ModelResult> {
    this.calls += 1;
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.01 };
    if (this.prose) return { text: 'they all look done to me', usage };
    const items = [...prompt.matchAll(/item_id: (\S+)\n[\s\S]*?EVIDENCE:\n {2}- (memory:\S+)/g)]
      .map((m) => ({ item_id: m[1], verdict: 'resolved', resolved_by: m[2], reason: 'a later record says so' }));
    return { text: JSON.stringify({ items }), usage };
  }
}

const record = (id: string, day: number, session: string, fields: Record<string, unknown> = {}): string => JSON.stringify({
  id, session_id: session, created_at: `2026-09-${String(day).padStart(2, '0')}T10:00:00+03:00`, agent: 't',
  summary: 'work', details: '', files: [], decisions: [], open_threads: [], ...fields,
});

describe('Janitor', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'asm-janitor-'));
    const vault = join(home, 'vault');
    mkdirSync(join(vault, 'wiki', 'main'), { recursive: true });
    writeFileSync(join(vault, 'wiki', 'main', 'empty.md'), '');
    mkdirSync(join(home, 'mem'));
    writeFileSync(join(home, 'mem', 'MEMORY.md.bak-20260908'), 'old index\n');
    mkdirSync(join(home, 'jobs'));
    writeFileSync(join(home, 'asm-paths.json'), JSON.stringify({ vault, repo: '' }));
    writeFileSync(join(home, 'jobs', 'config.json'), JSON.stringify({ memory_dir: join(home, 'mem') }));
    writeFileSync(join(home, 'memory.jsonl'), [
      record('a000000000000001', 20, 's1', { summary: 'Importer built', open_threads: ['deploy the importer 3fa9c21'] }),
      record('a000000000000002', 21, 's1', { summary: 'Deployed 3fa9c21 to the host' }),
      record('a000000000000003', 22, 's2', { summary: 'Gateway work not deployed' }),
      record('a000000000000004', 23, 's2', { summary: 'Deployed the gateway' }),
      record('a000000000000005', 24, 's3', { open_threads: ['check the metrics dashboard'] }),
      record('a000000000000006', 25, 's4', { open_threads: ['check the metrics dashboard'] }),
    ].join('\n'));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  async function janitor(runner: ModelRunner, options: Partial<JanitorOptions> = {}): Promise<{ janitor: Janitor; trust: TrustStore; ledger: LedgerStore; proposals: ProposalStore; applier: Applier }> {
    const layout = await loadLayout(home);
    const ledger = new LedgerStore(layout.ledger);
    const trust = new TrustStore(join(home, 'jobs', 'trust.json'));
    const proposals = new ProposalStore(join(home, 'jobs', 'proposals'));
    const deps = {
      layout, memory: new MemoryStore(layout.memory), vault: new VaultStore(layout.vault), ledger, trust, proposals,
      judge: new Judge(runner), applier: new Applier(ledger), items: new ItemStateStore(join(home, 'jobs', 'items.json')),
      now: () => new Date('2026-09-29T12:00:00Z'),
    };
    const merged: JanitorOptions = { dryRun: false, maxCalls: 30, batchSize: 8, sinceDays: 45, ...options };
    return { janitor: new Janitor(deps, merged), trust, ledger, proposals, applier: deps.applier };
  }

  it('proposes judged closures, applies hygiene, and never duplicates a pending proposal', async () => {
    const { janitor: job, ledger, proposals } = await janitor(new ResolvingRunner());
    const report = await job.run('r1');
    const pending = await proposals.pending();
    expect(pending.map((p) => p.class).sort()).toEqual(['record.retire.status', 'thread.close.resolved']);
    expect((await ledger.load()).map((op) => op.class).sort()).toEqual(['hygiene.archive', 'hygiene.archive', 'thread.close.duplicate']);
    expect(existsSync(join(home, 'vault', 'wiki', 'main', 'empty.md'))).toBe(false);
    expect(readFileSync(join(home, 'archive', 'r1', 'memory', 'MEMORY.md.bak-20260908'), 'utf8')).toBe('old index\n');
    expect(report.judged.calls).toBe(1);
    const again = await job.run('r2');
    expect(again.judged.calls).toBe(0);
    expect((await proposals.pending()).length).toBe(2);
  });

  it('never retires a status record that still has an open thread: silence is not evidence', async () => {
    writeFileSync(join(home, 'memory.jsonl'), `${readFileSync(join(home, 'memory.jsonl'), 'utf8')}\n${[
      record('a000000000000007', 22, 's5', { summary: 'Payments work not deployed', open_threads: ['confirm the payment provider with the owner'] }),
      record('a000000000000008', 24, 's5', { summary: 'Deployed the payments work' }),
    ].join('\n')}`);
    const { janitor: job, proposals } = await janitor(new ResolvingRunner());
    await job.run('r1');
    const retires = (await proposals.pending()).filter((p) => p.class === 'record.retire.status').map((p) => p.op.target.id);
    expect(retires).toContain('a000000000000003');
    expect(retires).not.toContain('a000000000000007');
  });

  it('applies thread closures once the judge gate passed', async () => {
    const { janitor: job, trust, ledger } = await janitor(new ResolvingRunner());
    await trust.setGate({ precision: 1, sample_size: 60, judged: 20, passed: true, at: 't', model: 'test' });
    await job.run('r1');
    expect((await ledger.load()).filter((op) => op.op === 'close_thread').map((op) => op.target.id).sort())
      .toEqual(['a000000000000001#0', 'a000000000000005#0']);
  });

  it('writes nothing in a dry run', async () => {
    const { janitor: job, ledger, proposals } = await janitor(new ResolvingRunner(), { dryRun: true });
    const report = await job.run('r1');
    expect(report.proposals.total).toBeGreaterThan(0);
    expect(await ledger.load()).toEqual([]);
    expect(await proposals.pending()).toEqual([]);
    expect(existsSync(join(home, 'vault', 'wiki', 'main', 'empty.md'))).toBe(true);
  });

  it('honors the call cap', async () => {
    const runner = new ResolvingRunner();
    const { janitor: job } = await janitor(runner, { maxCalls: 1, batchSize: 1 });
    await job.run('r1');
    expect(runner.calls).toBe(1);
  });

  it('builds a page proposal on the text the judge saw, so an edit made meanwhile defers it', async () => {
    const plan = join(home, 'vault', 'wiki', 'main', 'plan-x.md');
    const original = '---\nid: plan-x\nstatus: planning\nupdatedAt: 2026-09-20\n---\nShip the importer.\n';
    writeFileSync(plan, original);
    writeFileSync(join(home, 'memory.jsonl'), `${readFileSync(join(home, 'memory.jsonl'), 'utf8')}\n${record('a000000000000009', 26, 's9', { summary: 'Shipped plan-x to production' })}`);
    const editing = new ResolvingRunner();
    const run = editing.run.bind(editing);
    editing.run = async (prompt: string) => { writeFileSync(plan, `${original}Step 2 of 5 still pending.\n`); return run(prompt); };
    const { janitor: job, proposals, applier } = await janitor(editing);
    await job.run('r1');
    const done = (await proposals.pending()).find((p) => p.class === 'page.mark_done');
    expect(done?.file_edit?.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    await expect(applier.apply(done!, 'approved')).rejects.toBeInstanceOf(DeferredError);
  });

  it('marks a run in which every judge call failed as degraded', async () => {
    const { janitor: job } = await janitor(new ResolvingRunner(true));
    expect((await job.run('r1')).degraded).toBe('every judge call failed');
  });

  it('quarantines an item after three failed calls', async () => {
    const runner = new ResolvingRunner(true);
    const { janitor: job } = await janitor(runner);
    for (const run of ['r1', 'r2', 'r3']) await job.run(run);
    const report = await job.run('r4');
    expect(report.judged.calls).toBe(0);
    expect(report.judged.quarantined).toBeGreaterThan(0);
  });
});
