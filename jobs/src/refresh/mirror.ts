import { existsSync } from 'node:fs';
import { cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Make `to` a copy of `from`: files copied over, and whatever `from` no longer has removed. */
export async function mirror(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: true });
  await removeExtras(from, to);
}

async function removeExtras(from: string, to: string): Promise<void> {
  for (const entry of await readdir(to, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (!existsSync(source)) await rm(join(to, entry.name), { recursive: true, force: true });
    else if (entry.isDirectory()) await removeExtras(source, join(to, entry.name));
  }
}
