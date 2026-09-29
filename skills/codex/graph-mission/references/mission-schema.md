# Mission run file

Every mission has one. It lets a later session, or this one after compaction, find the frontier from the file alone.

## Name and place

`.codex/graph-runs/<YYYY-MM-DDTHH-MM-SSZ>-<mission>.json`, in the working tree the mission edits, or in the session's working directory until that tree exists. Inside a git repository, first append `.codex/graph-runs/` to the file `git rev-parse --git-path info/exclude` prints; this works in linked worktrees too, where `.git` is a file. Never put a run file anywhere git tracks.

Codex's workspace-write sandbox keeps `.codex/` and `.git/` read-only, so these writes fail with "Operation not permitted". Ask once, with a one-line justification, for write access to the run directory and the exclude file for this session (an escalated or additional-permissions request, as the approval policy allows). If no request is possible, say so in the brief: lineage then lives only in the plan and commentary, and the mission cannot be resumed.

## Schema version 2

```json
{
  "schema_version": 2,
  "mission": "export-and-alerts",
  "resume_with": "~/.agents/skills/graph-mission/references/run.md",
  "created_at": "2026-01-01T09:00:00Z",
  "closed_at": null,
  "session_id": null,
  "worktree": "/path/to/tree",
  "branch": "mission/export-and-alerts",
  "base_commit": "abc1234",
  "objective": "One outcome",
  "success_metric": "Concrete check, one per lane when there are two",
  "level": "fan-out → reduce → verify",
  "authority": {"allowed": ["local edits", "local tests"], "needs_user": ["push"]},
  "non_goals": ["Adjacent work that stays untouched"],
  "budget": {"max_subagents": 3, "max_rounds": 3, "on_exhaustion": "stop with the verified partial result"},
  "recall": [{"fact": "Known workspace constraint", "source": "vault:page-id"}],
  "steps": [
    {
      "id": "s1", "kind": "build", "action": "Add the export endpoint",
      "role": "export-builder", "depends_on": [], "paths": ["src/export/"],
      "locks": ["test-runner"], "success": "The export test passes on the live path",
      "artifact": null, "status": "pending", "evidence": null, "reason": null, "rounds": 0,
      "dispatched_at": null, "dispatched_session": null, "agent_id": null, "branch": null
    }
  ],
  "claims": [{"id": "c1", "text": "The old route has no callers", "source": "cmd:rg -n oldExportRoute", "from_step": null}],
  "decisions": [{"decision": "Reuse the CSV writer", "source": "file:docs/spec.md#L12"}],
  "open_threads": []
}
```

A step that is an improvement loop also carries `"loop": {"metric": "target", "guardrails": ["cost", "latency", "existing tests"], "trials": []}`.

## Field rules

- `mission`: kebab-case slug, also the filename suffix. `resume_with`: where the instructions live, for a session that lost the skill to compaction.
- `created_at`, `closed_at`: UTC ISO time. `closed_at` stays `null` until close-out; resume skips closed files unless the user names one.
- `session_id`: the session id the ASM memory gate names — in Codex the thread id (`$CODEX_THREAD_ID`); a descriptive id only when the client runs no ASM hooks. `worktree`, `branch`, `base_commit`: `null` until the tree exists.
- `authority.needs_user`: every item is a `gate` step. `non_goals`: never empty. `budget.max_subagents`: child agents running at once, verifiers included; at most 3 in Codex. `recall`: up to 8 sourced facts.
- `steps[].kind`: one of the seven in [decomposition.md](decomposition.md). `role`: `main` for the primary agent, otherwise the role the child is spawned with. `paths`: write scope, empty for read-only nodes. `locks`: from decomposition.md. `success`: concrete enough to fail.
- `evidence`: required for `verified`. `reason`: required for `failed`, `reverted`, `skipped` and `blocked`; says why, and whether the node's changes are still in the tree. `rounds`: revise cycles, re-verification rounds or loop trials used so far.
- `dispatched_at`, `dispatched_session`: written just before the spawn. `agent_id`: the child's id or task path as the spawn returns it, written as soon as it does. `branch`: for a node on its own worktree, merged by a `reduce`.
- `claims[].from_step` is `null` for claims from compile time; `decisions[]` carry their source; `open_threads` are copied into the close-out and the `memory_record`.

## Statuses

`pending` → `running` → `verified`, `failed`, `reverted` or `skipped`; a gate, or a node waiting on an external dependency, is `blocked`. A revise round moves a `build` from `verified` back to `running`, and its `verify` back to `pending`.

- `pending`: never started, or waiting to verify again
- `running`: dispatched to a child, or in progress inline
- `verified`: evidence attached; for a `build`, "built as claimed", with correctness left to its `verify`. A Claude-edition run file calls this `kept`; it means the same
- `failed`: criterion disproved, a blocking evidence-gate item failed, `rounds` ran out, or its `verify` failed on defects in its work
- `reverted`: the mission removed only this node's own changes, first saving a failed node's changes as a patch
- `skipped`: no longer needed
- `blocked`: waiting on the user's word or an external dependency

`verified` and `skipped` satisfy a dependency.

## Legacy mapping

- **Codex version 1** (`schema_version` 1 or missing): give every step a `kind` and `locks` before anything else; `success_signal`, `architecture`, `owner` and `budget.max_children` become `success_metric`, `level`, `role` and `budget.max_subagents`; `authorization` becomes `authority`, with `requires_user` as `needs_user`; each step's `permissions` is dropped once any authority action in it is a `gate`; missing fields take their defaults (`rounds: 0`, the rest `null`).
- **Claude-edition files**, read only when the user names one: `kept` is `verified`, `role: self` is `role: main`, `max_subagents` above 3 is capped at 3, and an authority list named after a person becomes `needs_user`.
- **Older forms anywhere**: `crash` → `failed`; `reverted` in a Claude version 1 file → `failed` (it meant failed, changes left in place); `blocked-on-*` and `blocked_on` → `blocked`; `dispatched` → `running`; `nodes`, `recall_pack` and a top-level `success` → `steps`, `recall`, `success_metric`; unmapped fields such as `decisions_needed` → `open_threads`; older source prefixes as [knowledge-loop.md](knowledge-loop.md) maps them.
