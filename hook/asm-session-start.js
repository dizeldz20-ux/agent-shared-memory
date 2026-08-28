#!/usr/bin/env node
// ASM SessionStart primer for hook-capable coding agents: shared memory is the first context
// about, instead of something remembered at the end. Prints a small standing rule that
// stdout-injects into the session context. Silent if the brain is not installed.
// Deployed copy: ~/.asm/hooks/asm-session-start.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const BRAIN = path.join(RUNTIME, 'brain.json');
const PATHS = path.join(RUNTIME, 'asm-paths.json');
const MEMORY = path.join(RUNTIME, 'memory.jsonl');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The nightly consolidation (vault dreaming) died silently for 16 days once; its state
// file is the only place that knows. One line here is what makes that visible.
function dreamingLine() {
  const vault = readJson(PATHS)?.vault;
  if (!vault) return '';
  const state = readJson(path.join(vault, 'dreaming', 'state.json'));
  if (!state || !state.lastRun) return '';
  const days = Math.floor((Date.now() - Date.parse(state.lastRun)) / 86400000);
  if (!Number.isFinite(days)) return '';
  const warn = days >= 2 ? ' — consolidation is not running; ask for /vault-dreaming' : '';
  return `Dreaming: last ran ${days}d ago${warn}\n`;
}

// Unfinished work left by any agent in the last two days: the cheapest "what is open"
// signal there is, and it lives in memory.jsonl rather than the 3-day-old graph. A raw
// thread count (345 in one week) is noise; the record count plus the newest thread is not.
function openThreadsLine() {
  let text;
  try { text = fs.readFileSync(MEMORY, 'utf8'); } catch { return ''; }
  const since = Date.now() - 2 * 86400000;
  let records = 0;
  let latest = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record.created_at || '');
    const threads = Array.isArray(record.open_threads) ? record.open_threads : [];
    if (!(at >= since) || !threads.length) continue;
    records += 1;
    if (!latest || at > latest.at) latest = { at, thread: String(threads[0]) };
  }
  if (!records) return '';
  return `Open threads: ${records} record(s) in the last 2 days ended with unfinished work — latest: "${latest.thread.slice(0, 120)}" (mcp__asm__memory_recent for the rest)\n`;
}

function hookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isCursor(input) {
  const client = String(input.client_type || input.clientType || '').toLowerCase();
  return Boolean(
    process.env.CURSOR_VERSION
    || input.cursor_version
    || input.cursorVersion
    || client.includes('cursor')
  );
}

try {
  const input = hookInput();
  const b = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
  const counts = {};
  for (const n of b.nodes) counts[n.layer] = (counts[n.layer] || 0) + 1;
  const layers = Object.entries(counts)
    .filter(([l]) => l !== 'ephemeral')
    .sort((a, b2) => b2[1] - a[1])
    .map(([l, c]) => `${l}:${c}`)
    .join(' ');
  const ageDays = Math.floor((Date.now() - Date.parse(b.generatedAt)) / 86400000);
  // 3d, not 7: the Stop hook refreshes daily (debounced), so >=3d means the automation broke.
  const stale = ageDays >= 3 ? `  (${ageDays}d old — run the ASM refresh script)` : '';

  const context = `ASM — AGENT SHARED MEMORY ONLINE. One graph for the Obsidian vault + all mapped project code.
Mapped: ${layers} | ${b.nodes.length} nodes${stale}
${dreamingLine()}${openThreadsLine()}
STANDING RULE for every agent — recall before reading; record after changing:
- Before the first Read/Edit of any file in a mapped project, call mcp__asm__brain_context(file_path).
  Its vault_pages field returns what a human already wrote about that file: the traps, the decisions.
  Read that page BEFORE editing. This is rung 0, above any code-graph tool and grep.
- Starting a task on a topic? mcp__asm__brain_search(topic) first.
- Changing something shared? mcp__asm__brain_neighbors(node_id) for the blast radius.
- After changing files, call mcp__asm__memory_record before the turn ends. Include the session id,
  concrete results, files, decisions, and open threads. Never store secrets.
- Works with the visualization server down; it reads brain.json from disk.
Full protocol + write-back: skill \`agent-shared-memory\`.
`;
  // Cursor requires a structured SessionStart response. Claude, Codex, and Kimi
  // accept the context as stdout; Grok also learns the same contract from the shared skill
  // and MCP server instructions.
  if (isCursor(input)) {
    process.stdout.write(JSON.stringify({ additional_context: context }));
  } else {
    process.stdout.write(context);
  }
} catch { /* brain not installed on this machine — stay silent */ }
