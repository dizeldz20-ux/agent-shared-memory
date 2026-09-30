import type { BenchCase, CaseScore, Channel, ChannelSummary } from './bench.types.js';

/** What an agent sees first: the hook injects five nodes, and a search is read top down. */
export const TOP_N = 5;

export function scoreCase(benchCase: BenchCase, channel: Channel, results: readonly string[]): CaseScore {
  const top = results.slice(0, TOP_N);
  const current = benchCase.current_ids.some((id) => top.includes(id));
  const stale = benchCase.stale_ids.some((id) => top.includes(id));
  return {
    case_id: benchCase.id,
    channel,
    top,
    current_hit: current,
    stale_hit: stale,
    stale_next_to_current: current && stale,
    stale_only: stale && !current,
  };
}

function emptySummary(): ChannelSummary {
  return { cases: 0, current_hit: 0, stale_hit: 0, stale_next_to_current: 0, stale_only: 0 };
}

export function summarize(scores: readonly CaseScore[]): Record<Channel, ChannelSummary> {
  const out: Record<Channel, ChannelSummary> = { hook: emptySummary(), search: emptySummary() };
  for (const score of scores) {
    const current = out[score.channel];
    out[score.channel] = {
      cases: current.cases + 1,
      current_hit: current.current_hit + Number(score.current_hit),
      stale_hit: current.stale_hit + Number(score.stale_hit),
      stale_next_to_current: current.stale_next_to_current + Number(score.stale_next_to_current),
      stale_only: current.stale_only + Number(score.stale_only),
    };
  }
  return out;
}
