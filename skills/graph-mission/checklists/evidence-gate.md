# Evidence Gate Checklist

Validates a node before it may be marked `kept`. Applied at every evaluator node in `run-mission`. A node that fails any item here is `reverted`, not "kept with a caveat".

## Provenance
- [ ] Every claim carries a source from the allowed set: `brain:` `memory:` `vault:` `file:` `cmd:`
- [ ] Sources cited from memory or the vault were confirmed to still exist — a memory is a dated snapshot, not a live fact
- [ ] No claim rests on "the worker said so"

## Side effects were verified, not reported
- [ ] Files the worker claims to have written were read back, and contain what was claimed
- [ ] Commands the worker claims to have run were run again here, and the output is in the evidence field
- [ ] A passing test was seen passing, not inferred from "tests should pass now"

## The verification used the right path
> Replace these with the specific verification paths your projects require — each one exists because a shortcut once produced a false green. See the Traps section of `context/operating-environment.md`.

- [ ] Tests ran through the project's real test path, not the convenient one
- [ ] Behavior and hardening were checked on the live path — not by reading code, not on loopback, not through a fixture with injected env
- [ ] An LLM path was verified with a direct call and no fallback; a weak result was checked for a rate limit or a silent fallback before the model was blamed
- [ ] UI was verified by driving the running app, not by reading the component source
- [ ] The edited tree is the live one, not a stale second copy

## The evaluator was actually independent
- [ ] Evaluator agent type differs from the generator's
- [ ] Evaluator saw different evidence or held a different lens than the generator
- [ ] Evaluator returned criterion-level defects or a clean pass — never the string "looks good"

## Scope held
- [ ] Nothing in a non-goal was touched
- [ ] The node's `success` criterion is the one from the brief, not one relaxed mid-run
- [ ] No unrequested abstraction was introduced
- [ ] Deliberate corner-cuts carry a comment naming the ceiling and the upgrade path

## Production and permissions
- [ ] No production action was taken autonomously — a deploy node waits for a human
- [ ] Credentialed or network operations used the project's sanctioned path and wrote no secret to a file

## Scoring

Any unchecked box in **Provenance**, **Side effects**, or **Production** blocks the node outright — mark it `reverted` and log the reason.

Unchecked boxes in **Right path**, **Independence**, or **Scope** mean the node is unverified rather than wrong: send it back for one more evaluator pass within budget, and if the budget is spent, report it as `pending` in the close-out instead of quietly upgrading it.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
