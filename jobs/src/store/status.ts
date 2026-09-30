// Pages write their status in many words, often followed by a note ("done — shipped 22/09").
// The same mapping as merge.normalize_status: finished, retired, or the word itself.
const STATUS_WORDS: Readonly<Record<string, string>> = {
  done: 'done', complete: 'done', completed: 'done', closed: 'done', shipped: 'done', deployed: 'done',
  retired: 'retired', archived: 'retired', superseded: 'retired', obsolete: 'retired',
};

export function normalizeStatus(value: string): string {
  const word = /^[\p{L}\p{N}_-]+/u.exec(value.trim().toLowerCase())?.[0] ?? '';
  return STATUS_WORDS[word] ?? word;
}
