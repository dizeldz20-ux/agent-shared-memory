import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../apply/files.js';
import { bodyOf, compact, hasCurrentState } from './compaction.js';
import { CURATOR, type Built, type CuratorContext } from './curator.types.js';
import { datedSections } from './dated.js';
import { compactionPrompt } from './prompts.js';
import { parseCurrentState } from './replies.js';

const MAX_COMPACTIONS = 5;

/** Memory files that became logs (two or more dated sections), the most dated first, get a current state. */
export async function compactionProposals(ctx: CuratorContext, touched: Set<string>): Promise<Built[]> {
  const dir = ctx.layout.config.memory_dir;
  if (!dir) return [];
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort();
  const candidates: { name: string; path: string; text: string; sections: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (touched.has(path) || ctx.waiting.has(`memfile.compact|mem:${name}`)) continue;
    const text = await readFile(path, 'utf8');
    const sections = datedSections(bodyOf(text));
    if (sections >= 2 && !hasCurrentState(text)) candidates.push({ name, path, text, sections });
  }
  const out: Built[] = [];
  for (const file of [...candidates].sort((a, b) => b.sections - a.sections).slice(0, MAX_COMPACTIONS)) {
    const reply = await ctx.ask(compactionPrompt(file.text));
    const state = reply === undefined ? undefined : parseCurrentState(reply);
    const after = state === undefined ? undefined : compact(file.text, state, ctx.now.toISOString().slice(0, 10));
    if (after === undefined) { out.push({ skipped: `mem:${file.name}: no usable current state` }); continue; }
    touched.add(file.path);
    out.push({ proposal: {
      id: `p_${sha256(`${ctx.runId}|compact|${file.name}`).slice(0, 12)}`, run_id: ctx.runId, class: 'memfile.compact', status: 'pending',
      summary: `${file.name}: ${file.sections} dated updates get a current state on top; every line stays under History`,
      created_at: ctx.now.toISOString(),
      op: { op: 'compact', target: { kind: 'memory_file', id: `mem:${file.name}` }, reason: `${file.sections} dated updates accreted`, actor: CURATOR },
      file_edit: { kind: 'replace', path: file.path, sha256: sha256(file.text), after_text: after },
    } });
  }
  return out;
}
