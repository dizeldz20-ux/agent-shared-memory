import { describe, expect, it } from 'vitest';
import { setFrontmatterFields } from './frontmatter.js';

describe('setFrontmatterFields', () => {
  const page = '---\nid: plan-a\ntitle: "Plan A"\nstatus: planning\ntags: [a, b]\n---\n\n# Plan A\n\nBody line: keep me.\n';

  it('replaces an existing field and appends a missing one, leaving every other byte alone', () => {
    const next = setFrontmatterFields(page, { status: 'done', done_at: '2026-09-29' });
    expect(next).toBe('---\nid: plan-a\ntitle: "Plan A"\nstatus: done\ntags: [a, b]\ndone_at: 2026-09-29\n---\n\n# Plan A\n\nBody line: keep me.\n');
  });

  it('quotes a value that YAML would misread', () => {
    expect(setFrontmatterFields(page, { done_evidence: 'memory:abc # note' })).toContain('done_evidence: "memory:abc # note"');
  });

  it('adds a frontmatter block to a page without one', () => {
    expect(setFrontmatterFields('# Title\n', { status: 'retired' })).toBe('---\nstatus: retired\n---\n# Title\n');
  });
});
