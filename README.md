# ASM — Agent Shared Memory

ASM gives local coding agents one shared, offline memory. It combines mapped source-code graphs, an optional Obsidian knowledge layer, and append-only implementation records behind one local Model Context Protocol (MCP) server.

Claude Code, Codex, Cursor, Kimi Code, Grok Build, Gemini CLI, and any other local stdio MCP host can query the same graph and write back to the same memory. The 3D interface is optional; recall and write-back continue to work when it is closed.

## Why ASM

ASM keeps three useful forms of memory together:

1. **Immediate work memory** — structured records are appended to `~/.asm/memory.jsonl` as soon as an agent documents a completed change.
2. **Durable human memory** — when an Obsidian vault is configured, the same record is appended to `wiki/main/daily/YYYY-MM-DD.md`.
3. **Queryable context graph** — `brain.json` joins files, dependencies, skills, infrastructure, vault concepts, and recent agent work.

The operating rule is simple: recall before reading or editing, inspect the current files, then record concrete outcomes after changing them. ASM is context, not a replacement for source control or verification.

## Architecture

```text
configured projects ──> Graphify ──┐
                                   ├──> merge.py ──> brain.json ──> local stdio MCP
optional Obsidian OKF graph ───────┘                         ├────> lifecycle hooks
                                                           └────> optional local UI
agent memory_record calls ──> memory.jsonl + optional Obsidian daily note
```

No hosted database or cloud memory service is required. The MCP server communicates over stdio and the optional UI binds to loopback by default.

## Agent support

| Agent host | Shared MCP | Shared skill | Native live activity | Installer target |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | user-scoped MCP and `~/.claude/settings.json` hooks, plus the skill router on `SessionStart`, `UserPromptSubmit`, and `PreToolUse` |
| Codex | Yes | Yes | Yes | user-scoped MCP and `~/.codex/hooks.json` |
| Cursor | Yes | Yes | Yes | `~/.cursor/mcp.json` and native user hooks |
| Kimi Code | Yes | Yes | Yes | `~/.kimi-code/mcp.json` and managed TOML hooks |
| Grok Build | Yes | Yes | Yes | native `grok mcp` registration plus `~/.grok/hooks/asm.json` for `PreToolUse`, `PostToolUse`, and `Stop` |
| Gemini CLI | Yes | Client-dependent | Not installed automatically | `~/.gemini/settings.json` |
| Other stdio MCP hosts | Yes | If the host supports Agent Skills | If the host can invoke JSON lifecycle hooks | portable config at `~/.asm/client-configs/mcp.json` |

Grok, Kimi, Claude, and other names can describe either a model or an agent host. A model selected inside Cursor uses Cursor's local MCP and hook environment. A raw model API cannot launch a process on your computer; it needs an MCP-capable host or adapter.

Grok Build's native hooks provide live file activity and the one-retry stop gate. Its `SessionStart` and `UserPromptSubmit` hooks are passive: they can observe events but cannot inject context into the active prompt. Grok therefore receives the recall protocol through the ASM MCP server instructions and the shared skill, not through lifecycle context injection.

## Requirements

