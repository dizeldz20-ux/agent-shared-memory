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
