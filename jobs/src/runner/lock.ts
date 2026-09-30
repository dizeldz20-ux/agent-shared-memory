import { open, readFile, unlink } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const STALE_MS = 2 * 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** One runner at a time: a lock file with the holder's pid, broken when stale or orphaned. */
export class RunLock {
  constructor(readonly path: string, private readonly staleMs = STALE_MS) {}

  async acquire(): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    if (await this.create()) return true;
    if (!(await this.stale())) return false;
    await unlink(this.path).catch(() => undefined);
    return this.create();
  }

  async release(): Promise<void> {
    const holder = await this.holder();
    if (holder?.pid === process.pid) await unlink(this.path).catch(() => undefined);
  }

  private async create(): Promise<boolean> {
    try {
      const handle = await open(this.path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  }

  private async holder(): Promise<{ pid: number; started_at: string } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { pid?: unknown; started_at?: unknown };
      return typeof parsed.pid === 'number' ? { pid: parsed.pid, started_at: String(parsed.started_at ?? '') } : undefined;
    } catch {
      return undefined;
    }
  }

  private async stale(): Promise<boolean> {
    const holder = await this.holder();
    if (holder === undefined) return true;
    const age = Date.now() - Date.parse(holder.started_at);
    return !alive(holder.pid) || !Number.isFinite(age) || age > this.staleMs;
  }
}
