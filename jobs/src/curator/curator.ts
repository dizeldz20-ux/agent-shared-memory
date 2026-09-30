import type { Applier } from '../apply/applier.js';
import { dispatchProposals } from '../apply/dispatch.js';
import { deferStale } from '../apply/stale.js';
import type { ProposalStore } from '../apply/proposal-store.js';
import { fold } from '../ledger/fold.js';
import type { LedgerStore } from '../ledger/ledger-store.js';
import { ModelFailedError, ModelUnavailableError } from '../model/model.errors.js';
import type { ModelRunner } from '../model/model-runner.js';
import type { MemoryStore } from '../store/memory-store.js';
import type { RuntimeLayout } from '../store/runtime-layout.js';
import type { VaultStore } from '../store/vault-store.js';
import type { TrustStore } from '../trust/trust-store.js';
import { blockProposal } from './block-proposal.js';
import { compactionProposals } from './compaction-proposal.js';
import { correctionProposals } from './correction-proposal.js';
import type { Built, CuratorContext, CuratorReport } from './curator.types.js';
import { indexFiles, indexProposal, type LineContext } from './index-proposal.js';
import { loadScope, loadSessionFiles } from './scope.js';

const MAX_INDEX_LINES = 10;

export interface CuratorDeps {
  readonly layout: RuntimeLayout;
  readonly memory: MemoryStore;
  readonly vault: VaultStore;
  readonly ledger: LedgerStore;
  readonly runner: ModelRunner;
  readonly trust: TrustStore;
  readonly proposals: ProposalStore;
  readonly applier: Applier;
  readonly now: () => Date;
}

export interface CuratorOptions {
  readonly dryRun: boolean;
  readonly maxPages: number;
}

/** The learning layer: keeps project blocks, index lines and memory files true, as proposals under the trust ladder. */
export class Curator {
  constructor(private readonly deps: CuratorDeps, private readonly options: CuratorOptions) {}

  async run(runId: string): Promise<CuratorReport> {
    const started = this.deps.now();
    const records = await this.deps.memory.load();
    const meter = { calls: 0, failed: 0, stopped: null as string | null, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } };
    if (!this.options.dryRun) await deferStale(this.deps.proposals);
    const pending = await this.deps.proposals.pending();
    // Every file a pending proposal touches is off limits, and so is every file this run already changes.
    const touched = new Set(pending.flatMap((p) => [p.file_edit?.path, ...(p.companions ?? []).map((c) => c.file_edit?.path)])
      .filter((path): path is string => path !== undefined));
    const ctx: CuratorContext = {
      runId, layout: this.deps.layout, records, life: fold(await this.deps.ledger.load(), records), pages: await this.deps.vault.pages(),
      scope: await loadScope(this.deps.layout), sessionFiles: await loadSessionFiles(this.deps.layout.sessions), now: started,
      waiting: new Set(pending.map((p) => `${p.class}|${p.op.target.id}`)),
      ask: (prompt) => this.ask(prompt, meter),
    };
    // An agent's correction first: it is explicit and evidenced, and it claims its file for this run.
    const built: Built[] = [...(await correctionProposals(ctx, touched))];
    const context = new Map<string, LineContext>();
    const blockAuto = !this.options.dryRun && (await this.deps.trust.modeFor('block.refresh')) === 'auto';
    for (const project of ctx.scope.slice(0, this.options.maxPages)) {
      const page = ctx.pages.find((p) => `vault:${p.id}` === project.page);
      if (page === undefined) { built.push({ skipped: `${project.page}: no such page` }); continue; }
      const result = await blockProposal(ctx, project, page, touched);
      built.push(result);
      // An index line may restate only what is on the page, or a refresh this run applies itself.
      const applied = result.proposal !== undefined && result.firstBuild !== true && blockAuto;
      const state = ((applied ? result.current : result.onPage)?.bullets ?? []).map((bullet) => `- ${bullet.text}`).join('\n');
      for (const idx of project.index_lines) context.set(idx, { state, changed: applied });
    }
    const budget = { left: MAX_INDEX_LINES };
    for (const file of indexFiles(ctx)) built.push(...(await indexProposal(ctx, file, context, touched, budget)));
    built.push(...(await compactionProposals(ctx, touched)));
    const proposals = built.flatMap((b) => (b.proposal ? [b.proposal] : []));
    const forced = new Set(built.flatMap((b) => (b.firstBuild && b.proposal ? [b.proposal.id] : [])));
    const dispatched = await dispatchProposals(this.deps, runId, proposals, this.options.dryRun, forced);
    const count: Record<string, number> = {};
    for (const proposal of proposals) count[proposal.class] = (count[proposal.class] ?? 0) + 1;
    const degraded = meter.stopped !== null ? `stopped: ${meter.stopped}`
      : meter.calls > 0 && meter.failed === meter.calls ? 'every model call failed' : undefined;
    return {
      ...(degraded === undefined ? {} : { degraded }),
      run_id: runId, started_at: started.toISOString(), finished_at: this.deps.now().toISOString(), dry_run: this.options.dryRun,
      calls: meter.calls, failed_calls: meter.failed, built: count, proposals: { total: proposals.length, ...dispatched },
      skipped: built.flatMap((b) => (b.skipped ? [b.skipped] : [])), stopped: meter.stopped, usage: meter.usage,
    };
  }

  private async ask(prompt: string, meter: { calls: number; failed: number; stopped: string | null; usage: CuratorReport['usage'] & { input_tokens: number; output_tokens: number; cost_usd: number } }): Promise<string | undefined> {
    if (meter.stopped !== null) return undefined;
    meter.calls += 1;
    try {
      const result = await this.deps.runner.run(prompt);
      meter.usage.input_tokens += result.usage.input_tokens + result.usage.cache_creation_input_tokens;
      meter.usage.output_tokens += result.usage.output_tokens;
      meter.usage.cost_usd += result.usage.cost_usd ?? 0;
      return result.text;
    } catch (error: unknown) {
      if (error instanceof ModelUnavailableError) { meter.stopped = error.message; return undefined; }
      if (!(error instanceof ModelFailedError)) throw error;
      meter.failed += 1;
      return undefined;
    }
  }
}
