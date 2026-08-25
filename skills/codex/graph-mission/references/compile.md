# Compile a mission

Compilation turns a raw request into a falsifiable contract before work fans out.

## 1. Read literally

Extract:

- **Objective:** one outcome in one sentence. Multiple outcomes become explicit lanes or separate missions.
- **Success signal:** a command, artifact, rendered behavior, sourced decision, or other check that can fail.
- **Constraints:** user instructions, `AGENTS.md`, recalled project rules, budget, platform, and time.
- **Non-goals:** nearby refactors, production actions, adjacent repositories, or other plausible scope not requested.
- **Authorization boundary:** actions the current request permits and actions that still need the user.

If success cannot be made measurable through safe inspection or a reasonable assumption, ask one concise blocking question. Otherwise compile and proceed.

## 2. Recall before decomposition

Apply [knowledge-loop.md](knowledge-loop.md). Build a 3-8 item recall pack before defining nodes. Each recalled trap must change a node's success criterion, add a verification node, or become an explicit non-goal.

## 3. Choose the cheapest architecture

Apply [graph-architecture.md](graph-architecture.md). Do not fan out just because agents exist. Independent reads may run concurrently; overlapping writes may not.

## 4. Type the graph

Each step has:

- `id`: short and stable
- `action`: one imperative outcome
- `owner`: `main` or a child-agent task name
- `depends_on`: real step ids only
- `paths`: exact read/write scope
- `success`: criterion concrete enough to fail
- `permissions`: side effects allowed for the node
- `status`: current lineage state
- `evidence`: direct proof, initially empty

Claims are separate from steps and must carry a source from the recall-pack source vocabulary. Validate that all dependencies exist, the graph is acyclic, concurrent write scopes are disjoint, and terminal success rolls up to the mission success signal.

## 5. Fix the budget before dispatch

Defaults:

- `max_children`: the smaller of 3 or the currently available child slots
- `max_rounds`: 3
- `on_exhaustion`: stop with the best verified artifact and list unresolved nodes

## 6. Emit and track

Mirror the top-level graph in the plan tool. Persist a run file only under the conditions in [mission-schema.md](mission-schema.md).

Share a concise commentary brief containing objective, success signal, non-goals, architecture level, lanes, and any authorization blocker. Unless invoked as compile-only, continue directly into execution.
