#!/usr/bin/env node
// ASM UserPromptSubmit recall for hook-capable agents: locate the few shared-memory nodes
// that are actually relevant — so recall happens on every prompt without anyone
// remembering to ask for it. Silent when nothing scores; reads brain.json from disk, so
// it works with the visualization server down.
// Deployed copy: ~/.asm/hooks/asm-prompt-recall.js

const fs = require('fs');
// Compact index (pages + files only, no links) — this runs synchronously in front of every
// prompt, so parsing the full 1.3MB graph here would tax every turn. brain.json is the
// fallback for a runtime deployed before merge.py started emitting the index.
const os = require('os');
const path = require('path');
const RUNTIME = process.env.ASM_HOME || path.join(os.homedir(), '.asm');
const INDEX = path.join(RUNTIME, 'brain.index.json');
const BRAIN = path.join(RUNTIME, 'brain.json');
const MAX_HITS = 5;
const MIN_SCORE = 3;

function loadNodes() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8')).map(
      (n) => ({ id: n.i, label: n.l, kind: n.k, path: n.p, meta: { description: n.d, tags: n.t } }));
  } catch {
    return JSON.parse(fs.readFileSync(BRAIN, 'utf8')).nodes;
  }
}

const STOP = new Set([
  'את', 'של', 'על', 'אני', 'אתה', 'לא', 'כן', 'זה', 'זאת', 'יש', 'אין', 'מה', 'איך', 'כמו',
  'גם', 'אבל', 'כדי', 'כל', 'הוא', 'היא', 'הם', 'עם', 'אם', 'רק', 'עוד', 'שם', 'פה', 'צריך',
  'רוצה', 'אפשר', 'בבקשה', 'תעשה', 'תבדוק', 'עכשיו', 'קובץ', 'קוד', 'עבור', 'בתוך', 'לפי',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'you', 'are', 'was',
  'can', 'not', 'but', 'all', 'any', 'now', 'please', 'need', 'want', 'make', 'file', 'code',
  'add', 'fix', 'run', 'use', 'let', 'get', 'set', 'new', 'why', 'how', 'what', 'where',
]);

// Hebrew is agglutinative: "\u05D4\u05D0\u05D9\u05E9\u05D5\u05E8\u05D9\u05DD" must still match "\u05D0\u05D9\u05E9\u05D5\u05E8\u05D9" in a vault description.
// Strip one leading particle (\u05D4/\u05D1/\u05DC/\u05D5/\u05DE/\u05E9/\u05DB) and a plural ending, and match on the stem.
function stem(t) {
  let s = t;
  if (s.length >= 5 && /^[\u05D4\u05D1\u05DC\u05D5\u05DE\u05E9\u05DB]/.test(s)) s = s.slice(1);
  if (s.length >= 6) s = s.replace(/(\u05D9\u05DD|\u05D5\u05EA|\u05D9\u05D4|\u05D9\u05EA)$/, '');
  return s;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const prompt = String(p.prompt || '').toLowerCase();
    if (!prompt || prompt.startsWith('/')) return; // slash commands route themselves

    const tokens = [...new Set(
      prompt.split(/[^\p{L}\p{N}_.\-\/]+/u)
        .map((t) => t.replace(/^[.\-\/]+|[.\-\/]+$/g, ''))
        .filter((t) => t.length >= 3 && !STOP.has(t))
        .map(stem)
        .filter((t) => t.length >= 3)
    )].slice(0, 25);
    if (!tokens.length) return;
    // a token specific enough to stand alone: a filename, or a long rare word
    const specific = new Set(tokens.filter((t) => /[./]/.test(t) || t.length >= 8));

    const hits = [];
    for (const n of loadNodes()) {
      if (n.kind === 'root' || n.kind === 'dir') continue;
      const meta = n.meta || {};
      const label = (n.label || '').toLowerCase();
      const path = (n.path || '').toLowerCase();
      const desc = (meta.description || '').toLowerCase();
      const tags = (meta.tags || []).join(' ').toLowerCase();
      let score = 0;
      let matched = 0;
      let strong = false;
      for (const t of tokens) {
        let s = 0;
        if (tags.includes(t)) s += 3;
        if (label.includes(t)) s += 2;
        if (desc.includes(t)) s += 1;
        if (path.includes(t)) s += 1;
        if (s) {
          score += s;
          matched++;
          if (specific.has(t) && (label.includes(t) || path.includes(t) || tags.includes(t))) {
            strong = true;
          }
        }
      }
      // Two independent hits, always. One generic word landing in one description is
      // a coincidence, and a hook that fires on coincidences gets ignored.
      if (!score || (matched < 2 && !strong)) continue;
      if (n.kind === 'page') score += 1; // knowledge outranks a file at equal evidence
      hits.push({ score, n });
    }
    if (!hits.length) return;
    hits.sort((a, b) => b.score - a.score);
    const top = hits.filter((h) => h.score >= MIN_SCORE).slice(0, MAX_HITS);
    if (!top.length) return;

    const lines = top.map(({ n }) => {
      const d = (n.meta || {}).description;
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
