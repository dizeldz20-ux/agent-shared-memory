import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export type ClassMode = 'propose' | 'auto';
export type ReviewOutcome = 'approved_clean' | 'edited' | 'rejected' | 'restored';

export interface ClassGate {
  readonly judged: number;
  readonly precision: number | null;
  readonly passed: boolean;
}

export interface GateResult {
  readonly precision: number | null;
  readonly sample_size: number;
  readonly judged: number;
  readonly passed: boolean;
  readonly at: string;
  readonly model: string;
  /** Per closing verdict (resolved, not_actionable): each must pass on its own to run automatically. */
  readonly classes?: Readonly<Record<string, ClassGate>>;
}

const classSchema = z.object({
  approved_runs: z.number().catch(0), promoted: z.boolean().catch(false), demoted: z.boolean().catch(false),
  last_clean_day: z.string().catch(''),
});
const fileSchema = z.object({
  classes: z.record(classSchema).catch({}),
  judge_gate: z.object({
    precision: z.number().nullable(), sample_size: z.number(), judged: z.number(), passed: z.boolean(), at: z.string(), model: z.string(),
    classes: z.record(z.object({ judged: z.number(), precision: z.number().nullable(), passed: z.boolean() })).optional(),
  }).nullable().catch(null),
}).catch({ classes: {}, judge_gate: null });
type TrustFile = z.infer<typeof fileSchema>;

const THREAD_CLASSES = new Set(['thread.close.resolved', 'thread.close.not_actionable', 'thread.close.superseded']);
// A verbatim duplicate thread is closed mechanically (the newer copy stays open) and uses no judge,
// so it runs automatically from the start, like hygiene (the owner's decision, 29/09).
const AUTO_FROM_START = new Set(['hygiene.archive', 'thread.close.duplicate']);

/**
 * The trust ladder. Judged thread closures run automatically once the judge passed its precision
 * gate; hygiene and verbatim-duplicate closures run automatically from the start; every content
 * class runs automatically after clean approvals on `required` separate days. A rejection or an
 * edit resets the count, and restoring any automatic operation demotes its class to proposals.
 */
export class TrustStore {
  constructor(readonly path: string, private readonly required = 3) {}

  async modeFor(cls: string): Promise<ClassMode> {
    const file = await this.load();
    const entry = file.classes[cls];
    if (entry?.demoted) return 'propose';
    if (THREAD_CLASSES.has(cls)) {
      const own = file.judge_gate?.classes?.[cls.slice('thread.close.'.length)];
      return file.judge_gate?.passed && (own === undefined || own.passed) ? 'auto' : 'propose';
    }
    if (AUTO_FROM_START.has(cls)) return 'auto';
    return entry?.promoted ? 'auto' : 'propose';
  }

  /**
   * A clean approval counts once per day: the owner who approves three runs' backlog in one sitting
   * has reviewed once, and trust is earned across separate reviews.
   */
  async recordReview(cls: string, outcome: ReviewOutcome, day = new Date().toISOString().slice(0, 10)): Promise<void> {
    const file = await this.load();
    const entry = file.classes[cls] ?? { approved_runs: 0, promoted: false, demoted: false, last_clean_day: '' };
    let next = entry;
    if (outcome === 'approved_clean' && entry.last_clean_day !== day) {
      const runs = entry.approved_runs + 1;
      next = { ...entry, approved_runs: runs, promoted: entry.promoted || runs >= this.required, last_clean_day: day };
    } else if (outcome === 'approved_clean') {
      next = entry;
    } else if (outcome === 'restored') {
      next = { approved_runs: 0, promoted: false, demoted: true, last_clean_day: '' };
    } else {
      next = { ...entry, approved_runs: 0 };
    }
    await this.save({ ...file, classes: { ...file.classes, [cls]: next } });
  }

  async setGate(result: GateResult): Promise<void> {
    await this.save({ ...(await this.load()), judge_gate: result });
  }

  async gate(): Promise<GateResult | null> {
    return (await this.load()).judge_gate;
  }

  private async load(): Promise<TrustFile> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return { classes: {}, judge_gate: null };
    }
  }

  private async save(file: TrustFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}
