import { describe, expect, it } from 'vitest';
import type { ModelResult, ModelRunner } from '../model/model-runner.js';
import type { MemoryRecord } from '../store/store.types.js';
import { runGate, type ThreadLabel } from './gate.js';
import { Judge } from './judge.js';

class FixedRunner implements ModelRunner {
  constructor(private readonly verdicts: Readonly<Record<string, string>>) {}
  async run(prompt: string): Promise<ModelResult> {
    const ids = [...prompt.matchAll(/item_id: (\S+)\n[\s\S]*?EVIDENCE:\n {2}- (memory:\S+)/g)];
    const items = ids.map((m) => ({ item_id: m[1], verdict: this.verdicts[m[1] ?? ''] ?? 'unknown', resolved_by: m[2], reason: 'r' }));
    return { text: JSON.stringify({ items }), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: null } };
  }
}

const rec = (id: string, day: number, threads: string[] = []): MemoryRecord => ({
  id, session_id: 's', created_at: `2026-09-${day}T10:00:00+03:00`, agent: 't', summary: `record ${id}`, details: '',
  files: [], decisions: [], open_threads: threads,
});

describe('runGate', () => {
  const records = [
    rec('a000000000000001', 10, ['first', 'second', 'third']),
    rec('a000000000000002', 11),
  ];
  const labels: ThreadLabel[] = [
    { thread_id: 'a000000000000001#0', text: 'first', label: 'resolved', resolved_by: 'memory:a000000000000002' },
    { thread_id: 'a000000000000001#1', text: 'second', label: 'still_open', resolved_by: null },
    { thread_id: 'a000000000000001#2', text: 'third', label: 'not_actionable', resolved_by: null },
  ];

  it('measures precision on the verdicts that would close a thread, and ignores unknown ones', async () => {
    const judge = new Judge(new FixedRunner({ 'a000000000000001#0': 'resolved', 'a000000000000001#1': 'resolved', 'a000000000000001#2': 'unknown' }));
    const { result, rows } = await runGate(labels, records, judge, { threshold: 0.95, minJudged: 1, batchSize: 8, model: 'test' });
    expect(result).toMatchObject({ precision: 0.5, judged: 2, sample_size: 3, passed: false });
    expect(rows.find((row) => row.thread_id === 'a000000000000001#1')).toMatchObject({ verdict: 'resolved', correct: false });
  });

  it('measures each closing class on its own, so not_actionable needs its own precision', async () => {
    const more = [...records, rec('a000000000000003', 9, ['fourth'])];
    const judge = new Judge(new FixedRunner({ 'a000000000000001#0': 'resolved', 'a000000000000003#0': 'resolved', 'a000000000000001#1': 'not_actionable' }));
    const labelled: ThreadLabel[] = [...labels, { thread_id: 'a000000000000003#0', text: 'fourth', label: 'resolved', resolved_by: 'memory:a000000000000002' }];
    const { result } = await runGate(labelled, more, judge, { threshold: 0.95, minJudged: 2, batchSize: 8, model: 'test' });
    expect(result.classes).toEqual({
      resolved: { judged: 2, precision: 1, passed: true },
      not_actionable: { judged: 1, precision: 0, passed: false },
    });
  });

  it('passes when every closing verdict agrees with its label and enough were judged', async () => {
    const judge = new Judge(new FixedRunner({ 'a000000000000001#0': 'resolved', 'a000000000000001#2': 'not_actionable' }));
    const { result } = await runGate(labels, records, judge, { threshold: 0.95, minJudged: 2, batchSize: 8, model: 'test' });
    expect(result).toMatchObject({ precision: 1, judged: 2, passed: true });
  });
});
