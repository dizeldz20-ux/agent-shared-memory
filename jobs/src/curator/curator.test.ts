import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelUnavailableError } from '../model/model.errors.js';
import { curatorFor, makeRuntime, PAGE, R1, R2, R3, ScriptedRunner } from './curator.testkit.js';

const blockPrompts = (runner: ScriptedRunner): string[] => runner.prompts.filter((p) => p.includes('"Current state" block'));
const withBlock = (at: string, bullets: string): string => PAGE.replace('# Alpha\n',
  `# Alpha\n<!-- asm:state begin seen=memory:${R2} at=${at} -->\n## Current state\n${bullets}<!-- asm:state end -->\n`);

describe('Curator: project blocks', () => {
  let home = '';
  let page = '';
  beforeEach(() => { home = makeRuntime(); page = join(home, 'vault/wiki/main/projects/alpha.md'); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('proposes a first build even for a trusted class, and applying it keeps every byte outside the block', async () => {
    writeFileSync(join(home, 'jobs/trust.json'), JSON.stringify({ classes: { 'block.refresh': { approved_runs: 3, promoted: true, demoted: false } } }));
    const runner = new ScriptedRunner();
    const { curator, proposals, applier } = await curatorFor(home, runner);
    await curator.run('r1');
    const prompt = blockPrompts(runner)[0] ?? '';
    expect(prompt).toContain(`memory:${R1}`);
    expect(prompt).toContain(`memory:${R2}`);
    expect(prompt).not.toContain(`memory:${R3}`);
    const block = (await proposals.pending()).find((p) => p.class === 'block.refresh');
    expect(block?.op.target.id).toBe('vault:alpha');
    expect(readFileSync(page, 'utf8')).toBe(PAGE);
    await applier.apply(block!, 'approved');
    const after = readFileSync(page, 'utf8');
    expect(after).toContain(`<!-- asm:state begin seen=memory:${R2} at=2026-09-28T10:00:00+03:00 -->`);
    expect(after).toMatch(/- Alpha runs bbb222 — since 28\/09 · memory:a000000000000001 \^s-[0-9a-f]{6}\n/);
    expect(after.replace(/\n<!-- asm:state begin[\s\S]*?<!-- asm:state end -->\n/, '')).toBe(PAGE);
  });

  it('sends only records past the watermark, and a reply citing anything else changes nothing', async () => {
    writeFileSync(page, withBlock('2026-09-25T10:00:00+03:00', `- Alpha runs aaa111 · memory:${R1} ^s-aaaaaa\n`));
    const runner = new ScriptedRunner((p) => (p.includes('"Current state" block')
      ? JSON.stringify({ ops: [{ op: 'append', text: 'Beta is live', cites: [R3] }] }) : undefined));
    const { curator, proposals } = await curatorFor(home, runner);
    const report = await curator.run('r1');
    const input = (blockPrompts(runner)[0] ?? '').split('NEW RECORDS')[1] ?? '';
    expect(input).toContain(`memory:${R2}`);
    expect(input).not.toContain(`memory:${R1}`);
    expect((await proposals.pending()).some((p) => p.class === 'block.refresh')).toBe(false);
    expect(report.skipped).toContain('vault:alpha: every operation was dropped');
  });

  it('refreshes on a retraction after the watermark, and not on one before it', async () => {
    const bullets = `- Alpha runs aaa111 · memory:${R1} ^s-aaaaaa\n- Alpha runs bbb222 · memory:${R2} ^s-bbbbbb\n`;
    writeFileSync(page, withBlock('2026-09-28T12:00:00+03:00', bullets));
    const retire = (ts: string): string => `${JSON.stringify({ id: 'lc_0000000000000001', ts, op: 'retire', target: { kind: 'record', id: R1 }, reason: 'wrong', mode: 'approved' })}\n`;
    writeFileSync(join(home, 'lifecycle.jsonl'), retire('2026-09-27T09:00:00+03:00'));
    const quiet = new ScriptedRunner();
    await (await curatorFor(home, quiet)).curator.run('r1');
    expect(blockPrompts(quiet)).toEqual([]);
    writeFileSync(join(home, 'lifecycle.jsonl'), retire('2026-09-29T09:00:00+03:00'));
    const runner = new ScriptedRunner((p) => (p.includes('"Current state" block') ? '{"ops":[{"op":"remove","block_id":"s-aaaaaa"}]}' : undefined));
    const { curator, proposals } = await curatorFor(home, runner);
    await curator.run('r2');
    expect(blockPrompts(runner)[0]).toContain(`RETRACTED RECORDS (a bullet resting only on these must go): memory:${R1}`);
    const block = (await proposals.pending()).find((p) => p.class === 'block.refresh');
    expect(block?.file_edit?.after_text).not.toContain('^s-aaaaaa');
    expect(block?.file_edit?.after_text).toContain('^s-bbbbbb');
  });

  it('counts a record that names repo-relative files for the project its session touched', async () => {
    const extra = JSON.stringify({ id: 'a000000000000004', session_id: 'wt-1', created_at: '2026-09-28T12:00:00+03:00', agent: 't',
      summary: 'Alpha stage 20 built in a worktree', details: '', files: ['server/stage20.ts'], decisions: [], open_threads: [] });
    writeFileSync(join(home, 'memory.jsonl'), `${readFileSync(join(home, 'memory.jsonl'), 'utf8')}\n${extra}`);
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'wt-1.json'), JSON.stringify({ session_id: 'wt-1', files: ['/w/Projects/alpha/server/stage20.ts'] }));
    const runner = new ScriptedRunner();
    await (await curatorFor(home, runner)).curator.run('r1');
    expect(blockPrompts(runner)[0]).toContain('memory:a000000000000004');
  });

  it('drops a bullet whose every citation was retracted, even when the model keeps it', async () => {
    writeFileSync(page, withBlock('2026-09-28T12:00:00+03:00', `- Alpha runs aaa111 · memory:${R1} ^s-aaaaaa\n- Alpha runs bbb222 · memory:${R2} ^s-bbbbbb\n`));
    writeFileSync(join(home, 'lifecycle.jsonl'), `${JSON.stringify({ id: 'lc_0000000000000001', ts: '2026-09-29T09:00:00+03:00', op: 'retire', target: { kind: 'record', id: R1 }, reason: 'wrong', mode: 'approved' })}\n`);
    const runner = new ScriptedRunner((p) => (p.includes('"Current state" block') ? '{"ops":[]}' : undefined));
    const { curator, proposals } = await curatorFor(home, runner);
    await curator.run('r1');
    const after = (await proposals.pending()).find((p) => p.class === 'block.refresh')?.file_edit?.after_text ?? '';
    expect(after).not.toContain('^s-aaaaaa');
    expect(after).toContain('^s-bbbbbb');
  });

  it('catches up oldest first after the watermark, so no record is skipped', async () => {
    writeFileSync(page, withBlock('2026-09-01T00:00:00+03:00', `- Alpha began · memory:${R1} ^s-aaaaaa\n`));
    const extra = Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: `e0000000000000${String(i).padStart(2, '0')}`, session_id: 'x',
      created_at: `2026-09-02T${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00+03:00`, agent: 't',
      summary: `alpha step ${i}`, details: '', files: ['Projects/alpha/s.ts'], decisions: [], open_threads: [] }));
    writeFileSync(join(home, 'memory.jsonl'), extra.join('\n'));
    const runner = new ScriptedRunner();
    const { curator, proposals } = await curatorFor(home, runner);
    await curator.run('r1');
    const prompt = blockPrompts(runner)[0] ?? '';
    expect(prompt).toContain('alpha step 0');
    expect(prompt).not.toContain('alpha step 29');
    expect((await proposals.pending()).find((p) => p.class === 'block.refresh')?.file_edit?.after_text).toContain('seen=memory:e000000000000024');
  });

  it('treats an empty block as a first build that waits for the owner', async () => {
    writeFileSync(join(home, 'jobs/trust.json'), JSON.stringify({ classes: { 'block.refresh': { approved_runs: 3, promoted: true, demoted: false } } }));
    writeFileSync(page, withBlock('2026-09-25T10:00:00+03:00', ''));
    const { curator, proposals } = await curatorFor(home, new ScriptedRunner());
    await curator.run('r1');
    expect((await proposals.pending()).some((p) => p.class === 'block.refresh')).toBe(true);
    expect(readFileSync(page, 'utf8')).not.toContain('Alpha runs bbb222');
  });

  it('skips a hand-edited block with a warning and never sends it to the model', async () => {
    writeFileSync(page, `${withBlock('2026-09-25T10:00:00+03:00', `- a · memory:${R1} ^s-aaaaaa\n`)}<!-- asm:state begin seen= at= -->\n`);
    const runner = new ScriptedRunner();
    const report = await (await curatorFor(home, runner)).curator.run('r1');
    expect(blockPrompts(runner)).toEqual([]);
    expect(report.skipped).toContain('vault:alpha: duplicated or unbalanced asm:state markers');
  });

  it('does not ask the model again about a target whose proposal still waits', async () => {
    const runner = new ScriptedRunner();
    const { curator } = await curatorFor(home, runner);
    await curator.run('r1');
    const calls = runner.prompts.length;
    expect(calls).toBeGreaterThan(0);
    await curator.run('r2');
    expect(runner.prompts.length).toBe(calls);
  });

  it('stops asking at an unavailable model and still files what needs no model', async () => {
    writeFileSync(join(home, 'lifecycle.jsonl'), `${JSON.stringify({ id: 'lc_00000000000000c1', ts: '2026-09-29T09:00:00+03:00', op: 'correct', mode: 'requested',
      target: { kind: 'page', id: 'vault:alpha' }, claimed: 'keep me', truth: 'kept', reason: `correction requested by memory:${R2}` })}\n`);
    const runner = new ScriptedRunner(() => new ModelUnavailableError('rate limited'));
    const { curator, proposals } = await curatorFor(home, runner);
    const report = await curator.run('r1');
    expect(runner.prompts.length).toBe(1);
    expect(report.stopped).toBe('rate limited');
    expect(report.degraded).toBe('stopped: rate limited');
    expect((await proposals.pending()).map((p) => p.class)).toEqual(['correction.apply']);
  });
});
