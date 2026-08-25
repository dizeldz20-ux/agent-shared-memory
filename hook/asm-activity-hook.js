#!/usr/bin/env node
// ASM PreToolUse/PostToolUse hook for local coding agents. The pre phase makes file
// access visible while a long tool is still running. Recognized mutation intent is
// recorded before the tool runs so Stop cannot race an asynchronous post hook; the
// post phase refreshes the same marker for clients that emit completion only. It must
// never fail the agent session.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const EVENTS_URL = process.env.ASM_EVENT_URL || 'http://127.0.0.1:8930/api/events';
const PENDING = path.join(RUNTIME, 'pending.jsonl');
const SESSIONS = path.join(RUNTIME, 'sessions');
const PENDING_MAX = 2 * 1024 * 1024;
const MUTATORS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'Delete']);
const DIRECT_FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'Delete', 'View', 'view_image']);
const EXPLICIT_FILE_KEYS = new Set(['file_path', 'notebook_path', 'target_path']);
const TOOL_ALIASES = new Map([
  ['Shell', 'Bash'],
  ['shell', 'Bash'],
  ['run_terminal_command', 'Bash'],
  ['run_terminal_cmd', 'Bash'],
  ['ReadFile', 'Read'],
  ['read_file', 'Read'],
  ['WriteFile', 'Write'],
  ['write_file', 'Write'],
  ['create', 'Write'],
  ['DeleteFile', 'Delete'],
  ['delete_file', 'Delete'],
  ['StrReplaceFile', 'Edit'],
  ['search_replace', 'Edit'],
  ['edit_file', 'Edit'],
  ['PatchFile', 'apply_patch'],
]);

function safeSession(value) {
  return String(value || 'unknown').replace(/[^\w.-]/g, '').slice(0, 160) || 'unknown';
}

function agentName(payload) {
  const explicit = process.env.ASM_AGENT_NAME || payload.agent_name || payload.agentName;
  if (explicit) return String(explicit).slice(0, 80);
  const client = String(payload.client_type || payload.clientType || '').toLowerCase();
  if (client.includes('kimi')) return 'Kimi Code';
  if (client.includes('cursor')) return 'Cursor';
  if (client.includes('grok')) return 'Grok Build';
  if (client.includes('codex')) return 'Codex';
  if (process.env.CURSOR_VERSION || payload.cursor_version || payload.cursorVersion) return 'Cursor';
  if (process.env.KIMI_CODE_HOME) return 'Kimi Code';
  if (process.env.GROK_SESSION_ID || payload.hookEventName || payload.workspaceRoot) return 'Grok Build';
  if (payload.turn_id || payload.turnId) return `Codex${payload.model ? ` · ${payload.model}` : ''}`;
  return 'Claude Code';
}

function canonicalTool(value) {
  const name = String(value || '');
  return TOOL_ALIASES.get(name) || name;
}

function canonicalEvent(value) {
  const compact = String(value || '').replace(/[^A-Za-z]/g, '').toLowerCase();
  if (compact === 'pretooluse') return 'PreToolUse';
  if (compact === 'posttooluse') return 'PostToolUse';
  return String(value || '');
}

function objectInput(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {}
  }
  return {};
}

function normalizeEvent(payload) {
  const toolCall = payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : {};
  return {
    ...payload,
    hook_event_name: canonicalEvent(payload.hook_event_name || payload.hookEventName),
    session_id: payload.session_id || payload.sessionId || payload.conversation_id || payload.conversationId,
    tool_name: canonicalTool(payload.tool_name || payload.toolName || toolCall.name),
    tool_input: objectInput(payload.tool_input || payload.toolInput || payload.toolArgs || toolCall.args),
    tool_use_id: payload.tool_use_id || payload.toolUseId || payload.tool_call_id || payload.toolCallId,
    cwd: payload.cwd || payload.workspaceRoot || payload.project_dir || '',
  };
}

function isAsmTool(value) {
  return /^(?:mcp__)?(?:asm|c2b)__/.test(String(value || ''));
}

function cleanCandidate(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]|["'`,;:)\]}]+$/g, '')
    .replace(/:\d+(?::\d+)?$/, '');
}

