import type { LedgerStore } from '../ledger/ledger-store.js';
import type { FileSnapshot, LedgerOp, OpMode } from '../ledger/ledger.types.js';
import { existsSync } from 'node:fs';
import { DeferredError, DestinationExistsError, UnknownOperationError } from './apply.errors.js';
import { move, readText, sha256, writeAtomic } from './files.js';
import { setFrontmatterFields } from './frontmatter.js';
import type { FileEdit, Proposal } from './proposal.types.js';

interface Planned {
  readonly before?: FileSnapshot;
  readonly after?: FileSnapshot;
  readonly write: () => Promise<void>;
}

/**
 * Carries out a proposal: the ledger operation is written first — with the file's old text or
 * its archive location — and the file second, so every change can be read back and restored.
 * A file whose hash no longer matches the proposal was edited by a live session: deferred.
 */
export class Applier {
  constructor(private readonly ledger: LedgerStore) {}

  async apply(proposal: Proposal, mode: OpMode): Promise<LedgerOp> {
    const planned = proposal.file_edit ? await this.plan(proposal.file_edit) : undefined;
    const companions: { op: Proposal['op']; planned: Planned | undefined }[] = [];
    for (const companion of proposal.companions ?? []) {
      companions.push({ op: companion.op, planned: companion.file_edit ? await this.plan(companion.file_edit) : undefined });
    }
    const op = await this.record(proposal.op, proposal.class, mode, planned);
    for (const companion of companions) await this.record(companion.op, proposal.class, mode, companion.planned);
    await planned?.write();
    for (const companion of companions) await companion.planned?.write();
    return op;
  }

  private record(op: Proposal['op'], cls: string, mode: OpMode, planned: Planned | undefined): Promise<LedgerOp> {
    return this.ledger.append({
      ...op, mode, class: cls,
      ...(planned?.before ? { before: planned.before } : {}),
      ...(planned?.after ? { after: planned.after } : {}),
    });
  }

  async restore(opId: string, reason: string): Promise<LedgerOp> {
    const op = (await this.ledger.load()).find((item) => item.id === opId);
    if (op === undefined || op.op === 'restore') throw new UnknownOperationError(opId);
    if (op.before && op.after) {
      const current = await readText(op.after.path);
      if (current === undefined || sha256(current) !== op.after.sha256) throw new DeferredError(op.after.path);
      if (op.before.text !== undefined) await writeAtomic(op.before.path, op.before.text);
      else await move(op.after.path, op.before.path);
    }
    return this.ledger.append({
      op: 'restore', target: op.target, undoes: op.id, reason, mode: 'approved', actor: { kind: 'owner', name: 'owner' },
    });
  }

  private async plan(edit: FileEdit): Promise<Planned> {
    const text = await readText(edit.path);
    if (text === undefined || sha256(text) !== edit.sha256) throw new DeferredError(edit.path);
    if (edit.kind === 'archive_move' && edit.archive_to) {
      const to = edit.archive_to;
      if (existsSync(to)) throw new DestinationExistsError(to); // before the ledger: no operation for a move that cannot happen
      return { before: { path: edit.path, sha256: edit.sha256 }, after: { path: to, sha256: edit.sha256 }, write: () => move(edit.path, to) };
    }
    const next = edit.kind === 'frontmatter' ? setFrontmatterFields(text, edit.fields ?? {}) : edit.after_text ?? text;
    return {
      before: { path: edit.path, sha256: edit.sha256, text },
      after: { path: edit.path, sha256: sha256(next) },
      write: () => writeAtomic(edit.path, next),
    };
  }
}
