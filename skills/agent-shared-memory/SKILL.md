---
name: agent-shared-memory
description: Use ASM, the offline shared memory for Claude, Codex, and other coding agents. Consult it before planning, reading, or editing mapped projects; use it for cross-project recall and blast-radius checks; record concrete outcomes after changing files.
---

# ASM — Agent Shared Memory

ASM joins the Obsidian knowledge vault, mapped source trees, recent file activity, and
immediate work records in one local MCP. Every configured agent reads and writes the same
runtime at `~/.asm`.

## Recall before code

Use ASM as rung 0, before repository search or the first file read:

| Need | Tool |
|---|---|
| Start work on a subject | `brain_search(query)` |
| Read or change a file | `brain_context(file_path)` |
| Estimate a shared change's blast radius | `brain_neighbors(node_id, depth)` |
| Understand how two nodes relate | `brain_path(from_id, to_id)` |
| Inspect a graph or memory node | `brain_node(node_id)` |
| Recover the latest agent handoff | `memory_recent(limit, query)` |

The prompt hook already lists matching nodes on every prompt (and will not repeat one it
listed in the last six prompts of this session). When `brain_context.vault_pages` is
non-empty, read the relevant vault page before editing.
`shared_memory` contains newer agent records that may not have reached the rebuilt graph yet.
If path resolution is ambiguous, retry with more path segments; never treat an ambiguous
empty result as proof that no prior knowledge exists.
When `brain_context` returns `main_checkout_behind`, the code map for your worktree comes from a
main checkout that many commits lack: files added since are missing from it and neighbours may be
old. Read the file itself for its current content, and trust vault pages over the code map.

Tool names are normally exposed as `mcp__asm__<tool>` by Claude and as ASM MCP tools by
Codex. Use the callable name visible in the current client.

## Record after change

After a session changes files, call `memory_record` before finishing. Include:

- the exact session id supplied by the memory gate;
- a summary naming what actually changed;
- details covering verified behavior and tests;
- affected files;
- decisions and why they were made;
- unresolved work for the next agent;
- the current agent name;
- `supersedes`: ids of earlier records this one corrects or closes, so they leave recall;
- `resolves`: what this work finished — a thread id `<record-id>#<n>` (the session-start banner
  and `memory_recent` print them), a record id to close all its threads, or `vault:<id>` for a
  plan page that is now done. Closed threads stop surfacing in recall;
- `corrects`: stale claims you found, as `{"target": "vault:<id>" | "mem:<file>" |
  "idx:<index>:<file>", "claimed": <the exact stale text>, "truth": ..., "evidence": [...]}`.
  The curator proposes the fix; copy `claimed` verbatim, and do not also edit that line yourself.

Never store secrets, credentials, private raw transcripts, or unverified claims. The tool
writes an immediate append-only record and appends the session narrative to the Obsidian
daily note. A durable trap, architectural rule, or decision still deserves its own vault
page; the daily note is the narrative, not the canonical fact.

## Keep the graph true

Run `refresh.sh --changed` (on Windows: `npm.cmd --prefix jobs run asm:refresh -- --changed`) after structural code changes or new
durable vault pages; it re-extracts only the sources that changed. The live memory record is searchable immediately, while graph nodes are a
snapshot and become current only after refresh. A session-start warning older than three
days means the refresh automation is unhealthy.

Two background jobs start from the session-start hook once a day: the janitor closes finished
threads and archives stale session files, and the curator keeps each project page's current-state
block and the memory index true. Content changes they are not yet trusted with wait as
proposals: when the banner says proposals wait, the `asm-review` skill walks the owner through
them. Never apply a proposal the owner did not choose.

The UI server is optional. MCP recall and write-back work offline without it; activity is
buffered under `~/.asm/pending.jsonl` until the server returns.

## Operational constraints

- Keep `~/.asm` on a local, non-cloud-synced path.
- Run the Python server through `uv run`; the supported Python version is 3.11+.
- Keep the MCP dependency on `mcp>=1.9,<2` until the FastMCP import is migrated.
- Do not extract vendored models, generated assets, or `node_modules`; use `.graphifyignore`.
