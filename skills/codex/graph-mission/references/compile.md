# Compile a mission

Compilation turns a raw request into a falsifiable contract and a validated graph before work fans out.

## 1. Read literally, set the mode

Restate the request in the user's terms before interpreting it, and set the mode (SKILL.md): compile mode ends with the brief; run mode continues into [run.md](run.md). Then extract:

- **Objective**: one outcome in one sentence. Two outcomes are two missions, or one whose success signal lists one check per lane; say which.
- **Success signal**: a check that can fail: a command that exits 0, a page that renders, a claim with a source, a decision the user makes.
- **Constraints**: the user's words, `AGENTS.md`, and the project rules recall adds.
- **Authority boundary**: what the mission may do alone (local edits, local tests, read-only calls), and every action from the SKILL.md authority list it touches. Each of those becomes a `gate`.
- **Non-goals**: never empty. Derive them from the prompt's silence: nearby files that look related, "while we're here" refactors, adjacent repositories, production actions nobody asked for.

## 2. Recall before anything else

Apply [knowledge-loop.md](knowledge-loop.md) before decomposing, before scanning code, and before any question to the user. A graph planned without recall contains nodes the brain already knows are dead ends, and questions it would have answered. Every state fact in the pack is confirmed now with `cmd:` or `file:` evidence, or becomes a `recon` node.

## 3. Gate verifiability; where a decision waits

Name the check, or define it cheaply now: a failing test, a file that must exist, a command. Never start autonomous execution on success that is taste without a rubric.

A decision the success signal depends on is settled now, before any work. If a source answers it (the spec, the code, an earlier decision of the user), decide, cite the source in `decisions`, and continue. Only when no source answers and the choice is genuinely the user's (taste, production, money, anything irreversible), ask one blocking question: end the turn with it, and continue when the answer arrives. A decision that only one lane depends on is not asked here; it becomes a `gate` inside that lane, so the other lanes keep moving.

## 4. Build the graph

Pick the cheapest level with [graph-architecture.md](graph-architecture.md) and name it, naming a composite as one (`fan-out → reduce → verify`). Decompose goal-backward with [decomposition.md](decomposition.md), and give every step the fields in [mission-schema.md](mission-schema.md). Put the claims collected so far in `claims` with `from_step: null`, and each source-backed decision in `decisions`. State which node, criterion, lock or non-goal each recall item changed.

## 5. Validate mechanically

- every `depends_on` names a real id, and there are no cycles
- every step has a `success` concrete enough to fail
- every `build` has a `verify` that depends directly on it, and a node that uses a build's output depends on that `verify`
- every action from the authority list is a `gate`
- **landing rule**: commits on lane branches and on a local integration branch are working commits. Work lands on the target branch, the one the mission hands over, only after reviews by two independent lenses and a full-suite `verify` that ran alone. A `reduce` lands it, or a `gate` when landing means a push
- no two nodes in one wave write the same path or hold the same lock
- every terminal node except `write-back` rolls up to the success signal; if none does, the graph misses the objective
- a mission that changes files ends in a `write-back` node

## 6. Budget

Set it before any dispatch: `max_subagents`, the child agents running at once, verifiers included (the smaller of 3 and the free slots); `max_rounds`, the most `rounds` any one step may use (default 3; waves are not budgeted); `on_exhaustion` (default: stop with the best verified result and list the unresolved nodes).

## 7. Emit

1. Write the run file. Every mission gets one, excluded from git before its first write ([mission-schema.md](mission-schema.md), Name and place).
2. Mirror the nodes in the plan tool: one step per node, or per wave for a large graph.
3. Share the brief: what the user does now (the blocking question, the gates ahead, or nothing); objective; success signal; level, and why not the rung above; authority boundary with each gated action; non-goals; the recall pack with sources; the graph by wave (id, kind, action, success, role, locks); budget; blockers. At most five items per group; the rest are in the run file.

Compile mode stops here, with the brief as the final answer. Run mode continues into [run.md](run.md) without asking for confirmation.
