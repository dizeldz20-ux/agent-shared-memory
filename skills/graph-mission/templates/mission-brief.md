# Mission Brief Template

Two artifacts: the **brief** shown to the user in their language, and the **run file** at `.claude/graph-runs/{utc-timestamp}-{mission-slug}.json`.

**Purpose:** every mission states its contract the same way, and any later session can resume it from the file alone.

Placeholder conventions: `{curly}` = interpolated value, `[square]` = prose you write.

## The Brief

Presented in the response, in the user's language; identifiers, paths and commands in backticks; at most 5 items per group, with a line pointing to the run file for the rest.

```template
**Now:** [what the user does now — the blocking question; in compile mode "say `/graph-mission run`, or `resume` in another session"; otherwise "nothing, it is running"]

## Mission: {mission-name}

**Objective:** [one sentence, one outcome]
**Success signal:** [the concrete check — one per lane when there are two]
**Architecture level:** `{level}` — [one line on why this rung and not the one above]
**Authority:** [what runs without asking] · waits for the user: [each gated action, or "nothing"]

### Non-goals
- [what this mission will not touch]
- [the refactor we are not doing "while we're here"]

### Already known
- [fact] — `{source}`

### Graph by wave
**Wave 1**
1. `{id}` (`{kind}`) — [action] · success: [criterion] · runs as: `{role}`
2. `{id}` (`{kind}`) — [action] · success: [criterion] · runs as: `{role}` · locks: `{locks}`

**Wave 2**
3. `{id}` (`{kind}`) — [action] · depends on: `{depends-on}` · success: [criterion] · runs as: `{role}`

### Budget
{max-subagents} subagents at once · {max-rounds} rounds per node · on exhaustion: [what happens]

### Blockers
[each gate and the decision it waits for, or "none"]
```

### Brief Fields

| Field | Type | Required | Purpose | Example |
|---|---|---|---|---|
| `[Now]` | prose | Yes | The one thing the user does now | `answer the scope question under Blockers` |
| `{mission-name}` | variable | Yes | Short name | `API stability pass` |
| `[Objective]` | prose | Yes | The single outcome | `seven stability items closed on one branch` |
| `[Success signal]` | prose | Yes | The check that proves it | `the project's verify script exits 0 on the integrated branch` |
| `{level}` | variable | Yes | Level or composite | `fan-out → reduce → verify` |
| `[Authority]` | prose | Yes | What runs alone vs what waits | `local edits and tests · waits for the user: deploy` |
| `{source}` | variable | Yes | Evidence edge per fact | `vault:api-deploy-gotchas` |
| `{id}` `{kind}` `{role}` `{locks}` `{depends-on}` | variable | Yes | Copied from the run file | `s1` (`recon`) … runs as: `Explore` |
| `{max-subagents}` `{max-rounds}` | variable | Yes | Budget | `4`, `3` |

## The Run File

```template
{
  "schema_version": 2,
  "mission": "{mission-slug}",
  "resume_with": "~/.claude/skills/graph-mission/tasks/run-mission.md",
  "created_at": "{utc-iso-timestamp}",
  "closed_at": null,
  "session_id": "{session-id}",
  "worktree": "{worktree-path}",
  "branch": "{branch}",
  "base_commit": "{sha}",
  "objective": "[one sentence]",
  "success_metric": "[the concrete check — one per lane when there are two]",
  "level": "{level}",
  "authority": {"allowed": ["[local edits, local tests]"], "needs_user": ["[deploy]"]},
  "non_goals": ["[what stays untouched]"],
  "budget": {"max_subagents": 4, "max_rounds": 3, "on_exhaustion": "[stop with the verified partial result]"},
  "recall": [
    {"fact": "[what we already know]", "source": "asm:{node-id}"}
  ],
  "steps": [
    {
      "id": "s1",
      "kind": "{kind}",
      "action": "[imperative outcome]",
      "role": "{role}",
      "depends_on": [],
      "paths": [],
      "locks": [],
      "success": "[criterion concrete enough to fail]",
      "artifact": null,
      "status": "pending",
      "evidence": null,
      "reason": null,
      "rounds": 0,
      "dispatched_at": null,
      "dispatched_session": null,
      "agent_id": null,
      "branch": null
    }
  ],
  "claims": [
    {"id": "c1", "text": "[assertion]", "source": "cmd:{command}", "from_step": null}
  ],
  "decisions": [
    {"decision": "[what was decided]", "source": "{source}"}
  ],
  "open_threads": []
}
```

A step that is an improvement loop also carries `"loop": {"metric": "[target]", "guardrails": ["[cost, latency, existing tests]"], "trials": []}`.

## Source Vocabulary

| Prefix | Points at | Use for |
|---|---|---|
| `asm:<node-id>` | A brain node, by its full id — `asm:vault:api-deploy-gotchas`, `asm:memory:<id>` | What the graph asserts: descriptions, blast radius, paths between nodes. Not yet read |
| `record:<id>` | An ASM record you read, id without the `memory:` prefix; `record:<id>#<n>` for one of its threads, if your ASM version numbers threads | Recent handoffs — a status snapshot until re-checked |
| `memory:<file>` | An agent memory file or project hub | Rules and project memory — dated |
| `vault:<page-id>` | A vault page whose body you read | Canonical decisions and gotchas |
| `file:<path>#L<n>` | Current source | What the code does now |
| `cmd:<command>` | Observed output | What is true now: tests, hosts, git |
| `url:<url>` | An authoritative external source | Facts from outside the machine |

