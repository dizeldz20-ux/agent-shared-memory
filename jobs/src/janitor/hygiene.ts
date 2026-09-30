import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../apply/files.js';
import type { Proposal } from '../apply/proposal.types.js';
import type { VaultPage } from '../store/store.types.js';
import { proposalId } from './janitor-proposals.js';

const INDEX_BACKUP = /^MEMORY\.md\.bak|\.bak(?:-\d+)?$/;
const ACTOR = { kind: 'janitor', name: 'janitor' } as const;

function archiveProposal(runId: string, targetKind: 'page' | 'memory_file', targetId: string, path: string,
  text: string, archiveTo: string, why: string): Proposal {
  return {
    id: proposalId(runId, 'hygiene.archive', targetId), run_id: runId, class: 'hygiene.archive', status: 'pending',
    summary: `${why}: ${path}`, created_at: new Date().toISOString(),
    op: { op: 'retire', target: { kind: targetKind, id: targetId }, reason: why, actor: ACTOR },
    file_edit: { kind: 'archive_move', path, sha256: sha256(text), archive_to: archiveTo },
  };
}

/** Zero-byte pages: nothing to lose, and each one is a dead node in the graph. */
export function zeroBytePages(runId: string, pages: readonly VaultPage[], archive: string): Proposal[] {
  return pages.filter((page) => page.size === 0)
    .map((page) => archiveProposal(runId, 'page', `vault:${page.id}`, page.path, '', join(archive, runId, 'vault', page.rel), 'an empty page'));
}

/** Backup copies of the memory index inside the memory directory, where every grep finds them. */
export async function indexBackups(runId: string, memoryDir: string, archive: string): Promise<Proposal[]> {
  if (!memoryDir) return [];
  const names = (await readdir(memoryDir).catch(() => [])).filter((name) => INDEX_BACKUP.test(name));
  const out: Proposal[] = [];
  for (const name of names) {
    const path = join(memoryDir, name);
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text !== undefined) out.push(archiveProposal(runId, 'memory_file', `mem:${name}`, path, text, join(archive, runId, 'memory', name), 'a backup copy of the memory index'));
  }
  return out;
}

/** Session runtime files older than the TTL (recall ledgers, gate markers, skill state). */
export async function staleSessionFiles(sessionsDir: string, ttlDays: number, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - ttlDays * 86_400_000;
  const out: string[] = [];
  for (const name of await readdir(sessionsDir).catch(() => [])) {
    const path = join(sessionsDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff) out.push(path);
  }
  return out.sort();
}

/** Memory files that no index or hub links to: reported for review, never moved. */
export async function orphanMemoryFiles(memoryDir: string, indexTexts: readonly string[]): Promise<string[]> {
  if (!memoryDir) return [];
  const all = indexTexts.join('\n');
  const names = (await readdir(memoryDir).catch(() => []))
    .filter((name) => name.endsWith('.md') && name !== 'MEMORY.md' && !INDEX_BACKUP.test(name));
  return names.filter((name) => !all.includes(name) && !all.includes(`[[${name.slice(0, -3)}]]`)).sort();
}
