<purpose>
Turn a raw prompt into a compiled mission: a testable objective, a measurable success signal, explicit non-goals, a recall pack of what is already known, and a dependency-ordered typed graph. Produces the brief that `run-mission` executes.
</purpose>

<user-story>
As the user, I want the loose thing I typed turned into an explicit mission before any work starts, so that the scope is pinned, what we already learned is reused instead of rediscovered, and I can see what "done" means before tokens are spent.
</user-story>

<when-to-use>
- A prompt with 2+ independent lanes, or one that drifts scope mid-sentence
- A broad request where "done" is not yet defined
- Entry point routes here via `/graph-mission` or `/graph-mission compile`
- NOT when the answer is one edit or one lookup — say so in one line and just do it
</when-to-use>

<context>
`~/.claude/skills/graph-mission/context/operating-environment.md`
</context>

<references>
`~/.claude/skills/graph-mission/frameworks/graph-engineering.md` (during select_architecture)
`~/.claude/skills/graph-mission/templates/mission-brief.md` (during emit_brief)
</references>

<steps>

<step name="read_the_prompt_literally" priority="first">
Restate what was asked, in the user's own terms, before interpreting it. Then extract four things and write them down:

1. **Objective** — the one outcome. If the prompt contains two outcomes joined by "and", that is two missions or one mission with two lanes. Name which.
2. **Success signal** — how we will know it worked. It must be something a machine or a human can check: a command that exits 0, a page that renders, a claim with a source, a decision the user makes.
3. **Constraints** — from the project's instruction files, from the environment doc, from anything the prompt states outright.
4. **Non-goals** — what this mission will *not* touch. Derive these from the prompt's silence: files nearby that look related, refactors that would be "while we're here", scope the prompt did not ask for. Non-goals are the cheapest scope control there is.

Do not skip non-goals because the prompt seems narrow. A prompt that seems narrow is exactly where scope creeps.
</step>

<step name="gate_verifiability">
If the success signal cannot be measured, the mission cannot start.

- Can you name the check? → continue.
- Can you *define* the check cheaply (write the failing test, name the file that must exist, name the command)? → define it now, then continue.
- Does it genuinely require a decision only the user can make (which of two designs, whether to deploy, what "good enough" means)? → ask **one** blocking question with `AskUserQuestion`.

  **Wait for the answer before continuing.** This is the only sanctioned wait point in the mission — everything after it proceeds autonomously.

Never start autonomous execution on an objective whose success is a matter of taste with no stated rubric.
</step>

<step name="recall_before_decomposing">
Recall runs **before** decomposition, not after. A graph planned without it will contain nodes that memory already proved are dead ends.

Walk the recall order in `context/operating-environment.md`, stopping as soon as the question is answered:

1. Ask ASM first: `mcp__asm__brain_search(topic)` for the mission subject, `mcp__asm__brain_context(file)` for any file the mission will touch. One call returns both the knowledge pages and the code neighbourhood — it usually answers steps 3 and 4 at once.
2. Scan the memory index already in context for lines touching this mission's subject, and read the topic files those lines point at.
3. Check the vault for the project page before scanning code.
4. For a code question in a project with a code-graph index, query it — it returns the symbols' source plus the call paths in one round trip.
5. Only then grep.

Write the result as a **recall pack**: 3-8 bullets of what is already known, each with its source. This pack goes into the brief and into every subagent prompt, so no worker rediscovers it.

Then apply it. For each trap the recall surfaced, either a node encodes it (a test node that runs the project's real test path, a verify node that hits the live path) or a non-goal excludes it. State which.
</step>

<step name="select_architecture">
Read `~/.claude/skills/graph-mission/frameworks/graph-engineering.md` and answer the six selection questions in order. Pick the **cheapest level that fits** and name it out loud in the brief.

The most common mistake here is over-graphing. Two checks before you commit to a fan-out:
- Would one agent in one context do this faster? Then it is not a mission — say so and do the work.
- Do the "parallel" lanes actually write to the same files? Then they are not independent; serialize them or isolate them.
</step>

<step name="build_the_graph">
Emit the typed graph. Two node types only — a `step` is work, a `claim` is an assertion that must carry evidence. Artifacts are a field on a step, not a third type.

Every step needs:
- `id` — short, stable, referenced by dependents
- `action` — what it does, imperative
- `role` — which agent type from the environment doc runs it, or `self` for inline work
- `depends_on` — ids only, no prose
- `success` — the criterion, concrete enough to fail
- `artifact` — the path it produces, when it produces one

Every claim needs a `source` from the allowed set: `brain:<node-id>`, `memory:<file>`, `vault:<page-id>`, `file:<path>#L<n>`, `cmd:<command>`. A claim with no source is not a claim, it is a guess — drop it or turn it into a step that goes and finds out.

Then validate, mechanically:
- every `depends_on` points at a real id
- no cycles
- every step has a `success`
- every terminal step's success rolls up to the mission's success signal — if nothing does, the graph does not achieve the objective

Set the budget before adding workers: `max_subagents` (default 4), `max_rounds` (default 3), and what to do when it runs out.
</step>

<step name="emit_brief">
Read `~/.claude/skills/graph-mission/templates/mission-brief.md` and fill it.

Track the graph with `TodoWrite` — one todo per step node, so progress is visible without re-reading the brief.

**Persist the run file only when it earns its cost:** 3+ nodes, or any subagent dispatch, or work likely to outlive the context window. Write it to `.claude/graph-runs/<UTC-timestamp>.json` in the project. A two-node mission needs no file — the todos are the lineage.

Present the brief to the user: objective, success signal, non-goals, recall pack, the graph as a short ordered list, budget, and the architecture level you chose.
</step>

<step name="confirm_or_proceed" priority="last">
If invoked as `/graph-mission compile`, stop here and hand over the brief.

Otherwise proceed straight into `tasks/run-mission.md` — do not ask "shall I start?". The brief *is* the plan; asking again just costs a turn. Stop only if the gate in `gate_verifiability` raised a real decision, or if the graph turned out to contain a destructive or production-facing node.
</step>

</steps>

<output>
## Artifact
A mission brief (in the response) and — when it earns its cost — a run file.

## Location
`.claude/graph-runs/<UTC-timestamp>.json` in the project root.

## Shape
See `templates/mission-brief.md` for both the brief sections and the run-file JSON schema.
</output>

<acceptance-criteria>
- [ ] Objective is one sentence and names one outcome
- [ ] Success signal is checkable by a command, a file, a rendered page, or a sourced claim
- [ ] Non-goals list is non-empty
- [ ] Recall pack drawn from the brain / memory / vault before any code scan, each bullet sourced
- [ ] Every trap the recall surfaced is either encoded in a node or excluded by a non-goal
- [ ] Architecture level named, and it is the cheapest one that fits
- [ ] Graph validates: real ids, no cycles, every step has `success`, terminal successes roll up to the mission's
- [ ] Every claim carries a source from the allowed set
- [ ] Budget set before any subagent is dispatched
- [ ] Run file written when the mission has 3+ nodes or dispatches subagents
</acceptance-criteria>

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
