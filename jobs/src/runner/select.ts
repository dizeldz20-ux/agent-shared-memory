import type { Proposal } from '../apply/proposal.types.js';

/** Proposals named on the command line: ids, `class:<name>`, or `all`. */
export function selectProposals(pending: readonly Proposal[], selectors: readonly string[]): Proposal[] {
  if (selectors.includes('all')) return [...pending];
  const classes = new Set(selectors.filter((s) => s.startsWith('class:')).map((s) => s.slice('class:'.length)));
  const ids = new Set(selectors.filter((s) => !s.startsWith('class:')));
  return pending.filter((proposal) => ids.has(proposal.id) || classes.has(proposal.class));
}
