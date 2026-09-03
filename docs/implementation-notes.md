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

- The 3D view pins real graph nodes inside a tapered cortical volume and surrounds them with a sparse deterministic cortical point field. A longitudinal fissure and bounded hub degree preserve the anatomical silhouette; ASM maps itself as a compact nucleus at the core.
- Shape forces must DOMINATE link forces or the mass collapses to a blob: link strength 0.015–0.08, charge −14, shell spring ~1.
- Force config must be deferred ~150ms after graphData lands (else a `reading 'tick'` crash) and wrapped in try/catch.
- Bloom calibration for ~1.6k nodes: UnrealBloomPass at low strength + small nodes — stronger bloom or bigger nodes washes dense lobes to white.
- 2D somas are pre-baked sprites (glow, lit body, rim light): `createRadialGradient` per node per frame blows the frame budget at ~1.6k repainting nodes.
- Link alphas multiply the renderer's global `linkOpacity` — the number in the code is not what you see. The quietest tier once rendered at an effective ~4%: a connection nobody could follow with their eye. Tiers still rank, but start from a visible floor; the structure of the brain is the links, not the dots.
- Live current never creates synthetic event lines. It traverses the same `contains`, `code`, `link`, and `xlayer` edges already painted in CONNECTOME/MAP/CORTEX. The 3D layer updates fixed GPU buffers; the 2D layer uses a transparent RAF canvas above the static atlas. Repainting the whole 20k-node ForceGraph at 12fps looked both choppy and expensive, while the isolated overlay remains fluid and leaves pan/zoom responsive.
- Pointer deformation is a bounded position-based relaxation, not a global force simulation: a spatial hash admits local colliders, real graph links supply springs, weak anatomical anchors preserve the brain silhouette, and per-frame displacement caps prevent dense fields from popping. The spatial world and spring pairs are reused; dense 2D pointer frames use an adaptive one-pass budget, then rebuild the static `Path2D` topology in short post-settle slices and atomically swap it so moved axons do not leave stale duplicate lines. The 3D view updates its existing GPU buffers without replacing DragControls; sampled dendrites and synaptic tips translate with their soma instead of being left behind. Per-layout position caches survive view/live-graph changes; reset clears only the active layout and rebuilds its canonical geometry.

## Adoption layer — the brain is consulted, not just updated

- SessionStart hook prints the primer + standing rule; stdout injects into session context. Verify with a fresh `claude -p` run — it should quote the rule back.
- UserPromptSubmit hook scores the prompt against the brain index and injects up to 5 nodes. For Hebrew (agglutinative), `stem()` strips one leading particle + plural suffix — without it Hebrew prompts match nothing. Noise gate: **2 matched tokens required**, unless a token is specific (filename or 8+ chars) — one generic word landing in one description is a coincidence, and a hook that fires on coincidences gets ignored.
- The prompt hook must stay synchronous: `async: true` would discard the stdout that carries the injection. Activity hooks can and should be async: `PreToolUse` emits the live start signal, while `PostToolUse` refreshes/completes it and is the only phase allowed to mark a mutation for the memory gate. Both phases carry the same `tool_use_id`, so the UI replaces start with finish instead of counting one access twice.
- **`"mcp__asm__*"` must be in `permissions.allow`** — otherwise every brain call prompts ("permission not granted"), silently killing adoption. Only a live `claude -p` run surfaces this.
- Testing hooks with non-ASCII input on Windows: PowerShell 5.1 mangles non-ASCII command-line text to `?`. Write the payload to a UTF-8 file and pipe it, or the test lies.

## Recall quality (2026-08-28, after studying OpenViking's context assembler)

