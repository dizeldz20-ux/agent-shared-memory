import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256 } from '../apply/files.js';
import { isHub } from '../store/runtime-layout.js';
import type { Companion } from '../apply/proposal.types.js';
import type { Target } from '../ledger/ledger.types.js';
import { CURATOR, type Built, type CuratorContext } from './curator.types.js';
import { datedSegments } from './dated.js';
import { addHistory } from './history.js';
import { indexLinePrompt } from './prompts.js';
import { parseLine } from './replies.js';

const LINK = /^- \[[^\]]*\]\(([^)\s/\\]+\.md)\)/;
const MAX_TAIL = 303; // 300 characters after " — " (spec §10.5)

export interface IndexFile {
  readonly name: string;
  readonly path: string;
  readonly target: Target;
}

/** What an index line's project says now, and whether its block changed in this run. */
export interface LineContext {
  readonly state: string;
  readonly changed: boolean;
}

/** The memory index and the hub pages: every line there that links a memory file is curated. */
export function indexFiles(ctx: CuratorContext): IndexFile[] {
  const dir = ctx.layout.config.memory_dir;
  if (!dir) return [];
  const hubs = ctx.pages.filter((page) => isHub(page.rel, ctx.layout.config));
  return [
    { name: 'MEMORY.md', path: join(dir, 'MEMORY.md'), target: { kind: 'memory_file', id: 'mem:MEMORY.md' } },
    ...hubs.map((page): IndexFile => ({ name: basename(page.path), path: page.path, target: { kind: 'page', id: `vault:${page.id}` } })),
  ];
}

function checkLine(line: string, link: string, next: string): string | undefined {
  if (next.includes('\n')) return 'the rewrite is more than one line';
  if (!next.startsWith(link)) return 'the rewrite changed the link';
  const targets = [...line.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => `](${match[1] ?? ''})`);
  if (targets.some((target) => !next.includes(target))) return 'the rewrite dropped a link';
  if (next.length - link.length > MAX_TAIL) return 'the rewrite is over 300 characters';
  return undefined;
}

/**
 * One proposal per index file. A line with two or more dated segments, or one whose project block
 * changed in this run, becomes one line of current state; its old text moves into the memory file's
 * History in the same proposal. A memory file is changed by one proposal per run (`touched`).
 */
export async function indexProposal(ctx: CuratorContext, file: IndexFile, context: ReadonlyMap<string, LineContext>,
  touched: Set<string>, budget: { left: number }): Promise<Built[]> {
  if (ctx.waiting.has(`index.rewrite|${file.target.id}`) || touched.has(file.path)) return [];
  const text = await readFile(file.path, 'utf8').catch(() => undefined);
  const dir = ctx.layout.config.memory_dir;
  if (text === undefined) return [];
  const lines = text.split('\n');
  const out: Built[] = [];
  const companions: Companion[] = [];
  for (let i = 0; i < lines.length && budget.left > 0; i += 1) {
    const line = lines[i] ?? '';
    const link = LINK.exec(line);
    if (!link?.[1]) continue;
    const idx = `idx:${file.name}:${link[1]}`;
    const project = context.get(idx);
    if (datedSegments(line) < 2 && !project?.changed) continue;
    const memPath = join(dir, link[1]);
    if (touched.has(memPath)) { out.push({ skipped: `${idx}: its memory file already changes in this run` }); continue; }
    const memText = await readFile(memPath, 'utf8').catch(() => undefined);
    if (memText === undefined) { out.push({ skipped: `${idx}: no memory file ${link[1]}` }); continue; }
    budget.left -= 1;
    const reply = await ctx.ask(indexLinePrompt(line, memText, project?.state));
    const next = reply === undefined ? undefined : parseLine(reply);
    const problem = next === undefined ? 'no usable model answer' : checkLine(line, link[0], next);
    if (problem !== undefined || next === undefined) { out.push({ skipped: `${idx}: ${problem}` }); continue; }
    lines[i] = next;
    touched.add(memPath);
    const old = line.slice(link[0].length).replace(/^\s*[—–-]\s*/, '');
    companions.push({
      op: { op: 'compact', target: { kind: 'memory_file', id: `mem:${link[1]}` }, reason: `the dated text of its ${file.name} line, moved here`, actor: CURATOR },
      file_edit: { kind: 'replace', path: memPath, sha256: sha256(memText),
        after_text: addHistory(memText, `- ${ctx.now.toISOString().slice(0, 10)}, from the ${file.name} line: ${old}`) },
    });
  }
  if (companions.length === 0) return out;
  touched.add(file.path);
  out.push({ proposal: {
    id: `p_${sha256(`${ctx.runId}|index|${file.target.id}`).slice(0, 12)}`, run_id: ctx.runId, class: 'index.rewrite', status: 'pending',
    summary: `${companions.length} line(s) of ${file.name} rewritten as current state; their dated text moves to the memory files' History`,
    created_at: ctx.now.toISOString(),
    op: { op: 'compact', target: file.target, reason: `accreted lines of ${file.name}`, actor: CURATOR },
    file_edit: { kind: 'replace', path: file.path, sha256: sha256(text), after_text: lines.join('\n') },
    companions,
  } });
  return out;
}
