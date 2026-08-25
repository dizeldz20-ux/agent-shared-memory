# Run or resume a mission

## Load the frontier

Use the just-compiled graph, or resume the named run file. If none is named, choose the newest lexically sorted file under `.codex/graph-runs/`. Treat `verified` without evidence as `pending`.

Report the objective, terminal nodes, and pending frontier in one concise update. Synchronize the plan before more work.

## Dispatch ready nodes

A node is ready only when all dependencies are terminal and verified. Dispatch independent ready nodes together when collaboration tools are available, higher-priority instructions permit it, and doing so earns the coordination cost.

Each child prompt contains only:

1. Role and distinct lens
2. Singular goal
3. Relevant sourced recall facts
4. Exact paths and whether edits are allowed
5. Non-goals and authorization boundary
6. Success criterion verbatim
7. Expected return shape: findings, files changed, commands run, and open risks

The filesystem is shared. Concurrent workers may inspect overlapping files, but writers need disjoint scopes or explicit isolated worktrees. Do not ask a child to change production state, push, send external messages, or use credentials unless the user separately authorized that exact action.

## Gate results

Apply [evidence-gate.md](evidence-gate.md). The primary agent reads changed files and performs risk-proportionate direct checks. Use a child evaluator for non-trivial or high-risk work when a genuinely different lens adds confidence; do not create a ceremonial reviewer for a trivial node.

Status transitions:

- `pending` -> `running` -> `verified`
- `running` -> `failed` when the criterion is disproved
- `pending` -> `skipped` only with a recorded reason
- `blocked` only when new authority, an external dependency, or missing user information prevents progress

Never label a node `reverted` unless the mission actually and safely removed only its own changes. Never hide partial completion behind a successful synthesis node.

## Ratchet and retry

For measurable loops, retain only changes that improve the target without breaking guardrails. Record every attempt. Stop at `max_rounds`; do not keep sampling until a weak result looks good.

## Maintain lineage

After every wave, update node status, evidence, decisions, actual file ownership, and the plan. If a run file exists, it must reflect current state after the wave rather than being reconstructed only at close-out.

## Close out

1. State the achieved outcome.
2. Name direct verification and its result.
3. List pending, failed, skipped, or authorization-blocked nodes.
4. Report child-agent count and rounds when a mission graph was used.
5. Record verified outcomes to ASM and create durable vault knowledge only when warranted.
6. Give one concrete next step only when work remains.
