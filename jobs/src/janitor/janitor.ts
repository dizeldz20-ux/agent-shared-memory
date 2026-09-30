import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Applier } from '../apply/applier.js';
import { dispatchProposals } from '../apply/dispatch.js';
import { deferStale } from '../apply/stale.js';
import { move } from '../apply/files.js';
import type { ProposalStore } from '../apply/proposal-store.js';
import type { Proposal } from '../apply/proposal.types.js';
import { fold } from '../ledger/fold.js';
import type { Lifecycle } from '../ledger/lifecycle.js';
import type { LedgerStore } from '../ledger/ledger-store.js';
import { ModelFailedError, ModelUnavailableError } from '../model/model.errors.js';
import type { MemoryStore } from '../store/memory-store.js';
import { isHub, type RuntimeLayout } from '../store/runtime-layout.js';
import type { MemoryRecord, VaultPage } from '../store/store.types.js';
import type { VaultStore } from '../store/vault-store.js';
import type { TrustStore } from '../trust/trust-store.js';
import { openThreads, planPages, statusSnapshots } from './candidates.js';
import { indexBackups, orphanMemoryFiles, staleSessionFiles, zeroBytePages } from './hygiene.js';
import type { ItemState, ItemStateStore } from './item-state-store.js';
import { duplicateProposal, verdictProposal } from './janitor-proposals.js';
import type { Candidate, Verdict } from './janitor.types.js';
import type { JanitorReport } from './janitor.types-report.js';
import { buildJudgeQueue, candidateTime } from './judge-queue.js';
import type { Judge } from './judge.js';
import { duplicateThreads } from './prepass.js';

export interface JanitorDeps {
  readonly layout: RuntimeLayout;
  readonly memory: MemoryStore;
  readonly vault: VaultStore;
  readonly ledger: LedgerStore;
  readonly judge: Judge;
  readonly trust: TrustStore;
  readonly proposals: ProposalStore;
  readonly applier: Applier;
  readonly items: ItemStateStore;
  readonly now: () => Date;
}

export interface JanitorOptions {
  readonly dryRun: boolean;
  readonly maxCalls: number;
  readonly batchSize: number;
  readonly sinceDays: number;
}

type JudgeStats = JanitorReport['judged'] & { readonly stopped: string | null; readonly usage: JanitorReport['usage'] };

/** The cleanup layer: finds what later evidence settled and closes, retires or archives it. */
export class Janitor {
  constructor(private readonly deps: JanitorDeps, private readonly options: JanitorOptions) {}

  async run(runId: string): Promise<JanitorReport> {
    const started = this.deps.now();
    if (!this.options.dryRun) await deferStale(this.deps.proposals);
    const records = await this.deps.memory.load();
    const life = fold(await this.deps.ledger.load(), records);
    const pages = await this.deps.vault.pages();
    const since = new Date(started.getTime() - this.options.sinceDays * 86_400_000);
    const threads = openThreads(records, life, since);
    const groups = duplicateThreads(threads);
    const duplicates = new Set(groups.flatMap((group) => group.duplicates.map((item) => item.id)));
    const snapshots = statusSnapshots(records, life, since);
    const plans = planPages(pages, life, (page) => isHub(page.rel, this.deps.layout.config));
    const candidates = [...threads.filter((t) => !duplicates.has(t.id)), ...snapshots, ...plans]
      .sort((a, b) => candidateTime(b) - candidateTime(a));
    const states = await this.deps.items.load();
    const judged = await this.judgeAll(runId, candidates, records.filter((r) => !life.hidden('record', r.id)), states, life);
    const archive = this.deps.layout.archive;
    const hygiene = [...zeroBytePages(runId, pages, archive), ...(await indexBackups(runId, this.deps.layout.config.memory_dir, archive))];
    const proposals = [...groups.flatMap((g) => g.duplicates.map((d) => duplicateProposal(runId, d, g.keep))), ...hygiene, ...judged.proposals];
    const dispatched = await dispatchProposals(this.deps, runId, proposals, this.options.dryRun);
    const moved = await this.sweepSessions(runId, started);
    if (!this.options.dryRun) await this.deps.items.save(states);
    const { stopped, usage, ...stats } = judged.stats;
    const degraded = stopped !== null ? `stopped: ${stopped}` : stats.calls > 0 && stats.items === 0 ? 'every judge call failed' : undefined;
    return {
      ...(degraded === undefined ? {} : { degraded }),
      run_id: runId, started_at: started.toISOString(), finished_at: this.deps.now().toISOString(), dry_run: this.options.dryRun,
      candidates: { threads: threads.length, snapshots: snapshots.length, pages: plans.length },
      duplicates: duplicates.size,
      hygiene: { archived_or_proposed: hygiene.length, stale_sessions_moved: moved, orphan_memory_files: await this.orphans(pages) },
      judged: stats, proposals: { total: proposals.length, ...dispatched }, stopped, usage,
    };
  }

