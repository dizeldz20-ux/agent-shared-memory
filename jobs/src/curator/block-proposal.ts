import { readFile } from 'node:fs/promises';
import { sha256 } from '../apply/files.js';
import type { VaultPage } from '../store/store.types.js';
import { CURATOR, type Built, type CuratorContext } from './curator.types.js';
import { blockPrompt } from './prompts.js';
import { parseOps } from './replies.js';
import { projectOf, type CuratedProject } from './scope.js';
import { applyOps, readBlock, writeBlock, type StateBlock } from './state-block.js';

const BUDGET = 1500;
const FIRST_BUILD_DAYS = 30;
const time = (iso: string | undefined): number => Date.parse(iso ?? '');

/** The latest of the given timestamps, as written. */
const latest = (stamps: readonly string[]): string => stamps.reduce((best, stamp) => (time(stamp) > time(best) || best === '' ? stamp : best), '');

/**
 * Bring one project page's current-state block up to date. A block is stale when an in-scope
 * record is newer than its watermark, or a record it cites was retired after it; a block that is
 * not stale is never sent to the model. `current` is the block after this run (new or unchanged).
 */
export async function blockProposal(ctx: CuratorContext, project: CuratedProject, page: VaultPage, touched: Set<string>):
  Promise<Built & { current?: StateBlock; onPage?: StateBlock }> {
  const text = await readFile(page.path, 'utf8');
  const read = readBlock(text);
  if (read.problem) return { skipped: `${project.page}: ${read.problem}` };
  const block = read.block;
  const same = { current: block, onPage: block };
  if (ctx.waiting.has(`block.refresh|${project.page}`)) return same;
  if (touched.has(page.path)) return { ...same, skipped: `${project.page}: the page already changes in this run or waits for the owner` };
  const firstBuild = block === undefined || block.bullets.length === 0;
  const watermark = time(block?.at);
  const from = Number.isNaN(watermark) ? ctx.now.getTime() - FIRST_BUILD_DAYS * 86_400_000 : watermark;
  const cited = [...new Set(block?.bullets.flatMap((bullet) => bullet.cites) ?? [])];
  const retracted = cited.filter((id) => ctx.life.hidden('record', id) && time(ctx.life.state('record', id)?.at) > from);
  const inScope = ctx.records.filter((r) => !ctx.life.hidden('record', r.id) && time(r.created_at) > from
    && projectOf(r, ctx.scope, ctx.sessionFiles) === project.project).sort((a, b) => time(a.created_at) - time(b.created_at));
  // A first build takes the newest records; a refresh catches up oldest first, so the watermark
  // never passes a record the model was not shown.
  const input = firstBuild ? inScope.slice(-40) : inScope.slice(0, 25);
  if (input.length === 0 && retracted.length === 0) return same;
  const reply = await ctx.ask(blockPrompt(project.project, block, input, retracted));
  const ops = reply === undefined ? undefined : parseOps(reply);
  if (ops === undefined) return { ...same, skipped: `${project.page}: no usable model answer` };
  const allowed = new Set([...input.map((r) => r.id), ...cited.filter((id) => !retracted.includes(id))]);
  const recordAt = new Map(ctx.records.map((r): [string, number] => [r.id, time(r.created_at) || 0]));
  const recency = (cites: readonly string[]): number => Math.max(0, ...cites.map((id) => recordAt.get(id) ?? 0));
  const applied = applyOps(block ?? { seen: '', at: '', bullets: [] }, ops, allowed, BUDGET, recency);
  if ('error' in applied) return { ...same, skipped: `${project.page}: ${applied.error}` };
  // A retraction is not advisory: a bullet whose every citation was retired goes, whatever the model kept.
  const bullets = applied.block.bullets.filter((bullet) => bullet.cites.length === 0 || bullet.cites.some((id) => !ctx.life.hidden('record', id)));
  if (bullets.length === 0) return { ...same, skipped: `${project.page}: the block would be empty` };
  const newest = input.at(-1);
  const at = latest([block?.at ?? '', newest?.created_at ?? '', ...retracted.map((id) => ctx.life.state('record', id)?.at ?? '')]);
  const next: StateBlock = { ...applied.block, bullets, seen: newest ? `memory:${newest.id}` : block?.seen ?? '', at };
  touched.add(page.path);
  return {
    current: next, onPage: block, firstBuild,
    proposal: {
      id: `p_${sha256(`${ctx.runId}|block|${project.page}`).slice(0, 12)}`, run_id: ctx.runId, class: 'block.refresh', status: 'pending',
      summary: `${block ? 'refresh' : 'first build of'} the current state of ${project.project}: ${next.bullets.length} bullets from ${input.length} new records${retracted.length ? ` and ${retracted.length} retracted` : ''}`,
      created_at: ctx.now.toISOString(),
      op: { op: 'compact', target: { kind: 'page', id: project.page }, reason: `the current state of ${project.project}`,
        evidence: [...input.slice(-10), ...retracted.map((id) => ({ id }))].map((r) => `memory:${r.id}`), actor: CURATOR },
      file_edit: { kind: 'replace', path: page.path, sha256: sha256(text), after_text: writeBlock(text, next) },
    },
  };
}
