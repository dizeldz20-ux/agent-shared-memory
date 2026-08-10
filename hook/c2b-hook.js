#!/usr/bin/env node
// C2B live-activity hook (PostToolUse, all tools). Posts to the local C2B server; when the
// server is down the event is buffered to pending.jsonl and drained on the next server
// start, so the brain keeps a record of what Claude touched even with nothing running.
// Must NEVER fail or slow a Claude session down.
// Deployed copy lives at ~/.claude/hooks/c2b-hook.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const PENDING = path.join(os.homedir(), '.claude', 'c2b', 'pending.jsonl');
const PENDING_MAX = 2 * 1024 * 1024;

function buffer(payload) {
  try {
    fs.mkdirSync(path.dirname(PENDING), { recursive: true }); // else appendFileSync ENOENTs silently
    // Over the cap, keep the NEWEST half: a recall system wants what just happened,
    // not a two-day-old backlog. Rare (~7k events), so the rewrite cost is fine.
    if (fs.existsSync(PENDING) && fs.statSync(PENDING).size > PENDING_MAX) {
      const lines = fs.readFileSync(PENDING, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(Math.floor(lines.length / 2));
      kept.unshift(JSON.stringify({ dropped: lines.length - kept.length, ts: Date.now() / 1000 }));
      fs.writeFileSync(PENDING, kept.join('\n') + '\n');
    }
    fs.appendFileSync(PENDING, JSON.stringify(payload) + '\n');
  } catch { /* unwritable path — the session must not care */ }
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let payload = null;
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const tool = p.tool_name || '';
    if (tool.startsWith('mcp__c2b__')) return process.exit(0); // don't log the brain reading itself
    const ti = p.tool_input || {};
    const paths = [];
    const push = (v) => { if (typeof v === 'string' && v.trim()) paths.push(v); };
    push(ti.file_path);
    push(ti.notebook_path);
    push(ti.path); // Grep/Glob search root
    if (Array.isArray(ti.edits)) for (const e of ti.edits) push(e && e.file_path);
    if (!paths.length) return process.exit(0);
    payload = { ts: Date.now() / 1000, tool, cwd: p.cwd || '', session: p.session_id || '', paths };
  } catch {
    return process.exit(0); // bad payload — nothing worth buffering
  }

  try {
    // 2s, not 1s: a burst of parallel tool calls spawns several Node processes at once and
    // the client-side deadline — not the server — was aborting after the server had already
    // persisted, which buffered an event that was then replayed as a duplicate.
    const res = await fetch('http://127.0.0.1:8930/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) buffer(payload);
  } catch {
    buffer(payload); // server down / timeout — keep it for the next start
  }
  process.exit(0);
});
