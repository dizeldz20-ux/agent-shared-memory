import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256 } from '../apply/files.js';
import { isHub } from '../store/runtime-layout.js';
import type { LedgerOp, NewLedgerOp, Target } from '../ledger/ledger.types.js';
import { applyCorrection } from './corrections.js';
import { CURATOR, type Built, type CuratorContext } from './curator.types.js';

const MEMORY_FILE = /^mem:([^/\\]+\.md)$/;

/** The file a correction targets: a vault page, a memory file, or the index holding an index line. */
function targetPath(ctx: CuratorContext, target: Target): string | undefined {
  const dir = ctx.layout.config.memory_dir;
  if (target.kind === 'page') return ctx.pages.find((page) => `vault:${page.id}` === target.id)?.path;
  if (target.kind === 'memory_file') {
    const name = MEMORY_FILE.exec(target.id)?.[1];
    return dir && name ? join(dir, name) : undefined;
  }
  if (target.kind !== 'index_line') return undefined;
  const index = target.id.split(':')[1] ?? '';
  if (index === 'MEMORY.md') return dir ? join(dir, 'MEMORY.md') : undefined;
  return ctx.pages.find((page) => isHub(page.rel, ctx.layout.config) && basename(page.path) === index)?.path;
}

interface Group {
  readonly path: string;
  readonly text: string;
  readonly requests: LedgerOp[];
}

const fields = (request: LedgerOp): { claimed: string; truth: string; evidence: string[] } => ({
  claimed: typeof request.claimed === 'string' ? request.claimed : '',
  truth: typeof request.truth === 'string' ? request.truth : '',
  evidence: Array.isArray(request.evidence) ? request.evidence.filter((item) => typeof item === 'string') : [],
});

/** One proposal per file: its corrections applied in turn, each one's ledger op closing its request. */
function combine(ctx: CuratorContext, group: Group): Built[] {
  const out: Built[] = [];
  const applied: LedgerOp[] = [];
  let text = group.text;
  for (const request of group.requests) {
    const { claimed, truth, evidence } = fields(request);
    const next = applyCorrection(text, request.target, claimed, truth, evidence, ctx.now.toISOString().slice(0, 10));
    if (next === undefined) { out.push({ skipped: `${request.id}: the claimed text is not in ${request.target.id} verbatim` }); continue; }
    text = next;
    applied.push(request);
  }
  const opOf = (request: LedgerOp): Omit<NewLedgerOp, 'mode'> => {
    const { claimed, truth, evidence } = fields(request);
    return { op: 'correct', target: request.target, applies: request.id, claimed, truth, reason: `apply the correction ${request.id}`, evidence, actor: CURATOR };
  };
  const [first, ...rest] = applied;
  if (first === undefined) return out;
  out.push({ proposal: {
    id: `p_${sha256(`${ctx.runId}|correct|${group.path}`).slice(0, 12)}`, run_id: ctx.runId, class: 'correction.apply', status: 'pending',
    summary: `${first.target.id}: ${applied.map((request) => `"${fields(request).claimed.slice(0, 60)}" → "${fields(request).truth.slice(0, 60)}"`).join('; ')}`,
    created_at: ctx.now.toISOString(), op: opOf(first),
    file_edit: { kind: 'replace', path: group.path, sha256: sha256(group.text), after_text: text },
    ...(rest.length > 0 ? { companions: rest.map((request) => ({ op: opOf(request) })) } : {}),
  } });
  return out;
}

/** Every correction an agent filed that is still pending, applied verbatim (one proposal per file) or reported. */
export async function correctionProposals(ctx: CuratorContext, touched: Set<string>): Promise<Built[]> {
  const out: Built[] = [];
  const groups = new Map<string, Group>();
  for (const request of ctx.life.requested.values()) {
    if (ctx.waiting.has(`correction.apply|${request.target.id}`)) continue;
    const path = targetPath(ctx, request.target);
    const text = path === undefined ? undefined : await readFile(path, 'utf8').catch(() => undefined);
    if (path === undefined || text === undefined) { out.push({ skipped: `${request.id}: no file for ${request.target.id}` }); continue; }
    if (touched.has(path)) { out.push({ skipped: `${request.id}: ${request.target.id} already changes in this run or waits for the owner` }); continue; }
    const group = groups.get(path) ?? { path, text, requests: [] };
    group.requests.push(request);
    groups.set(path, group);
  }
  for (const group of groups.values()) {
    const built = combine(ctx, group);
    if (built.some((item) => item.proposal !== undefined)) touched.add(group.path);
    out.push(...built);
  }
  return out;
}
