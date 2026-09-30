#!/usr/bin/env node
// ASM skill router — SKILL.state applied to skill loading.
//
// The paper (arXiv:2608.26263, "SKILL.state: Scalable Long-Horizon Agent Skills") replaces
// an append-only transcript with a small mutable state Σ that the runtime validates and
// patches every step, so the prompt stays O(1) and the run costs O(T) tokens. This hook is
// that idea pointed at one recurring cost: deciding which of ~200 installed skills applies
// to a prompt, and loading each SKILL.md at most once per context window.
//
//   Σ_skills (per session, ~/.asm/sessions/<id>.skills.json)
//     loaded   — skills whose SKILL.md is in the current context window (reset on compact)
//     hinted   — skills suggested recently (cooldown, so a hint that was declined stays quiet)
//     actions  — action→skill hints already given (cooldown in tool turns)
//   P  (the map, ~/.asm/skill-map.json) — derived once from every SKILL.md frontmatter plus
//      the curated overrides file; rebuilt when the skill roots change.
//   O  (the observation) — the prompt, or the tool call about to run.
//
// Every hook run reads (P, Σ, O), emits at most a few lines, applies a patch to Σ, and
// keeps no history. Silent whenever nothing matches.
//
// Modes:
//   (stdin JSON)              hook mode — dispatches on hook_event_name
//   --build                   rebuild ~/.asm/skill-map.json from the skill roots + overrides
//   --route "<text>" [--cwd D] [--session S]   dry-run the prompt router, prints JSON
//   --status <session>        print Σ_skills for a session
//   --report [days]           precision report from ~/.asm/skill-usage.jsonl
// Deployed copy: ~/.asm/hooks/asm-skill-router.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const RUNTIME = process.env.ASM_HOME || path.join(HOME, '.asm');
const CONFIG_HOME = process.env.ASM_CONFIG_HOME || HOME;
const MAP = path.join(RUNTIME, 'skill-map.json');
const OVERRIDES = path.join(RUNTIME, 'skill-map.overrides.json');
const USAGE = path.join(RUNTIME, 'skill-usage.jsonl');
const SESSIONS = path.join(RUNTIME, 'sessions');

const MAX_HINTS = 3;           // more than three candidates is a menu, not a routing decision
const HINT_COOLDOWN = 4;       // scored prompts before the same unloaded skill is suggested again
const LOADED_COOLDOWN = 6;     // scored prompts before "already loaded" is repeated for a skill
const ACTION_COOLDOWN = 40;    // tool turns before the same action→skill hint repeats
const HEAVY_TOKENS = 2500;     // above this the hint carries a size warning
const RARE_DF = 3;             // a description token shared by more skills than this is not evidence
const PROMPT_CAP = 20000;      // pasted logs beyond this are not routing signal
const MUTATORS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

// ---------------------------------------------------------------- small utilities

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function expandHome(p) {
  return /^~(?:[\/\\]|$)/.test(p) ? HOME + p.slice(1) : p;
}

const cp = (t) => [...t].length;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEBREW = /[א-ת]/;

// Hebrew is agglutinative: "הסקילים" must hit a trigger "סקיל". Up to two clitic letters
// in front and one common suffix behind. Latin words get the usual plural/verb endings.
// `\b` is ASCII-only in JS, so boundaries are spelled out as "not a letter".
function wordRegex(term) {
  const t = escapeRegex(term);
  if (HEBREW.test(term)) {
    return new RegExp(`(?:^|[^\\p{L}])[הבלומשכ]{0,2}${t}(?:ים|ות|יה|ית|י|ה)?(?=$|[^\\p{L}])`, 'u');
  }
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${t}(?:s|es|ed|ing)?(?=$|[^\\p{L}\\p{N}])`, 'u');
}

// A trigger with spaces or punctuation is a phrase: plain containment. A single word is
// matched with inflection tolerance.
function matchesTerm(text, term) {
  const term_ = String(term || '').toLowerCase().trim();
  if (cp(term_) < 2) return false;
  // Containment is necessary for every match (a prefix or suffix only adds letters around
  // the term), so the regex — the expensive part, ~6,000 of them per prompt otherwise —
  // is compiled only for the handful of terms that are actually present.
  if (!text.includes(term_)) return false;
  if (/[^\p{L}\p{N}]/u.test(term_)) return true;
  return wordRegex(term_).test(text);
}

// Minimal glob → regex. `**` spans directories, `*` stays inside one segment, `{a,b}` is a
// choice. Paths are compared with forward slashes; a leading `**/` also matches the root.
function globToRegex(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) { re += '\\{'; continue; }
      re += `(?:${g.slice(i + 1, end).split(',').map(escapeRegex).join('|')})`;
      i = end;
    } else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`, 'i');
}

function matchesGlob(value, globs) {
  if (!value || !Array.isArray(globs) || !globs.length) return false;
  const v = expandHome(String(value)).replace(/\\/g, '/');
  return globs.some((g) => {
    try { return globToRegex(expandHome(g)).test(v); } catch { return false; }
  });
}

