# C2B — Claude Second Brain

One graph over everything you know: your **Obsidian knowledge vault** (the durable *why* — decisions, traps you already paid for, architecture notes) joined to the **code files of every project you map** — with live Claude Code activity flowing through it, an **offline MCP recall layer**, and a 3D brain-shaped visualization.

The point is not the picture. The point is that **recall happens before code is read**: every Claude Code session starts knowing the brain exists, every prompt is matched against it, and every file edit can be preceded by one call that returns both the code neighbourhood *and* the human knowledge attached to it.

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  Obsidian vault          │        │  Your code projects           │
│  (openclaw structure)    │        │  (any language)               │
│  okf/catalog.json        │        │  graphify extract --code-only │
│  okf/graph.json          │        │  → data/raw/<name>/graph.json │
└───────────┬─────────────┘        └───────────────┬──────────────┘
            │        knowledge pages               │  symbol graphs,
            │        + links + tags                │  collapsed to file level
            └──────────────┬───────────────────────┘
                           ▼
                     merge.py  →  data/brain.json  (+ brain.index.json)
                           │
       ┌───────────────────┼──────────────────────────┐
       ▼                   ▼                          ▼
 mcp_server.py       server.py :8930           Claude Code hooks
 (stdio MCP,         (FastAPI + WebSocket      SessionStart  → primer
  reads brain.json    + React frontend:        UserPromptSubmit → recall
  from disk —         3D brain / 2D network    PostToolUse  → live events
  works offline)      / cortical rings)        (buffered when server down)
