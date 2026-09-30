import { describe, expect, it } from 'vitest';
import { scoreCase, summarize } from './metrics.js';
import type { BenchCase } from './bench.types.js';

const benchCase: BenchCase = {
  id: 'c01', query: 'is T7 deployed', current_ids: ['memory:new'], stale_ids: ['memory:old', 'vault:plan'],
};

describe('scoreCase', () => {
  it('flags a stale item shown next to the current one', () => {
    const score = scoreCase(benchCase, 'hook', ['vault:x', 'memory:old', 'memory:new']);
    expect(score).toMatchObject({ current_hit: true, stale_hit: true, stale_next_to_current: true, stale_only: false });
  });

  it('flags a stale item shown without the current one', () => {
    expect(scoreCase(benchCase, 'search', ['vault:plan'])).toMatchObject({ current_hit: false, stale_only: true });
  });

  it('only looks at the first five results', () => {
    const top = ['a', 'b', 'c', 'd', 'e', 'memory:old'];
    expect(scoreCase(benchCase, 'search', top).stale_hit).toBe(false);
  });
});

describe('summarize', () => {
  it('counts each flag per channel', () => {
    const summary = summarize([
      scoreCase(benchCase, 'hook', ['memory:new']),
      scoreCase(benchCase, 'hook', ['memory:old']),
      scoreCase(benchCase, 'search', ['memory:old', 'memory:new']),
    ]);
    expect(summary.hook).toEqual({ cases: 2, current_hit: 1, stale_hit: 1, stale_next_to_current: 0, stale_only: 1 });
    expect(summary.search).toEqual({ cases: 1, current_hit: 1, stale_hit: 1, stale_next_to_current: 1, stale_only: 0 });
  });
});
