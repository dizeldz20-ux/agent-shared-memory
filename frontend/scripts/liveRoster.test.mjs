import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const outDir = await mkdtemp(path.join(tmpdir(), 'asm-roster-'));
async function importTypeScript(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const name = path.basename(sourceUrl.pathname).replace(/\.tsx?$/, '.mjs');
  const output = ts.transpileModule(await readFile(sourceUrl, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(from\s*')(\.\/[\w.-]+)(')/g, '$1$2.mjs$3');
  await writeFile(path.join(outDir, name), output, 'utf8');
  return import(pathToFileURL(path.join(outDir, name)).href);
}

const roster = await importTypeScript('../src/liveRoster.ts');
const live = await importTypeScript('../src/liveActivity.ts');

const NOW = 1_800_000_000_000;
const secondsAgo = (s) => (NOW - s * 1000) / 1000;

const event = (overrides = {}) => ({
  ts: secondsAgo(0),
  tool: 'Read',
  cwd: '/work/project',
  session: 'session-1',
  agent: 'Codex',
  path: '/work/project/src/app.ts',
  node_id: 'agents:project/src/app.ts',
  matched: true,
  layer: 'agents',
  label: 'app.ts',
  source: 'hook',
  ...overrides,
});

test('one roster answers "which agents", with a state per agent and no second source', () => {
  const sightings = new Map();
  roster.recordSightings([
    event({ agent: 'Claude Code', ts: secondsAgo(1) }),
    event({ agent: 'Codex', ts: secondsAgo(70), source: 'codex-rollout-fallback' }),
    event({ agent: 'Grok Build', ts: secondsAgo(200) }),   // outside the window
  ], sightings, NOW);

  const list = roster.agentRoster(sightings, NOW);
  assert.deepEqual(list.map((agent) => agent.lane), ['claude', 'codex']);
  assert.deepEqual(list.map((agent) => agent.state), ['live', 'recent']);
  assert.equal(list.filter((agent) => agent.state === 'live').length, 1);
  // The deck prints `live/total` in both the strip and the trace head; there is
  // no second computation that could disagree with this pair.
  assert.equal(`${list.filter((a) => a.state === 'live').length}/${list.length}`, '1/2');
});

test('an inferred sighting is never promoted to a reported one, and vice versa', () => {
  const sightings = new Map();
  roster.recordSightings([event({ agent: 'Codex', ts: secondsAgo(20), source: 'codex-rollout-fallback' })], sightings, NOW);
  assert.equal(roster.agentRoster(sightings, NOW)[0].inferred, true);

  // A real hook arriving later owns the lane and clears the inference.
  roster.recordSightings([event({ agent: 'Codex', ts: secondsAgo(2), source: 'hook' })], sightings, NOW);
  assert.equal(roster.agentRoster(sightings, NOW)[0].inferred, false);

  // An older frame replayed after it must not take the lane back.
  roster.recordSightings([event({ agent: 'Codex', ts: secondsAgo(40), source: 'codex-rollout-fallback' })], sightings, NOW);
  const current = roster.agentRoster(sightings, NOW)[0];
  assert.equal(current.inferred, false);
  assert.equal(current.state, 'live');
  assert.equal(roster.isInferred(undefined), false);
  assert.equal(roster.isInferred('codex-rollout-fallback'), true);
});

test('history and clock skew cannot put an agent on the roster', () => {
  const sightings = new Map();
  roster.recordSightings([
    event({ agent: 'Codex', ts: secondsAgo(4 * 86400) }),   // a replayed rollout row
    event({ agent: 'Gemini', ts: secondsAgo(-120) }),        // beyond the tolerated skew
    event({ agent: 'Claude Code', ts: secondsAgo(-10) }),    // inside it: a clock difference
  ], sightings, NOW);
  assert.deepEqual(roster.agentRoster(sightings, NOW).map((agent) => agent.lane), ['claude']);

  // A lane holds its slot until the window closes around its own sighting.
  const fresh = new Map();
  roster.recordSightings([event({ agent: 'Claude Code', ts: secondsAgo(0) })], fresh, NOW);
  assert.equal(roster.pruneSightings(fresh, NOW + roster.AGENT_WINDOW_MS), false);
  assert.equal(roster.pruneSightings(fresh, NOW + roster.AGENT_WINDOW_MS + 1_000), true);
  assert.equal(fresh.size, 0);
});

test('agents no longer compete for rows, so neither can crowd out or impersonate the other', () => {
  // The defect, reproduced: one Codex touch a minute and a half ago against a
  // Claude session editing three files right now. A flat list had to rank them
  // against each other, and its reserved-lane rule put that stale row second.
  const lanes = live.laneFileActivity([
    event({ agent: 'Claude Code', ts: secondsAgo(1), node_id: 'a', path: '/p/a.ts' }),
    event({ agent: 'Claude Code', ts: secondsAgo(2), node_id: 'b', path: '/p/b.ts' }),
    event({ agent: 'Claude Code', ts: secondsAgo(3), node_id: 'c', path: '/p/c.ts' }),
    event({ agent: 'Claude Code', ts: secondsAgo(4), node_id: 'a', path: '/p/a.ts' }),
    event({ agent: 'Codex', ts: secondsAgo(88), node_id: 'd', path: '/p/d.ts' }),
  ], 2);

  // Each agent keeps its own newest work, capped on its own, and says its age
  // itself — Codex is neither promoted next to live work nor silently dropped.
  assert.deepEqual([...lanes.keys()].sort(), ['claude', 'codex']);
  assert.deepEqual(lanes.get('claude').map((row) => row.event.path), ['/p/a.ts', '/p/b.ts']);
  assert.equal(lanes.get('claude')[0].count, 2, 'repeat access folds into a counter');
  assert.equal(lanes.get('codex').length, 1);
  assert.equal(lanes.get('codex')[0].event.ts, secondsAgo(88));

  // An unmatched path is identified by the path itself, per agent.
  const unmatched = live.laneFileActivity([
    event({ agent: 'Codex', matched: false, node_id: 'ephemeral:shared', path: '/one/index.ts' }),
    event({ agent: 'Codex', matched: false, node_id: 'ephemeral:shared', path: '/two/index.ts' }),
  ], 4);
  assert.equal(unmatched.get('codex').length, 2);
});

test('every age is printed in one LTR tabular register, and a graph states its own age', () => {
  assert.equal(roster.formatAge(0), 'now');
  assert.equal(roster.formatAge(1_999), 'now');
  assert.equal(roster.formatAge(2_000), '2s');
  assert.equal(roster.formatAge(59_999), '59s');
  assert.equal(roster.formatAge(60_000), '1m');
  assert.equal(roster.formatAge(112_000), '1m 52s');
  assert.equal(roster.formatAge(roster.AGENT_WINDOW_MS), '1m 30s');

  assert.equal(roster.daysSince(null, NOW), null);
  assert.equal(roster.daysSince('not a date', NOW), null);
  assert.equal(Math.floor(roster.daysSince(new Date(NOW - 7 * 86_400_000).toISOString(), NOW)), 7);
});