- **Cross-prompt recall ledger.** `~/.asm/sessions/<session>.recall.json` (`{turn, entries:{node_id:{turn}}}`) is written only by the prompt hook; a node served in the last 6 *scored* prompts of the same session is skipped and the next-best node takes the slot (slash commands and token-less prompts do not advance the clock; two hooks racing on one session id can lose a turn — both are harmless). Observed before the ledger: the same two vault pages injected on three consecutive prompts. No session id → no ledger (sharing one under `unknown` would cool nodes across sessions); a corrupt ledger costs dedup for one prompt, never the injection.
- **IDF is the ranking, field weights are the gate.** Both the hook and `brain_search` keep the 3/2/1/1 field weights and the two-hit rule as the *gate*, and rank by `Σ weight·ln((N−df+0.5)/(df+0.5)+1)` with df counted in the same scan (no per-node term maps — that would add ~2MB/48% to `brain.index.json`). `index.ts` (228 files) and `sweeper` (three mapped copies) still count as evidence but no longer outrank a token that lands on five nodes. Pages and memory records get ×1.25.
- **One tokenizer, two languages.** `tokenize()` in `mcp_server.py` mirrors `tokenize()` in the hook (`node hook/asm-prompt-recall.js --tokenize "<text>"`); `tests/fixtures/tokenize.json` runs against both. The second trim after stemming matters: `ב-AWS` used to stem to `-aws` and match only a hyphen in a path by luck.
- **`aliases:` for Hebrew names.** Obsidian's native field, passed through both OKF generators into `catalog.json` → `meta.aliases` → index key `a`. Scored at label weight and an alias hit counts as *strong* on its own (Hebrew names rarely reach the 8-char bar). Deliberately not `tags`: tags also create `xlayer` edges. Verified: `צריך לתקן את הסוויפר של AWS` (the documented zero-hit prompt) now recalls `proj-sweeper-private`.
- **Memory records are recall candidates.** The hook reads `memory.jsonl` (1ms) and scores `summary/decisions/open_threads/files` — never `details` (~2.6KB per record would out-match every page). A handoff is recalled on the next prompt, not after the next refresh.
- **`usage.jsonl`** (`{node_id, ts}`) is appended by `brain_node`/`brain_context`. It is the only signal of which recalled context was actually opened. Nothing scores on it yet: a hotness blend needs weeks of rows before an α can be chosen.
- **`supersedes`.** `memory_record(supersedes=[ids])` retires earlier records from search/recall/recent at the single chokepoint `memory_records()`; `brain_node("memory:<id>")` still returns them with `superseded_by`.
- **Records join the graph at MCP start**, not in `merge.py`: `_attach_memory` adds `memory:<id>` nodes and `touches` edges through the fail-closed `find_by_path` (now backed by `ABS_INDEX`/`SUFFIX2`; 100 records attach in ~0.3s). `merge.py`'s `suffix_index` is first-wins, and 338/616 recorded paths were single-segment — neither is safe to bind blindly.
- **Edge priority before every cap.** `neighbors_of()` orders `xlayer < touches < link < code < contains`; a hub file with 50+ code edges returned zero `touches` before this, and `brain_context`'s `[:80]` slice could drop vault pages the same way.
- **Directories carry a generated overview.** `merge.py::describe_directories` writes `"N files (langs) · hubs: … · knowledge: …"` for every dir/project node from the graph alone; dirs are in the index and no longer skipped by the hook.
- **Secret scrubber** in `memory_record` (ported from ACP `memory_store.scrub_text`): private keys, JWTs, provider keys, bearer/basic, `password:`-style pairs, Luhn-valid cards. Not phones or internal IPs — in ASM records those are documented operational facts (PBX lines, fleet hosts). Only finding kinds are returned.
- **Mutation-marker hygiene.** `~` is expanded; `/dev/*`, `+`-prefixed `date` formats, and temp trees (`/tmp`, `/var/folders`) *outside the session cwd* are not mutations. A temp path under cwd stays real — test suites run there.
- **`refresh.sh --changed`** re-extracts only sources with a file newer than their `graph.json` (or an extract older than 3 days), then merges everything. The deployed hooks cannot see `sources.json`, so this is a script flag, not a Stop-hook state file.

## Hardening (found by an adversarial review of the offline path)

- **Drain race (destroyed events on Windows).** `read_text()` then `unlink()` left a window where a hook's append landed in an orphaned file — both sides reported success. Fix: `PENDING_PATH.replace(staged)` first — rename is atomic and appenders immediately get a fresh buffer. A `.draining` left by a crashed drain folds back in on the next start.
- **Replay duplicates.** A hook aborting *after* the server persisted buffered a copy that the drain re-added. Replay identity includes timestamp, agent, session, path, tool, phase, and operation id. `phase` is essential: Claude can emit Pre/Post in the same millisecond, and collapsing `finish` into `start` leaves access permanently open. The known set is advanced while scanning one staged file so duplicates inside the same buffer are also removed.
- **Silent no-op buffer.** `appendFileSync` does not create parent directories and the catch was empty; on a fresh machine the whole fallback was lossy and reported success. `mkdirSync(recursive)` first.
- **Import-time parses could brick startup forever.** One bad byte in the event log → server never boots → nothing drains → total silent loss. Fix: `errors="replace"`, catch `ValueError` (UnicodeDecodeError is one), and a corrupt `brain.json` serves an empty graph with a loud message instead of refusing to start — recording activity is the part that cannot be recovered later.
- **`persist()` failure hid behind a 200.** It now returns bool and the endpoint answers 500, so the hook buffers instead of losing the event.
- **Durability must precede visibility.** Neither live publish nor pending drain adds an event to `recent` before `persist()` succeeds. Otherwise the retry is mistaken for a duplicate and a failed append becomes permanent data loss.
- **One suspended UI blocked every agent.** WebSocket fanout now uses a client snapshot, concurrent sends, and a bounded per-client timeout. A stalled browser is removed without delaying the hook, Codex rollout watcher, or healthy UI clients.
- **Overflow dropped the newest events.** The 2MB cap returned early, keeping a stale backlog. Now it keeps the newest half and writes a `{"dropped": n}` marker line (drain skips markers).
- **`find_by_path` answered ambiguous paths confidently.** A bare-suffix match returned the first hit in iteration order — another project's node, its vault pages, injected as authoritative context. Now: exact match, else require ≥2 path segments and a *unique* match, else `None` plus a note telling the caller to qualify the path.
- **`recent_access` matched bare filenames** across projects; it matches node-id only once the node is known.
- **In-memory history smaller than the disk fallback.** The live server's `recent` deque must be ≥ the MCP's disk-tail window, or a running server returns *less* history than a dead one.
- **Non-atomic runtime deploy.** `Copy-Item -Force` truncates in place; a session starting inside that window got an MCP that could not parse `brain.json` and failed to boot. Deploy via tmp + `Move-Item`. The reload catch must also distinguish "server not running" from "server rejected the new graph".

