<purpose>
Execute a compiled mission graph: dispatch the ready frontier, hold at gates for the user's word, check every result through the evidence gate, send defects back for revision, ratchet only measurable improvements, and close out by writing the outcome back to ASM, the vault and memory. Also resumes an interrupted mission from its run file.
</purpose>

<user-story>
As the user, I want the compiled graph actually executed with independent lanes running in parallel and every claimed result verified before it counts, so that I get a finished mission with proof attached — and every production step waiting for my word — instead of a fluent summary of work that may not have happened.
</user-story>

<when-to-use>
- Immediately after `compile-mission` produced a brief in run mode
- `/graph-mission run` with a brief compiled in this session
- `/graph-mission resume`, or any session that finds an interrupted mission — a run file with no `closed_at`
- A gate that got its word after close-out — the user names the closed run file
</when-to-use>

<context>
`~/.claude/skills/graph-mission/context/operating-environment.md`
</context>

<references>
`~/.claude/skills/graph-mission/checklists/evidence-gate.md` (whenever a returned node is checked)
`~/.claude/skills/graph-mission/templates/mission-brief.md` (for the schema, the statuses, the legacy mapping and the budget)
`~/.claude/skills/graph-mission/frameworks/graph-engineering.md` (when a lane stalls and the architecture level looks wrong)
</references>

<steps>

<step name="load_or_resume" priority="first">
<if condition="a brief was compiled in this session">
Use its run file.
</if>

<if condition="resuming">
Find the run file: the one the user named — even a closed one, when a gate got its word after close-out; reopen it as `write_back` says — or the one under `.claude/graph-runs/` with no `closed_at` whose `worktree` is exactly this tree and whose `objective` is this task. Never take the newest file blindly — a run file committed by mistake travels into every worktree cut after it, and another mission's file can be newer.

With zero or several candidates, list them to the user and **wait for their answer.**

Then reconcile the file with the tree, in this order:
1. Map legacy fields and statuses per the template. A version 1 step has no `kind` — assign `kind` and `locks` before anything else, so a deploy step becomes a `gate`.
2. A `running` node whose `dispatched_session` is this session: wait for its agent's notification. Otherwise look for its work — its `paths` in `git status`, its `branch` in `git worktree list`. No work → `pending`. Work found → apply the Side Effects section against its `action`: passes → `kept`; fails → `failed` with the reason "partial changes in tree".
3. A `kept` node with no evidence → `pending`, unless a node that depends on it is `kept` with evidence; then keep it, with evidence `"inferred: dependent <id> kept"`.

Report in one line: objective, terminal nodes, and the frontier.
</if>
</step>

<step name="dispatch_ready_nodes">
Compute the frontier:
- every `pending` node whose dependencies are all satisfied (`kept` or `skipped`)
- minus any node whose path or lock a `running` node holds
- when frontier nodes share a path or lock, one holder at a time — the node on the critical path, otherwise the lowest id

Route what is left:
- a `gate` → `hold_at_gates`
- a `self` node → run it inline, after the subagent dispatches
- any other node → an `Agent` call

Dispatch up to `max_subagents` in **one message**, and the rest as slots free. Just before each call, write the node's `status: running`, `dispatched_at` and `dispatched_session` to the run file; as soon as the call returns, add its `agent_id`. A mission that compacts mid-wave must not dispatch the same node twice.

Each subagent prompt contains exactly these, and nothing else:

1. **Role** — the agent type and the perspective it holds
2. **Goal** — the node's `action`, imperative and singular
3. **Recall pack** — the relevant sourced facts, so it does not rediscover what we know
4. **Recall duty**, for nodes that edit — call `mcp__asm__brain_context(file_path)` on each file before editing it, and read the `vault_pages` it returns
5. **Paths** — its write scope and the files it needs, not the repo. A `build` leaves its changes uncommitted, unless it works on an isolated branch
6. **Non-goals and authority** — what it must not touch, and the Authority list from the environment doc, pasted in full: none of it is allowed to the subagent
7. **Locks** — what it holds and the rule that comes with each (`test-runner`: targeted files, a low worker count such as `--maxWorkers=1`, under `nice` where the OS has it; stop any service it starts)
8. **Success** — the node's criterion, verbatim
9. **Output format** — findings with sources, files changed, commands run with their output, open risks

