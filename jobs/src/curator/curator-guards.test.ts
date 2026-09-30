import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../apply/files.js';
import { curatorFor, GAMMA, makeRuntime, R2, ScriptedRunner } from './curator.testkit.js';

const indexPrompts = (runner: ScriptedRunner): string[] => runner.prompts.filter((p) => p.includes('A line of an agent memory index'));
const compactionPrompts = (runner: ScriptedRunner): string[] => runner.prompts.filter((p) => p.includes('This memory file accumulated'));

describe('Curator: guards found on live data', () => {
  let home = '';
  beforeEach(() => { home = makeRuntime(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('sends the whole memory file, and says the newest dated statement wins wherever it sits', async () => {
    writeFileSync(join(home, 'mem/alpha-notes.md'), `---\nname: alpha-notes\n---\nAlpha notes.\n${'old line\n'.repeat(600)}## 29/09\nLATEST: deployed zz9\n`);
    writeFileSync(join(home, 'mem/gamma.md'), `${GAMMA}${'filler\n'.repeat(2500)}## 29/09\nNEWEST gamma state\n`);
    const runner = new ScriptedRunner();
    await (await curatorFor(home, runner)).curator.run('r1');
    expect(indexPrompts(runner)[0]).toContain('LATEST: deployed zz9');
    expect(indexPrompts(runner)[0]).toMatch(/newest dated statement wins wherever it sits/);
    expect(compactionPrompts(runner)[0]).toContain('NEWEST gamma state');
  });

  it('never feeds an unapproved block into an index line', async () => {
    const runner = new ScriptedRunner();
    await (await curatorFor(home, runner)).curator.run('r1');
    expect(indexPrompts(runner)[0]).not.toContain('Alpha runs bbb222');
  });

  it('keeps every link of an index line and its length limit, or leaves the line as it is', async () => {
    for (const [line, why] of [
      ['- [Alpha notes](alpha-notes.md) — now bbb222', 'the rewrite dropped a link'],
      [`- [Alpha notes](alpha-notes.md) — ${'x'.repeat(300)} · [hub](other.md)`, 'the rewrite is over 300 characters'],
    ] as const) {
      const fresh = makeRuntime();
      const runner = new ScriptedRunner((p) => (p.includes('A line of an agent memory index') ? JSON.stringify({ line }) : undefined));
      const report = await (await curatorFor(fresh, runner)).curator.run('r1');
      expect(report.skipped).toContain(`idx:MEMORY.md:alpha-notes.md: ${why}`);
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('lets a pending proposal whose file changed leave the queue, and rebuilds its target', async () => {
    const { curator, proposals } = await curatorFor(home, new ScriptedRunner());
    await curator.run('r1');
    const first = (await proposals.pending()).find((p) => p.class === 'memfile.compact');
    writeFileSync(join(home, 'mem/gamma.md'), `${GAMMA}## 30/09\nan edit from a live session\n`);
    await curator.run('r2');
    const now = (await proposals.pending()).filter((p) => p.class === 'memfile.compact');
    expect(now.map((p) => p.id)).not.toContain(first?.id);
    expect(now.map((p) => p.file_edit?.sha256)).toEqual([sha256(readFileSync(join(home, 'mem/gamma.md'), 'utf8'))]);
  });

  it('proposes nothing more for a file a pending proposal already touches', async () => {
    writeFileSync(join(home, 'lifecycle.jsonl'), `${JSON.stringify({ id: 'lc_00000000000000c3', ts: '2026-09-29T09:00:00+03:00', op: 'correct',
      mode: 'requested', target: { kind: 'memory_file', id: 'mem:gamma.md' }, claimed: 'first state', truth: 'first state, since 27/09',
      reason: `correction requested by memory:${R2}` })}\n`);
    const runner = new ScriptedRunner();
    const { curator, proposals } = await curatorFor(home, runner);
    await curator.run('r1');
    const classes = (await proposals.pending()).filter((p) => p.file_edit?.path.endsWith('gamma.md')).map((p) => p.class);
    expect(classes).toEqual(['correction.apply']);
  });
});