// A cwd rule names a project root (`**/Projects/my-product*`); the session usually sits in a
// subdirectory of it, so the cwd and every ancestor are tried.
function matchesCwd(cwd, globs) {
  if (!cwd || !Array.isArray(globs) || !globs.length) return false;
  let dir = expandHome(String(cwd)).replace(/\\/g, '/').replace(/\/+$/, '');
  for (let i = 0; i < 40 && dir; i++) {
    if (matchesGlob(dir, globs)) return true;
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function matchesPattern(value, patterns) {
  if (!value || !Array.isArray(patterns) || !patterns.length) return null;
  for (const p of patterns) {
    try { if (new RegExp(p, 'iu').test(value)) return p; } catch { /* a bad override regex is not fatal */ }
  }
  return null;
}

// Hebrew costs about a token per character, everything else about four characters a token.
function estimateTokens(text) {
  let hebrew = 0;
  for (const ch of text) if (HEBREW.test(ch)) hebrew++;
  return Math.round(hebrew + (text.length - hebrew) / 4);
}

// ---------------------------------------------------------------- frontmatter

// Enough YAML for SKILL.md frontmatter: scalars, quoted scalars, and `>`/`|` block scalars
// (several installed skills carry multi-paragraph descriptions that way). Anything
// fancier is ignored rather than mis-parsed.
function parseFrontmatter(text) {
  // A file saved on Windows ends its lines in CRLF: `(.*)$` would then match no line at all.
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---')) return {};
  const end = src.indexOf('\n---', 3);
  if (end === -1) return {};
  const lines = src.slice(src.indexOf('\n') + 1, end).split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const fold = value.startsWith('>') || value === '';
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i]);
      }
      const trimmed = block.map((l) => l.replace(/^\s+/, ''));
      value = fold
        ? trimmed.join(' ').replace(/\s+/g, ' ').trim()
        : trimmed.join('\n').trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- skill discovery

function defaultRoots() {
  if (process.env.ASM_SKILL_ROOTS) {
    return process.env.ASM_SKILL_ROOTS.split(path.delimiter).filter(Boolean).map((p) => ({ root: expandHome(p), kind: kindOf(p) }));
  }
  return [
    { root: path.join(CONFIG_HOME, '.claude', 'skills'), kind: 'skills' },
    { root: path.join(CONFIG_HOME, '.claude', 'commands'), kind: 'commands' },
    { root: path.join(CONFIG_HOME, '.claude', 'plugins', 'cache'), kind: 'plugins' },
    { root: path.join(CONFIG_HOME, '.agents', 'skills'), kind: 'skills' },
  ];
}

function kindOf(root) {
  const base = path.basename(root.replace(/[\/\\]+$/, ''));
  if (base === 'commands') return 'commands';
  if (base === 'cache' && /plugins/.test(root)) return 'plugins';
  return 'skills';
}

function enabledPlugins() {
  const settings = readJson(path.join(CONFIG_HOME, '.claude', 'settings.json'), null);
  return settings && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : null;
}

// A plugin whose marketplace registry still points at another machine (the registry was
// carried over from Windows) is cached on disk but never loaded by the client, so its skills
// are not invocable here. Hinting them would send the agent to a name the Skill tool rejects.
function marketplaceAvailable(market) {
  const known = readJson(path.join(CONFIG_HOME, '.claude', 'plugins', 'known_marketplaces.json'), null);
  const entry = known && typeof known === 'object' ? known[market] : null;
  if (!entry || typeof entry !== 'object') return true;
  const loc = entry.installLocation || entry.path || entry.location;
  return loc ? fs.existsSync(String(loc)) : true;
}

function readSkillFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = parseFrontmatter(text.slice(0, 32 * 1024));
  return { fm, bytes: Buffer.byteLength(text), tokens: estimateTokens(text) };
}

function* walkMarkdown(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(full, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) yield full;
  }
}

// One entry per installed skill, named the way the Skill tool expects it:
//   ~/.claude/skills/<name>/SKILL.md            → <name>
//   ~/.claude/commands/<a>.md                    → <a>
//   ~/.claude/commands/<dir>/<sub>/<file>.md     → <dir>:<sub>:<file>   (sub-commands: hint=false)
//   plugins/cache/<market>/<plugin>/<ver>/skills/<s>/SKILL.md → <plugin>:<s>  (enabled only)
function discoverSkills(roots) {
  const found = new Map();
  const put = (entry) => { if (entry && entry.id && !found.has(entry.id)) found.set(entry.id, entry); };
  const enabled = enabledPlugins();
  for (const { root, kind } of roots) {
    if (!fs.existsSync(root)) continue;
    if (kind === 'skills') {
      for (const name of safeReaddir(root)) {
        const file = path.join(root, name, 'SKILL.md');
        const read = readSkillFile(file);
        if (!read) continue;
        put({ id: name, path: file, source: root, sub: false, ...read });
      }
    } else if (kind === 'commands') {
      for (const file of walkMarkdown(root)) {
        const rel = path.relative(root, file).replace(/\\/g, '/').replace(/\.md$/, '');
        const parts = rel.split('/');
        const read = readSkillFile(file);
        if (!read) continue;
        put({ id: parts.join(':'), path: file, source: root, sub: parts.length > 2 || (parts.length === 2 && parts[0] !== parts[1]), ...read });
      }
    } else if (kind === 'plugins') {
      for (const market of safeReaddir(root)) {
        if (!marketplaceAvailable(market)) continue;
        for (const plugin of safeReaddir(path.join(root, market))) {
          const key = `${plugin}@${market}`;
          if (enabled && enabled[key] === false) continue;
          const versions = safeReaddir(path.join(root, market, plugin)).sort();
          for (const version of versions) {
            const skills = path.join(root, market, plugin, version, 'skills');
            for (const s of safeReaddir(skills)) {
              const read = readSkillFile(path.join(skills, s, 'SKILL.md'));
              if (!read) continue;
              found.set(`${plugin}:${s}`, { id: `${plugin}:${s}`, path: path.join(skills, s, 'SKILL.md'), source: root, sub: false, plugin: key, ...read });
            }
          }
        }
      }
    }
  }
  return [...found.values()];
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')); } catch { return []; }
}

