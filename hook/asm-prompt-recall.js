#!/usr/bin/env node
// ASM UserPromptSubmit recall for hook-capable agents: locate the few shared-memory nodes
// that are actually relevant — so recall happens on every prompt without anyone
// remembering to ask for it. Silent when nothing scores; reads brain.json from disk, so
// it works with the visualization server down.
// Deployed copy: ~/.asm/hooks/asm-prompt-recall.js
//
// `node asm-prompt-recall.js --tokenize "<text>"` prints the query tokens as JSON. The
// Python MCP server carries the same tokenizer; tests/fixtures/tokenize.json keeps the two
// from drifting apart.

const fs = require('fs');
// Compact index (pages + files only, no links) — this runs synchronously in front of every
// prompt, so parsing the full 1.3MB graph here would tax every turn. brain.json is the
// fallback for a runtime deployed before merge.py started emitting the index.
const os = require('os');
const path = require('path');
const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const INDEX = path.join(RUNTIME, 'brain.index.json');
const BRAIN = path.join(RUNTIME, 'brain.json');
const MEMORY = path.join(RUNTIME, 'memory.jsonl');
const SESSIONS = path.join(RUNTIME, 'sessions');
const MAX_HITS = 5;
const MIN_SCORE = 3;
// Cross-prompt recall ledger: a node injected in the last COOLDOWN prompts of the same
// session is not injected again. The same two vault pages were observed re-injected on
// three consecutive prompts of one session — a hook that repeats itself gets ignored.
const COOLDOWN = 6;
const LEDGER_MAX = 200;

function loadNodes() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8')).map(
      (n) => ({ id: n.i, label: n.l, kind: n.k, path: n.p,
        meta: { description: n.d, tags: n.t, aliases: n.a || [] } }));
  } catch {
    return JSON.parse(fs.readFileSync(BRAIN, 'utf8')).nodes;
  }
}

// Shared-memory records are candidates too, so a handoff written five minutes ago is
// recalled on the next prompt instead of after the next graph refresh. `details` is left
// out on purpose: at ~2.6KB per record it would out-match every page on every prompt.
function loadMemory() {
  let text;
  try { text = fs.readFileSync(MEMORY, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* one bad line is not fatal */ }
  }
  // A record named in a later record's `supersedes` is retired from recall (same rule
  // as memory_records() in the MCP server).
  const superseded = new Set(records.flatMap((r) => (r && r.supersedes) || []));
  const out = [];
  for (const r of records) {
    if (!r || !r.id || superseded.has(r.id)) continue;
    // The summary is scored as a description (+1), never as a label: a 277-char summary
    // scored at label weight let any single 8-char word inject the record on its own.
    const list = (v) => (Array.isArray(v) ? v : []).map(String);
    out.push({
      id: `memory:${r.id}`, kind: 'memory', label: '',
      path: list(r.files).join(' '),
      meta: { description: String(r.summary || ''), tags: [], aliases: [],
        extra: [...list(r.decisions), ...list(r.open_threads)].join(' ') },
    });
  }
  return out;
}

const STOP = new Set([
  'את', 'של', 'על', 'אני', 'אתה', 'לא', 'כן', 'זה', 'זאת', 'יש', 'אין', 'מה', 'איך', 'כמו',
  'גם', 'אבל', 'כדי', 'כל', 'הוא', 'היא', 'הם', 'עם', 'אם', 'רק', 'עוד', 'שם', 'פה', 'צריך', 'מול',
  'רוצה', 'אפשר', 'בבקשה', 'תעשה', 'תבדוק', 'עכשיו', 'קובץ', 'קוד', 'עבור', 'בתוך', 'לפי',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'you', 'are', 'was',
  'can', 'not', 'but', 'all', 'any', 'now', 'please', 'need', 'want', 'make', 'file', 'code',
  'add', 'fix', 'run', 'use', 'let', 'get', 'set', 'new', 'why', 'how', 'what', 'where',
]);

// Hebrew is agglutinative: "האישורים" must still match "אישורי" in a vault description.
// Strip one leading particle (ה/ב/ל/ו/מ/ש/כ) and a plural ending, and match on the stem.
// Lengths are code points, as in Python, so a non-BMP character counts once.
const cp = (t) => [...t].length;

function stem(t) {
  let s = t;
  if (cp(s) >= 5 && /^[הבלומשכ]/.test(s)) s = s.slice(1);
  if (cp(s) >= 6) s = s.replace(/(ים|ות|יה|ית)$/, '');
  return s;
}

// The second trim matters for Hebrew prefixes glued to Latin words: "ב-AWS" stems to
// "-aws", which matched nothing (or matched a hyphen in a path by luck) before it.
function tokenize(text) {
  return [...new Set(
    String(text || '').toLowerCase().split(/[^\p{L}\p{N}_.\-\/]+/u)
      .map((t) => t.replace(/^[.\-\/]+|[.\-\/]+$/g, ''))
      .filter((t) => cp(t) >= 3 && !STOP.has(t))
      .map((t) => stem(t).replace(/^[.\-\/]+|[.\-\/]+$/g, ''))
      .filter((t) => cp(t) >= 3)
  )].slice(0, 25);
}

// Same id sanitizer as the activity hook, so the ledger sits next to that session's
// mutation marker. No session id → no ledger: sharing one under 'unknown' would cool nodes
// across unrelated sessions.
function sessionId(p) {
  const raw = p.session_id || p.sessionId || p.conversation_id || p.conversationId;
  const safe = String(raw || '').replace(/[^\w.-]/g, '').slice(0, 160);
  return safe || null;
}

function loadLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
    const turn = Number.isInteger(parsed?.turn) ? parsed.turn : 0;
    return { turn, entries };
  } catch {
    // Missing or half-written: this prompt runs without dedup and rewrites the file.
    return { turn: 0, entries: {} };
  }
}

function cooled(ledger, id) {
  const served = ledger.entries[id];
  const at = served && Number.isInteger(served.turn) ? served.turn : null;
  return at !== null && at <= ledger.turn && ledger.turn - at < COOLDOWN;
}

function saveLedger(file, ledger, injectedIds) {
  const turn = ledger.turn + 1;
  const entries = {};
  const keepFrom = turn - COOLDOWN * 4;
  for (const [id, served] of Object.entries(ledger.entries)) {
    const at = served && Number.isInteger(served.turn) ? served.turn : null;
    if (at !== null && at >= keepFrom && at <= turn) entries[id] = { turn: at };
  }
  for (const id of injectedIds) entries[id] = { turn };
  const kept = Object.entries(entries)
    .sort((a, b) => b[1].turn - a[1].turn)
    .slice(0, LEDGER_MAX);
  const payload = JSON.stringify({ version: 1, turn, entries: Object.fromEntries(kept) });
  fs.mkdirSync(SESSIONS, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file);
}

// Field weights are the gate; IDF is the ranking. A generic token such as `index.ts`
// (228 files) or `sweeper` (three mapped copies of one repo) still counts as evidence for
// the two-hit rule, but it no longer outranks a token that lands on a handful of nodes.
function scoreCandidates(candidates, tokens) {
  const specific = new Set(tokens.filter((t) => /[./]/.test(t) || cp(t) >= 8));
  const df = new Map();
  const scored = [];
  for (const n of candidates) {
    if (n.kind === 'root') continue; // dirs carry a generated overview since merge.py described them
    const meta = n.meta || {};
    const label = (n.label || '').toLowerCase();
    const path = (n.path || '').toLowerCase();
    const desc = (meta.description || '').toLowerCase();
    const tags = (meta.tags || []).join(' ').toLowerCase();
    const aliases = (Array.isArray(meta.aliases) ? meta.aliases : [meta.aliases || '']).join(' ').toLowerCase();
    const extra = (meta.extra || '').toLowerCase();
    let score = 0;
    let matched = 0;
    let strong = false;
    const hits = [];
    for (const t of tokens) {
      let s = 0;
      if (tags.includes(t)) s += 3;
      if (label.includes(t)) s += 2;
      if (aliases.includes(t)) s += 2;
      if (desc.includes(t)) s += 1;
      if (path.includes(t)) s += 1;
      if (extra.includes(t)) s += 1;
      if (s) {
        score += s;
        matched++;
        hits.push([t, s]);
        df.set(t, (df.get(t) || 0) + 1);
        // An alias is a name a human gave the page on purpose, so one hit on it is as
        // deliberate as a filename — Hebrew names rarely reach the 8-char bar otherwise.
        if (aliases.includes(t) || (specific.has(t) && (label.includes(t) || path.includes(t) || tags.includes(t)))) {
          strong = true;
        }
      }
    }
    // Two independent hits, always. One generic word landing in one description is
    // a coincidence, and a hook that fires on coincidences gets ignored.
    if (!score || (matched < 2 && !strong)) continue;
    const knowledge = n.kind === 'page' || n.kind === 'memory';
    if (knowledge) score += 1; // knowledge outranks a file at equal evidence
    scored.push({ score, hits, knowledge, n });
  }
  const total = candidates.length;
  for (const item of scored) {
    let rank = 0;
    for (const [t, s] of item.hits) {
      const d = df.get(t) || 0;
      rank += s * Math.log((total - d + 0.5) / (d + 0.5) + 1);
    }
    item.rank = rank * (item.knowledge ? 1.25 : 1);
  }
  return scored.sort((a, b) => b.rank - a.rank);
}

if (process.argv[2] === '--tokenize') {
  process.stdout.write(JSON.stringify(tokenize(process.argv[3] || '')));
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const prompt = String(p.prompt || '');
    if (!prompt || prompt.startsWith('/')) return; // slash commands route themselves
    const tokens = tokenize(prompt);
    if (!tokens.length) return;

    const session = sessionId(p);
    const ledgerFile = session ? path.join(SESSIONS, `${session}.recall.json`) : null;
    const ledger = ledgerFile ? loadLedger(ledgerFile) : { turn: 0, entries: {} };

    const scored = scoreCandidates([...loadNodes(), ...loadMemory()], tokens);
    // Cooled nodes drop out before the cut, so the next-best node takes the slot.
    const top = scored
      .filter((h) => h.score >= MIN_SCORE && !cooled(ledger, h.n.id))
      .slice(0, MAX_HITS);

    if (ledgerFile && (top.length || Object.keys(ledger.entries).length)) {
      // Sole writer of this file; the activity hook writes the sibling mutation marker.
      // A failed write only costs dedup on the next prompt, never the injection itself.
      try { saveLedger(ledgerFile, ledger, top.map((h) => h.n.id)); } catch {}
    }
    if (!top.length) return;

    const lines = top.map(({ n }) => {
      const meta = n.meta || {};
      const d = meta.description;
      const tail = d ? ` — ${d.slice(0, 150)}` : n.path ? ` — ${n.path}` : '';
      return `- ${n.id}${tail}`;
    });
    process.stdout.write(
`ASM recall — shared-memory nodes matching this prompt (located, not yet read):
${lines.join('\n')}
Open a vault node with mcp__asm__brain_node; call mcp__asm__brain_context(file) before editing code.
`);
  } catch { /* malformed payload or brain missing — inject nothing */ }
});
