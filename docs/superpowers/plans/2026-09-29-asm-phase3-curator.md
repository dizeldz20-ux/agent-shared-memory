# ASM Phase 3 — Curator (Learning Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the important files true over time. The curator does four things:

1. It maintains a sourced "Current state" block in each active project page.
2. It rewrites memory-index lines that accreted dated updates.
3. It compacts memory files that became logs.
4. It applies the corrections agents file.

Every change is a proposal under the trust ladder, written through the ledger.

**Architecture:** TypeScript in `jobs/src/curator/`, run by the same runner (job `curator`, between `janitor` and `refresh`):

| Part | What it is |
|---|---|
| Pure core | the block model, the dated-segment detector, the compaction builder |
| Model calls | block delta operations, a first-build block, and one line of current state for an index line |
| Scope | a private `curated.json` naming project pages, plus repository prefixes from the existing external project map (its path in the private config) |

**Tech Stack:** TypeScript 5.8 `strict` NodeNext, Vitest, zod, the Phase 2 ledger, applier, trust store and model runner.

**Spec:** `docs/superpowers/specs/2026-09-29-asm-learning-and-cleanup-layers-design.md` (sections 6.3, 10, 14 Phase 3)

## Global Constraints

- Everything from the Phase 2 plan's Global Constraints.
- **Text outside the curated block stays byte-identical** after every edit, and a test proves it.
- **Every bullet in a curated block cites** at least one record id that was in the model's input. An operation citing anything else is dropped. If every operation is dropped, the refresh fails and the page stays untouched. A result that would empty the block fails.
- **A first build is always a proposal,** whatever the trust state.
- **Compaction never loses a line:** every original non-empty body line must appear in the output, or the proposal is rejected mechanically.

## Review Focus

- **Hand-edited blocks:** a page whose block markers were hand-edited or duplicated is skipped with a warning, never rewritten.
- **Hebrew citations:** a bullet in Hebrew with a trailing `^s-slug` and a `memory:` citation parses and renders round-trip.
- **Index-line markup:** a line with Markdown links, bold and backticks keeps its link target exactly when rewritten.
- **Missing correction text:** a correction whose `claimed` text is not in the target verbatim is reported, never applied fuzzily.
- **Worktree paths:** a record whose files live in a dated worktree of a project counts for that project.

---

### Task 1: Scope — `curated.json`, project map, record matcher

- Create: `jobs/src/curator/scope.ts`:
  - `loadScope(layout)` reads `jobs/curated.json` (`projects: [{project, page, repo_prefixes?}]`) and the external map named by `config.project_map`;
  - `projectOf(record, projects)` takes the longest repo prefix across the record's files; absolute paths are cut at `Projects/`.
- Test: `scope.test.ts`, covering longest prefix, worktree paths and records without files.

### Task 2: The state block model

- Create: `jobs/src/curator/state-block.ts`, with these functions:
  - `readBlock(text)` → `{ block?: { seen, at, bullets: [{id, text, cites}] }, problem? }` (duplicated markers become `problem`);
  - `renderBlock(block)`;
  - `applyOps(block, ops, allowedCites, budget)` → `{ block } | { error }`;
  - `writeBlock(pageText, block)` (inserted after the first H1 when absent, replaced in place otherwise).
- Test: `state-block.test.ts`, covering:
  - round-trip in Hebrew;
  - unknown block ids;
  - foreign citations;
  - every operation dropped;
  - an emptied block;
  - the budget;
  - bytes outside the markers kept identical.

### Task 3: Model prompts and their parsing

- Create: `jobs/src/curator/prompts.ts`:
  - `blockPrompt(project, block, records, retracted)` for delta mode, or full mode when there is no block;
  - `indexLinePrompt(line, memoryFileHead, block)`.
- Create: `jobs/src/curator/replies.ts` (zod parsing of `{ops:[…]}` and `{line: "…"}`).
- Test: `replies.test.ts`, covering valid output, prose and a truncated reply.

### Task 4: Dated segments, compaction, corrections

- Create in `jobs/src/curator/`:
  - `dated.ts`: `datedSegments(line)` for index lines and `datedSections(body)` for memory files. A dated segment is a `DD/MM`, `DD/MM/YYYY` or `YYYY-MM-DD` stamp at a segment start or line start, optionally in bold or after `עדכון`.
  - `compaction.ts`: `compact(text, currentState)` keeps the frontmatter, puts `## Current state` first and `## History` holding the original body verbatim, then runs `everyLineKept(original, output)`.
  - `corrections.ts`: `applyCorrection(text, claimed, truth, evidence, date)` gives the new text plus a history line, or `undefined` when `claimed` is not present verbatim.
- Test: one file per module.

### Task 5: The curator job and runner wiring

- Create: `jobs/src/curator/curator.ts`, the class `Curator`. For each curated page in scope, while under `max_pages`:
  1. Read its block.
  2. Decide staleness: a newer in-scope record, or a retracted citation.
  3. Call the model with the delta or the full input.
  4. Apply and validate the operations.
  5. Build a `block.refresh` proposal (a replace file edit).

  It also:
  - proposes `index.rewrite` for accreted index lines of the memory index and hubs (at most 10 per run);
  - proposes `memfile.compact` for memory files with at least 2 dated sections (at most 5 per run);
  - proposes `correction.apply` for pending requested corrections.

  Mode comes from the trust store. A first build is always a proposal.
- Modify: `jobs/src/runner/cli.ts` so that `all` runs janitor, then curator, then refresh.
- Test: `curator.test.ts` against a synthetic runtime with a fake model runner.

### Task 6: Live run, review, commit

- Write the private `curated.json` with the active project pages.
- Run the curator once in propose mode and inspect the proposals.
- Verify end to end on a copy of the runtime that approving a `block.refresh` makes the page curated after `merge`, and that the hook then boosts it.
- Adversarial review, one fix pass, then commit.