Do not paste the conversation history. Each worker gets its own subgraph, not the whole run.

A node that could write the same files as another gets `isolation: "worktree"`. Before dispatching it, make sure the graph merges its branch in a `self` `reduce` and runs the full-suite `verify` after that merge — add whatever is missing to the run file — and record the `branch` it returns.

A node waiting on something outside the mission — another session's work, a service that is down — is `blocked` with the `reason`. Re-check it every wave, and set it back to `pending` when the dependency is there.

When the mission creates the tree it edits, move the run file into that tree's `.claude/graph-runs/`, exclude it from git there, and set `worktree`.

If the user explicitly opted into orchestration ("use a workflow"), `Workflow` may run the fan-out instead of `Agent`.
</step>

<step name="hold_at_gates">
When a `gate` node reaches the frontier, set it `blocked` and do not perform its action.

1. Tell the user in one line what the gate needs: the action, what it touches, and the evidence that the nodes before it are `kept`. A gate that is a choice is asked with `AskUserQuestion`.
2. Keep dispatching every lane that does not depend on the gate.

**Wait for the user's explicit word**, as the environment doc's Authority section defines it.

On the word, run the action as `self` and observe its effect on the live path — a health check, `git ls-remote`, a delivery receipt — never by running the action again. Mark the gate `kept` with that evidence. The word covers that action only: not the next gate, and not a retry with different parameters.
</step>

<step name="gate_every_result">
No returned node merges unverified. Read `~/.claude/skills/graph-mission/checklists/evidence-gate.md` and apply the sections it names for the node's kind. **Verify side effects yourself** — read the file, run the command. A worker's report is a lead, never proof.

- **`build`** — once its side effects are confirmed, mark it `kept`: "built as claimed". Whether it is right is its `verify`'s call.
- **`verify`** — first check the verifier's own report against Provenance and Side Effects. A report that fails — a claimed run that does not reproduce, a finding with no source — is the verifier's defect, not the builder's: dispatch a fresh verifier and add one to the verify's `rounds`. Then act on the findings:
  1. No defects → `kept`.
  2. Defects in one build's work → send them back to that builder (`SendMessage` to the same agent, or a new attempt), set the `build` back to `running` with one more round, and set the `verify` back to `pending`, so the frontier dispatches it again once the build is `kept`.
  3. Defects in integrated work → add each as a new `build` on the integration branch, and set the `verify` back to `pending`, so it runs again once they are `kept`.
- **`recon`** — append its sourced findings to `claims`.

A node becomes `failed` right away when Provenance, Side Effects or Authority fails in its own work, or when its `rounds` reach `max_rounds`. A `verify` that ends `failed` because of defects fails the builds those defects belong to. A `failed` node's `reason` says what failed and whether its changes are still in the tree. Before a full-suite `verify` runs, a failed build's changes in a shared tree are saved as a patch outside the tree — the session's scratchpad, if it has one — and removed; that build becomes `reverted`, with the patch path in its `reason`.

A node that is no longer needed becomes `skipped` with its `reason`, and so does any node that cannot run without it.
</step>

<step name="ratchet">
For a node with a `loop` field, keep only measurable improvements.

1. Record each trial in `loop.trials`: parent state, the change, the score on `loop.metric`, the guardrails, and keep or discard. Each trial adds one to `rounds`.
2. Discard a trial that did not improve the metric, or that regressed a guardrail — cost, latency, existing tests — and remove only that trial's own changes.
3. Stop when `rounds` reach `max_rounds`, not when the metric feels good enough.

The node is `kept` when its best trial improved the metric with every guardrail intact. It is `reverted` only when every trial was discarded.
</step>

<step name="update_lineage">
After every result, update the run file: statuses, evidence, `reason`, `rounds`, decisions and open threads. Update the tracker to match.

This is the step that makes the mission survive compaction. The file must be true at all times, not written once at the end.
</step>

<step name="write_back">
Run the `write-back` node as `self`, with no verifier, when every other node is terminal, `blocked`, or `pending` behind a `blocked` node — a gate still waiting does not hold the record back.

