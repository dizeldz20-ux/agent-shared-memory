import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RuntimeLayout } from '../store/runtime-layout.js';
import type { MemoryRecord } from '../store/store.types.js';

export interface CuratedProject {
  readonly project: string;
  /** `vault:<page id>` of the page that carries the project's current-state block. */
  readonly page: string;
  readonly repo_prefixes: readonly string[];
  /** `idx:<index file>:<memory file>` lines that restate this project: rewritten when its block changes. */
  readonly index_lines: readonly string[];
}

const curatedSchema = z.object({ projects: z.array(z.object({
  project: z.string(), page: z.string(), repo_prefixes: z.array(z.string()).optional(), index_lines: z.array(z.string()).optional(),
})) });
const mapSchema = z.object({ projects: z.record(z.object({ repo_prefixes: z.array(z.string()).catch([]) }).passthrough()) }).passthrough();

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The curated pages (private curated.json), with repository prefixes taken from the external
 *  project map when curated.json does not name its own — one map, never two that drift. */
export async function loadScope(layout: RuntimeLayout): Promise<CuratedProject[]> {
  const curated = curatedSchema.safeParse(await readJson(join(layout.jobs, 'curated.json')));
  if (!curated.success) return [];
  const map = layout.config.project_map ? mapSchema.safeParse(await readJson(layout.config.project_map)) : undefined;
  const external = map?.success ? map.data.projects : {};
  return curated.data.projects.map((entry) => ({
    project: entry.project, page: entry.page,
    repo_prefixes: entry.repo_prefixes ?? external[entry.project]?.repo_prefixes ?? [],
    index_lines: entry.index_lines ?? [],
  }));
}

const relative = (path: string): string => {
  const normal = path.replace(/\\/g, '/');
  const at = normal.indexOf('Projects/');
  return at >= 0 ? normal.slice(at) : normal;
};

/**
 * The project a record belongs to: the longest repository prefix any of its files falls under. A
 * record that names only repo-relative files falls back to its session: the project most of the
 * absolute files the activity hook saw that session touch fall under.
 */
export function projectOf(record: MemoryRecord, projects: readonly CuratedProject[],
  sessionFiles: ReadonlyMap<string, readonly string[]> = new Map()): string | undefined {
  const own = longestPrefix(record.files, projects);
  // Only a record whose files are all repo-relative falls back: an absolute path outside every
  // curated project, or no file at all, says the work was not in one of them.
  if (own !== undefined || record.files.length === 0 || !record.files.every(repoRelative)) return own;
  return majority(sessionFiles.get(record.session_id) ?? [], projects);
}

const repoRelative = (file: string): boolean => !/^([/~\\]|[A-Za-z]:)/.test(file) && !file.replace(/\\/g, '/').includes('Projects/');

/** The project more than half of a session's files fall under, if any. */
function majority(files: readonly string[], projects: readonly CuratedProject[]): string | undefined {
  const counts = new Map<string, number>();
  for (const file of files) {
    const project = longestPrefix([file], projects);
    if (project !== undefined) counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  for (const [project, count] of counts) if (count * 2 > files.length) return project;
  return undefined;
}

const markerSchema = z.object({ session_id: z.string().optional(), files: z.array(z.string()).catch([]) });

/** Session id → the absolute files the activity hook saw it touch (~/.asm/sessions/<id>.json). */
export async function loadSessionFiles(dir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    const marker = markerSchema.safeParse(await readJson(join(dir, name)));
    if (marker.success) out.set(marker.data.session_id ?? name.slice(0, -'.json'.length), marker.data.files);
  }
  return out;
}

function longestPrefix(files: readonly string[], projects: readonly CuratedProject[]): string | undefined {
  let best: { project: string; length: number } | undefined;
  for (const file of files.map(relative)) {
    for (const project of projects) {
      for (const prefix of project.repo_prefixes) {
        if (file.startsWith(prefix) && (best === undefined || prefix.length > best.length)) best = { project: project.project, length: prefix.length };
      }
    }
  }
  return best?.project;
}