function existingFile(value, cwd) {
  const candidate = cleanCandidate(value);
  if (!candidate || candidate.includes('://') || candidate.startsWith('-')) return null;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd || process.cwd(), candidate);
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    // Deleted/renamed files no longer exist after PostToolUse. Keep explicit file-like
    // paths so those mutations still reach the activity stream. Shell expressions,
    // globs and bare code tokens are not files and otherwise flood the live agent lane.
    const explicitPath = path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\');
    const shellSyntax = /[\0\r\n*?{}()[\]$=<>|]/.test(candidate)
      || (candidate.includes(':') && !/^[A-Za-z]:[\\/]/.test(candidate));
    return explicitPath && !shellSyntax && /(?:^|[/\\])[^/\\]+\.[A-Za-z0-9_-]{1,12}$/.test(candidate)
      ? resolved
      : null;
  }
}

function existingRegularFile(value, cwd) {
  const candidate = cleanCandidate(value);
  if (!candidate || candidate.includes('://') || candidate.startsWith('-')) return null;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd || process.cwd(), candidate);
  try { return fs.statSync(resolved).isFile() ? resolved : null; }
  catch { return null; }
}

function mutationPath(value, cwd) {
  const candidate = cleanCandidate(value);
  if (!candidate || candidate.includes('://') || candidate.startsWith('-')) return null;
  if (/[\0\r\n*?{}()[\]$=<>|]/.test(candidate)) return null;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd || process.cwd(), candidate);
  try {
    fs.statSync(resolved);
    return resolved;
  } catch {
    // Mutation targets may no longer exist after rm/mv or may have just been created.
    // Only the command-specific parser calls this helper, so a plain relative filename
    // is meaningful here even though it would be too noisy during generic extraction.
    const leaf = path.basename(candidate);
    return leaf && leaf !== '.' && leaf !== '..' ? resolved : null;
  }
}

