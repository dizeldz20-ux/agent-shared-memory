#!/usr/bin/env node
// C2B end-of-session documentation gate (Stop hook).
//
// The recall half of the brain only pays off if somebody writes the page. This hook makes
// that the default: a session that MUTATED FILES may not end until it has written the day's
// log into the vault. Read-only / conversational sessions are never blocked.
//
// Fires AT MOST ONCE per session. Three independent guards, because a Stop hook that loops
// is worse than one that never fires:
//   1. stop_hook_active  — Claude is already continuing because of this hook
//   2. a per-session marker file, written BEFORE the block is emitted
//   3. today's daily page already naming this session id
//
// Deployed copy lives at ~/.claude/hooks/c2b-session-doc.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME = path.join(os.homedir(), '.claude', 'c2b');
const MARKERS = path.join(RUNTIME, 'session-doc');

// This file is deployed to ~/.claude/hooks, where it cannot see the repo's sources.json —
// so refresh writes the resolved paths to c2b-paths.json next to the graph. C2B_VAULT /
// C2B_REPO override for a one-off run. No vault configured → the gate stays out of the way.
function configuredPaths() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'c2b-paths.json'), 'utf8'));
  } catch { /* not refreshed yet */ }
  return {
    vault: process.env.C2B_VAULT || cfg.vault || '',
    repo: process.env.C2B_REPO || cfg.repo || '',
  };
}

const TAIL_BYTES = 8 * 1024 * 1024; // cap the transcript scan; a long session's tail is enough
const MUTATORS = ['"Write"', '"Edit"', '"NotebookEdit"', '"MultiEdit"'];

const allow = () => process.exit(0);

function today() {
  // Local date, not UTC: the daily page is named for the day the human had.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mutatedFiles(transcriptPath) {
  // Unknown transcript → assume it mutated. Failing toward "document it" is the safe side:
  // a spurious prompt costs a paragraph, a missed one costs the lesson.
  if (!transcriptPath) return true;
  try {
    const { size } = fs.statSync(transcriptPath);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return MUTATORS.some((m) => text.includes(m));
  } catch {
    return true;
  }
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return allow(); // unparseable payload must never wedge a session
  }

  if (input.stop_hook_active) return allow(); // guard 1

  const { vault: VAULT, repo: REPO } = configuredPaths();
  if (!VAULT) return allow(); // no vault configured — nothing to document into

  const session = String(input.session_id || '').replace(/[^\w.-]/g, '') || 'unknown';
  const marker = path.join(MARKERS, `${session}.done`);
  try {
    if (fs.existsSync(marker)) return allow(); // guard 2
  } catch { return allow(); }

  const date = today();
  const daily = path.join(VAULT, 'wiki', 'main', 'daily', `${date}.md`);
  try {
    if (fs.existsSync(daily) && fs.readFileSync(daily, 'utf8').includes(session)) {
      return allow(); // guard 3 — already documented
    }
  } catch { /* fall through to the block */ }

  if (!mutatedFiles(input.transcript_path)) return allow();

  // Mark first, block second: if anything below throws, the session still ends cleanly.
  try {
    fs.mkdirSync(MARKERS, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch { return allow(); }

  const rel = path.join('wiki', 'main', 'daily', `${date}.md`);
  const reason = `C2B — this session changed files and is not documented yet. Before stopping:

1. Write (or append to) ${rel} in the vault at:
   ${VAULT}
   Use templates/session-log.md. Frontmatter: id: daily-${date}, pageType: report,
   privacy: private, and a description naming WHAT CHANGED, not what was discussed.
   Include the session id ${session} in the body so this gate can see it is done.

2. Anything durable learned — a trap, a decision, a gotcha — gets ITS OWN page in
   concepts/ or architecture/ or projects/, linked from the daily log. The daily log is
   the narrative; the durable page is the fact, and only the fact survives.

3. Regenerate so it reaches the brain, or none of the above is recallable tomorrow:
   rebuild the vault's okf bundle, then run the C2B refresh${REPO ? ` from ${REPO}\n   (./refresh.sh, or ./refresh.ps1 on Windows)` : ''}.

Then stop. This gate fires once per session and will not block you again.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
