#!/usr/bin/env node
// ASM Stop hook shared by hook-capable coding agents. A mutating session must leave one useful
// shared-memory record. It can continue a session only once, so a broken MCP can never
// trap an agent in a loop.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const SESSIONS = path.join(RUNTIME, 'sessions');
const MEMORY = path.join(RUNTIME, 'memory.jsonl');

function safeSession(value) {
  return String(value || 'unknown').replace(/[^\w.-]/g, '').slice(0, 160) || 'unknown';
}

function allow(input = {}) {
  // Kimi Code treats any successful stdout as context. Its official allow result is
  // therefore an empty stdout with exit code 0; Claude/Cursor/Grok retain the legacy
  // explicit continue response.
  if (clientKind(input) === 'kimi') return process.exit(0);
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function clientKind(input) {
  const client = String(input.client_type || input.clientType || '').toLowerCase();
  if (process.env.CURSOR_VERSION || input.cursor_version || input.cursorVersion || client.includes('cursor')) {
    return 'cursor';
  }
  if (input.hookEventName || input.workspaceRoot || process.env.GROK_SESSION_ID || client.includes('grok')) {
    return 'grok';
  }
  if (process.env.KIMI_CODE_HOME || client.includes('kimi')) return 'kimi';
  return 'claude';
}

function block(input, reason) {
  const client = clientKind(input);
  if (client === 'cursor') {
    process.stdout.write(JSON.stringify({ followup_message: reason }));
  } else if (client === 'kimi') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
  process.exit(0);
}

function memoryHasSession(session) {
  try {
    const text = fs.readFileSync(MEMORY, 'utf8');
    return text.split('\n').slice(-5000).some((line) => {
      try { return JSON.parse(line).session_id === session; } catch { return false; }
    });
  } catch {
    return false;
  }
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

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return allow(); }
  if (input.stop_hook_active || input.stopHookActive || Number(input.loop_count || 0) > 0) return allow(input);

  const session = safeSession(input.session_id || input.sessionId || input.conversation_id || input.conversationId);
  const markerPath = path.join(SESSIONS, `${session}.json`);
  let result;
  try {
    result = withMarkerLock(markerPath, () => {
      let marker;
      try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return { allow: true }; }
      if (!marker.mutated || marker.documented || marker.gate_prompted || memoryHasSession(session)) {
        return { allow: true };
      }

      // Write before asking the agent to continue. The next Stop is always allowed even
      // when the MCP is unavailable; persistence enforcement is a guardrail, not a deadlock.
      marker.gate_prompted = true;
      marker.documented = false;
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
      return { allow: false, marker };
    });
  } catch { return allow(input); }
  if (result.allow) return allow(input);
  const marker = result.marker;

  const files = (marker.files || []).slice(0, 30).map((value) => `- ${value}`).join('\n') || '- list the files you changed';
  const reason = `ASM memory gate — this session changed files but has not recorded its result in the shared memory.

Before finishing, call ASM's memory_record tool (shown as mcp__asm__memory_record in
Claude-compatible clients and asm__memory_record in Grok Build) with:
- session_id: ${session}
- agent: ${marker.agent || 'current agent'}
- summary: what actually changed (not what was discussed)
- details: verified behavior, tests, and enough context for the next agent
- files: the affected files
- decisions: choices and rejected alternatives that matter later
- open_threads: anything unfinished

Observed files:
${files}

Do not store secrets or raw transcripts. Durable architectural facts should also get their own Obsidian page; memory_record appends the session narrative to today's daily note.`;

  block(input, reason);
});
