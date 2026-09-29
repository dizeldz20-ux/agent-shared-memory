<purpose>
Turn a raw prompt into a compiled mission: a testable objective, a measurable success signal, an authority boundary, explicit non-goals, a recall pack of what is already known, and a goal-backward typed graph with locks and gates. Produces the brief and the run file that `run-mission` executes.
</purpose>

<user-story>
As the user, I want the loose thing I typed turned into an explicit mission before any work starts, so that the scope is pinned, what we already learned is reused instead of rediscovered, and I can see what "done" means — and what will wait for me — before tokens are spent.
</user-story>

<when-to-use>
- A prompt with 2+ lanes that write disjoint files, or one that drifts scope mid-sentence
- A broad request where "done" is not yet defined
- A plan request ("plan this", "break this down", "make me a plan") — compile only
- Entry point routes here via `/graph-mission` or `/graph-mission compile`
</when-to-use>

<context>
`~/.claude/skills/graph-mission/context/operating-environment.md`
</context>

<references>
`~/.claude/skills/graph-mission/frameworks/graph-engineering.md` (during select_architecture)
`~/.claude/skills/graph-mission/frameworks/decomposition.md` (during build_the_graph)
`~/.claude/skills/graph-mission/templates/mission-brief.md` (during build_the_graph and emit_brief)
</references>

<steps>

<step name="read_the_prompt_literally" priority="first">
Restate what was asked, in the user's own terms, before interpreting it. Then set the mode and extract five things.

**Mode.** `/graph-mission compile` or a plan request ("plan this", "break this down", "make me a plan") is **compile mode**: it ends with the brief. `/graph-mission` or a request to do the work is **run mode**: it continues into `run-mission`.

<if condition="the request is one edit or one lookup">
Say so in one line. In run mode, do the work directly. In compile mode, stop there.
</if>

1. **Objective** — the one outcome. Two outcomes joined by "and" or "and also" are two missions, or one mission whose objective names the shared purpose and whose success signal lists one check per lane. Name which.
2. **Success signal** — how we will know it worked. It must be something a machine or a human can check: a command that exits 0, a page that renders, a claim with a source, a decision the user makes.
3. **Constraints** — from the project's instruction files (`CLAUDE.md`, `AGENTS.md`) and anything the prompt states outright. Recall adds the project memory's.
4. **Authority boundary** — what this request lets the mission do alone (local edits, local tests, read-only calls), and which actions from the Authority section of the environment doc it touches. A mission never widens authority.
5. **Non-goals** — what this mission will *not* touch. Derive these from the prompt's silence: files nearby that look related, refactors that would be "while we're here", scope the prompt did not ask for.

Do not skip non-goals because the prompt seems narrow. A prompt that seems narrow is exactly where scope creeps.
</step>

<step name="recall_before_decomposing">
Recall runs **before** decomposition and before any question to the user. A graph planned without it contains nodes the brain already knows are dead ends, and a question it would have answered.

Walk the ladder in `context/operating-environment.md`:

1. Use what is already in context: the "ASM recall" nodes the prompt hook listed, the skill-router hints, the SessionStart banner, the memory index. Open the relevant nodes with `mcp__asm__brain_node(node_id)`. A prompt that starts with `/` — `/graph-mission …` included — gets no prompt-hook recall and no router hints for that prompt; this step then holds only the SessionStart banner, the memory index and earlier prompts' hook output.
2. Call `mcp__asm__brain_search(query=<subject>)`, and `mcp__asm__memory_recent(limit=5, query=<one or two distinctive words>)` for handoffs newer than the graph.
3. Read the project's hub or memory page, then the memory files the mission touches. Add their constraints.
4. For files the mission will edit, call `mcp__asm__brain_context(file_path=<path>)` and read the `vault_pages` it returns from disk. For a shared change, call `mcp__asm__brain_neighbors(node_id, depth)` for the blast radius — partial on a hub file, as the ladder says. On `node: null`, retry as the ladder says — more path segments, or the mapped checkout's absolute path — before concluding anything.
5. The disk last — grep, find, Read — for what the rungs above did not answer.

Note the open threads this mission will finish, so the write-back can record them as finished. If your ASM version numbers threads, `memory_recent` lists them as `<record-id>#<n>` — note those ids, so the write-back can close them.

Write the result as a **recall pack**: up to 8 facts, each with a source from the vocabulary in `templates/mission-brief.md`. Every fact that describes state is either confirmed now with `cmd:` or `file:` evidence, or becomes a `recon` node. An empty pack says what was searched.
</step>

<step name="gate_verifiability">
If the success signal cannot be measured, the mission cannot start.

<if condition="you can name the check">
Continue.
</if>

<if condition="you can define the check cheaply — a failing test, a file that must exist, a command">
Define it now, then continue.
</if>

