import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { envKey, envValue } from '../platform/env.js';

const directories = (parent: string, leaf: string, join: (...parts: string[]) => string): string[] => {
  try {
    return readdirSync(parent).sort().reverse().map((name) => join(parent, name, leaf)).filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false);
  } catch {
    return [];
  }
};

/**
 * uv and graphify install outside the default PATH: ~/.local/bin everywhere, plus the per-version
 * user-site bin on macOS and the per-version Scripts folder on Windows. Prepend them rather than
 * depend on the shell profile: schedulers give a job almost no PATH at all. The environment is
 * the one every tool of the refresh and the installer starts with.
 */
export function withToolPath(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const tools = [p.join(home, '.local', 'bin')];
  if (platform === 'darwin') tools.push(...directories(p.join(home, 'Library', 'Python'), 'bin', p.join));
  const appData = envValue(env, 'APPDATA');
  if (platform === 'win32' && appData) tools.push(...directories(p.join(appData, 'Python'), 'Scripts', p.join));
  const key = envKey(env, 'PATH');
  // Python on Windows writes pipes in the ANSI code page: a non-ASCII path (a Hebrew folder, an
  // accented user name) would reach the refresh mangled. UTF-8 mode makes every Python child agree.
  return {
    ...env, [key]: [...tools, env[key] ?? ''].filter(Boolean).join(platform === 'win32' ? ';' : ':'),
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
  };
}
