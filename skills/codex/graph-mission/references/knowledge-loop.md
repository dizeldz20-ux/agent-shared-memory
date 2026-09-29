# ASM, the vault, and the mission graph

Read this at the start of every mission. Four kinds of state cooperate; none replaces another.

| Layer | Holds | Freshness |
|---|---|---|
| ASM brain graph | Vault pages, code mapped by graphify, agent records as `memory:<id>` nodes, and their edges | Snapshot, rebuilt by `refresh.sh` |
| ASM records | Cross-agent handoffs in `~/.asm/memory.jsonl` | Immediate |
| Obsidian vault | Canonical decisions, traps and architecture | Durable; enters the graph on refresh |
| Mission graph | This run's nodes, owners, statuses and evidence | The run file under `.codex/graph-runs/` |

Current files, tests, running systems and authoritative external sources are the truth for "now". Recall supplies context and traps; it never replaces a live check of anything a node depends on.

## Recall ladder

Climb down. A question is answered when the fact is known **and** any state it asserts (deployed, pending, a flag, a commit) was checked live or became a `recon` node.

0. **In context**: `AGENTS.md`, plus the ASM session primer and prompt-recall nodes when the client runs ASM's hooks. Open a listed node with `brain_node`. A child gets no hook output; it starts at rung 1.
1. **ASM search**: `brain_search(subject)`, and `memory_recent(limit=5, query=subject)` for handoffs newer than the graph. Note the ids of open threads this mission will finish.
2. **ASM per file**: `brain_context(path)` before the first read or edit of a mapped file; read the bodies of the `vault_pages` it returns before editing. The code graph is graphify's extraction inside the brain: `brain_neighbors` gives a shared change's blast radius and `brain_path` how two nodes relate. There is no separate code-graph rung. On `node: null`, retry with more path segments, then `brain_search`; null never means nothing is known.
3. **Disk**: `rg` and file reads, for what rungs 0-2 did not answer, for page bodies, and for vault pages newer than the graph.

ASM returns metadata, meaning descriptions and paths; read a page from disk for its body. Records and pages are dated snapshots: a line naming a file, flag, port, commit or deploy state says what was true when it was written.

Newer ASM runtimes cap `memory_recent` at 20,000 characters, list open threads with ids `<record-id>#<n>`, hide closed threads, and mark finished items `[DONE]`; older ones return whole records. Keep `limit` at 5 or less, with a `query`, either way. An MCP server started before an ASM upgrade keeps the old tool schema until the client restarts, so check the parameters a tool actually exposes before relying on one.

## Recall pack

Up to 8 facts, each of which changes a node, a criterion, a lock or a non-goal ([decomposition.md](decomposition.md)). An empty pack says what was searched. Give each child the facts its node needs, never just a path.

Every fact carries one of these sources; no other form counts:

- `asm:<full node id>`, such as `asm:vault:<page-id>` or `asm:memory:<record-id>`: what the graph asserts, not yet read
- `record:<id>`: an ASM record you read, id without the `memory:` prefix; `record:<id>#<n>` for one of its threads
- `vault:<page-id>`: only a page whose body you read
- `file:<path>#L<n>`: current source
- `cmd:<command>`: observed output
- `url:<url>`: an authoritative external source

`file:` and `cmd:` say what is true now; the others say what was true when written. A fact with a historical and a live source joins them with ` + `. An unsourced assertion is a guess: drop it or turn it into a `recon` node.

Older prefixes: `brain:` means `asm:`; `memory:<record-id>` means `record:<record-id>`; `memory:<file>` in a Claude-edition run file names an agent memory file, a dated source like a record.

## Write-back

The `write-back` node runs as `main`, with no verifier, at the point [run.md](run.md) names.

1. Call `memory_record` with the session id the ASM memory gate names (otherwise one unique descriptive id for the run), a one-line `summary`, verified results in `details`, `files`, `decisions`, `open_threads` (every `blocked` gate among them), the agent name, and `supersedes` for earlier records of this mission.
2. If the `memory_record` tool accepts `resolves`/`corrects`: close the threads this mission finished by id (`<record-id>#<n>`, a record id to close all its threads, or `vault:<id>` for a plan page now done), and file each stale claim recall surfaced as `corrects: [{target: vault:<id> | mem:<file> | idx:<index>:<file>, claimed, truth, evidence}]` for the curator instead of editing it yourself. Otherwise use `supersedes` for stale and finished records, fix a stale vault line under the vault's `AGENTS.md`, and put "claimed X, true Y, evidence Z" in `details`.
3. Durable architecture, rules, traps or decisions get a vault page under the vault's own `AGENTS.md`; a page that revises another lists the old id in `contradictions`. Never store secrets or raw private transcripts.
4. A gate that gets its word after the record gets a new record that supersedes it.

`refresh.sh` rebuilds the graph and redeploys ASM's runtime, which every session shares. A mission runs it only when the mission is about ASM and no other session is working on ASM, in a node that holds `asm-refresh`. Records are searchable before any refresh.
