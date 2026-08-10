# Implementation notes

Engineering decisions and paid-for lessons, kept so the next person does not rediscover them.

## Graphify extraction

- Package: `uv tool install graphifyy` → binaries `graphify`, `graphify-mcp`.
- Extraction used: `graphify extract <src> --code-only --out <dir>` — local tree-sitter AST, no LLM, respects `.gitignore`. Writes `<dir>/graphify-out/graph.json`.
- Output schema: **NetworkX node-link JSON**: top keys `directed, multigraph, graph, nodes, links, hyperedges`.
  - node: `{id, label, source_file (repo-relative POSIX), source_location ("L26"), community (int), _callable?, type?("package"), _origin:"ast"}`. Includes noise nodes: `rationale_*` (docstring text), `fixture`, package.
  - link: `{source, target, relation, weight, source_file, source_location}`; relations seen: calls, method, uses, references, contains, rationale_for, imports, imports_from, inherits, indirect_call.
- Scale reference: a ~240-file Python service extracts to ~4.3k symbol nodes / ~15k links in ~2 minutes.
- Gotchas: `.sql` needs `pip install "graphifyy[sql]"` (skippable); a few JSON files produce zero nodes (harmless warning); a project without a git repo needs a `.graphifyignore` or `node_modules` gets indexed.

## brain.json strategy

- Graphify's symbol-level graph is too dense for a default 3D view and its communities are near-per-file — useless as level-of-detail. **`merge.py` collapses code graphs to FILE level**: one node per distinct `source_file`, edges = aggregated symbol links between different files (weight = count). Directory nodes (first path segment) + layer root nodes provide grouping. Raw graphify outputs stay under `data/raw/` for a future symbol-level drill-down.
- Vault layer comes from the vault's `okf/graph.json` (edges: `{from,to}`) + `okf/catalog.json` (id/path/title/description/tags/related/resource per page) — see [vault-structure.md](vault-structure.md).
- Cross-layer (`xlayer`) edges: (1) vault page tags → layer root; (2) `resource:`/`related` path-suffix match → file node.
- brain.json uses `nodes` + `links` keys so it feeds react-force-graph directly.
- `merge.py` also emits `brain.index.json` (pages+files only, no links — links are ~80% of the bytes) for the prompt hook, which runs synchronously in front of every prompt and must not parse the full graph. Warm hook runs ~120ms vs ~400ms on the full file.

## Brain-shaped layout (frontend)

- A custom d3 force herds nodes into an ellipsoid cortex with a longitudinal fissure; each layer gets a lobe bias, the vault forms the top band (corpus callosum), ephemeral activity sinks to the brain stem, and C2B maps itself as a compact nucleus at the core.
- Shape forces must DOMINATE link forces or the mass collapses to a blob: link strength 0.015–0.08, charge −14, shell spring ~1.
- Force config must be deferred ~150ms after graphData lands (else a `reading 'tick'` crash) and wrapped in try/catch.
- Bloom calibration for ~1.6k nodes: UnrealBloomPass at low strength + small nodes — stronger bloom or bigger nodes washes dense lobes to white.
- 2D somas are pre-baked sprites (glow, lit body, rim light): `createRadialGradient` per node per frame blows the frame budget at ~1.6k repainting nodes.
- Link alphas multiply the renderer's global `linkOpacity` — the number in the code is not what you see. The quietest tier once rendered at an effective ~4%: a connection nobody could follow with their eye. Tiers still rank, but start from a visible floor; the structure of the brain is the links, not the dots.

## Adoption layer — the brain is consulted, not just updated