No other form counts. A fact with a historical and a live source joins them with ` + `. A claim with no source is a guess.

## Field Documentation

The JSON above is the example for every field.

| Field | Type | Required | Rule |
|---|---|---|---|
| `schema_version` | number | Yes | `2`. A file without it is version 1 — read it with the legacy mapping |
| `mission` | string | Yes | Kebab-case slug; also the filename suffix |
| `resume_with` | string | Yes | Where the instructions live, for a session that lost the skill to compaction |
| `created_at`, `closed_at` | string | Yes | ISO time; `closed_at` stays `null` until close-out, and resume skips closed files |
| `session_id` | string | Yes | `null` when unknown |
| `worktree`, `branch`, `base_commit` | string | Yes | `null` until the tree exists; how resume matches a file is in `tasks/run-mission.md` |
| `objective` | string | Yes | One sentence |
| `success_metric` | string | Yes | Checkable; never taste without a rubric |
| `level` | string | Yes | From `frameworks/graph-engineering.md`; composites allowed |
| `authority` | object | Yes | Every `needs_user` item is a `gate` step |
| `non_goals` | array | Yes | Non-empty; derived from the prompt's silence, not just its words |
| `budget.max_subagents` | number | Yes | Subagents running at once, verifiers included — a rate limit, not a total. Default 4 |
| `budget.max_rounds` | number | Yes | The most `rounds` any one step may use. Waves are not budgeted. Default 3 |
| `budget.on_exhaustion` | string | Yes | What happens when a step's rounds run out |
| `recall` | array | Yes | Up to 8 facts, each sourced, each changing the graph |
| `steps[].id` | string | Yes | Short; dependents cite ids, never prose |
| `steps[].kind` | string | Yes | One of the seven in `frameworks/decomposition.md` |
| `steps[].action` | string | Yes | Imperative, one outcome |
| `steps[].role` | string | Yes | From the dispatch table, or `self` |
| `steps[].depends_on` | array | Yes | Real ids only; no cycles |
| `steps[].paths` | array | Yes | Write scope; empty for read-only nodes |
| `steps[].locks` | array | Yes | From the lock list in `frameworks/decomposition.md` |
| `steps[].success` | string | Yes | Concrete enough to fail. "Works correctly" is not a criterion |
| `steps[].artifact` | string | No | Path produced; `null` when none |
| `steps[].status` | string | Yes | See Statuses |
| `steps[].evidence` | string or array | For `kept` | Command output, file and line, or source |
| `steps[].reason` | string | For `failed`, `reverted`, `skipped`, `blocked` | Why, and whether the node's changes are still in the tree |
| `steps[].rounds` | number | Yes | Revise cycles, re-verification rounds or loop trials used so far |
| `steps[].dispatched_at`, `dispatched_session` | string | When dispatched | Written just before the `Agent` call |
| `steps[].agent_id` | string | When dispatched | Written as soon as the call returns |
| `steps[].branch` | string | For isolated nodes | Merged by a `reduce` node |
| `steps[].loop` | object | For loops | Metric, guardrails, trials |
| `claims[]` | array | Yes | `id`, `text`, `source`, `from_step` (`null` for claims collected while compiling) |
| `decisions[]` | array | Yes | What was decided, and from which source |
| `open_threads` | array | Yes | Copied into the close-out and the `memory_record` |

## Statuses

`pending` → `running` → `kept`, `failed`, `reverted` or `skipped`. A gate, or a node waiting on an external dependency, is `blocked`. A revise round moves a `build` from `kept` back to `running`, and its `verify` back to `pending`.

- `pending` — never started, or waiting to verify again
- `running` — dispatched, or in progress inline
- `kept` — verified, evidence attached; for a `build`, "built as claimed", with correctness left to its `verify`
- `failed` — criterion disproved, a blocking checklist item failed, `rounds` ran out, or its `verify` failed on defects in its work
- `reverted` — the mission removed only this node's own changes, saving them as a patch when the node had failed
- `skipped` — no longer needed
- `blocked` — waiting on the user's word or an external dependency

`kept` and `skipped` satisfy a dependency.

**Legacy mapping (version 1 and ad-hoc files):**
- `crash` → `failed`
- version 1 `reverted` → `failed` — it meant "failed the gate", with changes left in place
- `blocked_on` and any `blocked-on-…` status → `blocked`
- `dispatched` → `running`
- `nodes`, `recall_pack`, `architecture` and top-level `success` → `steps`, `recall`, `level` and `success_metric`
- the `brain:` source prefix → `asm:`
- fields with no mapping, such as `decisions_needed` → `open_threads`

## Section Specifications

**Now.** Quality check: the user can act on this line without reading the rest.

**Recall pack.** Collected before the graph exists; copied into the subagent prompts that need it. Quality check: delete a fact and ask whether the graph would change — if not, it did not belong.

**Authority line.** Quality check: every action from the environment doc's Authority section that appears in the graph is on the "waits for the user" side, and is a `gate` step.

**Graph list.** Grouped by wave, ordered by dependency within a wave. Quality check: the user can read it top to bottom and see the critical path and every gate.

**Run file.** Updated after every result. Quality check: a fresh session reading only the file knows the frontier.

**File name and place.** `{utc-timestamp}` is `YYYY-MM-DDTHH-MM-SSZ`, followed by `-{mission-slug}`: filesystem-safe, sorted by time, and naming the mission. Quality check: inside a git repository, `.claude/graph-runs/` is listed in the file `git rev-parse --git-path info/exclude` prints before the first write.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
