import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { bodyHead, frontmatterScalars } from './frontmatter-lite.js';
import type { VaultPage } from './store.types.js';

const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

/** Reads the Obsidian vault's pages under wiki/main. */
export class VaultStore {
  constructor(readonly root: string) {}

  async pages(): Promise<VaultPage[]> {
    const files = await this.markdownFiles(join(this.root, 'wiki', 'main'));
    const pages: VaultPage[] = [];
    for (const path of files) pages.push(await this.page(path));
    return pages;
  }

  async page(path: string): Promise<VaultPage> {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const front = frontmatterScalars(text);
    // '/' on every OS: hub_glob and the file: id fallback are written with it.
    const rel = relative(this.root, path).split(sep).join('/');
    return {
      id: front.id || `file:${rel}`,
      path,
      rel,
      title: front.title ?? '',
      status: front.status ?? '',
      updatedAt: front.updatedAt ?? '',
      type: front.type ?? '',
      description: front.description ?? '',
      size: info.size,
      head: bodyHead(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  }

  private async markdownFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.markdownFiles(path)));
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
    return out.sort();
  }
}
