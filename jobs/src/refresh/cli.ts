#!/usr/bin/env node
// The ASM refresh: re-extract the code graphs, rebuild the vault's okf bundle, merge brain.json,
// deploy the runtime copies and hot-reload a running server.
//   node jobs/dist/refresh/cli.js [--changed] [--brain-only]
// Start it through refresh.sh, refresh.ps1 or `npm --prefix jobs run asm:refresh`: they build
// jobs/ first, so the refresh that runs is the one in the checkout.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessRunner } from '../platform/process-runner.js';
import { CodeDeploy } from './code-deploy.js';
import { GraphRefresh } from './graph-refresh.js';
import { parseRefreshArgs, Refresh } from './refresh.js';
import type { RefreshLog } from './refresh.types.js';
import { withToolPath } from './tool-path.js';

const log: RefreshLog = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
  output: (text) => process.stdout.write(text),
};

async function main(): Promise<number> {
  let flags: ReturnType<typeof parseRefreshArgs>;
  try {
    flags = parseRefreshArgs(process.argv.slice(2));
  } catch (error: unknown) {
    log.warn(error instanceof Error ? error.message : String(error));
    return 2;
  }
  // This file is <repo>/jobs/dist/refresh/cli.js: the checkout it deploys is three levels up.
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  if (!existsSync(join(repo, 'merge.py'))) {
    log.warn(`no ASM checkout at ${repo}: run the refresh from the repository`);
    return 1;
  }
  const home = homedir();
  const runner = new ProcessRunner();
  // An empty ASM_HOME counts as unset, as it did in the shell script.
  const runtime = process.env.ASM_HOME || join(home, '.asm');
  await new Refresh(new GraphRefresh(runner, log), new CodeDeploy(runner, log), log)
    .run({ repo, runtime, home, env: withToolPath(process.env, home), ...flags });
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  log.warn(`REFRESH FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
