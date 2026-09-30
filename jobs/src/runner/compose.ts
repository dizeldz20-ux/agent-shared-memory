import { join } from 'node:path';
import { Applier } from '../apply/applier.js';
import { ProposalStore } from '../apply/proposal-store.js';
import { ItemStateStore } from '../janitor/item-state-store.js';
import { Janitor, type JanitorOptions } from '../janitor/janitor.js';
import { Judge } from '../janitor/judge.js';
import { Curator, type CuratorOptions } from '../curator/curator.js';
import { LedgerStore } from '../ledger/ledger-store.js';
import { ClaudeRunner } from '../model/claude-runner.js';
import type { ModelRunner } from '../model/model-runner.js';
import { MemoryStore } from '../store/memory-store.js';
import { loadLayout, type RuntimeLayout } from '../store/runtime-layout.js';
import { VaultStore } from '../store/vault-store.js';
import { TrustStore } from '../trust/trust-store.js';
import { JobStateStore } from './job-state-store.js';
import { RunLock } from './lock.js';

export interface Composed {
  readonly layout: RuntimeLayout;
  readonly ledger: LedgerStore;
  readonly memory: MemoryStore;
  readonly vault: VaultStore;
  readonly trust: TrustStore;
  readonly proposals: ProposalStore;
  readonly applier: Applier;
  readonly items: ItemStateStore;
  readonly state: JobStateStore;
  readonly lock: RunLock;
  readonly model: ModelRunner;
  readonly judge: Judge;
}

/** The composition root: every store and service the jobs use, wired from the runtime layout. */
export async function compose(home: string): Promise<Composed> {
  const layout = await loadLayout(home);
  const ledger = new LedgerStore(layout.ledger);
  const model = new ClaudeRunner(layout.config.judge_model);
  return {
    layout, ledger, model,
    memory: new MemoryStore(layout.memory),
    vault: new VaultStore(layout.vault),
    trust: new TrustStore(join(layout.jobs, 'trust.json')),
    proposals: new ProposalStore(join(layout.jobs, 'proposals')),
    applier: new Applier(ledger),
    items: new ItemStateStore(join(layout.jobs, 'items.json')),
    state: new JobStateStore(join(layout.jobs, 'state.json')),
    lock: new RunLock(join(layout.jobs, 'run.lock')),
    judge: new Judge(model),
  };
}

export function janitorFor(c: Composed, options: JanitorOptions): Janitor {
  return new Janitor({
    layout: c.layout, memory: c.memory, vault: c.vault, ledger: c.ledger, judge: c.judge, trust: c.trust,
    proposals: c.proposals, applier: c.applier, items: c.items, now: () => new Date(),
  }, options);
}

export function curatorFor(c: Composed, options: CuratorOptions): Curator {
  return new Curator({
    layout: c.layout, memory: c.memory, vault: c.vault, ledger: c.ledger, runner: c.model, trust: c.trust,
    proposals: c.proposals, applier: c.applier, now: () => new Date(),
  }, options);
}
