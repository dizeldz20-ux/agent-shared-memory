import type { ThreadCandidate } from './janitor.types.js';

export interface DuplicateGroup {
  readonly keep: ThreadCandidate;
  readonly duplicates: readonly ThreadCandidate[];
}

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');

/** Threads repeated verbatim across records: the newest copy stays open, the rest are duplicates. */
export function duplicateThreads(threads: readonly ThreadCandidate[]): DuplicateGroup[] {
  const groups = new Map<string, ThreadCandidate[]>();
  for (const thread of threads) {
    const key = normalized(thread.text);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), thread]);
  }
  const out: DuplicateGroup[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Date.parse(b.record.created_at) - Date.parse(a.record.created_at));
    const [keep, ...duplicates] = sorted;
    if (keep !== undefined) out.push({ keep, duplicates });
  }
  return out;
}
