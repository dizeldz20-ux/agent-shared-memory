import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withToolPath } from './tool-path.js';

describe('withToolPath', () => {
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'asm-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('puts uv and graphify first on macOS: ~/.local/bin, then the per-version Python bins', () => {
    mkdirSync(join(home, 'Library', 'Python', '3.9', 'bin'), { recursive: true });
    mkdirSync(join(home, 'Library', 'Python', '3.12', 'bin'), { recursive: true });
    mkdirSync(join(home, 'Library', 'Python', 'README'), { recursive: true });
    const env = withToolPath({ PATH: '/usr/bin' }, home, 'darwin');
    expect(env.PATH).toBe([posix.join(home, '.local', 'bin'), posix.join(home, 'Library', 'Python', '3.9', 'bin'), posix.join(home, 'Library', 'Python', '3.12', 'bin'), '/usr/bin'].join(':'));
  });

  it('keeps the key a Windows environment uses and joins with a semicolon', () => {
    const env = withToolPath({ Path: 'C:\\Windows' }, 'C:\\Users\\x', 'win32');
    expect(env.Path).toBe('C:\\Users\\x\\.local\\bin;C:\\Windows');
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
  });

  it('makes every Python child write UTF-8, so a non-ASCII path survives the pipe on Windows', () => {
    const env = withToolPath({ PATH: 'C:\\Windows' }, 'C:\\Users\\x', 'win32');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });
});
