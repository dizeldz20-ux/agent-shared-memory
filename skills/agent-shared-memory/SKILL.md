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

When `brain_context.vault_pages` is non-empty, read the relevant vault page before editing.
`shared_memory` contains newer agent records that may not have reached the rebuilt graph yet.
If path resolution is ambiguous, retry with more path segments; never treat an ambiguous
empty result as proof that no prior knowledge exists.

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
- the current agent name.

Never store secrets, credentials, private raw transcripts, or unverified claims. The tool
writes an immediate append-only record and appends the session narrative to the Obsidian
daily note. A durable trap, architectural rule, or decision still deserves its own vault
page; the daily note is the narrative, not the canonical fact.

## Keep the graph true

Run `refresh.sh` (`refresh.ps1` on Windows) after structural code changes or new durable
vault pages. The live memory record is searchable immediately, while graph nodes are a
snapshot and become current only after refresh. A session-start warning older than three
days means the refresh automation is unhealthy.

The UI server is optional. MCP recall and write-back work offline without it; activity is
buffered under `~/.asm/pending.jsonl` until the server returns.

## Operational constraints

- Keep `~/.asm` on a local, non-cloud-synced path.
- Run the Python server through `uv run`; the supported Python version is 3.11+.
- Keep the MCP dependency on `mcp>=1.9,<2` until the FastMCP import is migrated.
- Do not extract vendored models, generated assets, or `node_modules`; use `.graphifyignore`.
