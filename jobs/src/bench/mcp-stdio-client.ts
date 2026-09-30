import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpClientError } from './mcp-client.errors.js';

interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

type Waiter = (message: JsonRpcMessage) => void;

const REQUEST_TIMEOUT_MS = 60_000;

/** A minimal MCP client over newline-delimited JSON-RPC on a child's stdio. */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly waiters = new Map<number, Waiter>();

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.command, [...this.args], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.resume();
    await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'asm-bench', version: '1' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args });
    return toolPayload(result);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGINT');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await exited;
    clearTimeout(timer);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new McpClientError(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new McpClientError(message.error.message ?? `${method} failed`));
        else resolve(message.result);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: unknown): void {
    if (this.child === undefined) throw new McpClientError('the server is not started');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // not a JSON-RPC line
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.waiters.get(message.id);
    this.waiters.delete(message.id);
    waiter?.(message);
  }
}

/** FastMCP returns a tool's value as structuredContent.result, or as JSON text items. */
function toolPayload(result: unknown): unknown {
  const value = result as { structuredContent?: { result?: unknown }; content?: { text?: string }[] };
  if (value.structuredContent && 'result' in value.structuredContent) return value.structuredContent.result;
  const texts = (value.content ?? []).map((item) => item.text ?? '').filter((text) => text.length > 0);
  const parsed = texts.map((text) => JSON.parse(text) as unknown);
  return parsed.length === 1 ? parsed[0] : parsed;
}
