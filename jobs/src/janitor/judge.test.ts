import { describe, expect, it } from 'vitest';
import type { ModelResult, ModelRunner } from '../model/model-runner.js';
import { ModelUnavailableError } from '../model/model.errors.js';
import type { MemoryRecord } from '../store/store.types.js';
import { Judge, type JudgeItem } from './judge.js';

class ScriptedRunner implements ModelRunner {
  readonly prompts: string[] = [];
  constructor(private readonly reply: string | Error) {}
  async run(prompt: string): Promise<ModelResult> {
    this.prompts.push(prompt);
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: null } };
  }
}

const record: MemoryRecord = {
  id: 'a000000000000001', session_id: 's', created_at: '2026-09-20T10:00:00+03:00', agent: 't', summary: 'Built T7',
  details: '', files: [], decisions: [], open_threads: ['deploy T7'],
};
const items: JudgeItem[] = [
  { candidate: { kind: 'thread', id: 'a000000000000001#0', text: 'deploy T7', record, index: 0 },
    evidence: [{ id: 'memory:a000000000000009', created_at: '2026-09-21T10:00:00+03:00', summary: 'Deployed T7', details: '', files: [], threads: [] }] },
  { candidate: { kind: 'record', id: 'a000000000000001', text: 'Built T7, not deployed', record },
    evidence: [{ id: 'memory:a000000000000009', created_at: '2026-09-21T10:00:00+03:00', summary: 'Deployed T7', details: '', files: [], threads: [] }] },
];

describe('Judge', () => {
  it('keeps verdicts that cite the item\'s own evidence', async () => {
    const reply = JSON.stringify({ items: [
      { item_id: 'a000000000000001#0', verdict: 'resolved', resolved_by: 'memory:a000000000000009', reason: 'deployed' },
      { item_id: 'a000000000000001', verdict: 'resolved', resolved_by: 'memory:ffffffffffffffff', reason: 'made up' },
    ] });
    const runner = new ScriptedRunner(`Here you go:\n\`\`\`json\n${reply}\n\`\`\``);
    const outcome = await new Judge(runner).judgeBatch(items);
    expect(outcome.judgements.map((j) => [j.item_id, j.verdict])).toEqual([
      ['a000000000000001#0', 'resolved'], ['a000000000000001', 'unknown'],
    ]);
    expect(outcome.failed).toEqual([]);
    expect(runner.prompts[0]).toContain('memory:a000000000000009');
  });

  it('drops any verdict that cites a record outside the item\'s evidence, not only resolved', async () => {
    const reply = JSON.stringify({ items: [
      { item_id: 'a000000000000001#0', verdict: 'not_actionable', resolved_by: 'memory:ffffffffffffffff', reason: 'made up' },
      { item_id: 'a000000000000001', verdict: 'not_actionable', resolved_by: null, reason: 'a caveat' },
    ] });
    const outcome = await new Judge(new ScriptedRunner(reply)).judgeBatch(items);
    expect(outcome.judgements.map((j) => j.verdict)).toEqual(['unknown', 'not_actionable']);
  });

  it('tells the model that deadlines, release steps and pending approvals are never not_actionable', async () => {
    const runner = new ScriptedRunner(JSON.stringify({ items: [] }));
    await new Judge(runner).judgeBatch(items);
    expect(runner.prompts[0]).toMatch(/Never for a dated deadline or expiry, a release step still to do/);
  });

  it('turns an item the model skipped into unknown', async () => {
    const reply = JSON.stringify({ items: [{ item_id: 'a000000000000001#0', verdict: 'still_open', resolved_by: null, reason: 'pending' }] });
    const outcome = await new Judge(new ScriptedRunner(reply)).judgeBatch(items);
    expect(outcome.judgements[1]?.verdict).toBe('unknown');
  });

  it('counts prose instead of JSON as a failure of every item', async () => {
    const outcome = await new Judge(new ScriptedRunner('I think both are probably done.')).judgeBatch(items);
    expect(outcome.judgements).toEqual([]);
    expect(outcome.failed).toEqual(['a000000000000001#0', 'a000000000000001']);
  });

  it('lets an unavailable model stop the run', async () => {
    await expect(new Judge(new ScriptedRunner(new ModelUnavailableError('429'))).judgeBatch(items))
      .rejects.toBeInstanceOf(ModelUnavailableError);
  });
});
