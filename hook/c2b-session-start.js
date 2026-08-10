#!/usr/bin/env node
// C2B SessionStart primer: makes the second brain the FIRST thing every session knows
// about, instead of something remembered at the end. Prints a small standing rule that
// stdout-injects into the session context. Silent if the brain is not installed.
// Deployed copy: ~/.claude/hooks/c2b-session-start.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const BRAIN = path.join(os.homedir(), '.claude', 'c2b', 'brain.json');

try {
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
  const stale = ageDays >= 3 ? `  (${ageDays}d old — run refresh.ps1)` : '';

  process.stdout.write(
`C2B SECOND BRAIN — ONLINE. Unified graph of the Obsidian vault + all mapped project code.
Mapped: ${layers} | ${b.nodes.length} nodes${stale}

STANDING RULE for this session — recall before you read:
- Before the first Read/Edit of any file in a mapped project, call mcp__c2b__brain_context(file_path).
  Its vault_pages field returns what a human already wrote about that file: the traps, the decisions.
  Read that page BEFORE editing. This is rung 0, above CodeGraph and grep.
- Starting a task on a topic? mcp__c2b__brain_search(topic) first.
- Changing something shared? mcp__c2b__brain_neighbors(node_id) for the blast radius.
- Works with the visualization server down; it reads brain.json from disk.
Full protocol + refresh/write-back: skill \`c2b-brain\`.
`);
} catch { /* brain not installed on this machine — stay silent */ }
