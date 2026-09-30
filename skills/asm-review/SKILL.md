---
name: asm-review
description: Review the ASM janitor's and curator's pending proposals with the owner — show them grouped by class, then apply, reject or restore exactly what the owner chooses. Use when the owner types /asm-review, asks what the janitor or curator proposed, or when the ASM SessionStart banner says proposals wait for review.
---

# ASM review

The janitor (cleanup layer) and the curator (learning layer) write every change through the
lifecycle ledger. Classes the owner has not yet trusted wait here as proposals. Nothing is
applied without the owner's explicit choice in this conversation.

## Steps

1. List: `node ~/.asm/jobs/dist/runner/cli.js review` prints JSON — one entry per class with
   its mode (`propose` or `auto`) and its items (id, summary, target, evidence, reason).
2. Show the owner, in the owner's language, one group per class, at most five items per group
   (the rest as a count). For each item: what it closes or changes, why, and the evidence id.
   Open an evidence record with `mcp__asm__brain_node("memory:<id>")` when the owner asks.
   The curator's classes change text (`block.refresh`, `index.rewrite`, `memfile.compact`,
   `correction.apply`): for each such item run `node ~/.asm/jobs/dist/runner/cli.js show <id>`
   and show the lines it removes and adds in every file it touches — an `index.rewrite` also
   moves the old line into the memory file's History. `changed_since: true` means the file
   changed after the proposal was built; applying it will be deferred.
   A `quarantined` group lists items that failed three times; every run skips them. Name them to
   the owner; there is nothing to apply.
3. Ask one question: which items to apply.
4. Act on the answer, and only on it:
   - apply: `node ~/.asm/jobs/dist/runner/cli.js apply <id …|class:<name>|all>`
   - reject: `node ~/.asm/jobs/dist/runner/cli.js reject <id …|class:<name>|all>`
   - undo an applied operation: `node ~/.asm/jobs/dist/runner/cli.js restore <op-id> "<reason>"`
5. Report one line per class: applied, rejected, deferred.

## Rules

- A `deferred` result means a live session changed the file after the proposal was built. Say
  so; it leaves the queue and the next run rebuilds it on the file as it is now.
- `apply` returns `promoted`: the classes this approval moved to automatic. Tell the owner.
- A first build of a project's current-state block always waits for the owner, whatever the
  trust state. Rejecting a `correction.apply` closes the agent's correction request.
- Never edit proposal, ledger or trust files by hand.
- A class moves to automatic only through clean approvals on three separate days (a backlog
  approved in one sitting counts once); restoring an automatic operation moves its class back to
  proposals.
- Status and the judge gate: `node ~/.asm/jobs/dist/runner/cli.js status`.
