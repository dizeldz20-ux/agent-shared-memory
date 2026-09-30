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

0. **In context**: `AGENTS.md`, plus the ASM session primer and prompt-recall nodes when the client runs ASM's hooks; the primer warns about the graph's age only once it is 3 days old or more. Open a listed node with `brain_node(node_id)`. A child gets no hook output; it starts at rung 1.
1. **ASM search**: `brain_search(query)`, and `memory_recent(limit, query)` with `limit` 5 or less for handoffs newer than the graph. Query with one or two distinctive words: an older `memory_recent` keeps only records that contain every word, a newer one any word. Note the open threads this mission will finish — by id (`<record-id>#<n>`) when `memory_recent` lists ids.
2. **ASM per file**: `brain_context(file_path)` before the first read or edit of a mapped file; read the bodies of the `vault_pages` it returns before editing. A repo-relative path resolves only when exactly one mapped checkout ends with it; with several copies it returns `node: null`, so pass the mapped checkout's absolute path. Newer versions resolve a worktree's absolute path themselves and report it in `resolved_via`. After a `node: null`, retry that way, then `brain_search`; null never means nothing is known. The code graph is graphify's file-level extraction inside the brain, with no separate code-graph rung: `brain_neighbors(node_id, depth)` for a shared change's blast radius (capped at depth 3 and 50 nodes, so partial around a hub), `brain_path(from_id, to_id)` for how two nodes relate.
3. **Disk**: `rg` and file reads, for what rungs 0-2 did not answer, for page bodies, and for vault pages newer than the graph.

ASM returns metadata, meaning descriptions and paths; read a page from disk for its body. Records and pages are dated snapshots: a line naming a file, flag, port, commit or deploy state says what was true when it was written.

Newer ASM runtimes return `memory_recent` records as previews, capped at 20,000 characters in all (open a full record with `brain_node(node_id="memory:<id>")`), list open threads with ids `<record-id>#<n>`, and hide closed threads. On those runtimes, a vault plan page closed as done appears in recall labeled `[DONE dd/mm · evidence]`; `memory_recent` marks nothing. Older runtimes return whole records. An MCP server started before an ASM upgrade keeps the old tool schema until the client restarts, so check the parameters a tool actually exposes before relying on one.

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

1. Call `memory_record` with the session id the ASM memory gate names — in Codex the thread id (`$CODEX_THREAD_ID`); a descriptive id only when the client runs no ASM hooks — and a one-line `summary`, verified results in `details`, `files`, `decisions`, `open_threads` (every `blocked` gate among them), the agent name, and `supersedes` for earlier records of this mission; read `ignored_supersedes` in the answer.
2. If the `memory_record` tool accepts `resolves`/`corrects`: put in `resolves` what this mission finished (`<record-id>#<n>` with `<n>` counting from 0, a record id for all its threads, or `vault:<id>` for a plan page already in the graph), file each stale claim recall surfaced as `corrects: [{target: vault:<id> | mem:<file> | idx:<index>:<file>, claimed, truth, evidence}]`, and read `ignored_resolves` and `ignored_corrects` in the answer. Copy `claimed` verbatim from the target — a curator never applies a fuzzy match. If the SessionStart banner shows the curator running (`curator ok …`), its code is deployed (`~/.asm/jobs/dist/curator/`), and the target is a vault page, a memory file in its configured memory folder, or a line of that folder's `MEMORY.md` (or of a hub page, when the jobs config names hubs), leave the line to it: it replaces the claimed text once the user approves the proposal or on its own once that class has earned trust, and it cannot apply a correction whose text is already gone. In any other case, fix the stale line too and put "claimed X, true Y, evidence Z" in `details`. Otherwise quote the finished threads and each stale claim in `details` and fix the stale line under the vault's conventions; `supersedes` retires a whole record from recall for every session, so naming another session's record there is an irreversible operation on something the mission did not create; it waits for the user's word.
3. Durable architecture, rules, traps or decisions get a vault page under the vault's own `AGENTS.md`. A page about a file gets `resource` (its mapped path), which is what links it to that file in `brain_context`; a page that revises another lists the old id in `contradictions`. Never store secrets or raw private transcripts.
4. A gate that gets its word after the record gets a new record that supersedes it.

`refresh.sh` rebuilds the graph and copies the checkout's `mcp_server.py`, hooks and skills into the runtime every session shares, so a run from an older checkout downgrades every session. It is a `gate` unless the checkout is the one named by `repo` in `~/.asm/asm-paths.json` and `diff -rq` shows every file that checkout's `refresh.sh` deploys besides the graph equal to the deployed copy — read its deploy section: on public main that is `mcp_server.py`, `pyproject.toml`, `hook/*.js`, `skills/agent-shared-memory/SKILL.md` and `skills/codex/graph-mission/`; newer versions add `asm_text.py`, `lifecycle.py`, `jobs/dist/` and `skills/asm-review/SKILL.md`. A checkout elsewhere repoints the vault and the daily notes, and a branch carrying an older skill overwrites the installed one. `refresh.sh` does not deploy the Claude edition, so leave it out of the comparison. If that `refresh.sh` accepts `--brain-only`, a graph-only refresh from the `repo` checkout deploys no code and needs no gate. Either way the mission must be about ASM, no other session may be working on ASM, and the node holds `asm-refresh`. Records are searchable before any refresh.
