#!/usr/bin/env node
// okf-build — the OKF catalog generator for an ASM vault (Obsidian). Copy it into <vault>/okf/.
// מחולל קטלוג OKF לכספת.
// סורק wiki/main/**/*.md, פרסר frontmatter, ופולט bundle תואם-OKF ל-okf/:
//   catalog.json  — מכונה-קריא, כל המושגים בקריאה אחת
//   graph.json    — גרף-ידע (adjacency קדימה + backlinks) מ-related
//   index.md      — OKF progressive-disclosure, מקובץ לפי דומיין
// ללא תלויות. מטפל בנתיבי Unicode/עברית. אידמפוטנטי.
//
// שימוש:  node <vault>/okf/okf-build.mjs   (the ASM refresh runs it on every refresh)

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep, posix } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = join(__dirname, '..');          // <vault>/
const SCAN_DIR = join(VAULT_ROOT, 'wiki', 'main');  // wiki/main/
const OUT_DIR = __dirname;                           // okf/
// The vault's own folder name, unless OKF_VAULT_NAME says otherwise.
const VAULT_NAME = process.env.OKF_VAULT_NAME || VAULT_ROOT.split(sep).filter(Boolean).pop() || 'vault';

// תיקיות/קבצים שלא נסרקים (מנוהלי-תוסף או ניווט)
const SKIP_DIRS = new Set(['.openclaw-wiki', 'reports', '_attachments', '_views', 'code']);
const SKIP_BASENAMES = new Set(['index.md', 'inbox.md']);

// ---- סריקת קבצים ----
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, acc);
    } else if (name.endsWith('.md') && !SKIP_BASENAMES.has(name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---- פרסר frontmatter מינימלי (מספיק לסכמה השטוחה של הכספת) ----
function stripQuotes(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function parseInlineArray(s) {
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(x => stripQuotes(x)).filter(x => x.length);
}
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { fm: null, body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { fm: null, body: content };
  const raw = content.slice(3, end).replace(/^\r?\n/, '');
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const lines = raw.split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    let rest = m[2];
    if (rest.trim() === '') {
      // ייתכן block list בשורות הבאות
      const arr = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(stripQuotes(lines[++i].replace(/^\s*-\s+/, '')));
      }
      fm[key] = arr; // גם אם ריק — מפתח קיים עם ערך ריק
      if (arr.length === 0) fm[key] = '';
    } else if (rest.trim().startsWith('[')) {
      fm[key] = parseInlineArray(rest);
    } else {
      fm[key] = stripQuotes(rest);
    }
  }
  return { fm, body };
}

function firstH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}
function toPosixRel(fullPath) {
  return relative(VAULT_ROOT, fullPath).split(sep).join(posix.sep);
}

