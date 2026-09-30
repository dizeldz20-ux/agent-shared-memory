import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DestinationExistsError } from './apply.errors.js';

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Write through a temporary file and a rename, so no reader ever sees half a file. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.asm-tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

const code = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

// link() cannot work across volumes (EXDEV), or on volumes with no hard links, such as FAT,
// exFAT and some network or cloud-synced folders on Windows (EPERM, ENOTSUP, ENOSYS).
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS']);

/** Move a file without ever replacing another: a destination that exists refuses the move. */
export async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await link(from, to);
  } catch (error: unknown) {
    if (code(error) === 'EEXIST') throw new DestinationExistsError(to, { cause: error });
    if (!NO_LINK.has(code(error) ?? '')) throw error;
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } catch (copyError: unknown) {
      if (code(copyError) === 'EEXIST') throw new DestinationExistsError(to, { cause: copyError });
      throw copyError;
    }
  }
  await unlink(from);
}
