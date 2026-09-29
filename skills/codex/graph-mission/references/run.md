# Run or resume a mission

## Load or resume

After compiling in this session, use its run file. To resume, take the file the user names, or the one under `.codex/graph-runs/` whose `closed_at` is missing or `null`, whose `worktree` is this tree, and whose `objective` is this task. Never take the newest file blindly: older run files may have been committed and now sit in every worktree cut since. With zero or several candidates, list them and end the turn asking which.

Reconcile the file with the tree, in this order:

1. Map older fields and statuses ([mission-schema.md](mission-schema.md), Legacy mapping). A version 1 step gets its `kind` and `locks` first, so a deploy step becomes a `gate`.
2. A `running` node whose `dispatched_session` is this session: wait for its child. Otherwise look for its work: its `paths` in `git status`, its `branch` in `git worktree list`. No work: `pending`. Work found: check Side Effects ([evidence-gate.md](evidence-gate.md)) against its `action`; a pass is `verified`, a fail is `failed` with the reason "partial changes in tree".
3. A `verified` node with no evidence becomes `pending`, unless a node that depends on it is `verified` with evidence; then it stays, with evidence `"inferred: dependent <id> verified"`.

Report the objective, terminal nodes and frontier in one line, and sync the plan.

## Dispatch the frontier

The frontier is every `pending` node whose dependencies are all `verified` or `skipped`, minus any node whose path or lock a `running` node holds. When frontier nodes share a path or a lock, one holder at a time: the node on the critical path, otherwise the lowest id.

Route each node: a `gate` to Gates below; a node whose `role` is `main` runs inline, after the children are dispatched; any other node goes to a child, up to `max_subagents` at once. Just before each spawn, write `status: running`, `dispatched_at` and `dispatched_session` to the run file; as soon as the spawn returns, write its `agent_id`. A mission that compacts mid-wave must never dispatch a node twice. Spawn without forking the conversation into the child. A child's result arrives when it finishes: wait only when the next critical-path step needs it, never poll, and close each child once its result is gated so its slot frees.

A child prompt holds exactly these, and nothing else:

1. Role, and the lens it holds
2. Goal: the node's `action`, singular
3. Recall pack: the sourced facts this node needs
4. Recall duty, for nodes that edit: `brain_context(file_path)` on each file before editing it, and read the `vault_pages` it returns
5. Paths: its write scope and the files it needs, not the repo. A `build` leaves its changes uncommitted unless it works on its own branch
6. Non-goals and authority: the SKILL.md authority list pasted in full, none of it allowed to the child, and no spawning of its own agents
7. Locks: each lock it holds and its rule (`test-runner`: targeted tests, one run at a time; stop any service it starts)
8. Success: the node's criterion, verbatim
9. Output: findings with sources, files changed, commands run with their output, open risks

A node that could write the same files as another gets its own worktree, which the primary creates before dispatch (`git worktree add`, at a path the child can write), recording its `branch`. Make sure the graph merges that branch in a `reduce` run as `main`, and runs the full-suite `verify` after the merge; add whatever is missing to the run file first.

A node waiting on something outside the mission, such as another session's work or a service that is down, is `blocked` with its `reason`; re-check it every wave and set it back to `pending` when the dependency is there. When the mission creates the tree it edits, move the run file into that tree's `.codex/graph-runs/`, exclude it there, and set `worktree`.

## Gates

When a `gate` reaches the frontier, set it `blocked` and do not perform its action. Say in commentary, in one line, what it needs: the action, what it touches, and the evidence that the nodes before it are `verified`. Keep running every lane that does not depend on it. Codex does not block for an answer: if the word has not arrived when nothing else can move, run the write-back and close out with the gate as the first thing the user does.

Only the user's explicit word opens a gate, or an earlier instruction that said in so many words to proceed without asking. On the word, the primary runs the action, then observes its effect on the live path (a health check, `git ls-remote`, a delivery receipt), never by running the action again. Mark the gate `verified` with that evidence, even in a run file already closed; a record already written gets a superseding one ([knowledge-loop.md](knowledge-loop.md)). The word covers that action only: not the next gate, and not a retry with different parameters.

## Gate every result

Apply the sections of [evidence-gate.md](evidence-gate.md) that match the node's kind, and verify side effects yourself: read the file, run the command.

- **`build`**: once its side effects are confirmed, it is `verified` as "built as claimed". Whether it is right is its `verify`'s call.
- **`verify`**: first check the verifier's own report against Provenance and Side Effects. A report that fails (a claimed run that does not reproduce, a finding with no source) is the verifier's defect, not the builder's: dispatch a fresh verifier and add one to the verify's `rounds`. Then act on the findings:
  1. No defects: `verified`.
  2. Defects in one build's work: send them back to whoever built it (the same child while it is open, otherwise a fresh attempt carrying the defects), set the `build` back to `running` with one more round, and set the `verify` back to `pending` so the frontier dispatches it again once the build is `verified`.
  3. Defects in integrated work: add each as a new `build` on the integration branch, and set the `verify` back to `pending` so it runs again once they are `verified`.
- **`recon`**: append its sourced findings to `claims`.

A node is `failed` at once when Provenance, Side Effects or Authority fails in its own work, or when its `rounds` reach `max_rounds`. A `verify` that ends `failed` on defects fails the builds those defects belong to. A failed node's `reason` says what failed and whether its changes are still in the tree. Before a full-suite `verify` runs, save each failed build's own changes in a shared tree as a patch next to the run file, remove only those changes, and mark the build `reverted` with the patch path in its `reason`. A node no longer needed is `skipped` with its `reason`, and so is every node that cannot run without it.

## Ratchet

For a node with a `loop`, record each trial in `loop.trials`: parent state, the change, the score on `loop.metric`, the guardrails, and keep or discard. Each trial adds one to `rounds`. Discard a trial that did not improve the metric or regressed a guardrail (cost, latency, existing tests), removing only that trial's own changes. Stop when `rounds` reach `max_rounds`, not when the metric feels good enough. The node is `verified` when its best trial improved the metric with every guardrail intact, and `reverted` only when every trial was discarded.

## Lineage

After every result, update the run file (statuses, evidence, `reason`, `rounds`, decisions, open threads) and the plan. The file is what survives compaction, so it must be true at all times, not written once at the end.

## Write-back and close-out

Run the `write-back` node ([knowledge-loop.md](knowledge-loop.md)) when every other node is terminal, `blocked`, or waiting on a `blocked` node. A gate still waiting does not hold the record back.

Then stop every service the mission started, write `closed_at`, and give the final answer in this order:

1. What the user does now: the gates and decisions waiting, or that nothing is
2. What works, and how to check it: the command and its result
3. What is blocked or failed, with the reason and who unblocks it
4. Cost: the `rounds` spent and the children dispatched

A graph with `blocked`, `failed` or never-started `pending` nodes is reported as exactly that.
