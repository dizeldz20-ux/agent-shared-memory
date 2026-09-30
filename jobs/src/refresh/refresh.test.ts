import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeDeploy } from './code-deploy.js';
import { GraphRefresh } from './graph-refresh.js';
import { parseRefreshArgs, Refresh, reloadServer } from './refresh.js';
import { FakeRunner, MemoryLog, sandbox, type Sandbox } from './refresh.testkit.js';

describe('Refresh', () => {
  let box: Sandbox;
  let runner: FakeRunner;
  let log: MemoryLog;
  beforeEach(() => { box = sandbox(); runner = new FakeRunner(); log = new MemoryLog(); });
  afterEach(() => { rmSync(box.root, { recursive: true, force: true }); });

  const refresh = (brainOnly: boolean) => new Refresh(new GraphRefresh(runner, log), new CodeDeploy(runner, log), log, async () => 'server not running - skipped reload')
    .run(box.options({ brainOnly }));

  it('brain-only deploys the graph and the paths file, and no code: the daily job must never ship work in progress', async () => {
    await refresh(true);
    expect(existsSync(join(box.runtime, 'brain.json'))).toBe(true);
    expect(existsSync(join(box.runtime, 'mcp_server.py'))).toBe(false);
    expect(existsSync(join(box.runtime, 'hooks'))).toBe(false);
    expect(existsSync(join(box.home, '.claude')) || existsSync(join(box.home, '.agents'))).toBe(false);
    expect(JSON.parse(readFileSync(join(box.runtime, 'asm-paths.json'), 'utf8'))).toEqual({ vault: box.vault, repo: box.repo });
    expect(log.lines.slice(-2)).toEqual(['server not running - skipped reload', 'done.']);
  });

  it('a full refresh deploys the code too, then the paths file the deployed hooks read', async () => {
    await refresh(false);
    expect(existsSync(join(box.runtime, 'mcp_server.py'))).toBe(true);
    expect(existsSync(join(box.home, '.claude', 'skills', 'asm-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(box.runtime, 'asm-paths.json'))).toBe(true);
  });

  it('writes an empty vault for a code-only setup', async () => {
    writeFileSync(join(box.repo, 'sources.json'), JSON.stringify({ vault: null, sources: [] }));
    await refresh(true);
    expect(JSON.parse(readFileSync(join(box.runtime, 'asm-paths.json'), 'utf8')).vault).toBe('');
  });
});

describe('parseRefreshArgs', () => {
  it('reads --changed and --brain-only and refuses anything else', () => {
    expect(parseRefreshArgs(['--changed', '--brain-only'])).toEqual({ changedOnly: true, brainOnly: true });
    expect(parseRefreshArgs([])).toEqual({ changedOnly: false, brainOnly: false });
    expect(() => parseRefreshArgs(['--fast'])).toThrow('unknown option: --fast (supported: --changed, --brain-only)');
  });
});

describe('reloadServer', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  async function serve(status: number): Promise<string> {
    server = createServer((_request, response) => { response.statusCode = status; response.end(); });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reload`;
  }

  it('tells a reloaded server from one that rejected the graph and from one that is not running', async () => {
    expect(await reloadServer(await serve(200))).toBe('server reloaded (HTTP 200)');
    server?.close();
    expect(await reloadServer(await serve(500))).toBe('RELOAD FAILED - server is up but rejected the new graph (HTTP 500); it is still serving the OLD graph');
    const url = await serve(200);
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await reloadServer(url)).toBe('server not running - skipped reload');
  });
});
