import type { MemoryRecord } from '../store/store.types.js';
import type { StateBlock } from './state-block.js';

const recordLine = (record: MemoryRecord): string => {
  const open = record.open_threads.slice(0, 3).map((t) => t.slice(0, 200)).join(' ; ');
  const decisions = record.decisions.slice(0, 3).map((d) => d.slice(0, 200)).join(' ; ');
  return `- memory:${record.id} (${record.created_at}): ${record.summary}${open ? ` | still open then: ${open}` : ''}${decisions ? ` | decisions: ${decisions}` : ''}`;
};

export function blockPrompt(project: string, block: StateBlock | undefined, records: readonly MemoryRecord[], retracted: readonly string[]): string {
  const current = block && block.bullets.length > 0
    ? block.bullets.map((bullet) => `[${bullet.id}] ${bullet.text}`).join('\n')
    : '(none yet — build it from the records below with append operations)';
  return `You keep the "Current state" block of the project page "${project}" in a shared memory that coding
agents read before they work. The block says what is true NOW: what runs in production, which flags are
on, what shipped, what is still open, which decisions stand. Every bullet cites the work records it rests on.

CURRENT BLOCK:
${current}

RETRACTED RECORDS (a bullet resting only on these must go): ${retracted.length ? retracted.map((id) => `memory:${id}`).join(', ') : '(none)'}

NEW RECORDS, oldest first:
${records.map(recordLine).join('\n')}

Rules:
- Make the smallest change: replace a bullet whose fact changed, remove a bullet that a record explicitly
  refutes or that rests only on retracted records, append a bullet for a new lasting fact.
- Keep every bullet nothing refutes. A record that does not mention a bullet does not refute it.
- On the same fact the latest record wins; an older record never overrides a newer one.
- One fact per bullet, one line each, "since DD/MM" for states that change, in the records' language.
- The block holds at most 1,500 characters: at most 8 bullets, each under 110 characters of text, citing one or
  two records. List the most current facts first (what runs in production now, what blocks the work); older
  background goes last and is the first to be cut when space runs out.
- Cite only 16-hex ids from NEW RECORDS or ids already cited in the bullet you replace.
- Leave out narrative, one-off steps and anything already superseded.

Answer with JSON only, no prose:
{"ops":[{"op":"replace","block_id":"s-…","text":"…","cites":["<16-hex id>"]},{"op":"remove","block_id":"s-…"},{"op":"append","text":"…","cites":["<16-hex id>"]}]}`;
}

/** A file as the model reads it: whole up to 60,000 characters, else its start and its (newest) end. */
export function excerpt(text: string): string {
  return text.length <= 60_000 ? text : `${text.slice(0, 10_000)}\n\n[… ${text.length - 60_000} characters left out …]\n\n${text.slice(-50_000)}`;
}

const NEWEST_WINS = `The newest dated statement wins wherever it sits — in the file or in the line's own dated
segments. A file's start is often its oldest part: read all of it before deciding what is current.`;

export function indexLinePrompt(line: string, memoryFile: string, projectState?: string): string {
  return `A line of an agent memory index has piled up dated updates. Rewrite it as ONE line that says only
what is true now, in its language, at most 300 characters after the link. Keep the leading
"- [title](file.md)" exactly as it is, followed by " — ", and keep every other link the line has.
The memory file${projectState ? ' and the project state' : ''} below are the source of truth; drop values they show were superseded.
${NEWEST_WINS}
Answer with JSON only: {"line": "- [title](file.md) — …"}

LINE:
${line}

MEMORY FILE:
${excerpt(memoryFile)}${projectState ? `\n\nPROJECT CURRENT STATE:\n${projectState}` : ''}`;
}

export function compactionPrompt(fileText: string): string {
  return `This memory file accumulated dated updates instead of being rewritten. Write its CURRENT STATE:
3 to 8 short bullets ("- …") of what is true now, the newest statement winning on each fact, in the file's
language. End each bullet with the date of the section it comes from, as "(DD/MM)". Do not repeat history.
${NEWEST_WINS}
Answer with JSON only: {"current_state": "- …\\n- …"}

FILE:
${excerpt(fileText)}`;
}