// ---------------------------------------------------------------- trigger derivation

const STOP = new Set(`the and for with when user users use uses using used skill skills this that from into
your you are not can will should must also any all each only then than via per how what which where who
asks ask asked mentions mention needs need wants want create creating build building make making generate
generating write writing code file files project projects work working task tasks tool tools based like
such example examples including includes include covers cover support supports supported help helps guide
guides about after before other more most both does doesn don without within between through over under
high low new existing full complete specific general common standard official custom simple best practices
pattern patterns system systems agent agents claude model models api apis data output input integration
integrate application applications app apps web site website page pages content text hebrew israeli israel
english language first second one two three mode modes type types version run runs running set setup sets
get gets add adds added edit edits editing update updates updated check checks checking review reviews
reviewing test tests testing validate validation request requests requested response prompt prompts context
session sessions local remote server servers service services client clients none null true false hook hooks
trigger triggers triggered activate activates activation phrases phrase keywords keyword expert experts
workflow workflows automate automation process processes step steps handle handles handling manage manages
management managing implement implementing implementation design designs designing developer developers
development requires required require provide provides providing produce produces producing return returns
returning multiple single every always never instead rather whether either neither because since while
until unless already just still even much many some few several various different same another other
כל של את על עם או גם לא כן יש אין זה זו זאת אם כי מה איך למה כאשר עבור בתוך לפי כדי אז רק עוד כבר צריך
רוצה אפשר בבקשה תעשה תבנה תיצור תבדוק תריץ סקיל סקילים קובץ קבצים קוד פרויקט משתמש מערכת סוכן עברית
ישראלי ישראל בעברית`.split(/\s+/));

const ID_STOP = new Set(['skill', 'skills', 'israeli', 'gsd', 'hebrew', 'agent', 'claude', 'api', 'system', 'tool', 'tools',
  'best', 'practices', 'guidelines', 'rules', 'tasks', 'templates', 'v1', 'v2', 'core', 'cli', 'use', 'kit']);

// Sentences that say when NOT to use the skill are kept as the `not_for` line and removed
// from the evidence text: "Do NOT use for Tranzila (use tranzila-payment-gateway)" must not
// make the Cardcom skill light up on a Tranzila prompt.
function splitNotFor(description) {
  const sentences = description.split(/(?<=[.!?])\s+|\n+/);
  const negative = [];
  const positive = [];
  for (const s of sentences) {
    if (/\b(do not|don't|never|not for|not use|skip|not triggered|not trigger|nicht)\b/i.test(s) || /^NOT\b/.test(s.trim()) || /\bלא (עבור|ל)/.test(s)) negative.push(s.trim());
    else positive.push(s);
  }
  return { positive: positive.join(' '), not_for: negative.join(' ').slice(0, 220) };
}

function tokenize(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (HEBREW.test(t) ? cp(t) >= 3 : cp(t) >= 4) && !STOP.has(t) && !/^\d+$/.test(t)))];
}

// A weak trigger must be distinctive on its own: "find" and "link" are rare across skill
// descriptions yet common in prompts, so two of them would route half of all requests to
// the research skill. Six Latin letters, or a digit, or four Hebrew letters.
const weakEligible = (t) => (HEBREW.test(t) ? cp(t) >= 4 : cp(t) >= 6 || /\d/.test(t));

// Quoted phrases in a description are the author telling us the exact user words:
// "build an MCP server for X", "צריך MCP לסוכן". Placeholders X/Y/Z are dropped.
function quotedPhrases(text) {
  const out = [];
  const re = /["“”„«»]([^"“”„«»\n]{3,80})["“”„«»]/g;
  let m;
  while ((m = re.exec(text))) {
    const phrase = m[1].replace(/\b[XYZ]\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (cp(phrase) >= 3 && phrase.split(' ').length <= 8 && !/^(?:\/|--)/.test(phrase)) out.push(phrase);
  }
  // "Triggers on: bidi, rtl, hebrew pdf, ..." — a comma list after the keyword.
  const trig = /triggers?\s+(?:on|include|when)\s*:?\s*([^.\n]+)/i.exec(text);
  if (trig) for (const t of trig[1].split(/,|;/)) { const p = t.trim().toLowerCase(); if (cp(p) >= 3 && p.split(' ').length <= 5) out.push(p); }
  return [...new Set(out)];
}

function idTokens(id) {
  return id.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => cp(t) >= 4 && !ID_STOP.has(t));
}

