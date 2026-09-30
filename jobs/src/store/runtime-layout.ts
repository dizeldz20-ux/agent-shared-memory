import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// Private, per-machine settings of the jobs (never in the public repo): ~/.asm/jobs/config.json.
const configSchema = z.object({
  memory_dir: z.string().default(''),
  /** An external project map (JSON with projects.<name>.repo_prefixes) the curator reads its scope from. */
  project_map: z.string().default(''),
  /** The path fragment of the memory hub pages (private layout; empty means no hubs). */
  hub_glob: z.string().default(''),
  judge_model: z.string().default('sonnet'),
  janitor: z.object({
    max_calls: z.number().int().positive().default(30),
    batch_size: z.number().int().positive().default(8),
    since_days: z.number().int().positive().default(45),
  }).default({}),
  curator: z.object({ max_pages: z.number().int().positive().default(10) }).default({}),
  session_ttl_days: z.number().int().positive().default(30),
});

export type JobsConfig = z.infer<typeof configSchema>;

/** Whether a vault page is a memory hub: never when the private config names no hub path. */
export function isHub(rel: string, config: Pick<JobsConfig, 'hub_glob'>): boolean {
  return config.hub_glob !== '' && rel.includes(config.hub_glob);
}

export interface RuntimeLayout {
  readonly home: string;
  readonly memory: string;
  readonly ledger: string;
  readonly vault: string;
  readonly jobs: string;
  readonly archive: string;
  readonly sessions: string;
  readonly config: JobsConfig;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return {};
  }
}

/** The runtime's file layout: ~/.asm (or ASM_HOME), with the vault from asm-paths.json. */
export async function loadLayout(home: string): Promise<RuntimeLayout> {
  const paths = z.object({ vault: z.string().catch('') }).catch({ vault: '' }).parse(await readJson(join(home, 'asm-paths.json')));
  const config = configSchema.parse(await readJson(join(home, 'jobs', 'config.json')));
  return {
    home,
    memory: join(home, 'memory.jsonl'),
    ledger: join(home, 'lifecycle.jsonl'),
    vault: paths.vault,
    jobs: join(home, 'jobs'),
    archive: join(home, 'archive'),
    sessions: join(home, 'sessions'),
    config,
  };
}
