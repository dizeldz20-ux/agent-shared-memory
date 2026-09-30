import { createHash } from 'node:crypto';

// The one serialization an operation id is hashed from, byte-identical to lifecycle.py's
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False): keys sorted at
// every level, no spaces, non-ASCII kept.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function opId(op: Readonly<Record<string, unknown>>): string {
  const { id: _id, ...body } = op;
  return `lc_${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex').slice(0, 16)}`;
}
