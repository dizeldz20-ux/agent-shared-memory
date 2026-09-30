#!/usr/bin/env node
// ASM SessionStart primer for hook-capable coding agents: shared memory is the first context
// about, instead of something remembered at the end. Prints a small standing rule that
// stdout-injects into the session context. Silent if the brain is not installed.
// Deployed copy: ~/.asm/hooks/asm-session-start.js

const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const BRAIN = path.join(RUNTIME, 'brain.json');
const MEMORY = path.join(RUNTIME, 'memory.jsonl');
const LEDGER = path.join(RUNTIME, 'lifecycle.jsonl');
const JOBS = path.join(RUNTIME, 'jobs');
const JOBS_CLI = path.join(JOBS, 'dist', 'runner', 'cli.js');
const HOUR = 3600000;
let lifecycle = null;
try { lifecycle = require(path.join(__dirname, 'asm-lifecycle.js')); } catch { lifecycle = null; }

// Unfinished work left by any agent in the last two days: the cheapest "what is open"
// signal there is, and it lives in memory.jsonl rather than the 3-day-old graph. A thread the
// ledger closed, or one on a superseded or retired record, is finished business. The newest
// open thread is printed with its id, so the agent that finished it can close it.
// (Vault dreaming used to report its age here; it is retired and the curator replaces it.)
function openThreadsLine() {
  let text;
  try { text = fs.readFileSync(MEMORY, 'utf8'); } catch { return ''; }
  const parsed = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { parsed.push(JSON.parse(line)); } catch { /* one bad line is not fatal */ }
  }
  const superseded = new Set(parsed.flatMap((r) => (r && Array.isArray(r.supersedes) ? r.supersedes : [])));
  let life = null;
  if (lifecycle) {
    try { life = lifecycle.fold(lifecycle.loadOps(LEDGER), parsed); } catch { life = null; }
  }
  const since = Date.now() - 2 * 86400000;
  let records = 0;
  let open = 0;
  let newest = null;
  for (const record of parsed) {
    if (!record || superseded.has(record.id) || (life && life.hidden('record', record.id))) continue;
    const at = Date.parse(record.created_at || '');
    if (!(at >= since)) continue;
    const threads = Array.isArray(record.open_threads) ? record.open_threads : [];
    const live = threads.map((_, index) => index).filter((index) => !life || life.threadOpen(record.id, index));
    if (!live.length) continue;
    records += 1;
    open += live.length;
    if (!newest || at > newest.at) newest = { at, id: `${record.id}#${live[0]}`, text: String(threads[live[0]]) };
  }
  if (!records) return '';
  return `Open threads: ${open} open in ${records} record(s) from the last 2 days — newest: ${newest.id} "${newest.text.slice(0, 120)}" (close finished ones with memory_record(resolves=[id]))\n`;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function ago(iso) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return 'at an unknown time';
  const hours = Math.floor((Date.now() - at) / HOUR);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function pendingProposals() {
  let count = 0;
  try {
    for (const name of fs.readdirSync(path.join(JOBS, 'proposals'))) {
      if (!name.endsWith('.json')) continue;
      const run = readJsonFile(path.join(JOBS, 'proposals', name));
      for (const proposal of (run && run.proposals) || []) if (proposal.status === 'pending') count += 1;
    }
  } catch { /* no proposals yet */ }
  return count;
}