1. **Record.** Call `mcp__asm__memory_record` with the `session_id` the ASM memory gate names (in Claude Code, the UUID in this session's scratchpad path), a one-line `summary`, verified results in `details`, `files`, `decisions`, `open_threads` (every `blocked` gate among them), and `supersedes` for earlier records of this mission, such as one the memory gate forced mid-run. If your ASM version's `memory_record` accepts `resolves`, add the ids of the threads this mission finished (`<record-id>#<n>`, noted during recall; `<n>` counts from 0), a record id to close all its threads, or `vault:<id>` for a plan page now done — a page already in the graph. If it does not, quote the finished threads in `details`. Read the answer's `ignored_supersedes`, and `ignored_resolves` where your version returns it: an id listed there changed nothing. `supersedes` retires a whole record from recall for every session, so naming another session's record there is an irreversible operation on something the mission did not create — it waits for the user's word.
2. **Durable knowledge → a vault page** under `wiki/main/`, following the vault's own conventions: frontmatter `id`, `pageType` (entity, concept, synthesis, source, architecture or report), a one-sentence `description`, `tags`, `related` (existing page ids only), `aliases`, `updatedAt` — and `resource`, a mapped path, when the page is about a file: that is what links the page to the file in `brain_context`. Never hand-edit the generated `okf/` bundle or a generated index. A page that revises another lists the old id in `contradictions`.
3. **A rule for future sessions → a memory file plus one line** — in the project's hub or memory page; in the memory index only for a standing rule or a tool trap any session can hit.
4. **Recall that proved wrong is corrected, not just avoided.** If your ASM version's `memory_record` accepts `corrects`, file each stale claim there — `{"target": "vault:<id>" | "mem:<file>" | "idx:<index>:<file>", "claimed": …, "truth": …, "evidence": […]}` — and read `ignored_corrects` in the answer. Copy `claimed` verbatim from the target — a curator never applies a fuzzy match. If the SessionStart banner shows the curator running (`curator ok …`), its code is deployed (`~/.asm/jobs/dist/curator/`), and the target is a vault page, a memory file in its configured memory folder, or a line of that folder's `MEMORY.md` (or of a hub page, when the jobs config names hubs), leave the line to it: it replaces the claimed text once the user approves the proposal (in `/asm-review`, if your version ships that command) or on its own once that class has earned trust, and it cannot apply a correction whose text is already gone. In any other case — another target, no running curator, or no `corrects` — fix the stale line yourself and put "claimed X, true Y, evidence Z" in the record's `details`.

When a gate gets its word after the record, write a new record that supersedes it. When the word comes after close-out, reopen the run file (clear `closed_at`), run the gate as usual, then write a new record that supersedes the close-out record, and close out again.
</step>

<step name="close_out" priority="last">
Stop every service the mission started, and write `closed_at` to the run file. Then report to the user in their language, in this order:

1. **What they do now** — the gates and decisions waiting for them, or that nothing is
2. **What works, and how to check it** — the command and its result, the page that renders
3. **What is blocked or failed** — with the reason and who unblocks it
4. **Cost** — the `rounds` spent and the subagents dispatched

A graph with `blocked`, `failed` or never-started `pending` nodes is reported as exactly that. Never let a fluent summary paper over a partial failure.
</step>

</steps>

<output>
## Artifact
Completed work (code, docs, decisions) plus a run file with `closed_at`, in which every node is terminal, `blocked`, or `pending` because it never started, and every `kept` node holds evidence.

## Location
`.claude/graph-runs/{utc-timestamp}-{mission-slug}.json`, updated in place through the run.
</output>

<acceptance-criteria>
- [ ] Resumed only an unclosed run file tied to this mission, or the file the user named, with legacy statuses mapped and in-flight nodes reconciled
- [ ] Every node was set `running` before its dispatch and got its `agent_id` right after; never more than `max_subagents` ran at once
- [ ] Each subagent prompt carried the nine parts, the Authority list pasted in full, and no conversation dump
- [ ] No two running nodes shared a path or a lock
- [ ] Every gate waited for the user's word; its effect was observed, never re-run
- [ ] Every `kept` node passed the sections of `checklists/evidence-gate.md` for its kind; every `failed`, `reverted` or `skipped` node has a `reason`
- [ ] Run file and tracker true after every result
- [ ] Write-back done, including open gates as open threads
- [ ] Services started by the mission are stopped, and `closed_at` is written
- [ ] The close-out reached the user in the order above
</acceptance-criteria>

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