// ---------------------------------------------------------------- overrides + map build

function loadOverrides() {
  const o = readJson(OVERRIDES, {});
  return {
    version: o.version || 1,
    skills: o.skills && typeof o.skills === 'object' ? o.skills : {},
    suppress: Array.isArray(o.suppress) ? o.suppress : [],
    defaults: o.defaults && typeof o.defaults === 'object' ? o.defaults : {},
  };
}

function overrideFor(overrides, id) {
  if (overrides.skills[id]) return overrides.skills[id];
  for (const [key, value] of Object.entries(overrides.skills)) {
    if (/[*?{]/.test(key) && globToRegex(key).test(id)) return value;
  }
  return null;
}

function suppressed(overrides, id) {
  return overrides.suppress.some((g) => (/[*?{]/.test(g) ? globToRegex(g).test(id) : g === id));
}

function buildMap(roots = defaultRoots()) {
  const overrides = loadOverrides();
  const skills = discoverSkills(roots);
  const prepared = skills.map((s) => {
    const description = String(s.fm.description || '').replace(/\s+/g, ' ').trim();
    const { positive, not_for } = splitNotFor(description);
    return { ...s, description, positive, not_for, tokens_desc: tokenize(positive) };
  });
  // Document frequency over the positive text of every skill: a token that names one or
  // two skills is evidence, one that appears in thirty is background.
  const df = new Map();
  for (const p of prepared) for (const t of new Set([...p.tokens_desc, ...idTokens(p.id)])) df.set(t, (df.get(t) || 0) + 1);

  const entries = [];
  let curated = 0;
  for (const p of prepared) {
    const o = overrideFor(overrides, p.id) || {};
    if (Object.keys(o).length) curated++;
    const weak = new Set();
    for (const t of p.tokens_desc) if (weakEligible(t) && (df.get(t) || 0) <= RARE_DF) weak.add(t);
    for (const t of idTokens(p.id)) if (weakEligible(t) && (df.get(t) || 0) <= RARE_DF + 5) weak.add(t);
    for (const t of o.weak || []) weak.add(String(t).toLowerCase());
    const strong = new Set([...quotedPhrases(p.positive), ...(o.triggers || []).map((t) => String(t).toLowerCase())]);
    for (const t of o.drop || []) { strong.delete(String(t).toLowerCase()); weak.delete(String(t).toLowerCase()); }
    const hint = o.hint === false ? false : !(p.sub || suppressed(overrides, p.id));
    entries.push({
      id: p.id,
      path: p.path,
      tokens: p.tokens,
      heavy: p.tokens >= HEAVY_TOKENS,
      hint,
      reason: o.reason || summarize(p.positive),
      not_for: o.not_for !== undefined ? String(o.not_for) : p.not_for,
      strong: [...strong].slice(0, 40),
      weak: [...weak].slice(0, 30),
      patterns: Array.isArray(o.patterns) ? o.patterns : [],
      paths: Array.isArray(o.paths) ? o.paths : [],
      commands: Array.isArray(o.commands) ? o.commands : [],
      cwd: Array.isArray(o.cwd) ? o.cwd : [],
      requires_cwd: Boolean(o.requires_cwd),
      defer_to: Array.isArray(o.defer_to) ? o.defer_to : [],
      plugin: p.plugin || null,
    });
  }
  // Skills the harness ships without a SKILL.md on disk (code-review, dataviz, the artifact
  // skills) exist only as override entries marked `builtin`; they become map entries with
  // an unknown size. Any other override without an installed skill is an orphan: recorded
  // so `--status` can show it, never hinted.
  const known = new Set(entries.map((e) => e.id));
  const orphans = [];
  for (const [key, o] of Object.entries(overrides.skills)) {
    if (/[*?{]/.test(key) || known.has(key)) continue;
    if (!o || o.builtin !== true) {
      // `scope: project` marks a rule for a skill that lives in some repo's .claude/skills
      // and is matched at prompt time; it is not an orphan of the machine-wide map.
      if (!(o && o.scope === 'project')) orphans.push(key);
      continue;
    }
    curated++;
    known.add(key);
    entries.push({
      id: key, path: null, tokens: Number(o.tokens) || 0, heavy: false,
      hint: o.hint !== false && !suppressed(overrides, key),
      reason: o.reason || '', not_for: o.not_for || '',
      strong: (o.triggers || []).map((t) => String(t).toLowerCase()).slice(0, 40),
      weak: (o.weak || []).map((t) => String(t).toLowerCase()).slice(0, 30),
      patterns: Array.isArray(o.patterns) ? o.patterns : [],
      paths: Array.isArray(o.paths) ? o.paths : [],
      commands: Array.isArray(o.commands) ? o.commands : [],
      cwd: Array.isArray(o.cwd) ? o.cwd : [],
      requires_cwd: Boolean(o.requires_cwd),
      defer_to: Array.isArray(o.defer_to) ? o.defer_to : [],
      plugin: null, builtin: true,
    });
  }
  const map = {
    version: 1,
    generatedAt: new Date().toISOString(),
    roots: roots.map((r) => r.root),
    rootsMtime: rootsMtime(roots),
    counts: { skills: entries.length, hintable: entries.filter((e) => e.hint).length, curated, orphans: orphans.length },
    orphans,
    skills: entries,
  };
  atomicWrite(MAP, JSON.stringify(map));
  return map;
}

// The first clause of the description, without the "Use when" boilerplate, as the reason
// shown next to a hint. Kept short: the hint is a pointer, the SKILL.md is the content.
function summarize(text) {
  let s = text.replace(/^(?:this skill should be used when|use (?:this )?(?:skill )?when|use for|must use when)\s*/i, '');
  s = s.split(/(?<=[.;—–-])\s+/)[0] || s;
  return s.slice(0, 110).replace(/[\s,;:—–-]+$/, '');
}

function rootsMtime(roots) {
  let latest = 0;
  for (const { root } of roots) {
    try { latest = Math.max(latest, fs.statSync(root).mtimeMs); } catch { /* absent root */ }
    for (const name of safeReaddir(root)) {
      try { latest = Math.max(latest, fs.statSync(path.join(root, name)).mtimeMs); } catch { /* raced */ }
    }
  }
  return latest;
}

function loadMap() {
  return readJson(MAP, null);
}

function mapIsStale(map, roots = defaultRoots()) {
  if (!map || !Array.isArray(map.skills)) return true;
  if (fs.existsSync(OVERRIDES)) {
    try { if (fs.statSync(OVERRIDES).mtimeMs > Date.parse(map.generatedAt)) return true; } catch { /* ignore */ }
  }
  return rootsMtime(roots) > (map.rootsMtime || 0) + 1000;
}

// ---------------------------------------------------------------- Σ_skills (session state)

function sessionId(p) {
  const raw = p.session_id || p.sessionId || p.conversation_id || p.conversationId;
  const safe = String(raw || '').replace(/[^\w.-]/g, '').slice(0, 160);
  return safe || null;
}

function stateFile(session) { return path.join(SESSIONS, `${session}.skills.json`); }

const EMPTY_STATE = () => ({ version: 1, turn: 0, tool_turn: 0, loaded: {}, hinted: {}, actions: {}, compactions: 0 });

// Invalid state is discarded, not repaired: the paper's runtime rolls back a bad patch and
// retries; here a half-written file just costs one prompt of dedup.
function loadState(session) {
  if (!session) return EMPTY_STATE();
  const s = readJson(stateFile(session), null);
  if (!s || typeof s !== 'object' || s.version !== 1) return EMPTY_STATE();
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    version: 1,
    turn: Number.isInteger(s.turn) ? s.turn : 0,
    tool_turn: Number.isInteger(s.tool_turn) ? s.tool_turn : 0,
    loaded: obj(s.loaded), hinted: obj(s.hinted), actions: obj(s.actions),
    compactions: Number.isInteger(s.compactions) ? s.compactions : 0,
  };
}

// ⊕ with null-deletion: a patch key set to null deletes; an object patch merges one level.
function applyPatch(state, patch) {
  const next = { ...state };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') {
      next[k] = { ...next[k] };
      for (const [kk, vv] of Object.entries(v)) { if (vv === null) delete next[k][kk]; else next[k][kk] = vv; }
    } else next[k] = v;
  }
  return next;
}