```

## What you get

| Piece | What it does |
|---|---|
| `merge.py` | Merges vault knowledge pages + per-project code graphs into one `brain.json`. Code graphs are collapsed to file level; vault pages link to code by tags and path references (`xlayer` edges). |
| `mcp_server.py` | Stdio MCP server with 5 tools (`brain_context`, `brain_search`, `brain_neighbors`, `brain_path`, `brain_node`). Reads `brain.json` from disk — **fully usable with nothing else running**. |
| `hook/c2b-session-start.js` | SessionStart hook: injects a standing rule ("recall before you read") + graph stats + staleness warning into every session. |
| `hook/c2b-prompt-hook.js` | UserPromptSubmit hook: scores every prompt against the brain index and injects up to 5 relevant nodes. Hebrew-aware stemming; a noise gate requires two independent matches. |
| `hook/c2b-hook.js` | PostToolUse hook: streams every file Claude touches to the server; when the server is down, events buffer to `pending.jsonl` and drain on next start — no activity is lost. |
| `server.py` | Optional visualization/activity server on `:8930` — graph API, WebSocket fanout, persisted `events.jsonl` history. |
| `frontend/` | React + react-force-graph: anatomical 3D connectome, 2D network, and cortical-rings views. RTL, keyboard accessible, reduced-motion aware, with a sanitized demo mode. |
| `refresh.sh` / `refresh.ps1` | Re-extract → re-merge → atomically redeploy runtime copies → hot-reload the running server. Same steps on either platform; the `.sh` also rebuilds the vault's `okf/` bundle first. |
| `hook/c2b-session-doc.js` | Optional Stop hook: a session that **mutated files** may not end undocumented. Fires at most once per session, never blocks a read-only one, and stays silent until a vault is configured. |
| [`skills/`](skills/) | **The protocol layer** — `c2b-brain` (when to call which tool, how to read the result, how to keep the graph true) and `graph-mission` (compile a complex request into a typed mission graph with the brain as rung 0 of recall, an evidence gate, and a run file that survives compaction). |

## The recall protocol

The brain is **rung 0** of the recall ladder — above code-graph tools and grep — because one call returns the merged picture:

- About to touch a file? `brain_context(file_path)` → the matching node, its code neighbours, **the vault pages a human wrote about that file** (the traps, the decisions), and recent Claude access events.
- Starting a task on a topic? `brain_search(topic)` — finds the knowledge page and the code files in one shot, across all projects.
- Changing something shared? `brain_neighbors(node_id, depth)` — the blast radius.
- How do two things relate? `brain_path(a, b)` — the actual chain between them.

`brain_context`'s `vault_pages` field is the payload: a non-empty result means someone already paid for a lesson about this exact file. Read the page before editing.

## Requirements

- **Python 3.11+** and [uv](https://docs.astral.sh/uv/). Run everything through `uv run` — it provisions its own 3.11, which matters on macOS, where the system interpreter is 3.9 and `mcp_server.py` does not parse under it.
- **Node.js 24+** (the unit tests import TypeScript directly via type stripping)
- **[graphifyy](https://pypi.org/project/graphifyy/)** — `uv tool install graphifyy` (local tree-sitter AST extraction, no LLM, respects `.gitignore`)
- **[Claude Code](https://claude.com/claude-code)** — the hooks and MCP registration target its config
- **An Obsidian vault** for the knowledge layer — the vault **is the memory layer of the brain**. It must carry an `okf/` bundle (a machine-readable catalog of your pages). The expected structure and the exact JSON contract are documented in [docs/vault-structure.md](docs/vault-structure.md). No vault? Set `"vault": null` in `sources.json` and you get a code-only brain — but the knowledge layer is the half that makes recall worth it.
- **macOS / Linux / Windows.** The refresh and start scripts ship twice — `refresh.sh` + `start-c2b.sh` (bash) and `refresh.ps1` + `start-c2b.ps1` (PowerShell). Everything else (Python, Node, hooks) is cross-platform. Use whichever pair matches your shell; the two do the same work in the same order.

## Quick start

**1. Configure your sources.** Copy `sources.example.json` → `sources.json`, point it at your vault and projects, name your layers.

**2. Extract + merge:**

```bash
uv tool install graphifyy
./refresh.sh         # graphify extract per source → merge.py → deploy to ~/.claude/c2b
```

```powershell
uv tool install graphifyy
./refresh.ps1        # same, on Windows
```

Projects without a git repo need a `.graphifyignore` (like this repo's) so `node_modules`/build output stay out of the graph.

**3. Register the MCP server** (user scope, so it works in every project):

```
claude mcp add --scope user c2b -- uv run --directory <home>/.claude/c2b python mcp_server.py
```

**4. Wire the hooks** into `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"<home>/.claude/hooks/c2b-session-start.js\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<home>/.claude/hooks/c2b-prompt-hook.js\"" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node \"<home>/.claude/hooks/c2b-hook.js\"", "async": true }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<home>/.claude/hooks/c2b-session-doc.js\"" }] }]
  },
  "permissions": { "allow": ["mcp__c2b__*"] }
}
```

The `mcp__c2b__*` allow rule matters: without it every brain call prompts for permission, which silently kills adoption.

**5. (Optional) run the visualization:**

```bash
cd frontend && npm ci && npm run build && cd ..
uv run uvicorn server:app --port 8930    # serves the built UI + live activity
```

Or `./start-c2b.sh` (`./start-c2b.ps1` on Windows), which does the same with the PATH set up for a scheduler.

**6. Keep it fresh.** Re-run the refresh after structural code changes, or schedule it — a nightly job (launchd/cron/Task Scheduler) or a debounced wrapper fired from a Stop hook. Give a scheduled job an explicit `PATH`: launchd and cron hand it almost none, which is why the scripts prepend the uv and graphify bin directories themselves. The SessionStart primer warns every session when `brain.json` goes stale — a stale node is worse than no node.

**7. (Optional) the documentation gate.** `hook/c2b-session-doc.js` as a `Stop` hook blocks a file-mutating session from ending until it has written the day's log into the vault. It reads the vault path from `~/.claude/c2b/c2b-paths.json`, which the refresh writes for you (`C2B_VAULT` / `C2B_REPO` override it). Until then it stays silent rather than guessing at a vault — a hook that invents a path builds a fake vault instead of failing.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `brain_context` | `file_path` | node + code neighbours + linked vault pages + recent access. **Call before touching a file.** |
| `brain_search` | `query` | up to 20 nodes matching name/path/tag/description |
| `brain_neighbors` | `node_id`, `depth` | BFS neighbourhood (≤50), including cross-layer edges |
| `brain_path` | `from_id`, `to_id` | shortest path between two nodes |
| `brain_node` | `node_id` | full node record + degree |

Node ids are namespaced: `vault:<page-id>` for knowledge, `<layer>:<path>` for code.

## Offline by design

- The MCP reads `brain.json` from disk at startup; the `:8930` server only enriches `recent_access`, with a fallback to the persisted `events.jsonl`.
- The PostToolUse hook buffers events to `pending.jsonl` (2 MB cap, newest-half kept on overflow) whenever the server is down; the server drains the buffer on start, deduplicating replays.
- A corrupt `brain.json` never blocks the activity pipeline: the server boots with an empty graph and a loud message, because recording activity is the part that cannot be recovered later.

The hardening behind these guarantees (atomic drains, replay dedup, ambiguous-path refusal, and more) is documented in [docs/implementation-notes.md](docs/implementation-notes.md).

## Demo mode

`npm run demo:data` regenerates `frontend/public/demo/` from your real `data/brain.json` through a sanitizer that strips every identity: node ids become `n0…n`, labels become generic, paths and descriptions are dropped — a unit test proves no private string survives. `npm run build:preview` + `vite preview` then serves the full visualization with zero API calls, safe to show anyone. This repo ships with a pre-built demo dataset (~1.6k nodes).

## Tests

```bash
cd frontend
npm run test:unit    # node:test over the layout/sprite/frame/sanitizer logic
npm run test:e2e     # vite preview + Chrome: views, a11y contract, framing, reduced motion
```

## License

[MIT](LICENSE)
