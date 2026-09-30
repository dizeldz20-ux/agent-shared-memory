#!/usr/bin/env node
// ASM lifecycle ledger reader for the hooks (~/.asm/lifecycle.jsonl). Mirrors lifecycle.py
// operation for operation; tests/fixtures/lifecycle.json runs against both, and against
// jobs/src/ledger/fold.ts. CommonJS and dependency-free like every ASM hook, because hooks
// run straight from ~/.asm/hooks with no build step.
// Deployed copy: ~/.asm/hooks/asm-lifecycle.js
//
// `node asm-lifecycle.js --fold <fixture.json>` prints {states, open_threads, requested}.

'use strict';

const fs = require('fs');

const OPS = new Set(['close_thread', 'mark_done', 'retire', 'restore', 'correct', 'compact']);
const KINDS = new Set(['thread', 'record', 'page', 'memory_file', 'index_line']);
// The three operations that change what recall shows, and the state each one sets.
const VISIBILITY = { close_thread: 'closed', mark_done: 'done', retire: 'retired' };
const HIDDEN = new Set(['closed', 'retired']); // `done` stays visible, marked as finished

function targetKey(target) {
  return `${target && target.kind}:${target && target.id}`;
}

const text = (value) => typeof value === 'string' && value.trim().length > 0;

// A field of the wrong type makes the line invalid, exactly as in lifecycle.py and fold.ts.
function valid(op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string' || !OPS.has(op.op)) return false;
  const target = op.target;
  if (!target || typeof target !== 'object' || typeof target.kind !== 'string' || !KINDS.has(target.kind) || !text(target.id)) return false;
  if (!text(op.reason)) return false;
  if (['ts', 'undoes', 'applies'].some((name) => name in op && typeof op[name] !== 'string')) return false;
  if (op.op === 'restore' && !String(op.undoes || '').startsWith('lc_')) return false;
  return typeof op.id === 'string' && op.id.startsWith('lc_');
}

// Every valid operation in file order. A bad line is skipped, never fatal.
function loadOps(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const ops = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const op = JSON.parse(line);
      if (valid(op)) ops.push(op);
    } catch { /* one bad line is not fatal */ }
  }
  return ops;
}

// Replay the operations in file order. A record's `supersedes` list is read first as an
// implicit retire; `restore` reinstates what its undone operation replaced, and only while
// that operation is still the one in force, so a second restore is a no-op.
function fold(ops, records = []) {
  const states = new Map();
  const requested = new Map();
  for (const record of records || []) {
    const superseded = record && Array.isArray(record.supersedes) ? record.supersedes : [];
    for (const old of superseded) {
      states.set(`record:${old}`, {
        state: 'retired', op_id: `supersedes:${record.id}`, at: record.created_at || '',
        reason: 'superseded by a later record', superseded_by: `memory:${record.id}`,
      });
    }
  }
  const before = new Map();
  const seen = new Map();
  for (const op of ops) {
    if (seen.has(op.id)) continue; // a line written twice is one operation
    seen.set(op.id, op);
    if (VISIBILITY[op.op]) {
      const key = targetKey(op.target);
      before.set(op.id, states.has(key) ? states.get(key) : null);
      states.set(key, {
        state: VISIBILITY[op.op], op_id: op.id, at: op.ts || '',
        reason: op.reason || '', superseded_by: op.superseded_by ?? null,
      });
    } else if (op.op === 'restore') {
      const undone = seen.get(op.undoes);
      if (!undone || !VISIBILITY[undone.op]) continue;
      const key = targetKey(undone.target);
      if ((states.get(key) || {}).op_id !== undone.id) continue; // already restored or overtaken
      const previous = before.get(undone.id);
      if (previous === null || previous === undefined) states.delete(key);
      else states.set(key, previous);
    } else if (op.op === 'correct') {
      if (op.mode === 'requested') requested.set(op.id, op);
      else if (op.applies) requested.delete(op.applies);
    }
  }
  const state = (kind, id) => states.get(`${kind}:${id}`) || null;
  const hidden = (kind, id) => {
    const entry = state(kind, id);
    return Boolean(entry && HIDDEN.has(entry.state));
  };
  const threadOpen = (recordId, index) => !hidden('record', recordId) && !hidden('thread', `${recordId}#${index}`);
  return { states, requested, state, hidden, threadOpen };
}

module.exports = { loadOps, fold, targetKey };

if (require.main === module && process.argv[2] === '--fold') {
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const life = fold((fixture.ops || []).filter(valid), fixture.records || []);
  const open = [];
  for (const record of fixture.records || []) {
    (record.open_threads || []).forEach((_, index) => {
      if (life.threadOpen(record.id, index)) open.push(`${record.id}#${index}`);
    });
  }
  process.stdout.write(JSON.stringify({
    states: Object.fromEntries([...life.states].map(([key, value]) => [key, value.state])),
    open_threads: open.sort(),
    requested: [...life.requested.keys()].sort(),
  }));
}
