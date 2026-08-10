<purpose>
Execute a compiled mission graph: dispatch ready nodes to subagents, gate every result through the evidence checklist, ratchet only measurable improvements, and close out by writing durable knowledge back to the vault and memory. Also resumes an interrupted mission from its run file.
</purpose>

<user-story>
As the user, I want the compiled graph actually executed with independent lanes running in parallel and every claimed result verified before it counts, so that I get a finished mission with proof attached instead of a fluent summary of work that may not have happened.
</user-story>

<when-to-use>
- Immediately after `compile-mission` produced a brief
- `/graph-mission run` with an existing brief
- Resuming after a context reset, compaction, or crash — a run file exists with pending nodes
</when-to-use>

<context>
`~/.claude/skills/graph-mission/context/operating-environment.md`
</context>

<references>
`~/.claude/skills/graph-mission/checklists/evidence-gate.md` (at every evaluator node, before marking anything kept)
`~/.claude/skills/graph-mission/frameworks/graph-engineering.md` (when a lane stalls and the architecture level looks wrong)
</references>

<steps>

<step name="load_or_resume" priority="first">
If a brief was just compiled in this session, use it.

Otherwise resume: list `.claude/graph-runs/` and read the most recent run file, or the one the user named. Report in one line what it says — objective, which nodes are terminal, which are still `pending` — then continue from the pending frontier.

**Never trust a `kept` status without its evidence field.** A node marked kept with no evidence attached was interrupted mid-write; treat it as pending.
</step>

<step name="dispatch_ready_nodes">
Compute the frontier: every node whose `depends_on` are all terminal and verified. Dispatch the whole frontier in **one message**, one `Agent` call per node, so they run concurrently.

Each subagent prompt contains exactly these, and nothing else:

1. **Role** — the agent type from the environment doc, and what perspective it holds
2. **Goal** — the node's `action`, imperative and singular
3. **Recall pack** — the relevant bullets from the brief, so it does not rediscover what we know
4. **Paths** — the specific files it needs, not the repo
5. **Non-goals** — what it must not touch
6. **Success** — the node's criterion, verbatim
7. **Output format** — what to return, and whether edits are allowed

Do not paste the conversation history. Each worker gets its own subgraph, not the whole run. Context dumping is what makes fan-out expensive without making it better.

**Concurrency discipline:** two nodes that write the same file are not independent. Serialize them, or give one of them an isolated worktree. Respect `max_subagents` from the budget.

If the user explicitly opted into orchestration, the `Workflow` tool is available for the fan-out instead. Without that opt-in, dispatch with `Agent` and, if the mission is large enough to warrant it, mention in the report that a workflow was an option.
</step>

<step name="gate_every_result">
No worker output merges into the graph unverified. For each returned node:

1. Read `~/.claude/skills/graph-mission/checklists/evidence-gate.md` and apply it.
2. **Verify side effects yourself.** A worker saying it wrote a file, ran a test, or fixed a bug is a self-report. Read the file. Run the command. A self-report is never proof.
3. For anything non-trivial, dispatch an evaluator with a **different agent type and different evidence** than the generator — the table in the environment doc names which. An evaluator that shares the generator's prompt shares its blind spots and then confirms them.
4. The evaluator returns criterion-level defects — "the test at path:line still fails", "the claim has no source" — or it returns nothing. "Looks good" is not an output; send it back.

Mark the node `kept` only with its evidence attached. Otherwise `reverted` or `crash`, with the reason logged.
</step>

<step name="ratchet">
For loop-shaped nodes, keep only measurable improvements.

- Improved on the target metric and no guardrail regressed → `kept`
- No improvement → `reverted`, logged
- Crashed → `reverted`, logged

Each trial records parent state, the change, the score, and the keep/discard decision. Watch the guardrails alongside the target — cost, latency, existing tests — because a ratchet optimizes exactly the metric it can see and will happily trade away the ones it cannot.

Stop when the budget's `max_rounds` is spent, not when the metric feels good enough.
</step>

<step name="update_lineage">
After every wave, update the run file: node statuses, evidence, decisions. Update the `TodoWrite` list to match.

This is the step that makes the mission survive compaction. If the session dies here, the next one resumes from the file — so the file must be true at all times, not written once at the end.
</step>

<step name="write_back">
Before reporting done, close the knowledge loop.

1. Did this mission learn something durable — a bug pattern, a runtime or setup detail, an architecture decision, a gotcha, a status change? → write the vault page **this session**. It becomes a brain node on the next refresh, so the next session inherits it.
2. Does it change how future sessions must work? → write or update the memory topic file, and add exactly one pointer line to the index. Content goes in the topic file, never in the index.
3. Does it revise an earlier vault page? → record the superseded page id in `contradictions` rather than overwriting it.

A mission that discovered a trap and did not record it will cost the same discovery again.
</step>

<step name="close_out" priority="last">
Report in this order:

1. **What changed** — files, behavior, decisions
2. **What was verified, and how** — the evidence, named: the command and its result, the file and line, the page that rendered
3. **What is blocked** — with the reason and who unblocks it
4. **Cost** — rounds, subagents dispatched
5. **Next step** — one concrete thing

If the budget ran out mid-run, return the best current artifact plus the unresolved nodes plus the stop reason. Never let a fluent summary paper over a partial failure — a graph with `pending` nodes is reported as a graph with pending nodes.
</step>

</steps>

<output>
## Artifact
Completed work (code, docs, decisions) plus a run file where every node holds a terminal status and every `kept` node holds evidence.

## Location
`.claude/graph-runs/<UTC-timestamp>.json`, updated in place through the run.
</output>

<acceptance-criteria>
- [ ] Frontier nodes dispatched in a single message, concurrently
- [ ] Each subagent prompt carried role, goal, recall pack, paths, non-goals, success criterion, output format — and no conversation dump
- [ ] No two concurrent nodes wrote the same file
- [ ] Every side-effect claim verified directly with Read or Bash, not accepted as a self-report
- [ ] Evaluators used a different agent type and different evidence than their generators
- [ ] Every `kept` node has evidence attached; every non-kept node has a logged reason
- [ ] Run file and todos reflect true state after every wave
- [ ] Durable knowledge written to the vault, memory updated if it changes future sessions
- [ ] Close-out reported what changed, what was verified, what is blocked, cost, next step
</acceptance-criteria>

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
