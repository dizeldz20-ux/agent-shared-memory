import { createHash } from 'node:crypto';

// The curated "Current state" block of a project page. Only the text between the two markers
// is ever written; every byte outside them stays as the owner left it.

export interface Bullet {
  /** An Obsidian block id: `s-` and six hex characters, stable for a given text. */
  readonly id: string;
  readonly text: string;
  /** Full 16-hex record ids this bullet rests on. */
  readonly cites: readonly string[];
}

export interface StateBlock {
  readonly seen: string;
  readonly at: string;
  readonly bullets: readonly Bullet[];
}

export type BlockOp =
  | { readonly op: 'replace'; readonly block_id: string; readonly text: string; readonly cites: readonly string[] }
  | { readonly op: 'remove'; readonly block_id: string }
  | { readonly op: 'append'; readonly text: string; readonly cites: readonly string[] };

const BEGIN = /<!-- asm:state begin([^>]*)-->/g;
const END = '<!-- asm:state end -->';
const CITE = /memory:([0-9a-f]{16})/g;

const citesOf = (text: string): string[] => [...new Set([...text.matchAll(CITE)].map((m) => m[1] ?? ''))].filter(Boolean);
export const bulletId = (text: string): string => `s-${createHash('sha256').update(text).digest('hex').slice(0, 6)}`;

export function readBlock(text: string): { block?: StateBlock; problem?: string } {
  const begins = [...text.matchAll(BEGIN)];
  const ends = text.split(END).length - 1;
  if (begins.length === 0 && ends === 0) return {};
  if (begins.length !== 1 || ends !== 1) return { problem: 'duplicated or unbalanced asm:state markers' };
  const begin = begins[0];
  if (begin?.index === undefined) return { problem: 'unreadable asm:state marker' };
  if (text.indexOf(END) < begin.index) return { problem: 'duplicated or unbalanced asm:state markers' };
  const attrs = begin[1] ?? '';
  const inner = text.slice(begin.index + begin[0].length, text.indexOf(END));
  const bullets: Bullet[] = [];
  for (const line of inner.split('\n')) {
    if (!line.trim() || line.trim() === '## Current state') continue;
    if (!line.startsWith('- ')) return { problem: 'a line that is not a bullet (hand-edited block)' };
    const match = /^- (.*?)\s+\^(s-[0-9a-f]{6})\s*$/.exec(line);
    if (!match?.[1] || !match[2]) return { problem: 'a bullet without its block id (hand-edited block)' };
    bullets.push({ id: match[2], text: match[1], cites: citesOf(match[1]) });
  }
  return { block: { seen: /seen=(\S+)/.exec(attrs)?.[1] ?? '', at: /at=(\S+)/.exec(attrs)?.[1] ?? '', bullets } };
}

export function renderBlock(block: StateBlock): string {
  const lines = block.bullets.map((bullet) => `- ${bullet.text} ^${bullet.id}`);
  return `<!-- asm:state begin seen=${block.seen} at=${block.at} -->\n## Current state\n${lines.join('\n')}\n${END}`;
}

/** Replace the block in place, or insert it after the page's first heading. */
export function writeBlock(pageText: string, block: StateBlock): string {
  const rendered = renderBlock(block);
  const begin = pageText.search(BEGIN);
  if (begin >= 0) {
    const end = pageText.indexOf(END, begin) + END.length;
    return `${pageText.slice(0, begin)}${rendered}${pageText.slice(end)}`;
  }
  const front = /^---\n[\s\S]*?\n---\n/.exec(pageText)?.[0].length ?? 0;
  const heading = /^# .*\n/m.exec(pageText.slice(front));
  const at = heading?.index !== undefined ? front + heading.index + heading[0].length : front;
  return `${pageText.slice(0, at)}\n${rendered}\n${pageText.slice(at)}`;
}

function withCites(text: string, cites: readonly string[]): string {
  const missing = cites.filter((cite) => !text.includes(`memory:${cite}`));
  return missing.length === 0 ? text : `${text} · ${missing.map((cite) => `memory:${cite}`).join(' · ')}`;
}

/**
 * Apply the model's operations under the guards; the block is never left empty or over budget.
 * Appends that do not fit are dropped after every other operation freed what it frees: the one
 * resting on the oldest record first when `recency` ranks citations, else the last one listed.
 */
export function applyOps(block: StateBlock, ops: readonly BlockOp[], allowed: ReadonlySet<string>, budget: number,
  recency?: (cites: readonly string[]) => number): { block: StateBlock; dropped: number } | { error: string } {
  let bullets = [...block.bullets];
  const appended: Bullet[] = [];
  let dropped = 0;
  const valid = (cites: readonly string[]): boolean => cites.length > 0 && cites.every((cite) => allowed.has(cite));
  // A newline, a marker or a block id in model text would make the page look hand-edited forever.
  const safe = (text: string): boolean => !/[\r\n]|<!--|-->|\^s-[0-9a-f]{6}/.test(text);
  for (const op of ops) {
    const index = 'block_id' in op ? bullets.findIndex((bullet) => bullet.id === op.block_id) : -1;
    if (op.op === 'remove' && index >= 0) {
      bullets = bullets.filter((_, i) => i !== index);
    } else if (op.op === 'replace' && index >= 0 && op.text.trim() && safe(op.text) && valid(op.cites)) {
      const text = withCites(op.text.trim(), op.cites);
      bullets[index] = { id: bullets[index]?.id ?? bulletId(text), text, cites: [...op.cites] };
    } else if (op.op === 'append' && op.text.trim() && safe(op.text) && valid(op.cites)) {
      const text = withCites(op.text.trim(), op.cites);
      const bullet = { id: bulletId(text), text, cites: [...op.cites] };
      bullets.push(bullet);
      appended.push(bullet);
    } else {
      dropped += 1;
    }
  }
  while (renderBlock({ ...block, bullets }).length > budget && appended.length > 0) {
    let victim = appended.length - 1;
    for (let i = victim - 1; recency !== undefined && i >= 0; i -= 1) {
      if (recency(appended[i]?.cites ?? []) < recency(appended[victim]?.cites ?? [])) victim = i;
    }
    const [gone] = appended.splice(victim, 1);
    bullets = bullets.filter((bullet) => bullet !== gone);
    dropped += 1;
  }
  if (ops.length > 0 && dropped === ops.length) return { error: 'every operation was dropped' };
  if (bullets.length === 0) return { error: 'the block would be empty' };
  const next = { ...block, bullets };
  if (renderBlock(next).length > budget) return { error: 'the block is over its budget' };
  return { block: next, dropped };
}
