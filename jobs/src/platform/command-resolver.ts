import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { envValue } from './env.js';

export interface ResolvedCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface ResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly exists?: (file: string) => boolean;
  readonly read?: (file: string) => string;
}

/** A command that cannot be started without a shell, or is not installed. */
export class CommandUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommandUnavailableError';
  }
}

const SCRIPT = /\.[cm]?js$/i;
// cmd-shim writes "%dp0%\...\cli.js"; the npm.cmd that ships with Node writes %~dp0\...\npm-cli.js.
const SHIM_SCRIPT = /%~?dp0%?\\([^"%\r\n*?<>|]+?\.[cm]?js)\b/gi;

/**
 * How to start `name` without a shell. macOS and Linux leave the search to the OS. Windows
 * cannot spawn a .cmd without cmd.exe, and cmd.exe re-parses every argument, so an npm shim is
 * read and its script is run with the current node instead — the same way on every machine.
 */
export function resolveCommand(name: string, options: ResolveOptions = {}): ResolvedCommand {
  const execPath = options.execPath ?? process.execPath;
  if (SCRIPT.test(name)) return { file: execPath, args: [name] };
  if ((options.platform ?? process.platform) !== 'win32') return { file: name, args: [] };
  const exists = options.exists ?? existsSync;
  const found = locateOnWindows(name, options);
  if (found === undefined) throw new CommandUnavailableError(`${name} was not found on PATH`);
  const ext = path.win32.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: found, args: [] };
  const script = shimScript(found, options.read ?? ((file) => readFileSync(file, 'utf8')), exists);
  if (script === undefined) throw new CommandUnavailableError(`${found} runs only through a shell, which ASM does not use`);
  return { file: execPath, args: [script] };
}

/**
 * The absolute path of an installed tool, for a config that must name it (an MCP entry runs
 * without the user's PATH); undefined when it is not installed.
 */
export function findExecutable(name: string, options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) === 'win32') return locateOnWindows(name, options);
  const dirs = (envValue(env, 'PATH') ?? '').split(':').filter(Boolean);
  return dirs.map((dir) => path.posix.join(dir, name)).find((file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function locateOnWindows(name: string, options: ResolveOptions): string | undefined {
  return windowsCandidates(name, options.env ?? process.env).find(options.exists ?? existsSync);
}

function windowsCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase());
  const named = path.win32.extname(name) ? [name] : exts.map((ext) => `${name}${ext}`);
  if (/[\\/]/.test(name)) return named;
  const dirs = (envValue(env, 'PATH') ?? '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return dirs.flatMap((dir) => named.map((file) => path.win32.join(dir, file)));
}

function shimScript(shim: string, read: (file: string) => string, exists: (file: string) => boolean): string | undefined {
  const dir = path.win32.dirname(shim);
  if (path.win32.basename(shim).toLowerCase() === 'npm.cmd') {
    const cli = path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return cli;
  }
  // The last script the shim names is the one it runs: npm.cmd names npm-prefix.js first.
  const matches = [...read(shim).matchAll(SHIM_SCRIPT)].map((match) => match[1]).filter((m): m is string => m !== undefined);
  const last = matches.at(-1);
  if (last === undefined) return undefined;
  const script = path.win32.join(dir, last);
  return exists(script) ? script : undefined;
}
