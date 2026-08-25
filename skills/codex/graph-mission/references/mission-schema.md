# Mission run file

Write a run file only for three or more nodes, any child-agent dispatch, or work likely to cross compaction/session boundaries.

Location: `.codex/graph-runs/<UTC-timestamp>.json`, where the timestamp is `YYYY-MM-DDTHH-MM-SSZ`.

```json
{
  "schema_version": 1,
  "objective": "One outcome",
  "success_signal": "Concrete check",
  "architecture": "chain",
  "non_goals": ["Adjacent work that remains untouched"],
  "authorization": {
    "allowed": ["local edits and local tests"],
    "requires_user": ["deploy", "push"]
  },
  "budget": {
    "max_children": 3,
    "max_rounds": 3,
    "on_exhaustion": "stop with verified partial result"
  },
  "recall": [
    {"fact": "Known workspace constraint", "source": "vault:page-id"}
  ],
  "steps": [
    {
      "id": "s1",
      "action": "Inspect the current integration",
      "owner": "main",
      "depends_on": [],
      "paths": ["path/to/file"],
      "permissions": ["read"],
      "success": "The active call path is identified with file evidence",
      "status": "pending",
      "artifact": null,
      "evidence": []
    }
  ],
  "claims": [
    {
      "id": "c1",
      "text": "The active path uses the new implementation",
      "source": "file:path/to/file#L42",
      "from_step": "s1"
    }
  ],
  "decisions": [],
  "open_threads": []
}
```

## Invariants

- Dependencies name real ids and form an acyclic graph.
- `verified` always has non-empty evidence.
- Concurrent writer nodes have disjoint `paths` or separate worktrees.
- Status is one of `pending`, `running`, `verified`, `failed`, `skipped`, `blocked`.
- Claims use the source vocabulary from `knowledge-loop.md`.
- The file is updated after each wave and remains valid JSON.

For resume discovery, prefer `rg --files .codex/graph-runs | sort | tail -n 1` over directory-wide scans. Read the file, reconcile it with current files and plan state, and continue from the verified dependency frontier.
