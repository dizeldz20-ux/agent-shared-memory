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
const PAGES = path.join(RUNTIME, 'brain.pages.json');
const SESSIONS = path.join(RUNTIME, 'sessions');
const LEDGER = path.join(RUNTIME, 'lifecycle.jsonl');
const MAX_HITS = 5;
// The lifecycle ledger reader (hook/asm-lifecycle.js) is deployed next to this hook. A runtime
// deployed before it existed recalls without it, exactly as before.
let lifecycle = null;
try { lifecycle = require(path.join(__dirname, 'asm-lifecycle.js')); } catch { lifecycle = null; }
// A record's rank moves by at most ±15% with its age, reaching the floor at 60 days — the
// same factor as recency_factor() in mcp_server.py.
const RECENCY_R = 0.15;
const RECENCY_DAYS = 60;
// A page the curator keeps a current-state block in is the derived tier: prefer it.
const CURATED_BOOST = 1.25;
const DAILY_ID = /^vault:daily-\d{4}-\d{2}-\d{2}$/;
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
        meta: { description: n.d, tags: n.t, aliases: n.a || [], status: n.s || '', type: n.y || '',
          curated: Boolean(n.c) } }));
  } catch {
    return JSON.parse(fs.readFileSync(BRAIN, 'utf8')).nodes;
  }
}

// Vault page bodies, as the sorted stemmed word lists merge.py writes. Kept as arrays and
// probed by binary search rather than turned into Sets: 651 pages hold ~650k words between
// them and building that many Sets in front of every prompt costs more than the whole hook.
// Optional — a runtime deployed before this file existed simply scores no bodies.
function loadPages() {
  try { return JSON.parse(fs.readFileSync(PAGES, 'utf8')); } catch { return {}; }
}

function sortedHas(words, w) {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid] === w) return true;
    if (words[mid] < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function bodyCovers(words, parts) {
  for (const part of parts) if (!sortedHas(words, part)) return false;
  return true;
}

// Same tuned value as BODY_WEIGHT in mcp_server.py — the server and this hook have to
// agree on what a body hit is worth or the same prompt ranks two different ways.
const BODY_WEIGHT = 1.5;

function readRecords() {
  let text;
  try { text = fs.readFileSync(MEMORY, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && record.id) records.push(record);
    } catch { /* one bad line is not fatal */ }
  }
  return records;
}

// The ledger folded over the records, or null when there is no reader or no ledger to read.
function loadLifecycle(records) {
  if (!lifecycle) return null;
  try {
    const ops = lifecycle.loadOps(LEDGER);
    return { ops, life: lifecycle.fold(ops, records) };
  } catch {
    return null;
  }
}

// Now, or ASM_NOW when it is set: the recall benchmark runs a frozen snapshot at its own time
// (the same rule as _clock() in mcp_server.py).
function clockNow() {
  const frozen = Date.parse(process.env.ASM_NOW || '');
  return Number.isFinite(frozen) ? frozen : Date.now();
}

function recencyFactor(createdAt, now = clockNow()) {
  const at = Date.parse(createdAt || '');
  if (!Number.isFinite(at)) return 1;
  const age = Math.max(0, (now - at) / 86400000);
  return 1 + RECENCY_R - 2 * RECENCY_R * Math.min(age / RECENCY_DAYS, 1);
}

// Shared-memory records are candidates too, so a handoff written five minutes ago is
// recalled on the next prompt instead of after the next graph refresh. `details` is left
// out on purpose: at ~2.6KB per record it would out-match every page on every prompt.
function loadMemory(records, ledger) {
  // A record named in a later record's `supersedes`, or retired in the ledger, leaves recall
  // (same rule as memory_records() in the MCP server); so does a thread the ledger closed.
  const superseded = new Set(records.flatMap((r) => (r && r.supersedes) || []));
  const out = [];
  for (const r of records) {
    if (superseded.has(r.id) || (ledger && ledger.life.hidden('record', r.id))) continue;
    // The summary is scored as a description (+1), never as a label: a 277-char summary
    // scored at label weight let any single 8-char word inject the record on its own.
    const list = (v) => (Array.isArray(v) ? v : []).map(String);
    const threads = list(r.open_threads).filter((_, index) => !ledger || ledger.life.threadOpen(r.id, index));
    out.push({
      id: `memory:${r.id}`, kind: 'memory', label: '',
      path: list(r.files).join(' '),
      weight: recencyFactor(r.created_at),
      meta: { description: String(r.summary || ''), tags: [], aliases: [],
        extra: [...list(r.decisions), ...threads].join(' ') },
    });
  }
  return out;
}

function pageState(node, ledger) {
  const entry = ledger ? ledger.life.state('page', node.id) : null;
  if (entry) return entry;
  const status = String((node.meta && node.meta.status) || '').toLowerCase();
  return status === 'done' || status === 'retired' ? { state: status, op_id: 'frontmatter', at: '' } : null;
}

// Daily notes are never injected: they copy every record, and the records are candidates
// themselves. A retired page leaves recall; a done page stays, marked as finished.
function recallableNodes(nodes, ledger) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === 'page') {
      const meta = node.meta || {};
      if (DAILY_ID.test(node.id) || meta.type === 'daily-note') continue;
      const state = pageState(node, ledger);
      if (state && state.state === 'retired') continue;
      node.state = state;
      if (meta.curated) node.weight = CURATED_BOOST;
    }
    out.push(node);
  }
  return out;
}