// The background jobs (janitor, curator, refresh) report here, and loudly: vault dreaming
// once failed every night for 47 days behind a wrapper that exited 0.
function jobsLine() {
  const state = readJsonFile(path.join(JOBS, 'state.json'));
  const parts = [];
  for (const job of ['janitor', 'curator', 'refresh']) {
    const entry = state && state[job];
    if (!entry) continue;
    const failedLast = entry.last_error && (!entry.last_success || Date.parse(entry.last_error) > Date.parse(entry.last_success));
    if (failedLast) parts.push(`${job} FAILED ${ago(entry.last_error)}: ${String(entry.error_text || '').slice(0, 120)}`);
    else if (entry.last_success && Date.now() - Date.parse(entry.last_success) > 48 * HOUR) parts.push(`${job} last succeeded ${ago(entry.last_success)}; see ~/.asm/jobs/logs`);
    else if (entry.last_success) parts.push(`${job} ok ${ago(entry.last_success)}`);
  }
  // A job that dies at import writes no state at all: a launch nothing reported after is shown too.
  const launch = readJsonFile(path.join(JOBS, 'launch.json'));
  const launchedAt = Date.parse((launch && launch.at) || '');
  if (Number.isFinite(launchedAt) && Date.now() - launchedAt > 2 * HOUR) {
    const reported = ['janitor', 'curator', 'refresh'].some((job) => {
      const entry = state && state[job];
      return entry && [entry.last_success, entry.last_error].some((iso) => Date.parse(iso || '') >= launchedAt);
    });
    if (!reported) parts.push(`jobs launched ${ago(launch.at)} and never reported — see ~/.asm/jobs/logs`);
  }
  const pending = pendingProposals();
  if (pending) parts.push(`${pending} proposal(s) wait for review: /asm-review`);
  return parts.length ? `Jobs: ${parts.join(' · ')}\n` : '';
}

function lockAlive() {
  const lock = readJsonFile(path.join(JOBS, 'run.lock'));
  if (!lock || typeof lock.pid !== 'number') return false;
  try { process.kill(lock.pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  return Date.now() - Date.parse(lock.started_at || '') < 2 * HOUR;
}

// The jobs run from here, detached, rather than from launchd: a launchd job cannot read the
// vault on the Desktop and gets 256 file descriptors, which is what killed vault dreaming.
function launchDueJobs() {
  if (!fs.existsSync(JOBS_CLI)) return;
  const janitor = (readJsonFile(path.join(JOBS, 'state.json')) || {}).janitor || {};
  const since = (iso) => { const at = Date.parse(iso || ''); return Number.isFinite(at) ? Date.now() - at : Infinity; };
  // A run that keeps failing waits longer each time: 1, 2, 4 … hours, at most a day.
  const backoff = Math.min(24, 2 ** Math.max(0, (Number(janitor.consecutive_failures) || 0) - 1)) * HOUR;
  if (since(janitor.last_success) < 20 * HOUR || since(janitor.last_error) < backoff || lockAlive()) return;
  fs.mkdirSync(path.join(JOBS, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(JOBS, 'logs', `${new Date().toISOString().slice(0, 10)}.log`), 'a');
  // Node itself lowers the jobs (Windows has no `nice`), and a spawn error must not fail the hook.
  const child = spawn(process.execPath, [JOBS_CLI, 'run', '--job', 'all'], {
    detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ASM_JOB: '1' },
  });
  child.on('error', (error) => {
    try { fs.writeSync(log, `${new Date().toISOString()} the jobs could not start: ${error.message}\n`); } catch { /* nothing to tell */ }
  });
  if (child.pid) try { os.setPriority(child.pid, 10); } catch { /* the jobs still run, at normal priority */ }
  try { fs.writeFileSync(path.join(JOBS, 'launch.json'), JSON.stringify({ at: new Date().toISOString(), pid: child.pid ?? null })); } catch { /* the banner just cannot tell */ }
  child.unref();
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
  // ASM's own background jobs run headless agents; they never get the primer.
  if (process.env.ASM_JOB === '1') process.exit(0);
  const b = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
  const counts = {};
  for (const n of b.nodes) counts[n.layer] = (counts[n.layer] || 0) + 1;
  const layers = Object.entries(counts)
    .filter(([l]) => l !== 'ephemeral')
    .sort((a, b2) => b2[1] - a[1])
    .map(([l, c]) => `${l}:${c}`)
    .join(' ');
  const ageDays = Math.floor((Date.now() - Date.parse(b.generatedAt)) / 86400000);
  // 3d, not 7: the daily jobs refresh the graph (launched below), so >=3d means the automation broke.
  const stale = ageDays >= 3 ? `  (${ageDays}d old — run the ASM refresh script)` : '';

  const context = `ASM — AGENT SHARED MEMORY ONLINE. One graph for the Obsidian vault + all mapped project code.
Mapped: ${layers} | ${b.nodes.length} nodes${stale}
${openThreadsLine()}${jobsLine()}
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
  try { launchDueJobs(); } catch { /* a job that cannot start must never cost the session */ }
} catch { /* brain not installed on this machine — stay silent */ }
