import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Some volumes have no hard links (FAT, exFAT, some network and cloud-synced folders on
// Windows); they answer link() with EPERM or ENOTSUP rather than EXDEV.
const linkError = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (from: string, to: string) => {
      if (linkError.code) throw Object.assign(new Error(`link: ${linkError.code}`), { code: linkError.code });
      return real.link(from, to);
    },
  };
});

const { move } = await import('./files.js');
const { DestinationExistsError } = await import('./apply.errors.js');

describe('move', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-move-')); linkError.code = undefined; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.each(['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS'])('copies when the volume answers link() with %s', async (code) => {
    linkError.code = code;
    writeFileSync(join(dir, 'page.md'), 'body');
    await move(join(dir, 'page.md'), join(dir, 'archive', 'page.md'));
    expect(readFileSync(join(dir, 'archive', 'page.md'), 'utf8')).toBe('body');
    expect(existsSync(join(dir, 'page.md'))).toBe(false);
  });

  it('still refuses to replace a destination when it has to copy', async () => {
    linkError.code = 'EPERM';
    writeFileSync(join(dir, 'page.md'), 'new');
    writeFileSync(join(dir, 'kept.md'), 'old');
    await expect(move(join(dir, 'page.md'), join(dir, 'kept.md'))).rejects.toBeInstanceOf(DestinationExistsError);
    expect(readFileSync(join(dir, 'kept.md'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'page.md'), 'utf8')).toBe('new');
  });

  it('passes on any other link() failure', async () => {
    linkError.code = 'EACCES';
    writeFileSync(join(dir, 'page.md'), 'body');
    await expect(move(join(dir, 'page.md'), join(dir, 'moved.md'))).rejects.toThrow(/EACCES/);
    expect(existsSync(join(dir, 'page.md'))).toBe(true);
  });
});
