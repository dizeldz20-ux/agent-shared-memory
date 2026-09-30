import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { everyLineKept } from './compaction.js';
import { curatorFor, GAMMA, INDEX, makeRuntime, R2, ScriptedRunner } from './curator.testkit.js';

describe('Curator: memory index, compaction and corrections', () => {
  let home = '';
  beforeEach(() => { home = makeRuntime(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('rewrites an accreted index line with its link kept exactly, and moves the old text into the memory file History', async () => {
    const { curator, proposals, applier, ledger } = await curatorFor(home, new ScriptedRunner());
    await curator.run('r1');
    const rewrite = (await proposals.pending()).find((p) => p.class === 'index.rewrite');
    expect(rewrite?.op.target.id).toBe('mem:MEMORY.md');
    await applier.apply(rewrite!, 'approved');
    expect(readFileSync(join(home, 'mem/MEMORY.md'), 'utf8')).toBe(
      '# Memory Index\n- [Alpha notes](alpha-notes.md) — production on bbb222 since 28/09 · [hub](other.md)\n- [Beta](beta.md) — plain line\n');
    const notes = readFileSync(join(home, 'mem/alpha-notes.md'), 'utf8');
    expect(notes).toContain('## History');
    expect(notes).toContain('**27/09: ייצור = `aaa111`; 28/09: ייצור = `bbb222`** · [hub](other.md)');
    expect((await ledger.load()).map((op) => op.target.id)).toEqual(['mem:MEMORY.md', 'mem:alpha-notes.md']);
  });

  it('keeps a line whose rewrite changed its link, and says so', async () => {
    const runner = new ScriptedRunner((p) => (p.includes('A line of an agent memory index') ? '{"line":"- [Alpha notes](alpha-renamed.md) — now"}' : undefined));
    const { curator, proposals } = await curatorFor(home, runner);
    const report = await curator.run('r1');
    expect((await proposals.pending()).some((p) => p.class === 'index.rewrite')).toBe(false);
    expect(report.skipped).toContain('idx:MEMORY.md:alpha-notes.md: the rewrite changed the link');
    expect(readFileSync(join(home, 'mem/MEMORY.md'), 'utf8')).toBe(INDEX);
  });

  it('compacts a memory file that became a log, keeping every line', async () => {
    const { curator, proposals } = await curatorFor(home, new ScriptedRunner());
    await curator.run('r1');
    const compact = (await proposals.pending()).find((p) => p.class === 'memfile.compact');
    expect(compact?.op.target.id).toBe('mem:gamma.md');
    const after = compact?.file_edit?.after_text ?? '';
    expect(after.indexOf('## Current state')).toBeLessThan(after.indexOf('## History'));
    expect(after).toContain('- second state, since 28/09');
    expect(everyLineKept(GAMMA, after)).toBe(true);
  });

  it('combines the corrections of one file into one proposal, closing every request it applies', async () => {
    const request = (id: string, claimed: string, truth: string): string => JSON.stringify({ id, ts: '2026-09-29T09:00:00+03:00', op: 'correct',
      mode: 'requested', target: { kind: 'page', id: 'vault:alpha' }, claimed, truth, reason: `correction requested by memory:${R2}` });
    writeFileSync(join(home, 'lifecycle.jsonl'), `${request('lc_00000000000000d1', 'keep me', 'kept')}\n${request('lc_00000000000000d2', 'Human intro', 'Owner intro')}\n`);
    const { curator, proposals, applier, ledger } = await curatorFor(home, new ScriptedRunner());
    await curator.run('r1');
    const fixes = (await proposals.pending()).filter((p) => p.class === 'correction.apply');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.file_edit?.after_text).toContain('Owner intro: kept.');
    await applier.apply(fixes[0]!, 'approved');
    const { fold } = await import('../ledger/fold.js');
    expect(fold(await ledger.load()).requested.size).toBe(0);
  });

  it('applies a requested correction verbatim and reports one whose claim is not in the file', async () => {
    const request = (id: string, target: string, claimed: string): string => JSON.stringify({ id, ts: '2026-09-29T09:00:00+03:00', op: 'correct',
      mode: 'requested', target: { kind: target.startsWith('mem:') ? 'memory_file' : 'page', id: target }, claimed, truth: 'Human intro: kept.',
      evidence: [`memory:${R2}`], reason: `correction requested by memory:${R2}` });
    writeFileSync(join(home, 'lifecycle.jsonl'), `${request('lc_00000000000000c1', 'vault:alpha', 'Human intro: keep me.')}\n${request('lc_00000000000000c2', 'mem:gamma.md', 'nowhere to be found')}\n`);
    const { curator, proposals } = await curatorFor(home, new ScriptedRunner());
    const report = await curator.run('r1');
    const fix = (await proposals.pending()).find((p) => p.class === 'correction.apply');
    expect(fix?.op).toMatchObject({ op: 'correct', applies: 'lc_00000000000000c1', target: { kind: 'page', id: 'vault:alpha' } });
    expect(fix?.file_edit?.after_text).toContain('Human intro: kept.');
    expect(fix?.file_edit?.after_text).toContain('corrected "Human intro: keep me." → "Human intro: kept."');
    expect(report.skipped).toContain('lc_00000000000000c2: the claimed text is not in mem:gamma.md verbatim');
  });
});
