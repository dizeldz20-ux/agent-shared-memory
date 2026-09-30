import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { CommandUnavailableError, resolveCommand, type ResolvedCommand } from '../platform/command-resolver.js';
import type { ModelResult, ModelRunner } from './model-runner.js';
import { ModelFailedError, ModelUnavailableError } from './model.errors.js';

const TIMEOUT_MS = 180_000;
const UNAVAILABLE = /rate.?limit|\b429\b|usage limit|overloaded|\b401\b|\b403\b|log ?in|authenticat/i;

const outputSchema = z.object({
  is_error: z.boolean().catch(false),
  result: z.string().catch(''),
  usage: z.object({
    input_tokens: z.number().catch(0),
    output_tokens: z.number().catch(0),
    cache_read_input_tokens: z.number().catch(0),
    cache_creation_input_tokens: z.number().catch(0),
  }).partial().catch({}),
  total_cost_usd: z.number().nullable().catch(null),
}).passthrough();

/**
 * `claude -p` as a text-in, JSON-out function: no tools, no MCP servers, no saved session,
 * and ASM_JOB=1 so that none of ASM's own hooks run inside the judge. It runs from the temp
 * directory, so no project's CLAUDE.md is loaded into the prompt.
 */
export class ClaudeRunner implements ModelRunner {
  constructor(
    private readonly model: string,
    private readonly command = 'claude',
    private readonly timeoutMs = TIMEOUT_MS,
    private readonly resolve: (name: string) => ResolvedCommand = resolveCommand,
  ) {}

  async run(prompt: string): Promise<ModelResult> {
    const { code, stdout, stderr } = await this.exec(prompt);
    let parsed: z.infer<typeof outputSchema>;
    try {
      parsed = outputSchema.parse(JSON.parse(stdout));
    } catch (error: unknown) {
      const text = `${stdout}\n${stderr}`.slice(0, 500);
      if (UNAVAILABLE.test(text)) throw new ModelUnavailableError(text, { cause: error });
      throw new ModelFailedError(`unreadable model output (exit ${code}): ${text}`, { cause: error });
    }
    if (parsed.is_error || code !== 0) {
      const text = parsed.result || stderr;
      if (UNAVAILABLE.test(text)) throw new ModelUnavailableError(text.slice(0, 500));
      throw new ModelFailedError(`model call failed (exit ${code}): ${text.slice(0, 500)}`);
    }
    const usage = parsed.usage;
    return {
      text: parsed.result,
      usage: {
        input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cost_usd: parsed.total_cost_usd,
      },
    };
  }

  private exec(prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    // No user settings (their hooks and plugins act inside the call) and no skills: measured on a
    // trivial prompt, ~12.4k context tokens with them, ~2.5k without.
    const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project,local',
      '--disable-slash-commands', '--model', this.model];
    let command: ResolvedCommand;
    try {
      command = this.resolve(this.command);
    } catch (error: unknown) {
      // Not installed, or a Windows .cmd that would need a shell: the run stops, no item pays for it.
      if (error instanceof CommandUnavailableError) return Promise.reject(new ModelUnavailableError(error.message, { cause: error }));
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command.file, [...command.args, ...args], {
        cwd: tmpdir(), env: { ...process.env, ASM_JOB: '1' }, windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ModelFailedError('model call timed out')); }, this.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      // A missing command is not the items' fault: it stops the run like a rate limit does.
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT'
          ? new ModelUnavailableError(`the model command is missing: ${this.command}`, { cause: error })
          : new ModelFailedError(error.message, { cause: error }));
      });
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.on('error', () => undefined); // EPIPE when the model exits early; its exit code reports that
      child.stdin.end(prompt);
    });
  }
}