// The file on disk always carries the full schema: a map deleted by a `null` patch (the
// compact reset) is written back empty, so `--status` and other readers never see a
// missing key.
function saveState(session, state) {
  if (!session) return;
  try { atomicWrite(stateFile(session), JSON.stringify({ ...EMPTY_STATE(), ...state })); } catch { /* dedup lost for one turn, never the hint */ }
}

// Parallel PreToolUse hooks would otherwise lose each other's writes; the same lock shape
// as the memory gate, bounded so a stale lock can never stall a tool call.
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function withLock(session, fn) {
  if (!session) return fn();
  fs.mkdirSync(SESSIONS, { recursive: true });
  const lock = `${stateFile(session)}.lock`;
  let fd;
  for (let i = 0; i < 60 && fd === undefined; i++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); } catch { /* raced */ }
      Atomics.wait(SLEEP, 0, 0, 5);
    }
  }
  try { return fn(); } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
  }
}

function appendUsage(row) {
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.appendFileSync(USAGE, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
  } catch { /* telemetry is optional */ }
}

function agentName(p) {
  const explicit = process.env.ASM_AGENT_NAME || p.agent_name || p.agentName;
  if (explicit) return String(explicit).slice(0, 80);
  const client = String(p.client_type || p.clientType || '').toLowerCase();
  if (client.includes('cursor') || process.env.CURSOR_VERSION) return 'Cursor';
  if (client.includes('codex') || p.turn_id) return 'Codex';
  return 'Claude Code';
}

// ---------------------------------------------------------------- project-level skills

