# Graph architecture selection

Use the lowest level that preserves correctness.

| Situation | Architecture |
|---|---|
| Direct low-risk answer or localized edit | Zero-shot; no mission artifact |
| One checkable output needs refinement | Loop: generate, evaluate, revise |
| Stable dependent stages | Chain |
| One of several mutually exclusive paths | Router |
| Independent lanes with a reducer | Fan-out and synthesis |
| Decomposition changes as facts emerge | Orchestrator-workers |
| Alternatives must remain reversible and attributable | DAG |

## Selection questions

1. Can success be checked? If not, define the check or ask the one decision that blocks it.
2. Are stages stable? If yes, use a chain rather than orchestration.
3. Are lanes actually independent in information and write scope? If no, serialize them.
4. Must alternatives remain alive? If yes, retain a DAG and the decision rationale.
5. Must the run survive interruption? If yes, persist lineage.
6. Does delegation reduce wall-clock or improve independence enough to pay for coordination? If no, keep the node with the primary agent.

## Ownership

The primary agent retains objective interpretation, architecture decisions, mission state, synthesis across lanes, conflicts, permission decisions, and direct final verification.

When collaboration is available and permitted, use child agents for bounded independent reconnaissance, implementation in disjoint paths, or a genuinely different evaluation lens. Reserve one slot for the primary agent and never exceed three children.

An evaluator should differ from the generator in at least one material dimension: role, evidence, method, or prompt. Parallel copies of the same reasoning are correlated, not independent.

## Graph and evidence semantics

A step is work. A claim is an assertion backed by an evidence edge. An artifact is a field on a step, not a third node type.

For improvement loops, record parent state, change, target metric, guardrails, and keep/discard decision. A failed experiment does not authorize resetting the user's dirty worktree; isolate experiments or revert only changes created and owned by the mission.

## Anti-patterns

- Over-graphing a one-step task
- Planning before recall
- Fan-out whose workers edit the same file
- Passing the entire conversation to every worker
- Treating a worker's test report as direct evidence
- Splitting a subtle product or architecture decision across contexts
- Keeping a confident result with no falsifiable criterion
- Optimizing one metric while silently regressing cost, latency, safety, or existing tests
