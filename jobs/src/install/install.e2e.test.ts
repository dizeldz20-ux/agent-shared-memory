import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpStdioClient } from '../bench/mcp-stdio-client.js';
import { findExecutable } from '../platform/command-resolver.js';

// Runs against a real install in a throwaway home: CI installs one and points ASM_E2E_HOME at it
// (see .github/workflows/ci.yml). Without it the suite is skipped.
const home = process.env.ASM_E2E_HOME ?? '';
const runtime = join(home, '.asm');
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

interface HookGroup { readonly hooks?: readonly { readonly command?: string }[] }

describe.skipIf(!home)('an installed ASM (ASM_E2E_HOME)', () => {
  it('registered an MCP server that answers brain_search from the installed brain', async () => {
    const servers = json(join(home, '.claude.json')).mcpServers as Record<string, { command: string; args: string[] }>;
    const asm = servers.asm;
    expect(asm).toBeDefined();
    const client = new McpStdioClient(asm?.command ?? '', asm?.args ?? [], process.env);
    await client.start();
    try {
      const hits = (await client.callTool('brain_search', { query: 'refresh' })) as { id: string }[];
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 300_000);

  it('prints the SessionStart banner when a client runs the configured hook command through its shell', () => {
    const hooks = (json(join(home, '.claude', 'settings.json')).hooks ?? {}) as Record<string, HookGroup[]>;
    const command = (hooks.SessionStart ?? []).flatMap((group) => group.hooks ?? []).map((hook) => hook.command ?? '')
      .find((line) => line.includes('asm-session-start.js'));
    expect(command).toBeDefined();
    // A janitor that just ran: the banner is under test, not a background job that would start.
    mkdirSync(join(runtime, 'jobs'), { recursive: true });
    writeFileSync(join(runtime, 'jobs', 'state.json'), JSON.stringify({ janitor: { last_success: new Date().toISOString() } }));
    const input = JSON.stringify({ session_id: 'e2e', source: 'startup' });
    const env = { ...process.env, ASM_JOB: '' };
    // The platform shell (cmd.exe on Windows, /bin/sh elsewhere), and bash where it exists:
    // agents on Windows run their shell commands in Git Bash.
    const viaShell = spawnSync(command ?? '', { shell: true, input, encoding: 'utf8', env });
    expect(viaShell.stdout).toContain('ASM — AGENT SHARED MEMORY ONLINE');
    const bash = findExecutable('bash');
    if (bash !== undefined) {
      const viaBash = spawnSync(bash, ['-c', command ?? ''], { input, encoding: 'utf8', env });
      expect(viaBash.stdout).toContain('ASM — AGENT SHARED MEMORY ONLINE');
    }
  });

  it.skipIf(!process.env.ASM_E2E_UNICODE_SOURCE)('mapped the source under a non-ASCII folder name', () => {
    const brain = json(join(runtime, 'brain.json')) as { nodes: { id: string }[] };
    const prefix = `asm:${process.env.ASM_E2E_UNICODE_SOURCE ?? ''}`;
    expect(brain.nodes.some((node) => node.id.startsWith(prefix))).toBe(true);
  });

  it('deployed jobs that answer status', () => {
    const out = execFileSync(process.execPath, [join(runtime, 'jobs', 'dist', 'runner', 'cli.js'), 'status'], {
      encoding: 'utf8', env: { ...process.env, ASM_HOME: runtime },
    });
    expect(JSON.parse(out)).toHaveProperty('jobs');
  });
});
