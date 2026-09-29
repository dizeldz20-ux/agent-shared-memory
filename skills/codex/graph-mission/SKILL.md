---
name: graph-mission
description: "Compile a broad, vague, or multi-lane request into an evidence-backed mission graph before doing the work, then run it with child agents, gates for the user's authority, and a resumable run file under .codex/graph-runs. Use when the user invokes graph-mission or asks to plan or break down work; when two or more lanes that write disjoint files can run in parallel; when success is not yet defined or the scope drifts; when work must survive interruption; or to resume an interrupted mission. Plan requests stop after the brief. Not for a direct answer, one small edit, or a tightly coupled change best kept in one context."
---

# Graph Mission for Codex

Compile the request into a small typed graph before expensive work, then run it. The graph is temporary execution state; ASM and the vault hold durable knowledge.

- ASM recalls what the workspace already knows.
- The mission graph decides what this run still needs to do.
- Current files and live checks establish what is true now.
- ASM write-back makes verified outcomes available to later sessions of any agent.

## Activation boundary

Use this skill for an explicit `$graph-mission`, two or more lanes that write disjoint files, research plus implementation, broad work whose success is not yet pinned down, or work likely to cross a compaction or session boundary.

For one lookup, one localized edit, or a tightly coupled design or refactor, say in one line that a graph would cost more than it saves, then do the work directly (in compile mode, stop there).

## Modes

- **Compile**: a plan request ("plan this", "break this down", `$graph-mission compile`). Ends with the brief as the final answer.
- **Run**: `$graph-mission`, or a request to do the work. Compiles, then executes without asking "shall I start?"; gates stop the run where they sit in the graph.
- **Resume**: "resume the mission", `$graph-mission resume`, or a run file the user names. Continues per [run.md](references/run.md).

## Workflow

1. [knowledge-loop.md](references/knowledge-loop.md): recall before decomposing, opening mapped files, or asking the user anything.
2. [compile.md](references/compile.md): the contract, authority boundary, validation list, run file and brief.
3. [decomposition.md](references/decomposition.md) while building the graph: goal-backward nodes, seven kinds, locks, waves. [graph-architecture.md](references/graph-architecture.md) picks the cheapest level that fits.
4. Mirror the nodes in the plan tool and share the brief. Compile mode stops here.
5. [run.md](references/run.md): frontier, dispatch, gates, revise loop, lineage, write-back, close-out.
6. [evidence-gate.md](references/evidence-gate.md) before any node is marked `verified`. A child's report is a lead, not proof.
7. [mission-schema.md](references/mission-schema.md) whenever the run file is written, updated or resumed.

## Codex invariants

- The primary agent owns objective interpretation, architecture, mission state, synthesis, conflicts, gates and final verification. It keeps one plan step `in_progress` at a time.
- This skill asks for child agents for independent lanes, when collaboration tools exist and higher-priority instructions permit delegation. One slot stays with the primary: at most three children at once, verifiers included, fewer when fewer slots are free. Children spawn no agents of their own.
- Agents share a filesystem. Concurrent writers need disjoint `paths` and no common lock, or an explicit worktree each.
- User changes stay intact. A failed node never authorizes resetting or reverting work the mission did not create.
- Every mission has a run file under `.codex/graph-runs/`, kept out of git and true after every result.

## Authority

A mission never widens authority. These wait for the user's explicit word, and each one is a `gate` node:

- deploy, push, or an outbound message
- spending money
- using a credential: reading, copying or passing a secret, or signing in to an outside service as the user. Running an app with the keys it already has is not
- anything that drives the user's screen, mouse or keyboard
- changing a runtime every session shares: ASM's runtime, global hooks, agent client configuration, scheduled jobs. Data written through ASM's own tools is not. `refresh.sh` redeploys that runtime and follows the rule in [knowledge-loop.md](references/knowledge-loop.md)
- a destructive or irreversible operation on anything the mission did not create

A request in the prompt ("…and deploy it") is intent, not the word, and the word covers one action. A sandbox approval prompt is not the word either: ask first, with the evidence.

## Output

Commentary keeps the objective, success signal, architecture, frontier and blockers auditable without pasting the run file. The final answer follows the close-out order in run.md and never upgrades `pending`, `failed`, `blocked` or child-reported work into completion. Report in the user's language; run files, node ids and child prompts stay English.
