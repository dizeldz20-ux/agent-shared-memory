# Mission Brief Template

Two artifacts: the **brief** shown to the user, and the **run file** written to `.claude/graph-runs/{utc-timestamp}.json`.

Placeholder conventions: `{curly}` = interpolated value, `[square]` = prose you write.

## The Brief

Presented in the response, in the user's language. Identifiers and paths untouched.

```template
## Mission: {mission-name}

**Objective:** [one sentence, one outcome]
**Success signal:** [the concrete check — a command, a file, a rendered page, a sourced claim]
**Architecture level:** {level} — [one line on why this rung and not the one above]

### Non-goals
- [what this mission will not touch]
- [the refactor we are not doing "while we're here"]

### Already known (recall pack)
- [fact] — `{source}`
- [fact] — `{source}`

### Graph
1. `{id}` — [action] · depends on: {depends_on or "—"} · success: [criterion] · runs as: {role}
2. `{id}` — ...

### Budget
{max_subagents} subagents · {max_rounds} rounds · on exhaustion: [what happens]

### Blockers
[the decision that needs the user, or "none"]
```

## The Run File

```template
{
  "objective": "[one sentence]",
  "success_metric": "[the concrete check]",
  "level": "{chain|router|fan-out|orchestrator|dag|loop}",
  "non_goals": ["[what stays untouched]"],
  "budget": {"max_subagents": 4, "max_rounds": 3},
  "recall": [
    {"fact": "[what we already know]", "source": "brain:{node-id}"}
  ],
  "steps": [
    {
      "id": "s1",
      "action": "[imperative]",
      "role": "{Explore|general-purpose|code-reviewer|self}",
      "depends_on": [],
      "success": "[criterion concrete enough to fail]",
      "artifact": "{path or null}",
      "status": "pending",
      "evidence": null
    }
  ],
  "claims": [
    {"id": "c1", "text": "[assertion]", "source": "cmd:{command}", "from_step": "s1"}
  ]
}
```

## Field Documentation

| Field | Purpose | Rule |
|---|---|---|
| `objective` | The single outcome | One sentence. Two outcomes = two missions or two lanes |
| `success_metric` | How we know it worked | Machine- or human-checkable. Never a matter of taste without a rubric |
| `level` | Architecture level chosen | From the table in `frameworks/graph-engineering.md`. Cheapest that fits |
| `non_goals` | Scope fence | Non-empty. Derived from the prompt's silence, not just its words |
| `budget` | Limits set before dispatch | Defaults 4 subagents, 3 rounds |
| `recall` | What we already know | 3-8 entries, each with a source, gathered before decomposition |
| `steps[].id` | Stable reference | Short. Dependents cite ids, never prose |
| `steps[].role` | Which agent type runs it | From the dispatch table in `context/operating-environment.md`, or `self` for inline work |
| `steps[].depends_on` | Dependency edges | Real ids only. No cycles |
| `steps[].success` | The node's criterion | Concrete enough to fail. "Works correctly" is not a criterion |
| `steps[].artifact` | Path produced | `null` when the step produces no file |
| `steps[].status` | Lineage | `pending` → `kept` / `reverted` / `crash`. Terminal at close-out |
| `steps[].evidence` | Proof for `kept` | Command output, file path with line, or source. `kept` with `null` evidence is invalid |
| `claims[].source` | Evidence edge | One of `brain:` `memory:` `vault:` `file:` `cmd:`. No other form counts |

## Section Specifications

**Recall pack.** Gathered in the recall step, before the graph exists. Each bullet is a fact plus its source, and each one is copied into the subagent prompts that need it — that is the whole point, so no worker rediscovers what was already paid for.

**Graph list in the brief.** Ordered by dependency, not by importance. The user should be able to read it top to bottom and see the critical path.

**Status transitions.** Written after every wave, not once at the end. The run file is the resume point; if it is only true at close-out, it is useless exactly when it is needed.

**Timestamp.** `{utc-timestamp}` is `YYYY-MM-DDTHH-MM-SSZ` — filesystem-safe, sorts chronologically, so listing `.claude/graph-runs/` resumes the newest by reading the last line.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*