// <cwd>/.claude/skills is per repository, so it is read at prompt time instead of being
// baked into the machine-wide map. Bounded so a repo with 300 skills stays cheap.
function projectSkills(cwd, known = new Set()) {
  if (!cwd) return [];
  const root = path.join(cwd, '.claude', 'skills');
  const names = safeReaddir(root).filter((n) => !known.has(n)).slice(0, 40);
  if (!names.length) return [];
  const overrides = loadOverrides();
  const out = [];
  for (const name of names) {
    const read = readSkillFile(path.join(root, name, 'SKILL.md'));
    if (!read) continue;
    const description = String(read.fm.description || '').replace(/\s+/g, ' ').trim();
    const { positive, not_for } = splitNotFor(description);
    const o = overrideFor(overrides, name) || {};
    const lower = (list) => (list || []).map((t) => String(t).toLowerCase());
    out.push({
      id: name, path: path.join(root, name, 'SKILL.md'), tokens: read.tokens, heavy: read.tokens >= HEAVY_TOKENS,
      hint: o.hint === false ? false : !suppressed(overrides, name),
      reason: o.reason || summarize(positive), not_for: o.not_for !== undefined ? String(o.not_for) : not_for,
      strong: [...new Set([...quotedPhrases(positive), ...lower(o.triggers)])].filter((t) => !lower(o.drop).includes(t)),
      weak: [...new Set([...tokenize(positive).filter(weakEligible).slice(0, 12), ...lower(o.weak)])],
      patterns: Array.isArray(o.patterns) ? o.patterns : [], paths: Array.isArray(o.paths) ? o.paths : [],
      commands: Array.isArray(o.commands) ? o.commands : [], cwd: Array.isArray(o.cwd) ? o.cwd : [],
      requires_cwd: Boolean(o.requires_cwd), defer_to: Array.isArray(o.defer_to) ? o.defer_to : [], project: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------- routing

function scoreSkill(entry, text, cwd) {
  if (!entry.hint) return null;
  const cwdHit = entry.cwd.length ? matchesCwd(cwd, entry.cwd) : false;
  if (entry.requires_cwd && !cwdHit) return null;
  let score = 0;
  let strong = false;
  let weakHits = 0;
  const reasons = [];
  for (const t of entry.strong) if (matchesTerm(text, t)) { score += 3; strong = true; reasons.push(`"${t}"`); if (reasons.length >= 3) break; }
  const pat = matchesPattern(text, entry.patterns);
  if (pat) { score += 3; strong = true; reasons.push(`/${pat}/`); }
  for (const t of entry.weak) if (matchesTerm(text, t)) { score += 1; weakHits++; if (reasons.length < 4) reasons.push(t); }
  if (cwdHit) { score += 1; reasons.push('cwd'); }
  if (!strong && weakHits < 2) return null;
  return { id: entry.id, score, strong, reasons, tokens: entry.tokens, heavy: entry.heavy, reason: entry.reason, not_for: entry.not_for, defer_to: entry.defer_to };
}

function route(map, prompt, cwd) {
  const text = String(prompt || '').slice(0, PROMPT_CAP).toLowerCase().replace(/\s+/g, ' ');
  const mapped = map && Array.isArray(map.skills) ? map.skills : [];
  const entries = [...mapped, ...projectSkills(cwd, new Set(mapped.map((e) => e.id)))];
  const scored = entries.map((e) => scoreSkill(e, text, cwd)).filter(Boolean);
  const ids = new Set(scored.map((s) => s.id));
  // A skill that defers to a stronger sibling (taste-skill-v1 → taste-skill) steps aside
  // when the sibling also matched.
  const kept = scored.filter((s) => !s.defer_to.some((d) => ids.has(d)));
  kept.sort((a, b) => b.score - a.score || Number(b.strong) - Number(a.strong) || a.tokens - b.tokens);
  return kept;
}

function tok(n) { return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n); }

function formatHint(candidates, loadedMentions) {
  const lines = [];
  if (candidates.length) {
    lines.push(`Skill router — candidates for this prompt (not loaded; load at most one via the Skill tool, or none if none fits):`);
    for (const c of candidates) {
      const why = c.reason ? ` — ${c.reason}` : '';
      const size = c.heavy ? ` · heavy ~${tok(c.tokens)} tok` : '';
      const no = c.not_for ? ` · NOT: ${c.not_for.slice(0, 90)}` : '';
      lines.push(`- ${c.id}${why}${size}${no}`);
    }
  }
  if (loadedMentions.length) {
    lines.push(`Already loaded this session (in context — do not reload): ${loadedMentions.map((m) => `${m.id} (turn ${m.turn})`).join(', ')}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------- hook handlers

function onPrompt(p) {
  const prompt = String(p.prompt || p.user_input || '');
  if (!prompt || prompt.startsWith('/')) return '';       // slash commands route themselves
  const map = loadMap();
  if (!map) return '';
  const cwd = String(p.cwd || process.cwd());
  const session = sessionId(p);
  return withLock(session, () => {
    const state = loadState(session);
    const ranked = route(map, prompt, cwd);
    if (!ranked.length) return '';
    const turn = state.turn + 1;
    const candidates = [];
    const loadedMentions = [];
    for (const c of ranked) {
      const loaded = state.loaded[c.id];
      if (loaded) {
        const last = state.hinted[`loaded:${c.id}`];
        if (!(last && turn - last.turn <= LOADED_COOLDOWN)) loadedMentions.push({ id: c.id, turn: loaded.turn });
        continue;
      }
      const last = state.hinted[c.id];
      if (last && turn - last.turn <= HINT_COOLDOWN) continue;
      if (candidates.length < MAX_HINTS) candidates.push(c);
    }
    const hintedPatch = {};
    for (const c of candidates) hintedPatch[c.id] = { turn };
    for (const m of loadedMentions) hintedPatch[`loaded:${m.id}`] = { turn };
    saveState(session, applyPatch(state, { turn, hinted: hintedPatch }));
    for (const c of candidates) appendUsage({ kind: 'hint', session, agent: agentName(p), skill: c.id, turn, score: c.score, reasons: c.reasons.slice(0, 4) });
    return formatHint(candidates, loadedMentions);
  });
}

function toolName(p) {
  const raw = p.tool_name || p.toolName || (p.toolCall && p.toolCall.name) || '';
  return String(raw);
}

function toolInput(p) {
  const v = p.tool_input || p.toolInput || p.toolArgs || (p.toolCall && p.toolCall.args);
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

function onTool(p) {
  const tool = toolName(p);
  const input = toolInput(p);
  const session = sessionId(p);
  const map = loadMap();
  return withLock(session, () => {
    const state = loadState(session);
    if (tool === 'Skill') {
      const skill = String(input.skill || input.skill_name || input.name || '').trim();
      if (!skill) return null;
      const entry = map && map.skills.find((e) => e.id === skill);
      const reload = Boolean(state.loaded[skill]);
      saveState(session, applyPatch(state, { loaded: { [skill]: { turn: state.turn, tool_turn: state.tool_turn, reload } } }));
      appendUsage({ kind: 'load', session, agent: agentName(p), skill, turn: state.turn, tokens: entry ? entry.tokens : null, hinted: Boolean(state.hinted[skill]), reload });
      return null;                                            // silent: the load is the answer
    }
    if (!map) return null;
    const toolTurn = state.tool_turn + 1;
    const file = input.file_path || input.notebook_path || input.path || '';
    const command = tool === 'Bash' ? String(input.command || '') : '';
    if (!MUTATORS.has(tool) && !command) { saveState(session, applyPatch(state, { tool_turn: toolTurn })); return null; }
    const hits = [];
    for (const e of map.skills) {
      if (!e.hint || state.loaded[e.id]) continue;
      const last = state.actions[e.id];
      if (last && toolTurn - last.tool_turn <= ACTION_COOLDOWN) continue;
      let why = null;
      if (file && matchesGlob(file, e.paths)) why = `writes ${path.basename(String(file))}`;
      else if (command) { const pat = matchesPattern(command, e.commands); if (pat) why = `command matches /${pat}/`; }
      if (why) hits.push({ id: e.id, why, reason: e.reason, heavy: e.heavy, tokens: e.tokens });
      if (hits.length >= 2) break;
    }
    const actionsPatch = {};
    for (const h of hits) actionsPatch[h.id] = { tool_turn: toolTurn };
    saveState(session, applyPatch(state, { tool_turn: toolTurn, actions: actionsPatch }));
    if (!hits.length) return null;
    for (const h of hits) appendUsage({ kind: 'action-hint', session, agent: agentName(p), skill: h.id, tool, why: h.why });
    const lines = hits.map((h) => `- ${h.id} (${h.why})${h.reason ? ` — ${h.reason}` : ''}${h.heavy ? ` · heavy ~${tok(h.tokens)} tok` : ''}`);
    return `Skill router — this action falls under a skill that is not loaded in this session:\n${lines.join('\n')}\nLoad it via the Skill tool before continuing if it applies; ignore if the action is incidental.`;
  });
}

function onSessionStart(p) {
  const source = String(p.source || '').toLowerCase();
  const session = sessionId(p);
  if (session) {
    withLock(session, () => {
      const state = loadState(session);
      if (source === 'compact') {
        // The context window was rewritten: every SKILL.md is gone from it, so hints may
        // return and nothing counts as loaded. This is the paper's "state recovery in
        // zero steps" — the runtime observes the drift, not the model. Reset is a `null`
        // deletion (⊕ merges objects, so an empty object would be a no-op); loadState
        // recreates the missing maps empty.
        saveState(session, applyPatch(state, { loaded: null, hinted: null, compactions: state.compactions + 1 }));
      } else if (source === 'clear') {
        try { fs.unlinkSync(stateFile(session)); } catch { /* nothing to clear */ }
      }
    });
  }
  const roots = defaultRoots();
  const map = loadMap();
  if (!mapIsStale(map, roots)) return '';
  try {
    const built = buildMap(roots);
    return `Skill router: map rebuilt — ${built.counts.skills} skills, ${built.counts.hintable} hintable, ${built.counts.curated} curated rules.\n`;
  } catch (e) {
    return `Skill router: skill map is missing or stale and the rebuild failed (${String(e && e.message || e).slice(0, 120)}); run \`node ~/.asm/hooks/asm-skill-router.js --build\`.\n`;
  }
}

function eventName(p) {
  const compact = String(p.hook_event_name || p.hookEventName || '').replace(/[^A-Za-z]/g, '').toLowerCase();
  if (compact === 'userpromptsubmit') return 'UserPromptSubmit';
  if (compact === 'pretooluse') return 'PreToolUse';
  if (compact === 'sessionstart') return 'SessionStart';
  if (compact === 'posttooluse') return 'PostToolUse';
  return '';
}

function isCursor(p) {
  const client = String(p.client_type || p.clientType || '').toLowerCase();
  return Boolean(process.env.CURSOR_VERSION || p.cursor_version || p.cursorVersion || client.includes('cursor'));
}

function dispatch(p) {
  // Without an event name, infer: a prompt payload routes, a tool payload records.
  const event = eventName(p) || (p.prompt !== undefined ? 'UserPromptSubmit' : toolName(p) ? 'PreToolUse' : p.source !== undefined ? 'SessionStart' : '');
  if (event === 'UserPromptSubmit') {
    const text = onPrompt(p);
    if (text) process.stdout.write(isCursor(p) ? JSON.stringify({ additional_context: text }) : text);
  } else if (event === 'PreToolUse') {
    const text = onTool(p);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }));
  } else if (event === 'SessionStart') {
    const text = onSessionStart(p);
    if (text) process.stdout.write(isCursor(p) ? JSON.stringify({ additional_context: text }) : text);
  }
}

// ---------------------------------------------------------------- CLI modes

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function report(days) {
  let text;
  try { text = fs.readFileSync(USAGE, 'utf8'); } catch { return { rows: 0, skills: {} }; }
  const since = Date.now() - days * 86400000;
  const skills = {};
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!(Date.parse(r.ts) >= since)) continue;
    rows++;
    const s = (skills[r.skill] = skills[r.skill] || { hints: 0, action_hints: 0, loads: 0, loads_after_hint: 0, reloads: 0, tokens: null });
    if (r.kind === 'hint') s.hints++;
    else if (r.kind === 'action-hint') s.action_hints++;
    else if (r.kind === 'load') { s.loads++; if (r.hinted) s.loads_after_hint++; if (r.reload) s.reloads++; if (r.tokens != null) s.tokens = r.tokens; }
  }
  const totals = Object.values(skills).reduce((a, s) => ({
    hints: a.hints + s.hints, loads: a.loads + s.loads, loads_after_hint: a.loads_after_hint + s.loads_after_hint,
    reloads: a.reloads + s.reloads, reload_tokens: a.reload_tokens + s.reloads * (s.tokens || 0),
  }), { hints: 0, loads: 0, loads_after_hint: 0, reloads: 0, reload_tokens: 0 });
  const unpredicted = Object.entries(skills).filter(([, s]) => s.loads && !s.loads_after_hint).map(([id]) => id);
  const noisy = Object.entries(skills).filter(([, s]) => s.hints >= 3 && !s.loads).map(([id]) => id);
  return { days, rows, totals, precision: totals.hints ? +(totals.loads_after_hint / totals.hints).toFixed(2) : null, unpredicted, noisy, skills };
}