const OKF_FIELDS = ['title', 'description', 'tags', 'resource', 'related', 'contradictions', 'aliases'];
function pickOkf(fm) {
  // רק שדות OKF שנוכחים בפועל ב-frontmatter (לא ריקים) — לצילום ה-snapshot
  const o = {};
  for (const k of OKF_FIELDS) {
    const v = fm[k];
    if (v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    o[k] = v;
  }
  return o;
}
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// ---- בניית entries ----
const files = walk(SCAN_DIR).sort();
const entries = [];
const rawOkf = {};   // relPath → שדות OKF שנוכחים בפועל (מקור לצילום הבטיחות)
const unindexed = [];         // "shadow missed list" — נסרק אך לא נכנס לקטלוג (coverage honesty)
const bodyWikilinks = [];     // {from: relPath, to: target} — לבדיקת לינקים שבורים
const fileStems = new Set();  // שם-קובץ ללא .md — יעדי wikilink לגיטימיים
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
let maxMtimeMs = 0;
for (const full of files) {
  const content = readFileSync(full, 'utf8');
  maxMtimeMs = Math.max(maxMtimeMs, statSync(full).mtimeMs);
  const { fm, body } = parseFrontmatter(content);
  const relPathEarly = toPosixRel(full);
  fileStems.add(relPathEarly.split(posix.sep).pop().replace(/\.md$/, ''));
  for (const m of body.matchAll(WIKILINK_RE)) {
    bodyWikilinks.push({ from: relPathEarly, to: m[1].trim() });
  }
  if (!fm || !fm.type) { unindexed.push(relPathEarly); continue; } // רק דפים עם frontmatter תקין ו-type
  const relPath = relPathEarly;
  rawOkf[relPath] = pickOkf(fm);
  const sources = asArray(fm.sources);
  const entry = {
    id: fm.id || relPath,
    path: relPath,
    type: fm.type,
    pageType: fm.pageType || fm.type,
    title: fm.title || firstH1(body) || fm.id || relPath,
    description: fm.description || '',
    tags: asArray(fm.tags),
    resource: fm.resource || sources[0] || '',
    related: asArray(fm.related),
    updatedAt: fm.updatedAt || fm.updated || '',
  };
  // contradictions נכלל רק כשקיים בפועל (synthesis/claim שמחליף מידע ישן) — כדי לא לשנות פלט של דפים בלעדיו
  const contradictions = asArray(fm.contradictions);
  if (contradictions.length) entry.contradictions = contradictions;
  // aliases (שדה Obsidian מובנה): שמות עבריים/חלופיים ל-recall של סוכנים בלבד — לא tags,
  // כי tags יוצרים קשתות xlayer בגרף; נכלל רק כשקיים בפועל
  const aliases = asArray(fm.aliases);
  if (aliases.length) entry.aliases = aliases;
  entries.push(entry);
}
entries.sort((a, b) => a.path.localeCompare(b.path));

// generatedAt נגזר מזמן-העריכה המקסימלי של המקורות → הרצה חוזרת ללא שינוי היא אידמפוטנטית
const generatedAt = new Date(maxMtimeMs || Date.now()).toISOString();

// ---- גרף-ידע + בריאות ----
// health = "shadow missed graph": הפערים של האינדקס הם בעצמם נתונים שאילתיים.
// אזהרות בלבד — health לעולם לא מכשיל את ה-build (ה-Stop hook חייב להישאר שקט).
const byId = new Map();
const health = {
  danglingRelated: [],        // {from, to, suggestion?} — יעד related שאינו id קיים
  danglingContradictions: [], // {from, to} — supersession תלוי = הדף שהוחלף בלתי-נגיש
  brokenWikilinks: [],        // {from, to} — [[לינק]] בגוף דף שלא נפתר
  invalidPageType: [],        // {path, pageType} — מחוץ ל-enum
  duplicateIds: [],           // {id, paths} — אותו id בשני נתיבים
  unindexed,                  // נסרק ודולג (אין frontmatter/type)
  singletonTypeCount: 0,      // ערכי type בשימוש חד-פעמי (סימן לזליגת אוצר-מילים)
};
const PAGE_TYPES = new Set(['entity', 'concept', 'synthesis', 'source', 'architecture', 'report']);
for (const e of entries) {
  if (byId.has(e.id)) {
    health.duplicateIds.push({ id: e.id, paths: [byId.get(e.id).path, e.path] });
  } else {
    byId.set(e.id, e);
  }
  if (!PAGE_TYPES.has(e.pageType)) health.invalidPageType.push({ path: e.path, pageType: e.pageType });
}
// הצעות ליעדים תלויים: התאמת-stem מדויקת בלבד (המקרה הנפוץ — שם-קובץ שימש כ-id במקום ה-id בפועל)
// ponytail: exact-stem suggestions only; add prefix match if cleanup leaves stragglers
const stemToId = new Map();
for (const e of entries) {
  const stem = e.path.split(posix.sep).pop().replace(/\.md$/, '');
  if (stem !== e.id && !stemToId.has(stem)) stemToId.set(stem, e.id);
}
const adjacency = {};
const backlinks = {};
for (const e of entries) { adjacency[e.id] = []; backlinks[e.id] ||= []; }
const edges = [];
for (const e of entries) {
  for (const r of e.related) {
    if (!byId.has(r)) {
      const item = { from: e.id, to: r };
      if (stemToId.has(r)) item.suggestion = stemToId.get(r);
      health.danglingRelated.push(item);
      continue; // קשתות רק ליעדים קיימים — בלי קשתות-רפאים
    }
    adjacency[e.id].push(r);
    backlinks[r].push(e.id);
    edges.push({ from: e.id, to: r });
  }
  for (const c of e.contradictions || []) {
    if (!byId.has(c)) health.danglingContradictions.push({ from: e.id, to: c });
  }
}
// wikilinks בגוף דפים: נפתרים מול id-ים, שמות-קבצים, ומסמכי הניווט
const WIKILINK_WHITELIST = new Set(['wikilink', 'wikilinks', 'index', 'WIKI', 'AGENTS', 'README', 'inbox']);
for (const { from, to } of bodyWikilinks) {
  if (byId.has(to) || fileStems.has(to) || WIKILINK_WHITELIST.has(to)) continue;
  health.brokenWikilinks.push({ from, to });
}
const typeCounts = {};
for (const e of entries) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
health.singletonTypeCount = Object.values(typeCounts).filter(n => n === 1).length;

const graph = {
  version: 1,
  generatedAt,
  nodes: entries.map(e => e.id),
  edges,
  adjacency,
  backlinks,
};

// ---- catalog.json ----
const catalog = {
  version: 2,
  format: 'OKF-0.1',
  generatedAt,
  vault: VAULT_NAME,
  count: entries.length,
  health,
  concepts: entries,
};

// ---- index.md (OKF progressive disclosure, פיצול היברידי) ----
// נקודת הכניסה נשארת קטנה: דומיינים חוצי-רוחב מלאים inline, projects/daily הופכים
// ל-TOC עם ספירות מדויקות שמפנה לקבצי פירוט ב-okf/index/ — נקראים רק כשרלוונטי.
// שורת ה-related הוסרה מהאינדקסים: catalog.json/graph.json כבר משרתים אותה במלואה.
function domainOf(relPath) {
  // wiki/main/<domain>/... → <domain>; wiki/main/<file> → 'root'
  const parts = relPath.split(posix.sep); // ['wiki','main',...]
  return parts.length > 3 ? parts[2] : 'root';
}
const domains = {};
for (const e of entries) (domains[domainOf(e.path)] ||= []).push(e);
const domainOrder = ['root', 'concepts', 'syntheses', 'architecture', 'projects', 'entities', 'sources', 'daily'];
const domainNames = {
  root: 'שורש הכספת', concepts: 'מושגים תפעוליים', syntheses: 'סיכומים חוצי-רוחב',
  architecture: 'ארכיטקטורה', projects: 'פרויקטים', entities: 'ישויות',
  sources: 'מקורות', daily: 'הערות יומיות',
};
const orderedDomains = [
  ...domainOrder.filter(d => domains[d]),
  ...Object.keys(domains).filter(d => !domainOrder.includes(d)).sort(),
];

function rowsFor(list, linkPrefix) {
  let out = '';
  for (const e of list.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const desc = e.description ? ` — ${e.description}` : '';
    const tags = e.tags.length ? `  \`${e.tags.join('` `')}\`` : '';
    out += `- [${e.title}](${linkPrefix}${e.path}) \`${e.type}\`${desc}${tags}\n`;
  }
  return out;
}

const INDEX_DIR = join(OUT_DIR, 'index');
mkdirSync(INDEX_DIR, { recursive: true });
const detailFiles = new Map(); // basename → תוכן; נכתבים בסוף, ישנים נמחקים
function detailFile(basename, heading, list) {
  let d = `# ${heading}\n\n`;
  d += '> קובץ מחולל אוטומטית ע"י `okf-build.mjs` — אין לערוך ידנית.\n\n';
  d += rowsFor(list, '../../');
  detailFiles.set(basename, d);
}

let md = '';
md += '---\n';
md += 'type: OKF Catalog\n';
md += `title: "OKF Knowledge Catalog — ${VAULT_NAME} Vault"\n`;
md += 'description: "אינדקס progressive-disclosure מחולל של כל מושגי הכספת — נקודת הכניסה של הסוכן."\n';
md += `generatedAt: ${catalog.generatedAt}\n`;
md += `count: ${entries.length}\n`;
md += '---\n\n';
md += `# OKF Knowledge Catalog — ${VAULT_NAME} Vault\n\n`;
md += '> קובץ מחולל אוטומטית ע"י `okf-build.mjs`. אין לערוך ידנית — ערוך את ה-frontmatter של הדפים והרץ מחדש.\n\n';
md += 'נקודת כניסה לסוכן: סרוק את הרשימה, אתר את המושג הרלוונטי לפי ה-description, ופתח רק את הדף הקנוני.\n';
md += 'דפי פרויקט והערות יומיות — בקבצי פירוט תחת `index/` (קרא רק את הרלוונטי).\n';
md += 'מכונה-קריא מקביל: [`catalog.json`](catalog.json) · גרף-ידע: [`graph.json`](graph.json)\n\n';

// בלוק בריאות: ספירות בלבד; העדר הבלוק = נקי. truncation לעולם לא שקט.
{
  const hc = [
    ['dangling-related', health.danglingRelated.length],
    ['dangling-contradictions', health.danglingContradictions.length],
    ['broken-wikilinks', health.brokenWikilinks.length],
    ['invalid-pageType', health.invalidPageType.length],
    ['duplicate-ids', health.duplicateIds.length],
    ['unindexed', health.unindexed.length],
  ].filter(([, n]) => n > 0);
  if (hc.length) {
    md += '## בריאות הקטלוג\n\n';
    for (const [k, n] of hc) md += `- ${n} ${k}\n`;
    md += '\nפירוט מלא: [`catalog.json`](catalog.json) → `health`.\n\n';
  }
}

for (const dom of orderedDomains) {
  const list = domains[dom];
  if (dom === 'projects') {
    // TOC עומק-2: שורה לפרויקט + קובץ פירוט — נקודת הכניסה גדלה עם מספר הפרויקטים, לא הדפים
    const byProject = {};
    for (const e of list) {
      const parts = e.path.split(posix.sep); // wiki/main/projects/<name>/...
      const name = parts.length > 4 ? parts[3] : '_root';
      (byProject[name] ||= []).push(e);
    }
    md += `## ${domainNames[dom]} — ${list.length} דפים\n\n`;
    for (const name of Object.keys(byProject).sort()) {
      const sub = byProject[name];
      detailFile(`projects-${name}.md`, `${domainNames[dom]} / ${name}`, sub);
      md += `- [${name}](index/projects-${name}.md) — ${sub.length} דפים\n`;
    }
    md += '\n';
  } else if (dom === 'daily') {
    detailFile('daily.md', domainNames[dom], list);
    md += `## ${domainNames[dom]}\n\n- [daily](index/daily.md) — ${list.length} רשומות\n\n`;
  } else {
    md += `## ${domainNames[dom] || dom}\n\n`;
    md += rowsFor(list, '../');
    md += '\n';
  }
}

// ---- snapshot בטיחות + זיהוי regression ----
// okf-fields.json הוא זיכרון עמיד של שדות OKF. union-merge: הערך הנוכחי מנצח,
// והקודם ממלא פערים — כך ששדה ידוע-טוב לעולם לא נמחק מהצילום גם אם נעלם מ-frontmatter
// (למשל אם openclaw ידרוס). okf-restore.mjs יכול לשחזר ממנו. לא מכיל timestamp → אידמפוטנטי.
const SNAP_PATH = join(OUT_DIR, 'okf-fields.json');
let prevSnap = {};
try { prevSnap = JSON.parse(readFileSync(SNAP_PATH, 'utf8')); } catch { prevSnap = {}; }

const snapshot = {};
const regressions = [];
const allPaths = new Set([...Object.keys(rawOkf), ...Object.keys(prevSnap)]);
for (const relPath of [...allPaths].sort()) {
  if (!existsSync(join(VAULT_ROOT, relPath.split(posix.sep).join(sep)))) continue; // נמחק → נשמט מהצילום
  const cur = rawOkf[relPath] || {};
  const prev = prevSnap[relPath] || {};
  for (const k of Object.keys(prev)) if (!(k in cur)) regressions.push({ path: relPath, key: k });
  const merged = { ...prev, ...cur };
  if (Object.keys(merged).length) snapshot[relPath] = sortKeys(merged);
}

// ---- כתיבה (אטומית: tmp → rename; קבצי 240KB על OneDrive מתוך Stop hook שעלול להיהרג באמצע) ----
function publish(dest, data) {
  writeFileSync(dest + '.tmp', data, 'utf8');
  renameSync(dest + '.tmp', dest);
}
publish(join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
publish(join(OUT_DIR, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
publish(join(OUT_DIR, 'index.md'), md);
publish(SNAP_PATH, JSON.stringify(snapshot, null, 2) + '\n');
for (const [basename, data] of detailFiles) publish(join(INDEX_DIR, basename), data);
// purge קבצי פירוט שלא נוצרו בריצה זו (פרויקט ששמו השתנה לא משאיר רוח)
for (const name of readdirSync(INDEX_DIR)) {
  if (name.endsWith('.md') && !detailFiles.has(name)) unlinkSync(join(INDEX_DIR, name));
}

console.log(`OKF build: ${entries.length} concepts → catalog.json, graph.json, index.md, okf-fields.json`);
const missing = entries.filter(e => !e.description);
if (missing.length) {
  console.log(`  ${missing.length} ללא description:`);
  for (const e of missing) console.log(`   - ${e.path}`);
}
// health: אזהרות בלבד, לא משנה exit code — ponytail: health never fails the build
const healthCounts = [
  ['dangling-related', health.danglingRelated.length],
  ['dangling-contradictions', health.danglingContradictions.length],
  ['broken-wikilinks', health.brokenWikilinks.length],
  ['invalid-pageType', health.invalidPageType.length],
  ['duplicate-ids', health.duplicateIds.length],
  ['unindexed', health.unindexed.length],
].filter(([, n]) => n > 0);
if (healthCounts.length) {
  console.log(`  בריאות: ${healthCounts.map(([k, n]) => `${n} ${k}`).join(', ')} (פירוט ב-catalog.json → health)`);
  for (const d of health.danglingRelated) {
    console.log(`   - related ${d.from} → ${d.to}${d.suggestion ? `  (אולי: ${d.suggestion})` : ''}`);
  }
  for (const d of health.danglingContradictions) console.log(`   - contradictions ${d.from} → ${d.to}`);
  for (const d of health.brokenWikilinks) console.log(`   - wikilink ${d.from} → [[${d.to}]]`);
  for (const d of health.invalidPageType) console.log(`   - pageType ${d.path}: ${d.pageType}`);
  for (const d of health.duplicateIds) console.log(`   - duplicate id ${d.id}: ${d.paths.join(' , ')}`);
}
if (regressions.length) {
  console.log(`  ⚠ ${regressions.length} שדות OKF נעלמו מ-frontmatter (regression) — הרץ okf-restore.mjs לשחזור:`);
  for (const r of regressions) console.log(`   - ${r.path}: ${r.key}`);
  process.exitCode = 2; // סימון לא-אפס כדי שה-hook/CI יבחין
}
