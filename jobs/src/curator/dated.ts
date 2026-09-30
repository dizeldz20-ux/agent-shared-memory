// A dated update is a date stamp (DD/MM, DD/MM/YYYY or YYYY-MM-DD) opening a segment of an index
// line or a line of a memory file: the shape of text that accretes instead of being rewritten.
const STAMP = /(?:^|[\s(*·|—])(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})(?=[\s:,.)*]|$)/gu;
const SECTION = /^(?:#{1,6}\s*|\*\*|-\s+)?(?:עדכון\s*)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/u;

/** A stamp that is a calendar date: ratios and scores such as 0/3, 13/14 or 44/60 are not. */
function isDate(stamp: string): boolean {
  const iso = /^\d{4}-(\d{2})-(\d{2})$/.exec(stamp);
  const [day, month] = iso ? [Number(iso[2]), Number(iso[1])] : stamp.split('/').map(Number);
  return day !== undefined && month !== undefined && day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

export function datedSegments(line: string): number {
  return [...line.matchAll(STAMP)].filter((match) => isDate(match[1] ?? '')).length;
}

export function datedSections(body: string): number {
  return body.split('\n').filter((line) => isDate(SECTION.exec(line.trim())?.[1] ?? '')).length;
}
