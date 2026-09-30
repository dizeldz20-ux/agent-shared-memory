#!/usr/bin/env node
// asm-jobs: the janitor (cleanup layer), the curator (learning layer) and their review.
//   run --job janitor|curator|refresh|all [--dry-run] [--max-calls N]
//   review | show <id> | apply <ids|class:<name>|all> | reject <ids|class:<name>|all> | restore <op-id> [reason]
//   gate --labels <file> | status
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply, gate, reject, restore, review, show, status } from './commands.js';
import { compose } from './compose.js';
import { runJobs } from './run-jobs.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = (): string[] => args.slice(1).filter((arg, index, all) => !arg.startsWith('--') && !all[index - 1]?.startsWith('--'));

async function main(): Promise<void> {
  const home = process.env.ASM_HOME ?? join(homedir(), '.asm');
  const command = args[0];
  let out: unknown;
  if (command === 'run') out = await runJobs(home, args);
  else if (command === 'review') out = await review(await compose(home));
  else if (command === 'show') out = await show(await compose(home), positional()[0] ?? '');
  else if (command === 'apply') out = await apply(await compose(home), positional());
  else if (command === 'reject') out = await reject(await compose(home), positional());
  else if (command === 'restore') out = await restore(await compose(home), positional()[0] ?? '', positional().slice(1).join(' ') || 'restored by the owner');
  else if (command === 'gate') out = await gate(await compose(home), flag('labels') ?? '');
  else if (command === 'status') out = await status(await compose(home));
  else throw new Error('usage: cli.js run|review|show|apply|reject|restore|gate|status');
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