function doneTag(state, ledger) {
  const at = String(state.at || '');
  const day = /^\d{4}-\d{2}-\d{2}/.test(at) ? `${at.slice(8, 10)}/${at.slice(5, 7)}` : '';
  let evidence = 'status: done';
  if (state.op_id !== 'frontmatter') {
    const op = ledger ? ledger.ops.find((item) => item.id === state.op_id) : null;
    evidence = op && Array.isArray(op.evidence) && op.evidence[0] ? String(op.evidence[0]) : '';
  }
  return ['DONE', day].filter(Boolean).join(' ') + (evidence ? ` · ${evidence}` : '');
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

// The index side of the match. tokenize() keeps `.`, `-` and `/` so a query can name
// `src/app.py`; a FIELD has to be split on them so a query word can land on one word
// inside a path or a title. Mirrors field_words()/query_parts() in asm_text.py.
function fieldWords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (cp(w) >= 3) out.add(stem(w));
  }
  return out;
}

// A query token may itself be compound: `src/app.py` is one token and three index words,
// and all of them have to be present for it to count as a hit.
function queryParts(t) {
  const parts = fieldWords(t);
  return parts.size ? parts : new Set([t]);
}

function covers(words, parts) {
  for (const part of parts) if (!words.has(part)) return false;
  return true;
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
// (228 files) or a product name mapped three times still counts as evidence for
// the two-hit rule, but it no longer outranks a token that lands on a handful of nodes.
function scoreCandidates(candidates, tokens, PAGE_WORDS = {}) {
  const specific = new Set(tokens.filter((t) => /[./]/.test(t) || cp(t) >= 8));
  const df = new Map();
  const scored = [];
  // Every query part is produced by stripping a prefix or a suffix off a word, so a part
  // that is a WORD of a field is always a SUBSTRING of that field. The cheap substring test
  // is therefore a sound gate: it can only let through nodes the exact test may still
  // reject, never hide one it would accept. Without it this hook builds ~190k Sets in front
  // of every prompt and takes 219ms instead of 50.
  const partsByToken = new Map(tokens.map((t) => [t, [...queryParts(t)]]));
  for (const n of candidates) {
    if (n.kind === 'root') continue; // dirs carry a generated overview since merge.py described them
    const meta = n.meta || {};
    const rawAliases = (Array.isArray(meta.aliases) ? meta.aliases : [meta.aliases || '']).join(' ');
    const blob = (`${n.label || ''} ${n.path || ''} ${meta.description || ''} `
      + `${(meta.tags || []).join(' ')} ${rawAliases} ${meta.extra || ''}`).toLowerCase();
    const bodyWords = PAGE_WORDS[n.id];
    const live = tokens.filter((t) => {
      const parts = partsByToken.get(t);
      return parts.every((part) => blob.includes(part))
        || (bodyWords && bodyCovers(bodyWords, parts));
    });
    if (!live.length) continue;
    const label = fieldWords(n.label);
    const path = fieldWords(n.path);
    const desc = fieldWords(meta.description);
    const tags = fieldWords((meta.tags || []).join(' '));
    const aliases = fieldWords(rawAliases);
    const extra = fieldWords(meta.extra);
    const body = bodyWords;
    let score = 0;
    let matched = 0;
    let strong = false;
    const hits = [];
    for (const t of live) {
      const parts = partsByToken.get(t);
      let s = 0;
      if (covers(tags, parts)) s += 3;
      if (covers(label, parts)) s += 2;
      if (covers(aliases, parts)) s += 2;
      if (covers(desc, parts)) s += 1;
      if (covers(path, parts)) s += 1;
      if (covers(extra, parts)) s += 1;
      if (body && bodyCovers(body, parts)) s += BODY_WEIGHT;
      if (s) {
        score += s;
        matched++;
        hits.push([t, s]);
        df.set(t, (df.get(t) || 0) + 1);
        // An alias is a name a human gave the page on purpose, so one hit on it is as
        // deliberate as a filename — Hebrew names rarely reach the 8-char bar otherwise.
        if (covers(aliases, parts)
            || (specific.has(t) && (covers(label, parts) || covers(path, parts) || covers(tags, parts)))) {
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
    item.rank = rank * (item.knowledge ? 1.25 : 1) * (item.n.weight || 1);
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
  if (process.env.ASM_JOB === '1') return; // ASM's own background jobs never feed ASM's hooks
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const prompt = String(p.prompt || '');
    if (!prompt || prompt.startsWith('/')) return; // slash commands route themselves
    const tokens = tokenize(prompt);
    if (!tokens.length) return;

    const session = sessionId(p);
    const ledgerFile = session ? path.join(SESSIONS, `${session}.recall.json`) : null;
    const ledger = ledgerFile ? loadLedger(ledgerFile) : { turn: 0, entries: {} };

    const records = readRecords();
    const lifeState = loadLifecycle(records);
    const candidates = [...recallableNodes(loadNodes(), lifeState), ...loadMemory(records, lifeState)];
    const scored = scoreCandidates(candidates, tokens, loadPages());
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
      const tag = n.state && n.state.state === 'done' ? ` [${doneTag(n.state, lifeState)}]` : '';
      return `- ${n.id}${tag}${tail}`;
    });
    process.stdout.write(
`ASM recall — shared-memory nodes matching this prompt (located, not yet read):
${lines.join('\n')}
Open a vault node with mcp__asm__brain_node; call mcp__asm__brain_context(file) before editing code.
`);
  } catch { /* malformed payload or brain missing — inject nothing */ }
});
