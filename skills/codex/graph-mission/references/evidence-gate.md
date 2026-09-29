# Evidence gate

Apply this before a node is marked `verified`. A node that fails an item is not "verified with a caveat".

**Sections by node kind:**

- `recon`, `decide`: Provenance
- `build`, `reduce`: Side Effects
- `verify`: every section
- `gate`, after the user's word: Provenance, Right Path and Authority. Its effect is observed, never produced again; Independence is N/A, because the word is the independent check
- `write-back`: Provenance, meaning the record id and the page paths exist

An item that does not apply to the node (no UI, no LLM call, no tests) is N/A, not failed.

## Provenance

- [ ] Every claim carries a source from the vocabulary in [knowledge-loop.md](knowledge-loop.md); `vault:` only for a page whose body was read
- [ ] Recalled state (deployed, pending, a flag, a commit) was re-checked live; a record, a vault line or a graph node is a snapshot, not a live fact
- [ ] External or time-sensitive claims cite current primary or authoritative sources, and inference across sources is labeled as inference
- [ ] No claim rests on "the child said so" or on model confidence

## Side Effects

- [ ] Files a child claims to have written were read back (in its worktree, if isolated) and contain what was claimed
- [ ] Commands a child claims to have run were run again by the primary, with the output in `evidence`; a gated action's effect is observed instead
- [ ] A passing test was seen passing, not inferred from "should pass"; a check the sandbox blocked is reported as not run, never as passed

## Right Path

- [ ] Tests ran through the project's sanctioned path (`AGENTS.md`, recalled traps): targeted, one run at a time under `test-runner`, the full suite only at the end of a stage and alone
- [ ] Behavior and hardening were exercised on the live path, not by reading code, on loopback, or through a fixture with injected env
- [ ] An LLM path was verified by a direct call with no fallback; a weak result was checked for rate limiting or a silent fallback before the model was blamed
- [ ] UI was verified by driving the running app, not by reading its source
- [ ] The edited tree is the task's own, never a shared or production checkout

## Independence

- [ ] The verifier is independent of the builder: a different role that saw different evidence or used a different method, or the primary running live checks the builder did not run. Two children with the same prompt are correlated, not independent
- [ ] The verifier returned criterion-level defects or a clean pass, never "looks good"

## Scope

- [ ] Nothing in a non-goal or outside the node's `paths` was touched, and existing user changes are intact
- [ ] The node's `success` is the one from the brief, not one relaxed mid-run
- [ ] No unrequested abstraction, dependency or speculative feature was added

## Authority

- [ ] Nothing on the SKILL.md authority list ran without the user's explicit word
- [ ] No token or secret was written to a file or handed to a child
- [ ] Every service the node started for a check was stopped

## Scoring

An unchecked item in Provenance, Side Effects or Authority fails the node now: mark it `failed` with the reason. The exception is a `verify` whose own report fails them; that is the verifier's defect, so the round re-runs with a fresh verifier.

An unchecked item in Right Path, Independence or Scope means the node is unverified, not wrong: run another round, which adds one to its `rounds`. When `rounds` reach `max_rounds`, mark it `failed` with the reason "unverified: budget spent", and say whether its changes are still in the tree.
