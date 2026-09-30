import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runner } from '../platform/process-runner.js';
import type { RefreshLog } from '../refresh/refresh.types.js';

export interface InstallOptions {
  /** The ASM checkout: tools/configure_agent_integrations.py lives there. */
  readonly repo: string;
  readonly runtime: string;
  /** Where the client configs live: the user's home unless ASM_CONFIG_HOME says otherwise. */
  readonly configHome: string;
  readonly skipRefresh: boolean;
  readonly skipClientCli: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** An install step failed; `exitCode` is the failing tool's, as the shell installer exited. */
export class InstallError extends Error {
  constructor(message: string, readonly exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstallError';
  }
}

/** Configures every local coding agent to use the one ASM runtime, the same way on every platform. */
export class Installer {
  constructor(
    private readonly runner: Runner,
    private readonly log: RefreshLog,
    private readonly refresh: () => Promise<void>,
    private readonly which: (name: string) => string | undefined,
  ) {}

  async run(options: InstallOptions): Promise<void> {
    const uv = this.which('uv');
    if (uv === undefined) throw new InstallError('uv is required. Install it from https://docs.astral.sh/uv/ and run this installer again.');
    await mkdir(options.runtime, { recursive: true });
    if (!options.skipRefresh) await this.refresh();
    const configure = [join(options.repo, 'tools', 'configure_agent_integrations.py'), '--home', options.configHome, '--runtime', options.runtime, '--uv', uv];
    if (existsSync(join(options.configHome, '.kimi'))) configure.push('--include-legacy-kimi');
    await this.must('uv', ['run', '--no-project', 'python', ...configure], options);
    if (!options.skipClientCli) await this.registerClients(options, uv);
    this.log.info('ASM is configured for Claude Code, Codex, Gemini CLI, Cursor, Kimi Code, Grok Build (when installed), and generic stdio MCP clients.');
    this.log.info('Restart open agent sessions. In clients with hook trust controls, review and trust the local ASM hooks once.');
  }

  // Both `mcp add` commands are upserts: a failed command never removes a working registration.
  // Claude's user MCP registry is merged atomically by the configurator instead of its CLI.
  private async registerClients(options: InstallOptions, uv: string): Promise<void> {
    const server = ['--', uv, 'run', '--directory', options.runtime, 'python', 'mcp_server.py'];
    if (this.which('codex') !== undefined) await this.must('codex', ['mcp', 'add', 'asm', ...server], options);
    if (this.which('grok') !== undefined) await this.must('grok', ['mcp', 'add', '--scope', 'user', 'asm', ...server], options);
  }

  private async must(name: string, args: readonly string[], options: InstallOptions): Promise<void> {
    const result = await this.runner.run(name, args, { cwd: options.repo, env: options.env, onOutput: (text) => this.log.output(text) });
    if (result.code !== 0) throw new InstallError(`${name} ${args.slice(0, 3).join(' ')} failed (exit ${result.code}): ${result.output.slice(-600)}`, result.code ?? 1);
  }
}