  private async judgeAll(runId: string, candidates: readonly Candidate[], live: readonly MemoryRecord[],
    states: Map<string, ItemState>, life: Lifecycle): Promise<{ proposals: Proposal[]; stats: JudgeStats }> {
    const built = buildJudgeQueue(candidates, live, states, life);
    const verdicts: Record<Verdict, number> = { resolved: 0, still_open: 0, not_actionable: 0, unknown: 0 };
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    const proposals: Proposal[] = [];
    let calls = 0;
    let failed = 0;
    let quarantined = built.quarantined;
    let stopped: string | null = null;
    const now = this.deps.now().toISOString();
    for (let start = 0; start < built.queue.length && calls < this.options.maxCalls; start += this.options.batchSize) {
      const batch = built.queue.slice(start, start + this.options.batchSize);
      calls += 1;
      let outcome;
      try {
        outcome = await this.deps.judge.judgeBatch(batch);
      } catch (error: unknown) {
        if (error instanceof ModelUnavailableError) { stopped = error.message; break; }
        if (!(error instanceof ModelFailedError)) throw error;
        outcome = { judgements: [], failed: batch.map((item) => item.candidate.id), usage: null };
      }
      usage.input_tokens += (outcome.usage?.input_tokens ?? 0) + (outcome.usage?.cache_creation_input_tokens ?? 0);
      usage.output_tokens += outcome.usage?.output_tokens ?? 0;
      usage.cost_usd += outcome.usage?.cost_usd ?? 0;
      for (const id of outcome.failed) {
        const previous = states.get(id);
        const failures = (previous?.failures ?? 0) + 1;
        states.set(id, { last_checked_at: now, verdict: previous?.verdict ?? '', evidence_key: previous?.evidence_key ?? '', failures, quarantined: failures >= 3 });
        failed += 1;
        if (failures >= 3) quarantined += 1;
      }
      for (const judgement of outcome.judgements) {
        const item = batch.find((queued) => queued.candidate.id === judgement.item_id);
        if (item === undefined) continue;
        verdicts[judgement.verdict] += 1;
        states.set(item.candidate.id, { last_checked_at: now, verdict: judgement.verdict, evidence_key: item.key, failures: 0, quarantined: false });
        // The hash of the text the candidate was read from: an edit made since then defers the proposal.
        const pageSha = item.candidate.kind === 'page' ? item.candidate.page.sha256 : undefined;
        const proposal = verdictProposal(runId, item.candidate, judgement, pageSha);
        if (proposal !== undefined) proposals.push(proposal);
      }
    }
    return {
      proposals,
      stats: {
        calls, items: calls === 0 ? 0 : Object.values(verdicts).reduce((a, b) => a + b, 0), verdicts, failed, quarantined,
        skipped_no_evidence: built.skippedNoEvidence, skipped_same_evidence: built.skippedSameEvidence, stopped, usage,
      },
    };
  }

  private async sweepSessions(runId: string, now: Date): Promise<number> {
    const stale = await staleSessionFiles(this.deps.layout.sessions, this.deps.layout.config.session_ttl_days, now);
    if (this.options.dryRun) return stale.length;
    for (const path of stale) await move(path, join(this.deps.layout.archive, 'sessions', runId, basename(path)));
    return stale.length;
  }

  private async orphans(pages: readonly VaultPage[]): Promise<string[]> {
    const dir = this.deps.layout.config.memory_dir;
    if (!dir) return [];
    const hubs = pages.filter((page) => isHub(page.rel, this.deps.layout.config));
    const texts = await Promise.all([join(dir, 'MEMORY.md'), ...hubs.map((page) => page.path)]
      .map((path) => readFile(path, 'utf8').catch(() => '')));
    return orphanMemoryFiles(dir, texts);
  }
}