function main() {
  const mode = process.argv[2];
  if (mode === '--build') {
    const built = buildMap();
    process.stdout.write(`${MAP}: ${built.counts.skills} skills, ${built.counts.hintable} hintable, ${built.counts.curated} curated, ${built.counts.orphans} override(s) without an installed skill\n`);
    return;
  }
  if (mode === '--route') {
    const text = process.argv[3] || '';
    const cwd = argValue('--cwd') || process.cwd();
    const session = argValue('--session');
    const state = loadState(session ? session.replace(/[^\w.-]/g, '') : null);
    const ranked = route(loadMap(), text, cwd).map((c) => ({ ...c, loaded: Boolean(state.loaded[c.id]), cooled: Boolean(state.hinted[c.id] && state.turn + 1 - state.hinted[c.id].turn <= HINT_COOLDOWN) }));
    process.stdout.write(`${JSON.stringify({ candidates: ranked.slice(0, 8), shown: ranked.filter((c) => !c.loaded && !c.cooled).slice(0, MAX_HINTS).map((c) => c.id) }, null, 2)}\n`);
    return;
  }
  if (mode === '--status') {
    const session = String(process.argv[3] || '').replace(/[^\w.-]/g, '');
    const map = loadMap();
    process.stdout.write(`${JSON.stringify({ session, state: loadState(session), map: map ? { generatedAt: map.generatedAt, counts: map.counts, orphans: map.orphans, stale: mapIsStale(map) } : null }, null, 2)}\n`);
    return;
  }
  if (mode === '--report') {
    process.stdout.write(`${JSON.stringify(report(Number(process.argv[3]) || 7), null, 2)}\n`);
    return;
  }
  if (mode === '--tokenize') { process.stdout.write(JSON.stringify(tokenize(process.argv[3] || ''))); return; }
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    if (process.env.ASM_JOB === '1') return; // ASM's own background jobs never feed ASM's hooks
    try {
      const p = JSON.parse(raw.replace(/^﻿/, ''));
      if (p && typeof p === 'object') dispatch(p);
    } catch { /* malformed payload or missing runtime — inject nothing, never fail the turn */ }
  });
}

main();
