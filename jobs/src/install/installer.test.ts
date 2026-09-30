import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessRunner, type RunOptions, type RunResult, type Runner } from '../platform/process-runner.js';
import { MemoryLog } from '../refresh/refresh.testkit.js';
import { InstallError, Installer, type InstallOptions } from './installer.js';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

/** Records the client CLIs; runs the real configurator, so the written configs are the real ones. */
class ClientRunner implements Runner {
  readonly calls: string[] = [];
  readonly exit = new Map<string, number>();
  private readonly real = new ProcessRunner();

  async run(name: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push(`${name} ${args.join(' ')}`);
    if (args.some((arg) => arg.endsWith('configure_agent_integrations.py'))) return this.real.run(name, args, options);
    const code = this.exit.get(`${name} ${args.slice(0, 3).join(' ')}`) ?? 0;
    return { code, output: code ? `${name} failed` : '', stdout: '' };
  }
}

describe('Installer', () => {
  let root = '';
  let runner: ClientRunner;
  let log: MemoryLog;
  let refreshed = 0;
  const tools = new Map<string, string>();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'asm-install-'));
    runner = new ClientRunner();
    log = new MemoryLog();
    refreshed = 0;
    tools.clear();
    tools.set('uv', join(root, 'bin', 'uv'));
    tools.set('codex', join(root, 'bin', 'codex'));
    tools.set('grok', join(root, 'bin', 'grok'));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const options = (overrides: Partial<InstallOptions> = {}): InstallOptions => ({
    repo: REPO, runtime: join(root, 'runtime'), configHome: join(root, 'home'),
    skipRefresh: false, skipClientCli: false, env: process.env, ...overrides,
  });
  const installer = () => new Installer(runner, log, async () => { refreshed += 1; }, (name) => tools.get(name));
  const json = (rel: string) => JSON.parse(readFileSync(join(root, 'home', rel), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;

  it('refreshes, writes every client config with the absolute uv, and registers Codex and Grok', async () => {
    await installer().run(options());
    expect(refreshed).toBe(1);
    expect(json('.claude.json').mcpServers?.asm?.command).toBe(tools.get('uv'));
    expect(existsSync(join(root, 'home', '.claude', 'settings.json'))).toBe(true);
    const clients = runner.calls.filter((call) => !call.includes('configure_agent_integrations.py'));
    const server = `-- ${tools.get('uv')} run --directory ${join(root, 'runtime')} python mcp_server.py`;
    expect(clients).toEqual([`codex mcp add asm ${server}`, `grok mcp add --scope user asm ${server}`]);
  });

  it('fails with the client\'s exit code when a registration fails, and stops there', async () => {
    runner.exit.set('codex mcp add asm', 19);
    const failure = await installer().run(options()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InstallError);
    expect((failure as InstallError).exitCode).toBe(19);
    expect(runner.calls.some((call) => call.startsWith('grok'))).toBe(false);
  });

  it('refuses to start without uv, and says where to get it', async () => {
    tools.delete('uv');
    await expect(installer().run(options())).rejects.toThrow('uv is required. Install it from https://docs.astral.sh/uv/ and run this installer again.');
    expect(refreshed).toBe(0);
  });

  it('can skip the refresh and the client CLIs', async () => {
    await installer().run(options({ skipRefresh: true, skipClientCli: true }));
    expect(refreshed).toBe(0);
    expect(runner.calls.filter((call) => !call.includes('configure_agent_integrations.py'))).toEqual([]);
  });

  it('includes the legacy Kimi CLI config when ~/.kimi exists', async () => {
    mkdirSync(join(root, 'home', '.kimi'), { recursive: true });
    await installer().run(options({ skipRefresh: true, skipClientCli: true }));
    expect(runner.calls.find((call) => call.includes('configure_agent_integrations.py'))).toContain('--include-legacy-kimi');
    expect(json('.kimi/mcp.json').mcpServers?.asm?.command).toBe(tools.get('uv'));
  });
});
