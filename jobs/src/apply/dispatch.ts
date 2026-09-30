import type { TrustStore } from '../trust/trust-store.js';
import { DeferredError } from './apply.errors.js';
import type { Applier } from './applier.js';
import type { ProposalStore } from './proposal-store.js';
import type { Proposal } from './proposal.types.js';

export interface DispatchDeps {
  readonly trust: TrustStore;
  readonly proposals: ProposalStore;
  readonly applier: Applier;
}

export interface DispatchResult {
  readonly applied: number;
  readonly pending: number;
  readonly deferred: number;
}

/**
 * Route each proposal by its class's trust: an automatic class is applied now (a file a live
 * session edited meanwhile is deferred), everything else waits for the owner. A proposal for a
 * target that already has one pending is not added twice. `forcePropose` holds ids that must wait
 * whatever the trust state (a curator's first build of a block).
 */
export async function dispatchProposals(deps: DispatchDeps, runId: string, proposals: readonly Proposal[],
  dryRun: boolean, forcePropose: ReadonlySet<string> = new Set()): Promise<DispatchResult> {
  const waiting = new Set((await deps.proposals.pending()).map((p) => `${p.class}|${p.op.target.id}`));
  const pending: Proposal[] = [];
  let applied = 0;
  let deferred = 0;
  for (const proposal of proposals) {
    if (waiting.has(`${proposal.class}|${proposal.op.target.id}`)) continue;
    const mode = forcePropose.has(proposal.id) ? 'propose' : await deps.trust.modeFor(proposal.class);
    if (mode === 'propose') { pending.push(proposal); continue; }
    if (dryRun) { applied += 1; continue; }
    try {
      await deps.applier.apply(proposal, 'auto');
      applied += 1;
    } catch (error: unknown) {
      if (!(error instanceof DeferredError)) throw error;
      deferred += 1;
    }
  }
  if (!dryRun) await deps.proposals.save(runId, pending);
  return { applied, pending: pending.length, deferred };
}
