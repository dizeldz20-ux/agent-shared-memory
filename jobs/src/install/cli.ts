#!/usr/bin/env node
// The ASM installer: runs a full refresh, merges ASM into every local agent's config (Claude
// Code, Codex, Gemini CLI, Cursor, Kimi Code, Grok Build, generic MCP clients) and registers the
// MCP server with the Codex and Grok CLIs when they are installed.
//   node jobs/dist/install/cli.js
// Start it through install-agent-integrations.sh or `npm --prefix jobs run asm:install`, which
// build jobs/ first. ASM_SKIP_REFRESH=1 and ASM_SKIP_CLIENT_CLI=1 skip those steps.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../platform/command-resolver.js';
import { ProcessRunner } from '../platform/process-runner.js';
import { CodeDeploy } from '../refresh/code-deploy.js';
import { GraphRefresh } from '../refresh/graph-refresh.js';
import { Refresh } from '../refresh/refresh.js';
import type { RefreshLog } from '../refresh/refresh.types.js';
import { withToolPath } from '../refresh/tool-path.js';
import { InstallError, Installer } from './installer.js';

const log: RefreshLog = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
  output: (text) => process.stdout.write(text),
};

async function main(): Promise<void> {
  // This file is <repo>/jobs/dist/install/cli.js: the checkout it installs is three levels up.
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  if (!existsSync(join(repo, 'merge.py'))) throw new InstallError(`no ASM checkout at ${repo}: run the installer from the repository`);
  const home = homedir();
  const env = withToolPath(process.env, home);
  // Empty variables count as unset, as they did in the shell installer.
  const runtime = process.env.ASM_HOME || join(home, '.asm');
  const runner = new ProcessRunner();
  const refresh = async (): Promise<void> => {
    await new Refresh(new GraphRefresh(runner, log), new CodeDeploy(runner, log), log)
      .run({ repo, runtime, home, env, changedOnly: false, brainOnly: false });
  };
  await new Installer(runner, log, refresh, (name) => findExecutable(name, { env })).run({
    repo, runtime, env,
    configHome: process.env.ASM_CONFIG_HOME || home,
    skipRefresh: process.env.ASM_SKIP_REFRESH === '1',
    skipClientCli: process.env.ASM_SKIP_CLIENT_CLI === '1',
  });
}

main().catch((error: unknown) => {
  log.warn(`INSTALL FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof InstallError ? error.exitCode : 1;
});
