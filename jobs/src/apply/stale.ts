import { readText, sha256 } from './files.js';
import type { ProposalStore } from './proposal-store.js';

/**
 * Take out of the queue every pending proposal whose file changed since it was built (status
 * deferred): applying it would defer anyway, and while it waits, no run may rebuild its target.
 */
export async function deferStale(proposals: ProposalStore): Promise<number> {
  let deferred = 0;
  for (const proposal of await proposals.pending()) {
    const edits = [proposal.file_edit, ...(proposal.companions ?? []).map((companion) => companion.file_edit)];
    for (const edit of edits) {
      if (edit === undefined) continue;
      const text = await readText(edit.path);
      if (text !== undefined && sha256(text) === edit.sha256) continue;
      await proposals.decide(proposal.run_id, [proposal.id], 'deferred');
      deferred += 1;
      break;
    }
  }
  return deferred;
}
