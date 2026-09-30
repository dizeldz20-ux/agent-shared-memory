import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { loadLayout } from './runtime-layout.js';
import { VaultStore } from './vault-store.js';

describe('stores', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads memory records, filling absent lists and skipping broken lines', async () => {
    writeFileSync(join(dir, 'memory.jsonl'), [
      JSON.stringify({ id: 'a000000000000001', session_id: 's', created_at: '2026-09-28T10:00:00+03:00', agent: 't', summary: 'one', details: 'd' }),
      'not json',
      JSON.stringify({ summary: 'no id' }),
    ].join('\n'));
    const records = await new MemoryStore(join(dir, 'memory.jsonl')).load();
    expect(records.map((record) => record.id)).toEqual(['a000000000000001']);
    expect(records[0]?.open_threads).toEqual([]);
  });

  it('reads vault page frontmatter and falls back to a file id', async () => {
    const wiki = join(dir, 'vault', 'wiki', 'main', 'docs');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'plan.md'), '---\nid: plan-a\ntitle: "Plan A"\nstatus: planned\nupdatedAt: 2026-09-20\n---\n# Plan\n');
    writeFileSync(join(wiki, 'empty.md'), '');
    mkdirSync(join(dir, 'vault', 'wiki', 'main', '.obsidian'));
    writeFileSync(join(dir, 'vault', 'wiki', 'main', '.obsidian', 'x.md'), 'ignored');
    const pages = await new VaultStore(join(dir, 'vault')).pages();
    const plan = pages.find((page) => page.id === 'plan-a');
    expect(plan).toMatchObject({ title: 'Plan A', status: 'planned', updatedAt: '2026-09-20', rel: 'wiki/main/docs/plan.md' });
    expect(pages.find((page) => page.rel.endsWith('empty.md'))).toMatchObject({ id: 'file:wiki/main/docs/empty.md', size: 0 });
    expect(pages.some((page) => page.rel.includes('.obsidian'))).toBe(false);
  });

  it('builds the runtime layout from asm-paths.json and the jobs config', async () => {
    writeFileSync(join(dir, 'asm-paths.json'), JSON.stringify({ vault: join(dir, 'vault'), repo: '' }));
    mkdirSync(join(dir, 'jobs'));
    writeFileSync(join(dir, 'jobs', 'config.json'), JSON.stringify({ memory_dir: join(dir, 'mem'), judge_model: 'haiku' }));
    const layout = await loadLayout(dir);
    expect(layout).toMatchObject({ home: dir, ledger: join(dir, 'lifecycle.jsonl'), vault: join(dir, 'vault') });
    expect(layout.config.judge_model).toBe('haiku');
    expect(layout.config.janitor.batch_size).toBe(8);
  });
});

describe('isHub', () => {
  it('treats no page as a hub until the private config names the hub path', async () => {
    const { isHub } = await import('./runtime-layout.js');
    expect(isHub('wiki/main/syntheses/claude-memory-voice.md', { hub_glob: '' })).toBe(false);
    expect(isHub('wiki/main/syntheses/hubs-voice.md', { hub_glob: 'syntheses/hubs-' })).toBe(true);
    const { loadLayout } = await import('./runtime-layout.js');
    expect((await loadLayout('/nonexistent-asm-home')).config.hub_glob).toBe('');
  });
});
