import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../store/store.types.js';
import { compact, everyLineKept } from './compaction.js';
import { applyCorrection } from './corrections.js';
import { datedSections, datedSegments } from './dated.js';
import { parseLine, parseOps } from './replies.js';
import { projectOf, type CuratedProject } from './scope.js';

const record = (files: string[]): MemoryRecord => ({
  id: 'a000000000000001', session_id: 's', created_at: '2026-09-29T10:00:00Z', agent: 't', summary: 's', details: '',
  files, decisions: [], open_threads: [],
});

describe('scope', () => {
  const projects: CuratedProject[] = [
    { project: 'bot', page: 'vault:bot', repo_prefixes: ['Projects/Bot'], index_lines: [] },
    { project: 'bot-voice', page: 'vault:bot-voice', repo_prefixes: ['Projects/Bot-voice'], index_lines: [] },
  ];
  it('picks the longest prefix, reads absolute paths and dated worktrees', () => {
    expect(projectOf(record(['/Users/x/Desktop/w/Projects/Bot/server/a.ts']), projects)).toBe('bot');
    expect(projectOf(record(['Projects/Bot-voice-20260927/engine.py']), projects)).toBe('bot-voice');
    expect(projectOf(record(['Projects/Bot-work-card-20260926/server/b.ts']), projects)).toBe('bot');
    expect(projectOf(record([]), projects)).toBeUndefined();
  });

  it('falls back to the session only for repo-relative files, and only on a clear majority', () => {
    const touched = new Map([['s', ['/w/Projects/Bot/a.ts', '/w/Projects/Bot/b.ts', '/w/Projects/Other/c.ts', '/w/Projects/Other/d.ts', '/w/Projects/Other/e.ts']]]);
    expect(projectOf(record(['/w/Projects/Elsewhere/x.ts']), projects, touched)).toBeUndefined();  // absolute: not ours
    expect(projectOf(record([]), projects, touched)).toBeUndefined();  // no files: no evidence
    expect(projectOf(record(['src/x.ts']), projects, touched)).toBeUndefined();  // Bot has 2 of 5: no majority
  });

  it('falls back to the files its session touched when the record names only repo-relative paths', () => {
    const touched = new Map([['s', ['/w/Projects/Bot-voice/a.py', '/w/Projects/Bot/server/b.ts', '/w/Projects/Bot/server/c.ts']]]);
    expect(projectOf(record(['server/b.ts']), projects, touched)).toBe('bot');  // most files, not the longest prefix
    expect(projectOf(record(['/w/Projects/Bot-voice/x.py']), projects, touched)).toBe('bot-voice');  // its own files first
    expect(projectOf(record(['server/b.ts']), projects, new Map())).toBeUndefined();
  });
});

describe('dated', () => {
  it('does not count ratios and scores as dates', () => {
    expect(datedSegments('- [x](x.md) — סולם אמון 0/3; 13/14 סעיפים; ציון 44/60')).toBe(0);
    expect(datedSections('## 13/14 done\n- 0/3 approved\n## 28/09\nreal')).toBe(1);
  });

  it('counts dated segments in an index line and dated sections in a body', () => {
    expect(datedSegments('- [x](x.md) — **29/09 10:00: prod c0de123** · **28/09: prod f00d456** · 26/09 deployed')).toBe(3);
    expect(datedSegments('- [x](x.md) — plain line with 2026-09-29 only')).toBe(1);
    expect(datedSections('intro\n**עדכון 28/08/2026:** a\n\n**29/09 10:00:** b\n## 27/09 ערב\nc\n')).toBe(3);
  });
});

describe('compaction', () => {
  const file = '---\nname: x\n---\nFirst fact.\n\n**עדכון 28/08:** second fact.\n**29/09:** third fact.\n';
  it('puts the current state first and keeps every original line under History', () => {
    const out = compact(file, '- the third fact holds (29/09)', '2026-09-29');
    expect(out?.startsWith('---\nname: x\n---\n\n## Current state (as of 2026-09-29)\n\n- the third fact holds (29/09)\n\n## History\n\nFirst fact.')).toBe(true);
    expect(everyLineKept(file, out ?? '')).toBe(true);
    expect(compact(out ?? '', '- again', '2026-09-30')).toBeUndefined();
  });
});

describe('corrections', () => {
  it('replaces the claimed text verbatim and records the correction, or refuses', () => {
    const text = 'The flag is simulation.\nOther text.\n';
    const out = applyCorrection(text, { kind: 'page', id: 'vault:p' }, 'flag is simulation', 'flag is restaurant (since 27/09)', ['memory:x'], '29/09');
    expect(out).toContain('The flag is restaurant (since 27/09).');
    expect(out).toContain('- 29/09: corrected "flag is simulation" → "flag is restaurant (since 27/09)" (memory:x)');
    expect(applyCorrection(text, { kind: 'page', id: 'vault:p' }, 'not in the text', 'x', [], '29/09')).toBeUndefined();
  });

  it('corrects the live text once and leaves History as it was', () => {
    const text = 'The flag is simulation.\n\n## History\n\n- 20/09: the flag is simulation (as recorded then)\n';
    const out = applyCorrection(text, { kind: 'memory_file', id: 'mem:x.md' }, 'flag is simulation', 'flag is restaurant', [], '29/09') ?? '';
    expect(out).toContain('The flag is restaurant.');
    expect(out).toContain('- 20/09: the flag is simulation (as recorded then)');
    expect(applyCorrection('Intro.\n\n## History\n\n- old: only here\n', { kind: 'memory_file', id: 'mem:x.md' }, 'only here', 'x', [], '29/09')).toBeUndefined();
  });

  it('never changes the link of an index line it corrects', () => {
    const index = '- [plan](plan-a.md) — plan-a is pending\n';
    expect(applyCorrection(index, { kind: 'index_line', id: 'idx:MEMORY.md:plan-a.md' }, 'plan-a', 'plan-b', [], '29/09'))
      .toBe('- [plan](plan-a.md) — plan-b is pending\n');
  });

  it('limits an index-line correction to the line that links the file', () => {
    const index = '- [A](a.md) — flag simulation\n- [B](b.md) — flag simulation\n';
    const out = applyCorrection(index, { kind: 'index_line', id: 'idx:MEMORY.md:b.md' }, 'flag simulation', 'flag restaurant', [], '29/09');
    expect(out).toBe('- [A](a.md) — flag simulation\n- [B](b.md) — flag restaurant\n');
  });
});

describe('replies', () => {
  it('parses operations and lines, and rejects prose or truncated output', () => {
    expect(parseOps('```json\n{"ops":[{"op":"remove","block_id":"s-000001"}]}\n```')).toEqual([{ op: 'remove', block_id: 's-000001' }]);
    expect(parseOps('I would remove the first bullet.')).toBeUndefined();
    expect(parseOps('{"ops":[{"op":"append","text":"x"')).toBeUndefined();
    expect(parseLine('{"line":"- [A](a.md) — now"}')).toBe('- [A](a.md) — now');
    expect(parseOps('{"ops":[{"op":"append","text":"t","cites":["memory:a000000000000001"],"reason":"r"}]}'))
      .toEqual([{ op: 'append', text: 't', cites: ['a000000000000001'] }]);
  });
});
