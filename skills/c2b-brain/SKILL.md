---
name: c2b-brain
description: Use the C2B second brain — the unified graph of your Obsidian vault plus the code of every mapped project. Consult it BEFORE reading, editing, or planning work on any file in those projects, and before answering "where is X", "what breaks if I change Y", "what do we know about Z". Triggers on brain_context / brain_search / second brain / C2B / "what do we know about", and whenever a session-start primer or prompt-recall block mentions the brain. Also covers refreshing the brain after code changes and writing new knowledge back into it.
---

# C2B — the second brain

One graph over everything you know: vault knowledge pages (the durable *why*, including
every trap already paid for) joined to the code files of every mapped project. Query it
before you look at code, not after you broke something.

Runtime: `~/.claude/c2b/`. Source project: wherever you cloned this repo.

## The rule

**Recall from the brain before the first Read of a work item, not after.**

The brain is rung 0 of the recall order — it sits *above* any code-graph tool and grep,
because one call returns both the code neighbourhood and the human knowledge attached to
it. It costs one tool call. Skipping it is how a session rediscovers a trap the vault
already recorded.

## Which tool, when

| You are about to… | Call | Why |
|---|---|---|
| touch a specific file (read, edit, debug) | `brain_context(file_path)` | vault pages about that file (**the traps**), its code neighbours, recent access |
| start a task on a topic | `brain_search(query)` | finds the vault page and the code files in one shot, across all projects |
| change something shared | `brain_neighbors(node_id, depth)` | blast radius — who else is wired to it |
| ask how two things relate | `brain_path(a, b)` | the actual chain between them |
| inspect one node | `brain_node(node_id)` | full record |

Node ids are namespaced: `vault:<page-id>` for knowledge, `<layer>:<path>` for code, where
the layer names are the ones you defined in `sources.json`.

`brain_context` is the one that matters. Its `vault_pages` field is the payload: those are
pages a human wrote about *this file* — a bug pattern, a deploy gotcha, a decision. Read
the page before editing when one comes back.

## Reading the result

- `vault_pages` non-empty → **read the page before you edit.** It exists because something
  bit someone there.
- `recent_access` → what was touched lately (survives restarts; see below).
- Empty result → the file is not mapped, or the path was too ambiguous to resolve. Pass more
  path segments (`src/pkg/file.py`, not `file.py`), then fall back to grep. Do not assume
  "nothing known" means "nothing to know" — check the vault index too.

## It works with the server down

The MCP reads `brain.json` from disk. The visualization server on 8930 is optional — it only
adds `recent_access`, and when it is down the MCP falls back to the persisted event log. So
the brain is fully usable with nothing running and nobody watching.

Hook events are buffered to `~/.claude/c2b/pending.jsonl` while the server is down and drained
into history on next start — no activity is ever lost.

## Keeping it true

The brain is a snapshot; a stale node is worse than no node.

- Code changed structurally (files added, renamed, deleted) → run `refresh.ps1`, or the
  debounced wrapper if you installed one.
- The SessionStart primer flags a brain older than 3 days. With a daily refresh that means
  the automation broke — check its log before trusting anything the brain says.
- Knowledge learned (a bug pattern, a setup detail, an architecture decision, a gotcha) →
  write the vault page **in the same session**. That page becomes a brain node on the next
  refresh, so tomorrow's session inherits today's lesson.
- When a new page revises an older one, record the superseded page id in `contradictions`
  instead of overwriting it silently.
- A node's path no longer exists → the brain is stale. Refresh before trusting it.

## Traps

- **`mcp>=1.9,<2`** — SDK 2.0 removed `mcp.server.fastmcp`; the MCP dies on start with 2.x.
- **`mcp__c2b__*` must be in `permissions.allow`** — otherwise every brain call prompts for
  permission and the brain silently stops being used. Only a live headless run surfaces this.
- **Keep the runtime directory on a plain local path.** Cloud-synced folders interfere with
  concurrent appends and file watching, and a non-ASCII path breaks hook/MCP registration
  quoting on some shells.
- **`graphify extract` needs `--code-only`**, plus a `.graphifyignore` in any project without
  a git repo — otherwise it indexes `node_modules`.
- **Never run the extractor on a tree with a vendored model or asset directory.** One 30k-file
  subdirectory turns a two-minute extract into an hour.
- **Do not wrap the refresh in a PowerShell `*>>` redirect.** Extractors print progress to
  stderr; PowerShell 5.1 wraps redirected native stderr into ErrorRecords, and with
  `$ErrorActionPreference = 'Stop'` the run dies on a *success* message. Redirect at the
  `cmd /c` level instead.
