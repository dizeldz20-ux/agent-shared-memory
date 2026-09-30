import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DeferredError } from '../apply/apply.errors.js';
import { readText, sha256 } from '../apply/files.js';
import { setFrontmatterFields } from '../apply/frontmatter.js';
import type { FileEdit } from '../apply/proposal.types.js';
import { runGate, type ThreadLabel } from '../janitor/gate.js';
import type { Composed } from './compose.js';
import { selectProposals } from './select.js';

export async function review(c: Composed): Promise<unknown> {
  const pending = await c.proposals.pending();
  const classes = [...new Set(pending.map((p) => p.class))].sort();
  const quarantined = [...(await c.items.load())].filter(([, state]) => state.quarantined)
    .map(([id, state]) => ({ id, failures: state.failures, last_checked_at: state.last_checked_at }));
  const groups = await Promise.all(classes.map(async (cls) => {
    const items = pending.filter((p) => p.class === cls);
    return {
      class: cls, mode: await c.trust.modeFor(cls), count: items.length,
      items: items.map((p) => ({ id: p.id, run_id: p.run_id, summary: p.summary, target: p.op.target.id, evidence: p.op.evidence ?? [], reason: p.op.reason })),
    };
  }));
  // Items that failed three times are skipped by every run (spec §12); the owner sees them here.
  return quarantined.length === 0 ? groups : [...groups, { class: 'quarantined', count: quarantined.length, items: quarantined }];
}

/** The lines a change removes and adds (a line diff over the longest common subsequence), so a
 *  wrong line is never buried among unchanged ones. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if (x.length * y.length > 25_000_000) return { removed: x, added: y };
  const width = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = x[i] === y[j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i += 1; j += 1; } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) removed.push(x[i++] ?? '');
    else added.push(y[j++] ?? '');
  }
  return { removed: [...removed, ...x.slice(i)], added: [...added, ...y.slice(j)] };
}

async function fileChange(edit: FileEdit): Promise<Record<string, unknown>> {
  const current = (await readText(edit.path)) ?? '';
  const changed_since = sha256(current) !== edit.sha256;
  if (edit.kind === 'archive_move') return { path: edit.path, changed_since, moves_to: edit.archive_to ?? '' };
  const next = edit.kind === 'frontmatter' ? setFrontmatterFields(current, edit.fields ?? {}) : edit.after_text ?? current;
  return { path: edit.path, changed_since, ...changedLines(current, next) };
}

/** One pending proposal with the lines it would remove and add in every file it touches. */
export async function show(c: Composed, id: string): Promise<unknown> {
  const proposal = (await c.proposals.pending()).find((p) => p.id === id);
  if (proposal === undefined) return { error: `no pending proposal ${id}` };
  const edits = [proposal.file_edit, ...(proposal.companions ?? []).map((companion) => companion.file_edit)]
    .filter((edit): edit is FileEdit => edit !== undefined);
  const files: Record<string, unknown>[] = [];
  for (const edit of edits) files.push(await fileChange(edit));
  return { id, class: proposal.class, summary: proposal.summary, reason: proposal.op.reason, evidence: proposal.op.evidence ?? [], files };
}

export async function apply(c: Composed, selectors: readonly string[]): Promise<unknown> {
  const chosen = selectProposals(await c.proposals.pending(), selectors);
  const results: { id: string; ok: boolean; detail: string }[] = [];
  for (const proposal of chosen) {
    try {
      const op = await c.applier.apply(proposal, 'approved');
      await c.proposals.decide(proposal.run_id, [proposal.id], 'applied');
      results.push({ id: proposal.id, ok: true, detail: op.id });
    } catch (error: unknown) {
      if (!(error instanceof DeferredError)) throw error;
      // Out of the queue: the next run rebuilds it on the file as it is now.
      await c.proposals.decide(proposal.run_id, [proposal.id], 'deferred');
      results.push({ id: proposal.id, ok: false, detail: error.message });
    }
  }
  const stillPending = await c.proposals.pending();
  const pairs = new Set(chosen.map((p) => `${p.run_id}|${p.class}`));
  const promoted: string[] = [];
  for (const pair of pairs) {
    const [runId, cls] = pair.split('|') as [string, string];
    if (stillPending.some((p) => p.run_id === runId && p.class === cls)) continue;
    // Clean means the owner approved every proposal of the class in that run: a rejection spoils it.
    if ((await c.proposals.run(runId)).some((p) => p.class === cls && p.status === 'rejected')) continue;
    const before = await c.trust.modeFor(cls);
    await c.trust.recordReview(cls, 'approved_clean');
    if (before === 'propose' && (await c.trust.modeFor(cls)) === 'auto' && !promoted.includes(cls)) promoted.push(cls);
  }
  return { results, promoted };
}

export async function reject(c: Composed, selectors: readonly string[]): Promise<unknown> {
  const chosen = selectProposals(await c.proposals.pending(), selectors);
  for (const proposal of chosen) {
    // A rejected correction closes its request; otherwise every run would propose it again.
    if (proposal.op.applies !== undefined) {
      await c.ledger.append({ ...proposal.op, mode: 'rejected', class: proposal.class, reason: `rejected by the owner: ${proposal.op.reason}`,
        actor: { kind: 'owner', name: 'owner' } });
    }
    await c.proposals.decide(proposal.run_id, [proposal.id], 'rejected');
  }
  for (const cls of new Set(chosen.map((p) => p.class))) await c.trust.recordReview(cls, 'rejected');
  return { rejected: chosen.map((p) => p.id) };
}

export async function restore(c: Composed, opId: string, reason: string): Promise<unknown> {
  const original = (await c.ledger.load()).find((op) => op.id === opId);
  const op = await c.applier.restore(opId, reason);
  if (original?.mode === 'auto' && original.class) await c.trust.recordReview(original.class, 'restored');
  return { restored: opId, op: op.id };
}

const labelsSchema = z.object({ threads: z.array(z.object({
  thread_id: z.string(), text: z.string().catch(''), resolved_by: z.string().nullable().catch(null),
  label: z.enum(['resolved', 'still_open', 'not_actionable', 'unknown']),
})) });

export async function gate(c: Composed, labelsPath: string): Promise<unknown> {
  const labels: ThreadLabel[] = labelsSchema.parse(JSON.parse(await readFile(labelsPath, 'utf8'))).threads;
  const { result, rows } = await runGate(labels, await c.memory.load(), c.judge, {
    threshold: 0.95, minJudged: 8, batchSize: c.layout.config.janitor.batch_size, model: c.layout.config.judge_model,
  });
  await c.trust.setGate(result);
  await writeFile(join(c.layout.jobs, `gate-${result.at.slice(0, 10)}.json`), `${JSON.stringify({ result, rows }, null, 2)}\n`);
  return result;
}

export async function status(c: Composed): Promise<unknown> {
  const pending = await c.proposals.pending();
  return { jobs: await c.state.load(), pending: pending.length, gate: await c.trust.gate() };
}