<if condition="the success signal depends on a decision">
If the recall or a source answers it — the spec, the code, one of the user's earlier decisions — decide, cite the source in the brief, and continue.

Only when no source answers it and the decision is genuinely the user's, ask **one** blocking question with `AskUserQuestion` (without it, write the question into the brief's blockers and stop).

**Wait for the answer before continuing.** A decision that only one lane depends on is not asked here — it becomes a `gate` inside that lane.
</if>

Never start autonomous execution on an objective whose success is a matter of taste with no stated rubric.
</step>

<step name="select_architecture">
Read `~/.claude/skills/graph-mission/frameworks/graph-engineering.md` and answer the six selection questions in order. Pick the **cheapest level that fits** and name it out loud in the brief. Name a composite as a composite (`fan-out → reduce → verify`).

The most common mistake here is over-graphing. Two checks before you commit to a fan-out:
- Would one agent in one context do this faster? Then it is not a mission — say so, and follow the one-edit rule in `read_the_prompt_literally`.
- Do the "parallel" lanes write the same files or need the same exclusive resource? Then they are not independent; serialize them or isolate them.
</step>

<step name="build_the_graph">
Read `~/.claude/skills/graph-mission/frameworks/decomposition.md` and decompose **goal-backward**: start at the terminal check, turn "what must be true for it to pass?" into conditions, and resolve each one as the framework says.

Give every step the fields in `templates/mission-brief.md`: `id`, `kind`, `action`, `role`, `depends_on`, `paths`, `locks` (from the framework's list), `success`, `artifact` — and `loop` for an improvement loop. `decide`, `gate`, `reduce` and `write-back` nodes run as `self`.

Write the claims collected so far into `claims` with `from_step: null`, and every decision taken from a source into `decisions` with that source. A claim with no source is a guess — drop it or turn it into a `recon` node.

Apply the recall pack: each item must change a node, a criterion, a lock or a non-goal. State which.

Compute the waves as the framework describes. Then validate, mechanically:
- every `depends_on` points at a real id, and there are no cycles
- every step has a `success`
- every `build` has a `verify` that depends directly on it, and a node that uses a build's output depends on that `verify`
- every action from the Authority section is a `gate`
- commits on lane branches and on a local integration branch are working commits. The work lands on the target branch — the one the mission hands over — only after reviews by at least two evaluator types and a `verify` that ran the full suite, alone. A `reduce` lands it, or a `gate` when landing means a push
- no two nodes in one wave write the same path or hold the same lock
- every terminal node except `write-back` rolls up to the mission's success signal — if none does, the graph does not achieve the objective
- a mission that changes files ends in a `write-back` node

Set the budget before adding workers: `max_subagents` (default 4), `max_rounds` (default 3) and `on_exhaustion`, as the template defines them.
</step>

<step name="emit_brief">
Read `~/.claude/skills/graph-mission/templates/mission-brief.md`.

1. Write the run file — every mission gets one. Put it under `.claude/graph-runs/` in the working tree the mission edits, or in the session's working directory when that tree does not exist yet. Name it as the template says. When the location is inside a git repository, first append `.claude/graph-runs/` to the file that `git rev-parse --git-path info/exclude` prints — this works in linked worktrees too, where `.git` is a file.
2. Track progress as the environment doc's Dispatch section says.
3. Present the brief to the user in their language, filled from the template.
</step>

<step name="confirm_or_proceed" priority="last">
<if condition="compile mode">
Stop here and hand over the brief.
</if>

<if condition="run mode">
Proceed straight into `tasks/run-mission.md` — do not ask "shall I start?". The brief *is* the plan; asking again just costs a turn. Gates stop the run where they sit in the graph, not before it starts.
</if>
</step>

</steps>

<output>
## Artifact
A mission brief (in the response, in the user's language) and a run file.

## Location
`.claude/graph-runs/{utc-timestamp}-{mission-slug}.json`, excluded from git.

## Shape
See `templates/mission-brief.md` for the brief, the run-file schema, the statuses and the source vocabulary.
</output>

<acceptance-criteria>
- [ ] Mode set: compile mode for `compile` and plan requests, run mode otherwise
- [ ] Objective is one sentence; with two lanes, the success signal lists one check per lane
- [ ] Success signal is checkable by a command, a file, a rendered page, or a sourced claim
- [ ] Authority boundary names every action in the graph that waits for the user
- [ ] Non-goals list is non-empty
- [ ] Recall ran before any question and any code scan; every fact sourced; every status fact confirmed now or turned into a `recon` node
- [ ] Every recall item changed a node, a criterion, a lock or a non-goal
- [ ] Architecture level named, and it is the cheapest one that fits
- [ ] Waves computed, then the graph validated against every rule in `build_the_graph`
- [ ] Budget set before any subagent is dispatched
- [ ] Run file written and excluded from git
- [ ] The brief reached the user
</acceptance-criteria>

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
