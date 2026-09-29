# Evidence Gate Checklist

Validates a returned node before it may be marked `kept`. A node that fails an item is not "kept with a caveat".

**Which sections apply, by kind:**
- `recon`, `decide` — Provenance
- `build`, `reduce` — Side Effects
- `verify` — every section
- `gate`, after the user's word — Provenance, Right Path and Authority. Its effect is observed, never produced again; Independence is N/A, because the user's word is the independent check
- `write-back` — Provenance: the record id and the page paths exist

An item that does not apply to the node (no UI, no LLM call, no tests) is marked N/A, not failed.

## Provenance
- [ ] Every claim carries a source from the vocabulary in `templates/mission-brief.md`; `vault:` only for a page whose body was read
- [ ] Recalled state (deployed, pending, a flag, a commit) was re-checked against live state — a record, a hub line or a graph node is a snapshot, not a live fact
- [ ] No claim rests on "the worker said so"

## Side Effects
- [ ] Files the worker claims to have written were read back — in the worktree it returned, if it was isolated — and contain what was claimed
- [ ] Commands the worker claims to have run were run again here, and the output is in the evidence field — except a gated action, whose effect is observed instead
- [ ] A passing test was seen passing, not inferred from "tests should pass now"

## Right Path

> Replace these with the verification paths your projects require — each one exists because a shortcut once produced a false green. They mirror the Traps section of `context/operating-environment.md`; keep the two in sync.

- [ ] Tests ran through the project's real test path — targeted, capped, and one run at a time; the full suite only at the end of a stage, alone
- [ ] Behavior and hardening were checked on the live path — not by reading code, not on loopback, not through a fixture with injected env
- [ ] An LLM path was verified with a direct call and no fallback; a weak result was checked for a rate limit or a silent fallback before the model was blamed
- [ ] UI was verified by driving the running app, not by reading its source
- [ ] The edited tree is the task's own local tree — never a production checkout or a stale second copy

## Independence
- [ ] The verifier is independent of the builder: a different agent type that saw different evidence or held a different lens — or the primary agent running live checks the builder did not run
- [ ] The verifier returned criterion-level defects or a clean pass — never the string "looks good"

## Scope
- [ ] Nothing in a non-goal or outside the node's `paths` was touched
- [ ] The node's `success` criterion is the one from the brief, not one relaxed mid-run
- [ ] No unrequested abstraction was introduced; deliberate corner-cuts carry a comment naming the ceiling and the upgrade path

## Authority
- [ ] Nothing on the Authority list in `context/operating-environment.md` ran without the user's word as that section defines it
- [ ] Network git and credentialed calls, if any, took the sanctioned path and wrote no secret to a file
- [ ] Every service the node started for a check was stopped

## Scoring

An unchecked item in **Provenance**, **Side Effects** or **Authority** fails the node now — mark it `failed` with the reason. The exception is a `verify` whose own report fails them: that is the verifier's defect, so the round is re-run with a fresh verifier.

An unchecked item in **Right Path**, **Independence** or **Scope** means the node is unverified, not wrong: run another round, which adds one to its `rounds`. When `rounds` reach `max_rounds`, mark it `failed` with the reason "unverified — budget spent", and say whether its changes are still in the tree.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
