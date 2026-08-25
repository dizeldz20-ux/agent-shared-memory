import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const live = await importTypeScript('../src/liveActivity.ts');
const batching = await importTypeScript('../src/liveBatch.ts');

const event = (overrides = {}) => ({
  ts: 1,
  tool: 'Read',
  cwd: '/work/project',
  session: 'session-1',
  agent: 'Codex',
  path: '/work/project/src/app.ts',
  node_id: 'agents:project/src/app.ts',
  matched: true,
  layer: 'agents',
  label: 'app.ts',
  ...overrides,
});

test('live file classification canonicalizes mapped paths and rejects shell/build noise', () => {
  const nodes = new Map([['agents:project/src/app.ts', {
    id: 'agents:project/src/app.ts',
    label: 'App.ts',
    layer: 'agents',
    kind: 'file',
    path: 'project/src/App.ts',
    abs: '/Users/test/Projects/project/src/App.ts',
  }]]);
  const canonical = live.canonicalLiveEvent(event(), nodes);
  assert.equal(canonical.path, '/Users/test/Projects/project/src/App.ts');
  assert.equal(live.isFileAccessEvent(canonical, nodes), true);
  assert.equal(live.isFileAccessEvent(event({ presence: true, path: '' }), nodes), false);
  assert.equal(live.isFileAccessEvent(event({ matched: false, node_id: 'x', path: '(raw.chats.length' }), nodes), false);
  for (const path of ['README', 'BUILD', '.nvmrc', '.env.local', 'rules/build.bzl', 'src/module.mts']) {
    assert.equal(live.isFileAccessEvent(event({ matched: false, node_id: 'x', path }), nodes), true, path);
  }
  for (const path of ['.python-version', '.gitmodules', '.zshrc', 'Brewfile', 'Vagrantfile', 'Dockerfile.dev', 'rules.star', 'build.gradle.kts']) {
    assert.equal(live.isFileAccessEvent(event({ matched: false, node_id: 'x', path, file_access: true }), nodes), true, path);
  }
  assert.equal(live.isFileAccessEvent(event({
    matched: false, node_id: 'x', path: '(raw.chats.length', file_access: true, tool: 'Bash',
  }), nodes), false);
  assert.equal(live.isFileAccessEvent(event({
    matched: false, node_id: 'x', path: '/repo/new-dir', file_access: true, tool: 'Grep',
  }), nodes), false);
});

test('file ledger retains distinct unmatched paths, both agents, and repeat counts', () => {
  const rows = live.fairFileActivity([
    event({ ts: 5 }),
    event({ ts: 4, tool: 'Edit' }),
    event({ ts: 3, agent: 'Claude Code' }),
    event({ ts: 2, matched: false, node_id: 'ephemeral:shared', path: '/one/index.ts' }),
    event({ ts: 1, matched: false, node_id: 'ephemeral:shared', path: '/two/index.ts' }),
  ], 12);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((row) => row.event.agent === 'Codex' && row.event.matched)?.count, 2);
  assert.deepEqual(new Set(rows.map((row) => live.agentLane(row.event.agent))), new Set(['codex', 'claude']));
  assert.deepEqual(
    new Set(rows.filter((row) => !row.event.matched).map((row) => row.event.path)),
    new Set(['/one/index.ts', '/two/index.ts']),
  );
});

test('finish replaces start even when PreToolUse and PostToolUse share one timestamp', () => {
  const start = event({ phase: 'start', operation_id: 'tool-1', source: 'hook' });
  const finish = event({ phase: 'finish', operation_id: 'tool-1', source: 'hook' });
  const merged = live.mergeFileEvents([start, finish], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].phase, 'finish');

  const fallback = event({ phase: 'start', operation_id: 'tool-1', source: 'codex-rollout-fallback' });
  assert.equal(live.mergeFileEvents([fallback, start], []).length, 1);
});

test('expired live state is reclaimed without waiting for another event', () => {
  const active = new Map([['expired.ts', 99], ['live.ts', 101]]);
  const agents = new Map([['expired.ts', 'claude'], ['live.ts', 'codex']]);
  const sources = new Map([
    ['claude\0expired.ts', { nodeId: 'expired.ts', agent: 'claude', until: 99 }],
    ['codex\0live.ts', { nodeId: 'live.ts', agent: 'codex', until: 101 }],
  ]);

  assert.equal(live.pruneExpiredLiveState(100, active, agents, sources), 2);
  assert.deepEqual([...active], [['live.ts', 101]]);
  assert.deepEqual([...agents], [['live.ts', 'codex']]);
  assert.deepEqual([...sources.keys()], ['codex\0live.ts']);
});

test('live batcher emits every queued event once and disposal cancels pending work', async () => {
  const batches = [];
  const batcher = batching.createLiveBatcher((items) => batches.push(items), 18);
  batcher.enqueue([1]);
  batcher.enqueue([2, 3]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(batches, [[1, 2, 3]]);

  batcher.enqueue([4]);
  batcher.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(batches, [[1, 2, 3]]);
});