function shellPaths(command, cwd) {
  const candidates = [];
  const push = (value) => {
    const resolved = existingFile(value, cwd);
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  };

  // Quoted arguments cover paths containing spaces. The second pass catches normal
  // relative/absolute file arguments while deliberately ignoring flags and URLs.
  for (const match of String(command || '').matchAll(/(["'])([^\n]*?)\1/g)) push(match[2]);
  for (const token of String(command || '').split(/[\s|;&<>]+/)) push(token);
  return candidates;
}

function shellWords(segment) {
  const words = [];
  const source = String(segment || '');
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of source.matchAll(pattern)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"' ])/g, '$1'));
  }
  return words;
}

function shellMutationPaths(command, cwd) {
  const mutated = [];
  const push = (value) => {
    const resolved = mutationPath(value, cwd);
    if (resolved && !mutated.includes(resolved)) mutated.push(resolved);
  };

  // Redirection targets are writes regardless of whether the producer is echo, cat,
  // a compiler, or another command. File-descriptor redirects such as 2>&1 are excluded.
  for (const match of String(command || '').matchAll(/(?:^|\s)\d*(?:>>?|<>)[ \t]*(?!&)(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g)) {
    push(match[1] || match[2] || match[3]);
  }

  // Deliberately recognize a narrow set of shell programs with unambiguous file
  // mutation semantics. Unknown commands still produce live read/access paths but do
  // not create a false memory-gate marker.
  const mutatingCommands = new Set(['rm', 'unlink', 'touch', 'truncate', 'mv', 'cp', 'install', 'tee', 'sed', 'perl']);
  for (const segment of String(command || '').split(/(?:&&|\|\||[|;\n])/)) {
    const words = shellWords(segment);
    const commandIndex = words.findIndex((word) => mutatingCommands.has(path.basename(word)));
    if (commandIndex < 0) continue;
    const program = path.basename(words[commandIndex]);
    const args = words.slice(commandIndex + 1);
    const operands = args.filter((arg) => arg !== '--' && !arg.startsWith('-'));

    if (program === 'rm' || program === 'unlink' || program === 'touch' || program === 'truncate') {
      for (const operand of operands) push(operand);
    } else if (program === 'mv') {
      // mv removes/renames the source and writes the destination.
      for (const operand of operands) push(operand);
    } else if (program === 'cp' || program === 'install') {
      // Sources are reads; only the final destination is mutated.
      if (operands.length) push(operands[operands.length - 1]);
    } else if (program === 'tee') {
      for (const operand of operands) push(operand);
    } else if (program === 'sed' || program === 'perl') {
      const inPlace = args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place='));
      if (inPlace) {
        for (const operand of operands) {
          const existing = existingRegularFile(operand, cwd);
          if (existing) push(existing);
        }
      }
    }
  }
  return mutated;
}

function pathsFromInput(tool, input, cwd = '') {
  const values = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !values.includes(value.trim())) values.push(value.trim());
  };
  const walk = (value, key = '', depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (EXPLICIT_FILE_KEYS.has(key)) {
        if (DIRECT_FILE_TOOLS.has(tool)) push(value);
        else {
          const resolved = existingRegularFile(value, cwd);
          if (resolved) push(resolved);
        }
      } else if (key === 'path') {
        // Grep/Glob use `path` for a search directory. Only accept this generic
        // key as an explicit path for file-semantic tools. Search directories are
        // presence, never fake file neurons.
        if (DIRECT_FILE_TOOLS.has(tool)) push(value);
        else {
          const resolved = existingRegularFile(value, cwd);
          if (resolved) push(resolved);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value)) walk(nestedValue, nestedKey, depth + 1);
    }
  };
  walk(input);

  // Codex apply_patch reports the patch in tool_input.command.
  if (tool === 'apply_patch' && typeof input.command === 'string') {
    for (const match of input.command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) push(match[1]);
  }
  if (tool === 'Bash') {
    for (const candidate of shellPaths(input.command || input.cmd, cwd)) push(candidate);
  }
  return values;
}

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function withMarkerLock(markerPath, callback) {
  const lockPath = `${markerPath}.lock`;
  let descriptor;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) fs.unlinkSync(lockPath);
      } catch {}
      Atomics.wait(LOCK_SLEEP, 0, 0, 5);
    }
  }
  if (descriptor === undefined) throw new Error('timed out acquiring ASM session marker lock');
  try {
    return callback();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function markMutation(payload, observedPaths) {
  const tool = payload.tool_name || '';
  let paths = observedPaths;
  if (tool === 'Bash') {
    paths = shellMutationPaths(payload.tool_input?.command || payload.tool_input?.cmd, payload.cwd || '');
    if (!paths.length) return;
  } else if (!MUTATORS.has(tool)) {
    return;
  }
  try {
    fs.mkdirSync(SESSIONS, { recursive: true });
    const session = safeSession(payload.session_id);
    const markerPath = path.join(SESSIONS, `${session}.json`);
    withMarkerLock(markerPath, () => {
      let marker = {};
      try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
      const touched = [...new Set([...(marker.files || []), ...paths])].slice(-200);
      fs.writeFileSync(markerPath, JSON.stringify({
        ...marker,
        session_id: session,
        agent: agentName(payload),
        mutated: true,
        documented: Boolean(marker.documented),
        gate_prompted: Boolean(marker.gate_prompted),
        files: touched,
        updated_at: new Date().toISOString(),
      }, null, 2));
    });
  } catch { /* memory enforcement must never break the coding tool */ }
}

function buffer(payload) {
  try {
    fs.mkdirSync(path.dirname(PENDING), { recursive: true });
    if (fs.existsSync(PENDING) && fs.statSync(PENDING).size > PENDING_MAX) {
      const lines = fs.readFileSync(PENDING, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(Math.floor(lines.length / 2));
      kept.unshift(JSON.stringify({ dropped: lines.length - kept.length, ts: Date.now() / 1000 }));
      fs.writeFileSync(PENDING, kept.join('\n') + '\n');
    }
    fs.appendFileSync(PENDING, JSON.stringify(payload) + '\n');
  } catch {}
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  let rawEvent;
  try {
    rawEvent = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return process.exit(0);
  }
  const event = normalizeEvent(rawEvent);

  const tool = event.tool_name || '';
  if (isAsmTool(tool)) return process.exit(0);
  const paths = pathsFromInput(tool, event.tool_input || {}, event.cwd || '');
  const phase = event.hook_event_name === 'PreToolUse' ? 'start' : 'finish';
  // PreToolUse is installed synchronously. Persisting mutation intent here closes the
  // Stop/PostToolUse ordering race; repeating the merge on PostToolUse is idempotent.
  markMutation(event, paths);

  const payload = {
    ts: Date.now() / 1000,
    tool,
    cwd: event.cwd || '',
    session: safeSession(event.session_id),
    agent: agentName(event),
    paths,
    // Every emitted path has come from a file-semantic argument, an apply_patch
    // header, or a regular-file check. Generic Grep/Glob directories stay out.
    file_access: paths.length > 0,
    phase,
    operation_id: String(event.tool_use_id || '').replace(/[^\w.-]/g, '').slice(0, 160),
  };

  try {
    const response = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) buffer(payload);
  } catch {
    buffer(payload);
  }
  process.exit(0);
});
