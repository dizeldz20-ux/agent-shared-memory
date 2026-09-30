import { z } from 'zod';
import type { ModelRunner, ModelUsage } from '../model/model-runner.js';
import { buildJudgePrompt } from './judge.prompt.js';
import type { Candidate, EvidenceItem, Judgement } from './janitor.types.js';

export interface JudgeItem {
  readonly candidate: Candidate;
  readonly evidence: readonly EvidenceItem[];
}

export interface JudgeOutcome {
  readonly judgements: readonly Judgement[];
  /** Items whose call produced no usable answer: each counts one failure. */
  readonly failed: readonly string[];
  readonly usage: ModelUsage | null;
}

const replySchema = z.object({
  items: z.array(z.object({
    item_id: z.string(),
    verdict: z.enum(['resolved', 'still_open', 'not_actionable', 'unknown']),
    resolved_by: z.string().nullable().catch(null),
    reason: z.string().catch(''),
  })),
});

function parseReply(text: string): z.infer<typeof replySchema>['items'] | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = replySchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data.items : undefined;
  } catch {
    return undefined;
  }
}

const unknown = (itemId: string, reason: string): Judgement => ({ item_id: itemId, verdict: 'unknown', resolved_by: null, reason });

/** One batch of candidates, one model call, and a strict check of what came back. */
export class Judge {
  constructor(private readonly runner: ModelRunner) {}

  async judgeBatch(items: readonly JudgeItem[]): Promise<JudgeOutcome> {
    const result = await this.runner.run(buildJudgePrompt(items));
    const reply = parseReply(result.text);
    if (reply === undefined) return { judgements: [], failed: items.map((item) => item.candidate.id), usage: result.usage };
    const byId = new Map(reply.map((entry) => [entry.item_id, entry]));
    const judgements = items.map(({ candidate, evidence }): Judgement => {
      const entry = byId.get(candidate.id);
      if (entry === undefined) return unknown(candidate.id, 'the model gave no verdict');
      // Every cited record must be in the item's own evidence, whatever the verdict; a resolved
      // verdict must cite one.
      const cited = entry.resolved_by !== null && !evidence.some((item) => item.id === entry.resolved_by);
      if (cited || (entry.verdict === 'resolved' && entry.resolved_by === null)) {
        return unknown(candidate.id, 'the cited record was not in this item\'s evidence');
      }
      return { item_id: candidate.id, verdict: entry.verdict, resolved_by: entry.resolved_by, reason: entry.reason };
    });
    return { judgements, failed: [], usage: result.usage };
  }
}
