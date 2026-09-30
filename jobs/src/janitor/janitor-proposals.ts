import { createHash } from 'node:crypto';
import type { Proposal } from '../apply/proposal.types.js';
import type { Actor } from '../ledger/ledger.types.js';
import type { Candidate, Judgement, ThreadCandidate } from './janitor.types.js';

const ACTOR: Actor = { kind: 'janitor', name: 'janitor' };

export const proposalId = (runId: string, cls: string, target: string): string =>
  `p_${createHash('sha256').update(`${runId}|${cls}|${target}`).digest('hex').slice(0, 12)}`;

function base(runId: string, cls: string, target: string, summary: string): Pick<Proposal, 'id' | 'run_id' | 'class' | 'summary' | 'created_at' | 'status'> {
  return { id: proposalId(runId, cls, target), run_id: runId, class: cls, summary, created_at: new Date().toISOString(), status: 'pending' };
}

export function duplicateProposal(runId: string, duplicate: ThreadCandidate, keep: ThreadCandidate): Proposal {
  return {
    ...base(runId, 'thread.close.duplicate', duplicate.id, `thread repeated verbatim; ${keep.id} stays open: ${duplicate.text.slice(0, 120)}`),
    op: {
      op: 'close_thread', target: { kind: 'thread', id: duplicate.id }, actor: ACTOR,
      reason: `repeated verbatim in a later record; ${keep.id} stays open`,
      evidence: [`memory:${keep.record.id}`], superseded_by: `memory:${keep.record.id}`,
    },
  };
}

/** The proposal a verdict asks for, or undefined when the verdict changes nothing. */
export function verdictProposal(runId: string, candidate: Candidate, judgement: Judgement, pageSha?: string): Proposal | undefined {
  const evidence = judgement.resolved_by ? [judgement.resolved_by] : [];
  const reason = judgement.reason || judgement.verdict;
  if (candidate.kind === 'thread' && (judgement.verdict === 'resolved' || judgement.verdict === 'not_actionable')) {
    const cls = judgement.verdict === 'resolved' ? 'thread.close.resolved' : 'thread.close.not_actionable';
    return {
      ...base(runId, cls, candidate.id, `${judgement.verdict}: ${candidate.text.slice(0, 120)}`),
      op: { op: 'close_thread', target: { kind: 'thread', id: candidate.id }, reason, evidence, actor: ACTOR },
    };
  }
  if (judgement.verdict !== 'resolved' || judgement.resolved_by === null) return undefined;
  if (candidate.kind === 'record') {
    return {
      ...base(runId, 'record.retire.status', candidate.id, `status overtaken: ${candidate.text.slice(0, 120)}`),
      op: { op: 'retire', target: { kind: 'record', id: candidate.id }, reason, evidence, superseded_by: judgement.resolved_by, actor: ACTOR },
    };
  }
  if (candidate.kind === 'page' && pageSha !== undefined) {
    return {
      ...base(runId, 'page.mark_done', candidate.id, `plan done: ${candidate.page.title || candidate.page.rel}`),
      op: { op: 'mark_done', target: { kind: 'page', id: candidate.id }, reason, evidence, actor: ACTOR },
      file_edit: {
        kind: 'frontmatter', path: candidate.page.path, sha256: pageSha,
        fields: { status: 'done', done_at: new Date().toISOString().slice(0, 10), done_evidence: judgement.resolved_by },
      },
    };
  }
  return undefined;
}
