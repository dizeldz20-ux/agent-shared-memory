import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandUnavailableError } from '../platform/command-resolver.js';
import { ClaudeRunner } from './claude-runner.js';
import { ModelFailedError, ModelUnavailableError } from './model.errors.js';

// A Node script, so the same fake runs on macOS, Linux and Windows.
function fakeClaude(dir: string, body: string, name = 'fake-claude.mjs'): string {
  const script = join(dir, name);
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nfor await (const _ of process.stdin) { /* read the prompt */ }\n${body}\n`);
  return script;
}

const reply = (value: object): string => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;

describe('ClaudeRunner', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-model-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the result text and usage, and runs with ASM_JOB=1', async () => {
    const script = fakeClaude(dir, `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'job=' + process.env.ASM_JOB, usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.01 }));`);
    const result = await new ClaudeRunner('sonnet', script).run('hello');
    expect(result.text).toBe('job=1');
    expect(result.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, cost_usd: 0.01 });
  });

  it('runs without the owner\'s user settings, hooks, plugins or skills (and so without their tokens)', async () => {
    const script = fakeClaude(dir, `writeFileSync(${JSON.stringify(join(dir, 'args.txt'))}, process.argv.slice(2).join(' '));\n${reply({ is_error: false, result: 'ok', usage: {} })}`);
    await new ClaudeRunner('sonnet', script).run('x');
    const args = readFileSync(join(dir, 'args.txt'), 'utf8');
    expect(args).toContain('--setting-sources project,local');
    expect(args).toContain('--disable-slash-commands');
  });

  it('maps a rate limit to ModelUnavailableError', async () => {
    const script = fakeClaude(dir, `${reply({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 429 rate limit reached' })}\nprocess.exitCode = 1;`);
    await expect(new ClaudeRunner('sonnet', script).run('x')).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('maps a missing claude binary to ModelUnavailableError, so no item is charged for it', async () => {
    await expect(new ClaudeRunner('sonnet', join(dir, 'no-such-claude')).run('x')).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('maps a command Windows cannot start without a shell to ModelUnavailableError', async () => {
    const refuse = (): never => { throw new CommandUnavailableError('C:\\npm\\claude.cmd runs only through a shell'); };
    await expect(new ClaudeRunner('sonnet', 'claude', 5_000, refuse).run('x')).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('reports a model that exits without reading a long prompt as a failure, not a crash', async () => {
    const script = join(dir, 'early-exit.mjs');
    writeFileSync(script, 'setTimeout(() => process.exit(1), 300);\n');
    await expect(new ClaudeRunner('sonnet', script).run('x'.repeat(2_000_000))).rejects.toBeInstanceOf(ModelFailedError);
  });

  it('maps any other failure to ModelFailedError', async () => {
    const script = fakeClaude(dir, `console.log('not json at all');`);
    await expect(new ClaudeRunner('sonnet', script).run('x')).rejects.toBeInstanceOf(ModelFailedError);
  });
});
