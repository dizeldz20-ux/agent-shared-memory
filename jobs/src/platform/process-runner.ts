import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CommandUnavailableError, findExecutable, resolveCommand, type ResolvedCommand } from './command-resolver.js';

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Each chunk of stdout and stderr as it arrives. */
  readonly onOutput?: (text: string) => void;
}

export interface RunResult {
  readonly code: number | null;
  /** The last 8,000 characters of stdout and stderr together: enough to explain a failure. */
  readonly output: string;
  /** All of stdout, for a tool whose answer is its output. */
  readonly stdout: string;
}

export interface Runner {
  run(name: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

type Resolve = (name: string, options: { env: NodeJS.ProcessEnv }) => ResolvedCommand;

/** Starts a tool the same way on every platform: resolved without a shell, no console window. */
export class ProcessRunner implements Runner {
  constructor(private readonly resolve: Resolve = resolveCommand) {}

  async run(name: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const env = options.env ?? process.env;
    if (options.cwd !== undefined && !existsSync(options.cwd)) {
      throw new CommandUnavailableError(`the working folder ${options.cwd} does not exist (running ${name})`);
    }
    const command = this.resolve(name, { env });
    return new Promise((resolve, reject) => {
      const child = spawn(command.file, [...command.args, ...args], {
        cwd: options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const stdout: Buffer[] = [];
      const take = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        output = `${output}${text}`.slice(-8_000);
        options.onOutput?.(text);
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); take(chunk); });
      child.stderr.on('data', take);
      child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? missing(name, env, error) : error));
      child.once('close', (code) => resolve({ code, output, stdout: Buffer.concat(stdout).toString('utf8') }));
    });
  }
}

// ENOENT also means "found, but its interpreter is gone" (a uv or pip tool after a Python upgrade).
function missing(name: string, env: NodeJS.ProcessEnv, cause: Error): CommandUnavailableError {
  const found = findExecutable(name, { env });
  return found === undefined
    ? new CommandUnavailableError(`${name} was not found on PATH`, { cause })
    : new CommandUnavailableError(`${name} is installed (${found}) but could not start: is its interpreter missing?`, { cause });
}