## Skill router (2026-09-03, after studying SKILL.state — arXiv:2608.26263)

The paper replaces an append-only transcript with a small mutable state Σ that the runtime
validates and patches each step (prompt O(1), run O(T) tokens, reasoning discarded after the
patch). `hook/asm-skill-router.js` applies that to one recurring cost: choosing among ~200
installed skills and loading each SKILL.md at most once per context window.

- **P** — `~/.asm/skill-map.json`, derived from every SKILL.md frontmatter (`~/.claude/skills`,
  `~/.claude/commands`, enabled plugin caches whose marketplace path exists on this machine,
  `~/.agents/skills`) plus the private `skill-map.overrides.json`. Rebuilt by `--build`,
  by `refresh.sh`, and by `SessionStart` when the roots or the overrides are newer than the map.
- **Σ** — `~/.asm/sessions/<id>.skills.json`: `loaded`, `hinted`, `actions`, turn counters,
  `compactions`. Patched with ⊕ (only sent keys change, `null` deletes) under a lock.
  `SessionStart source=compact` deletes `loaded`/`hinted` (the context was rewritten, so
  every SKILL.md is gone from it); `clear` deletes the file; an unparsable file starts empty.
- **O** — the prompt (UserPromptSubmit) or the tool call (PreToolUse, matcher
  `Skill|Write|Edit|MultiEdit|NotebookEdit|Bash`). A Skill call is recorded silently; a
  Write/Edit/Bash is matched against `paths` globs and `commands` regexes and yields an
  `additionalContext` hint when the skill is not loaded (cooldown 40 tool turns).
- **Evidence** — strong = quoted phrases in the description, curated triggers, regex patterns
  (one hit suffices); weak = tokens rare across all descriptions (df ≤ 3) and long enough
  (≥ 6 Latin / ≥ 4 Hebrew letters), two hits needed — the recall hook's two-hit rule. Negative
  sentences ("Do NOT use for Tranzila") are stripped from the evidence and shown as `NOT:`.
  Hebrew single-word triggers match through clitic prefixes and common suffixes because `\b`
  is ASCII-only. `defer_to` lets overlapping families collapse to one. Cut at three, cooled
  for four prompts, "already loaded" repeated at most every six.
- **Telemetry** — `~/.asm/skill-usage.jsonl` rows (`hint`, `action-hint`, `load` with
  `hinted`/`reload`); `--report 7` gives precision, `noisy` (hinted ≥ 3, never loaded) and
  `unpredicted` (loaded, never hinted) — the tuning loop for the overrides.
- **Cost** — 30 ms per prompt after a containment prefilter (compiling ~6,000 boundary
  regexes per prompt had cost 270 ms); a hint is 40–120 tokens on the minority of prompts
  that match; a wrong or duplicate SKILL.md load is 200–22,000 tokens.
- Claude only: the configurator registers the three events with `include_skill_router=True`
  for `~/.claude/settings.json`; other clients keep the memory hooks alone. The curated rules
  name private products and paths, so they live in the runtime, not in this repo
  (`hook/skill-map.overrides.example.json` is the generic seed).

## Offline path

- Hook POST fails → append to `~/.asm/pending.jsonl` (cap 2MB, newest-half kept).
- Server start → load recent history (tail of `events.jsonl`) → drain pending (dedup) → serve.
- MCP `recent_access()` tries HTTP `:8930` (1s timeout), falls back to the tail of `events.jsonl`.
- Verified end to end: server down → fresh session called `brain_context` fine → events buffered → restart drained them.

## Ports / paths

- Visualization server: **8930** (optional — the brain works without it). Vite dev: 5930; e2e preview: 5941.
- Runtime copies (4 hooks, MCP server, brain.json, events.jsonl, memory.jsonl): `~/.asm/`. Keep the runtime dir on a plain local path — cloud-synced folders (OneDrive & co.) interfere with concurrent appends and file watching.
- Python deps pin `mcp>=1.9,<2` — SDK 2.0 removed `mcp.server.fastmcp`; the MCP dies on start with 2.x.
