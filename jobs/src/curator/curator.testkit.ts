// Test support for the curator (excluded from the build): a synthetic runtime and a scripted model.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Applier } from '../apply/applier.js';
import { ProposalStore } from '../apply/proposal-store.js';
import { LedgerStore } from '../ledger/ledger-store.js';
import type { ModelResult, ModelRunner } from '../model/model-runner.js';
import { MemoryStore } from '../store/memory-store.js';
import { loadLayout } from '../store/runtime-layout.js';
import { VaultStore } from '../store/vault-store.js';
import { TrustStore } from '../trust/trust-store.js';
import { Curator } from './curator.js';

export const R1 = 'a000000000000001';
export const R2 = 'a000000000000002';
export const R3 = 'a000000000000003';
export const PAGE = '---\nid: alpha\ntitle: Alpha\n---\n# Alpha\n\nHuman intro: keep me.\n';
export const INDEX = '# Memory Index\n- [Alpha notes](alpha-notes.md) — **27/09: ייצור = `aaa111`; 28/09: ייצור = `bbb222`** · [hub](other.md)\n- [Beta](beta.md) — plain line\n';
export const GAMMA = '---\nname: gamma\n---\nGamma log.\n\n## 27/09\nfirst state\n\n## 28/09\nsecond state\n';

const record = (id: string, day: number, files: readonly string[], summary: string): string => JSON.stringify({
  id, session_id: `s${day}`, created_at: `2026-09-${day}T10:00:00+03:00`, agent: 't', summary, details: '', files, decisions: [], open_threads: [],
});

/** A model that answers each curator prompt the way a careful model would, unless told otherwise. */
export class ScriptedRunner implements ModelRunner {
  readonly prompts: string[] = [];
  constructor(private readonly override: (prompt: string) => string | Error | undefined = () => undefined) {}

  async run(prompt: string): Promise<ModelResult> {
    this.prompts.push(prompt);
    const answer = this.override(prompt) ?? defaultAnswer(prompt);
    if (answer instanceof Error) throw answer;
    return { text: answer, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.01 } };
  }
}

function defaultAnswer(prompt: string): string {
  if (prompt.includes('"Current state" block')) {
    const first = /NEW RECORDS, oldest first:\n- memory:([0-9a-f]{16})/.exec(prompt)?.[1] ?? '';
    return JSON.stringify({ ops: [{ op: 'append', text: 'Alpha runs bbb222 — since 28/09', cites: [`memory:${first}`] }] });
  }
  if (prompt.includes('A line of an agent memory index')) {
    const line = /LINE:\n(.*)\n/.exec(prompt)?.[1] ?? '';
    const [first, ...rest] = [...line.matchAll(/\[[^\]]*\]\([^)]*\)/g)].map((match) => match[0]);
    return JSON.stringify({ line: `- ${first ?? ''} — production on bbb222 since 28/09${rest.length ? ` · ${rest.join(' · ')}` : ''}` });
  }
  return JSON.stringify({ current_state: '- second state, since 28/09' });
}

/** A runtime with one curated project page, a memory index, and three records (the third out of scope). */
export function makeRuntime(): string {
  const home = mkdtempSync(join(tmpdir(), 'asm-curator-'));
  const files: Record<string, string> = {
    'asm-paths.json': JSON.stringify({ vault: join(home, 'vault'), repo: '' }),
    'jobs/config.json': JSON.stringify({ memory_dir: join(home, 'mem'), project_map: join(home, 'project-map.json') }),
    'jobs/curated.json': JSON.stringify({ projects: [{ project: 'alpha', page: 'vault:alpha', index_lines: ['idx:MEMORY.md:alpha-notes.md'] }] }),
    'project-map.json': JSON.stringify({ projects: { alpha: { repo_prefixes: ['Projects/alpha/'] } } }),
    'vault/wiki/main/projects/alpha.md': PAGE,
    'mem/MEMORY.md': INDEX,
    'mem/alpha-notes.md': '---\nname: alpha-notes\n---\nAlpha notes.\n',
    'mem/gamma.md': GAMMA,
    'memory.jsonl': [
      record(R1, 20, ['/home/dev/work/Projects/alpha/src/a.ts'], 'Alpha deployed aaa111'),
      record(R2, 28, ['Projects/alpha/src/b.ts'], 'Alpha deployed bbb222'),
      record(R3, 28, ['Projects/beta/x.ts'], 'Beta work'),
    ].join('\n'),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}

export async function curatorFor(home: string, runner: ModelRunner): Promise<{
  curator: Curator; ledger: LedgerStore; proposals: ProposalStore; trust: TrustStore; applier: Applier;
}> {
  const layout = await loadLayout(home);
  const ledger = new LedgerStore(layout.ledger);
  const proposals = new ProposalStore(join(home, 'jobs', 'proposals'));
  const trust = new TrustStore(join(home, 'jobs', 'trust.json'));
  const applier = new Applier(ledger);
  const curator = new Curator({
    layout, memory: new MemoryStore(layout.memory), vault: new VaultStore(layout.vault), ledger, runner, trust, proposals, applier,
    now: () => new Date('2026-09-29T12:00:00Z'),
  }, { dryRun: false, maxPages: 10 });
  return { curator, ledger, proposals, trust, applier };
}
