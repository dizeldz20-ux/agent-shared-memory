import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 86_400_000;
const SKIPPED = new Set(['node_modules', '.git', '.venv']);

/**
 * True when an extract can be kept: it exists, is at most 3 whole days old (deletions alone
 * never make a newer file), and no file in the source tree is newer. A tree that cannot be read
 * counts as changed: launchd without Full Disk Access reads nothing on ~/Desktop, and
 * "unreadable" must never pass for "unchanged".
 */
export async function extractIsFresh(extract: string, base: string, now: number): Promise<boolean> {
  let built: number;
  try {
    built = (await stat(extract)).mtimeMs;
  } catch {
    return false;
  }
  if (Math.floor((now - built) / DAY) > 3) return false;
  try {
    return !(await hasNewerFile(base, built));
  } catch {
    return false;
  }
}

async function hasNewerFile(root: string, since: number): Promise<boolean> {
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) pending.push(file);
      } else if (entry.isFile() && (await stat(file)).mtimeMs > since) {
        return true;
      }
    }
  }
  return false;
}