- macOS, Linux or Windows 10/11
- Python 3.11 or newer
- [`uv`](https://docs.astral.sh/uv/)
- Graphify: `uv tool install graphifyy`
- Node.js 22 or newer (the refresh, the installer, the hooks and the background jobs); Node.js 24 for the complete frontend build and test workflow
- At least one local MCP-capable coding agent
- Optional: an Obsidian vault with the [documented OKF structure](docs/vault-structure.md). Copy `tools/okf-build.mjs` into `<vault>/okf/` once; every refresh then rebuilds the vault's catalog with it

## Quick start

```bash
git clone https://github.com/dizeldz20-ux/agent-shared-memory.git
cd agent-shared-memory

cp sources.example.json sources.json
# Edit sources.json: add projects and set vault to null for code-only mode.

uv tool install graphifyy

cd frontend
npm ci
npm run build
cd ..

chmod +x refresh.sh start-asm.sh install-agent-integrations.sh
./install-agent-integrations.sh
```

On Windows, in PowerShell or cmd:

```powershell
git clone https://github.com/dizeldz20-ux/agent-shared-memory.git
cd agent-shared-memory

copy sources.example.json sources.json
# Edit sources.json: add projects and set vault to null for code-only mode.

uv tool install graphifyy
npm.cmd --prefix jobs ci
npm.cmd --prefix jobs run asm:install
```

Type `npm.cmd`, not `npm`: in PowerShell a bare `npm` runs `npm.ps1`, which Windows' default execution policy refuses to run. The refresh and the installer are one TypeScript implementation (`jobs/src/refresh`, `jobs/src/install`) on every platform; `refresh.sh`, `refresh.ps1` and `install-agent-integrations.sh` only build `jobs/` and hand it their arguments.

The installer:

- rebuilds the graph and deploys the runtime to `~/.asm`;
- installs one portable `agent-shared-memory` skill under `~/.agents/skills` for compatible agents and retains only Claude Code's client-specific compatibility copy;
- registers the same `asm` stdio MCP command with installed native CLIs;
- safely merges MCP entries for Gemini CLI, Cursor, current Kimi Code, and legacy Kimi CLI, with native lifecycle hooks for Cursor and current Kimi Code;
- configures Grok Build's native global activity and stop hooks without claiming unsupported session or prompt context injection;
- writes a portable MCP configuration to `~/.asm/client-configs/mcp.json`;
- preserves unrelated settings and refuses to overwrite malformed JSON.

Restart open agent sessions after installation. Review the local hook command once in clients that expose a hook-trust screen.

### Configure mapped sources

`sources.json` is deliberately ignored by Git because it contains machine-specific paths. Add explicit sources, auto-discover sibling project directories, or combine both:

```json
{
  "vault": null,
  "layers": { "agents": "Projects", "asm": "ASM" },
  "sources": [
    { "layer": "asm", "raw": "asm-self", "base": ".", "prefix": "" }
  ],
  "discoverSources": [
    {
      "root": "../projects",
      "defaultLayer": "agents",
      "exclude": ["archive"]
    }
  ]
}
```

Discovery is deterministic, explicit entries win, and one missing source does not prevent the remaining sources from being merged.

## Shared agent protocol

Every integrated agent receives the same contract through the shared skill, server instructions, or both:

1. Call `brain_search` before planning work in a mapped domain.
2. Call `brain_context` before the first read or edit of a mapped target file.
3. Use `brain_neighbors` when a change may affect several components.
4. Inspect and verify the current code normally.
5. After changing files, call `memory_record` with the result, affected files, decisions, verification, and open threads.
6. Never store credentials, private keys, tokens, raw transcripts, or secret-bearing tool output.

Clients with an installed `Stop` hook also get a one-retry memory gate: a session with a recognized editor, delete, or conservative file-mutating shell operation is prompted once to write its handoff before stopping. Read-only tools and recognized read-only shell commands are not blocked, and a missing MCP server cannot create an infinite loop. This is a workflow guardrail, not a complete operating-system audit. Passive lifecycle events are not treated as context injection.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `brain_search(query)` | Search graph nodes and immediate shared memories. |
| `brain_node(node_id)` | Inspect one graph node or `memory:<id>` record. |
| `brain_context(path)` | Get dependencies, related vault pages, and recent memory for a file. |
| `brain_neighbors(node_id, depth)` | Traverse a bounded blast-radius neighborhood. |
| `brain_path(from_id, to_id)` | Find the shortest relationship path between two nodes. |
| `memory_recent(limit, query)` | Read recent cross-agent implementation records. |
| `memory_record(...)` | Append a structured handoff to local memory and, when configured, the vault. `supersedes=[ids]` retires earlier records from recall; credentials and card numbers are redacted mechanically. |

For a client not handled by the installer, copy the `asm` entry from `~/.asm/client-configs/mcp.json`. The portable shape is:

```json
{
  "mcpServers": {
    "asm": {
      "command": "/absolute/path/to/uv",
      "args": [
        "run",
        "--directory",
        "/absolute/path/to/.asm",
        "python",
        "mcp_server.py"
      ]
    }
  }
}
```

## Refresh the brain

```bash
./refresh.sh            # every source
./refresh.sh --changed  # only sources with files newer than their last extract
./refresh.sh --brain-only  # the graph files only, no code
```

On Windows: `npm.cmd --prefix jobs run asm:refresh -- --changed`, or `.\refresh.ps1 --changed` where PowerShell scripts may run.

The refresh rebuilds the optional vault OKF graph, extracts each code source independently, merges the graph, atomically deploys runtime files, and hot-reloads the UI only if it is already running. It does not start the UI. `--changed` makes a refresh cheap enough to run after every real change instead of once a week.

The daily background job runs the same refresh with `--changed --brain-only`, from the deployed runtime, so it never ships code from a checkout that is being edited.

## Optional live UI

```bash
./start-asm.sh
```

Open `http://127.0.0.1:8930`. Connectome provides the interactive 3D neural view; Map and Cortex are 2D projections of the same graph and live routes. File-access activity is buffered locally while the UI is closed and replayed when it starts again.

The server expects a production frontend in `frontend/dist`. Build it with `npm run build`. To refresh the tracked, sanitized public demo separately, run `npm run demo:data`; the normal brain refresh does not rewrite demo assets.

## Runtime layout

```text
~/.asm/
├── brain.json
├── brain.index.json
├── brain.pages.json     # vault page bodies as stemmed word sets — the searchable text
├── asm_text.py          # the one tokenizer mcp_server.py and merge.py share
├── memory.jsonl
├── usage.jsonl          # node opens (brain_node / brain_context) — recall feedback
├── skill-map.json       # derived skill routing map (rebuilt from every installed SKILL.md)
├── skill-map.overrides.json  # your curated routing rules (private; seeded from hook/skill-map.overrides.example.json)
├── skill-usage.jsonl    # skill hints and loads — routing precision feedback
├── events.jsonl
├── pending.jsonl
├── sessions/            # per-session mutation markers, recall ledgers, and skill state (<id>.skills.json)
├── asm-paths.json
├── mcp_server.py
├── client-configs/
│   └── mcp.json
└── hooks/
    ├── asm-session-start.js
    ├── asm-prompt-recall.js
    ├── asm-activity-hook.js
    ├── asm-memory-gate.js
    └── asm-skill-router.js   # Claude Code only: SKILL.state-style skill routing (see docs/implementation-notes.md)
```

## Privacy and security

- Keep `sources.json`, generated runtime data, credentials, and local event logs out of Git.
- `brain.json` contains graph metadata and local file paths. Obsidian note bodies are not copied into it, but `brain.pages.json` beside it holds every vault page body reduced to a stemmed word set — recoverable vocabulary, not readable prose, and still local-only. The graph belongs on the local machine unless deliberately sanitized.
- Live activity records agent name, tool name, phase, and file paths. It does not send prompts, source contents, tool inputs, or tool output to the UI event stream.
- The optional Codex rollout fallback derives tool names and paths without publishing prompt text or command output. Disable it with `ASM_CODEX_ROLLOUT_FALLBACK=0`.
- Keep the UI bound to `127.0.0.1`; do not expose the local runtime through a public tunnel without adding authentication and reviewing the data boundary.
- Treat all text passed to `memory_record` as durable. Review it before recording and never include secrets.

## Development checks

```bash
uv run python -m unittest discover -s tests
bash -n refresh.sh install-agent-integrations.sh start-asm.sh
npm --prefix jobs ci
npm --prefix jobs run typecheck
npm --prefix jobs test

cd frontend
npm ci
npm run test:unit
npm run build:preview
npm run test:e2e
```

See [implementation notes](docs/implementation-notes.md) for graph/runtime invariants and [vault structure](docs/vault-structure.md) for the optional Obsidian contract.

## License

[MIT](LICENSE)