- SessionStart hook prints the primer + standing rule; stdout injects into session context. Verify with a fresh `claude -p` run — it should quote the rule back.
- UserPromptSubmit hook scores the prompt against the brain index and injects up to 5 nodes. For Hebrew (agglutinative), `stem()` strips one leading particle + plural suffix — without it Hebrew prompts match nothing. Noise gate: **2 matched tokens required**, unless a token is specific (filename or 8+ chars) — one generic word landing in one description is a coincidence, and a hook that fires on coincidences gets ignored.
- The prompt hook must stay synchronous: `async: true` would discard the stdout that carries the injection. The activity hook (PostToolUse) can and should be async.
- **`"mcp__c2b__*"` must be in `permissions.allow`** — otherwise every brain call prompts ("permission not granted"), silently killing adoption. Only a live `claude -p` run surfaces this.
- Testing hooks with non-ASCII input on Windows: PowerShell 5.1 mangles non-ASCII command-line text to `?`. Write the payload to a UTF-8 file and pipe it, or the test lies.

## Hardening (found by an adversarial review of the offline path)

- **Drain race (destroyed events on Windows).** `read_text()` then `unlink()` left a window where a hook's append landed in an orphaned file — both sides reported success. Fix: `PENDING_PATH.replace(staged)` first — rename is atomic and appenders immediately get a fresh buffer. A `.draining` left by a crashed drain folds back in on the next start.
- **Replay duplicates.** A hook aborting *after* the server persisted buffered a copy that the drain re-added. Drain skips events whose `(ts, session, path)` is already known. Hook timeout 1s→2s (the aborts came from parallel Node startup contention, not server latency).
- **Silent no-op buffer.** `appendFileSync` does not create parent directories and the catch was empty; on a fresh machine the whole fallback was lossy and reported success. `mkdirSync(recursive)` first.
- **Import-time parses could brick startup forever.** One bad byte in the event log → server never boots → nothing drains → total silent loss. Fix: `errors="replace"`, catch `ValueError` (UnicodeDecodeError is one), and a corrupt `brain.json` serves an empty graph with a loud message instead of refusing to start — recording activity is the part that cannot be recovered later.
- **`persist()` failure hid behind a 200.** It now returns bool and the endpoint answers 500, so the hook buffers instead of losing the event.
- **Overflow dropped the newest events.** The 2MB cap returned early, keeping a stale backlog. Now it keeps the newest half and writes a `{"dropped": n}` marker line (drain skips markers).
- **`find_by_path` answered ambiguous paths confidently.** A bare-suffix match returned the first hit in iteration order — another project's node, its vault pages, injected as authoritative context. Now: exact match, else require ≥2 path segments and a *unique* match, else `None` plus a note telling the caller to qualify the path.
- **`recent_access` matched bare filenames** across projects; it matches node-id only once the node is known.
- **In-memory history smaller than the disk fallback.** The live server's `recent` deque must be ≥ the MCP's disk-tail window, or a running server returns *less* history than a dead one.
- **Non-atomic runtime deploy.** `Copy-Item -Force` truncates in place; a session starting inside that window got an MCP that could not parse `brain.json` and failed to boot. Deploy via tmp + `Move-Item`. The reload catch must also distinguish "server not running" from "server rejected the new graph".

## Offline path

- Hook POST fails → append to `~/.claude/c2b/pending.jsonl` (cap 2MB, newest-half kept).
- Server start → load recent history (tail of `events.jsonl`) → drain pending (dedup) → serve.
- MCP `recent_access()` tries HTTP `:8930` (1s timeout), falls back to the tail of `events.jsonl`.
- Verified end to end: server down → fresh session called `brain_context` fine → events buffered → restart drained them.

## Ports / paths

- Visualization server: **8930** (optional — the brain works without it). Vite dev: 5930; e2e preview: 5941.
- Runtime copies (3 hooks, MCP server, brain.json, events.jsonl): `~/.claude/c2b/` and `~/.claude/hooks/`. Keep the runtime dir on a plain local path — cloud-synced folders (OneDrive & co.) interfere with concurrent appends and file watching.
- Python deps pin `mcp>=1.9,<2` — SDK 2.0 removed `mcp.server.fastmcp`; the MCP dies on start with 2.x.
