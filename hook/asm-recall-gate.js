#!/usr/bin/env node
// Claude Code only: turns "recall before you read" from advice into a gate. The first
// code search (Grep, Glob, or a recursive grep/rg/find in Bash) into a mapped project
// during a prompt is denied once with the ASM calls to make instead, unless the session
// already asked ASM something since that prompt. Repeating the same search passes, so
// the map is consulted first and grep still answers what the map lacks.
// Deployed copy: ~/.asm/hooks/asm-recall-gate.js. It must never break the session.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const SESSIONS = path.join(RUNTIME, 'sessions');
const RECALL_TOOLS = /^mcp__asm__(?:brain_search|brain_context|brain_node|brain_neighbors|brain_path|memory_recent)$/;
const SEARCH_PROGRAMS = new Set(['rg', 'ag', 'ack', 'find', 'fd']);
const LOAD_TOOLS = 'ToolSearch query "select:mcp__asm__brain_search,mcp__asm__brain_context,mcp__asm__brain_node"';

const WRAPPERS = new Set(['nice', 'time', 'command', 'xargs', 'timeout', 'env', 'sudo']);

const home = (p) => String(p)
  .replace(/^~(?=\/|$)/, os.homedir())
  .replace(/^\$(?:\{HOME\}|HOME\b)/, os.homedir());
const within = (p, root) => p === root || p.startsWith(`${root}/`);

// Mapped trees: every top-level folder of Projects (the parent of the ASM repo) that
// sources.json does not exclude, plus the vault. Mirrors the refresh's discovery.
function mappedRoots() {
  let paths = {};
  try { paths = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'asm-paths.json'), 'utf8')); } catch { return null; }
  if (!paths.repo) return null;
  let exclude = [];
  try {
    const sources = JSON.parse(fs.readFileSync(path.join(paths.repo, 'sources.json'), 'utf8'));
    exclude = (sources.discoverSources || []).flatMap((s) => s.exclude || []);
  } catch {}
  return { projects: path.dirname(paths.repo), exclude: new Set(exclude), vault: paths.vault || '' };
}

function rootOf(target, roots) {
  if (!target) return null;
  const abs = path.resolve(target);
  if (roots.vault && within(abs, roots.vault)) return roots.vault;
  if (!abs.startsWith(`${roots.projects}/`)) return null;
  const top = abs.slice(roots.projects.length + 1).split('/')[0];
  return top && !roots.exclude.has(top) ? path.join(roots.projects, top) : null;
}

function words(text) {
  return [...String(text).matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// Search targets of a shell command. Quoted text is blanked before splitting so a `|`
// inside a regex is not a pipe; only the first stage of a pipeline searches files, and
// `cd X &&` moves the directory a later bare search runs in.
function shellTargets(command, cwd) {
  // Heredoc bodies are data (a commit message that says "grep -r"), never commands.
  const source = String(command || '').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, (m) => m.split('\n')[0]);
  const masked = source.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
  const targets = [];
  let dir = cwd;
  let from = 0;
  const segments = [];
  for (const m of masked.matchAll(/&&|\|\||;|\n/g)) { segments.push([from, m.index]); from = m.index + m[0].length; }
  segments.push([from, source.length]);
  for (const [start, end] of segments) {
    const pipe = masked.slice(start, end).indexOf('|');
    const argv = words(source.slice(start, pipe < 0 ? end : start + pipe)).filter((w) => !/^\w+=/.test(w));
    // `timeout 10 grep`, `nice -n 5 rg`: drop wrappers with their options and numbers.
    while (WRAPPERS.has(argv[0])) {
      argv.shift();
      while (argv.length && /^(?:-|\d)/.test(argv[0])) argv.shift();
    }
    const program = path.basename(argv[0] || '');
    if (program === 'cd' && argv[1]) { dir = path.resolve(dir, home(argv[1])); continue; }
    let args = argv.slice(1);
    let searchDir = dir;
    if (program === 'git') {
      // `git -C <dir> --no-pager grep`: global options come before the subcommand.
      while (args.length && args[0].startsWith('-')) {
        const option = args.shift();
        if (option === '-C' && args.length) searchDir = path.resolve(dir, home(args.shift()));
        else if (option === '-c') args.shift();
      }
      if (args[0] !== 'grep') continue;
    } else {
      const recursiveGrep = /^e?grep$/.test(program) && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
      if (!recursiveGrep && !SEARCH_PROGRAMS.has(program)) continue;
    }
    args = args.filter((a) => !a.startsWith('-'));
    const operands = args.map((a) => path.resolve(searchDir, home(a))).filter((p) => fs.existsSync(p));
    targets.push(...(operands.length ? operands : [searchDir]));
  }
  return targets;
}

function searchTargets(event) {
  const input = event.tool_input || {};
  const cwd = event.cwd || process.cwd();
  if (event.tool_name === 'Grep' || event.tool_name === 'Glob') {
    const target = path.resolve(cwd, home(input.path || cwd));
    // Searching one known file is reading it, not re-mapping the project.
    try { if (fs.statSync(target).isFile()) return []; } catch {}
    return [target];
  }
  if (event.tool_name === 'Bash') return shellTargets(input.command, cwd);
  return [];
}

function update(session, change) {
  const file = path.join(SESSIONS, `${session}.recall-gate.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const result = change(state);
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return result;
}

function decide(event, now = Date.now()) {
  const session = String(event.session_id || '').replace(/[^\w.-]/g, '').slice(0, 160);
  if (!session) return null;
  if (event.hook_event_name === 'UserPromptSubmit') return update(session, (s) => { s.prompt_at = now; });
  if (RECALL_TOOLS.test(event.tool_name || '')) return update(session, (s) => { s.recalled_at = now; });
  const roots = mappedRoots();
  if (!roots) return null;
  const mapped = [...new Set(searchTargets(event).map((t) => rootOf(t, roots)).filter(Boolean))];
  if (!mapped.length) return null;
  return update(session, (s) => {
    const since = s.prompt_at || 0;
    if (s.recalled_at && s.recalled_at >= since) return null;
    s.nudged = s.nudged || {};
    const fresh = mapped.filter((r) => !s.nudged[r] || s.nudged[r] < since);
    if (!fresh.length) return null;
    for (const r of fresh) s.nudged[r] = now;
    return fresh;
  });
}

function reason(roots) {
  return [
    `ASM has ${roots.join(', ')} mapped, and this prompt has not asked the map yet.`,
    'Before searching code: mcp__asm__brain_search("<topic>") and, for a file you know, mcp__asm__brain_context("<absolute path>"); read the vault_pages they return.',
    `If the ASM tools are deferred, load them first: ${LOAD_TOOLS}.`,
    'Search with grep only for what the map lacks. Repeating this same search now is allowed.',
  ].join(' ');
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  if (process.env.ASM_JOB === '1') return process.exit(0);
  try {
    const denied = decide(JSON.parse(raw.replace(/^\uFEFF/, '')));
    if (Array.isArray(denied)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason(denied),
      } }));
    }
  } catch { /* a gate that fails stays open */ }
  // No process.exit here: it could cut a piped stdout write short on Windows.
});
