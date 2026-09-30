import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpStdioClient } from './mcp-stdio-client.js';

export interface RecallProbeOptions {
  /** A runtime (~/.asm, hooks under hooks/) or the source repo (hooks under hook/). */
  readonly codeDir: string;
  readonly snapshotDir: string;
  readonly workDir: string;
  /** Where `uv run --directory` finds the Python environment with the mcp package. */
  readonly uvDir: string;
}

const CODE = ['mcp_server.py', 'asm_text.py', 'lifecycle.py'];
const HOOKS = ['asm-prompt-recall.js', 'asm-lifecycle.js'];
const DATA = ['brain.json', 'brain.index.json', 'brain.pages.json', 'memory.jsonl', 'lifecycle.jsonl'];

/** Runs the recall an agent actually gets — the prompt hook and brain_search — on a frozen snapshot. */
export class RecallProbe {
  private server: McpStdioClient | undefined;
  private frozenAt: string | undefined;

  constructor(private readonly options: RecallProbeOptions) {}

  get runDir(): string {
    return join(this.options.workDir, 'run');
  }

  /** The snapshot's own time, which both recall paths use as now (ASM_NOW). */
  get clock(): string | undefined {
    return this.frozenAt;
  }

  async start(): Promise<void> {
    await this.assemble();
    this.frozenAt = await manifestTime(this.options.snapshotDir);
    this.server = new McpStdioClient('uv', ['run', '--directory', this.options.uvDir, 'python',
      join(this.runDir, 'mcp_server.py')], this.env());
    await this.server.start();
  }

  async stop(): Promise<void> {
    await this.server?.close();
  }

  async hookTop(caseId: string, query: string): Promise<string[]> {
    const payload = JSON.stringify({ prompt: query, session_id: `bench-${caseId}` });
    const output = await runNode(join(this.runDir, 'hooks', 'asm-prompt-recall.js'), payload,
      { ...this.env(), ASM_HOME: this.runDir });
    return output.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(/\s/)[0] ?? '');
  }

  async searchTop(query: string): Promise<string[]> {
    if (this.server === undefined) throw new Error('the probe is not started');
    const items = await this.server.callTool('brain_search', { query });
    return (Array.isArray(items) ? items : []).map((item) => String((item as { id?: unknown }).id ?? ''));
  }

  private env(): NodeJS.ProcessEnv {
    return this.frozenAt === undefined ? cleanEnv() : { ...cleanEnv(), ASM_NOW: this.frozenAt };
  }

  private async assemble(): Promise<void> {
    await rm(this.runDir, { recursive: true, force: true });
    await mkdir(join(this.runDir, 'hooks'), { recursive: true });
    const hookDir = existsSync(join(this.options.codeDir, 'hooks')) ? 'hooks' : 'hook';
    const copies: [string, string][] = [
      ...CODE.map((name): [string, string] => [join(this.options.codeDir, name), join(this.runDir, name)]),
      ...HOOKS.map((name): [string, string] => [join(this.options.codeDir, hookDir, name), join(this.runDir, 'hooks', name)]),
      ...DATA.map((name): [string, string] => [join(this.options.snapshotDir, name), join(this.runDir, name)]),
    ];
    for (const [from, to] of copies) {
      if (existsSync(from)) await copyFile(from, to);
    }
    await writeFile(join(this.runDir, 'asm-paths.json'),
      JSON.stringify({ vault: join(this.options.workDir, 'vault'), repo: '' }));
  }
}

async function manifestTime(snapshotDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as { created_at?: unknown };
    return typeof manifest.created_at === 'string' ? manifest.created_at : undefined;
  } catch {
    return undefined;
  }
}

/** The probe must see recall exactly as an agent does, never as ASM's own jobs do. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ASM_JOB;
  delete env.ASM_HOME;
  return env;
}

function runNode(script: string, input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve(output));
    child.stdin.end(input);
  });
}
