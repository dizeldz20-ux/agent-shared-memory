---
name: graph-mission
description: "Compile and run complex, multi-lane Codex work as an evidence-backed mission graph tied to ASM: recall before decomposition, define measurable success and non-goals, coordinate only independent lanes, persist resumable lineage, verify effects, and write back durable outcomes. Use when the user explicitly asks for graph-mission or a task has multiple independent research, build, or verification lanes or must survive interruption. Do not use for a direct answer, one small edit, or a tightly coupled change best kept in one context."
---

# Graph Mission for Codex

Turn a broad request into a small, typed execution graph before doing expensive work. The graph is temporary execution state; ASM and the Obsidian vault are the durable knowledge system.

The useful distinction is:

- ASM recalls what the workspace already knows.
- The mission graph decides what this run still needs to do.
- Current files and live checks establish what is true now.
- ASM write-back makes verified outcomes available to later Claude, Codex, and Gemini sessions.

## Activation boundary

Use this skill for an explicit `$graph-mission` request, two or more genuinely independent lanes, evidence-heavy research plus implementation, broad work whose success is not yet pinned down, or work likely to cross a compaction or session boundary.

If the task is one lookup, one localized edit, or a tightly coupled design/refactor, choose zero-shot or a short chain and do the work directly. State that the graph would cost more than it saves; do not manufacture ceremony.

## Required workflow

1. Read [references/knowledge-loop.md](references/knowledge-loop.md) and perform ASM recall before decomposing the request or inspecting mapped project files.
2. Read [references/compile.md](references/compile.md) and [references/graph-architecture.md](references/graph-architecture.md), then compile one objective, one checkable success signal, explicit non-goals, authorization boundaries, a sourced recall pack, and the cheapest graph that fits.
3. Mirror the top-level nodes in the client plan. Share a concise mission brief in commentary and proceed without asking for redundant confirmation unless a real user decision or new authority is required.
4. Read [references/run.md](references/run.md) before execution. Keep architecture, synthesis, conflict resolution, and final verification with the primary agent.
5. Read [references/evidence-gate.md](references/evidence-gate.md) before accepting any worker result or marking a node verified. A worker report is a lead, not proof.
6. Use [references/mission-schema.md](references/mission-schema.md) when the run needs persistent lineage or is being resumed.
7. Close the knowledge loop through ASM. Record only verified outcomes; create or update a canonical vault page only for knowledge that should remain durable beyond the handoff.

## Codex execution invariants

- The primary agent owns the mission graph and keeps only one plan step `in_progress` at a time.
- When collaboration tools are available and higher-priority instructions permit delegation, this skill calls for child agents only for genuinely independent lanes. Reserve one concurrency slot for the primary agent: at most three children, and fewer when the available slot count is lower.
- Agents share a filesystem. Never let concurrent workers write the same file or overlapping generated artifacts. Serialize the work or isolate it in explicit worktrees.
- Pass a worker only its node, relevant recall facts, exact paths, non-goals, success criterion, permission boundary, and expected output. Do not dump the whole conversation.
- Keep user changes intact. A failed node does not authorize resetting or reverting unrelated work.
- A mission does not expand authority. Deployments, destructive actions, credential use, pushes, external messages, and other consequential mutations still require the authorization they would require outside this skill.
- Persist `.codex/graph-runs/*.json` only when it earns the write: three or more nodes, child-agent dispatch, or likely interruption. Update it after each execution wave so it remains a real resume point.

## Output contract

During execution, commentary should make the objective, success signal, architecture level, current frontier, and blockers easy to audit without reproducing the whole run file.

The final answer leads with the achieved outcome, then names direct verification, unresolved nodes or authorization blockers, and any durable ASM/vault write-back. Never upgrade `pending`, `failed`, or merely worker-reported work into a fluent claim of completion.
