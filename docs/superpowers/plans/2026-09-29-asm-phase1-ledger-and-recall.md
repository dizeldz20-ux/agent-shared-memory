# ASM Phase 1 — Ledger and Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ASM an append-only lifecycle ledger that every reader honors, so closed threads, retired items and finished plans stop reaching agents. Measure it with a frozen private benchmark whose baseline is taken before recall changes.

**Architecture:**

- **The ledger.** `~/.asm/lifecycle.jsonl` is folded identically by three readers:
  - `lifecycle.py` (MCP server);
  - `hook/asm-lifecycle.js` (hooks);
  - `jobs/src/ledger/fold.ts` (background jobs).

  One fixture (`tests/fixtures/lifecycle.json`) pins them together.
- **Writers.** Agents write operations through `memory_record(resolves=…, corrects=…)`. The janitor and the curator (Phases 2–3) write through the same format.
- **Recall.** It becomes ledger- and date-aware and stops injecting daily notes.
- **Benchmark.** A TypeScript harness under `jobs/src/bench/` measures the hook and `brain_search` on a frozen copy of the stores.

**Tech Stack:** Python 3.11 (stdlib, FastMCP), CommonJS hooks, TypeScript 5.8 `strict` with NodeNext, Vitest, zod.

**Spec:** `docs/superpowers/specs/2026-09-29-asm-learning-and-cleanup-layers-design.md` (sections 6.1, 6.2, 7, 8, 14 Phase 1)

## Global Constraints

- **Public repository:** synthetic fixtures only. Benchmark cases, snapshots and labels live under `~/.asm/bench/`.
- **Hebrew regular expressions** never use `\b`.
- **Language:** new modules in TypeScript (Node 22+, ESM, `strict`, NodeNext `.js` import suffixes, no `any`, `readonly` by default, errors are classes, `async/await` only). Existing Python stays Python and existing hooks stay CommonJS. A module the hooks `require` stays CommonJS JavaScript, because hooks have no build step.
- **Tests:** `unittest` under `nice`; Vitest with `--maxWorkers=2` under `nice`; never two runs at once.
- **The raw tier is never edited.** `memory.jsonl` stays append-only, and every curation state lives in `lifecycle.jsonl`.
- **Commits:** Hebrew title and body, and no push.

## Review Focus

- **Restore of a restore:** `restore` undoes only visibility operations. A second restore of the same operation is a no-op, not a crash.
- **Ledger lines:** a ledger line with an unknown `op` or without a `reason` is skipped by all three readers, never fatal.
- **Superseded plus closed:** a superseded record with a thread closed in the ledger is excluded once, not twice, and the banner count does not go negative.
- **Recency factor at the edges:** at age 0 the factor is exactly `1 + r`; at `h` days and beyond it is `1 − r`; for a future timestamp it clamps to `1 + r`.
- **Daily-note exclusion:** it matches `vault:daily-YYYY-MM-DD` ids and `type: daily-note`, and nothing else. A page called `daily-standup-rules` stays.

---

### Task 1: The ledger format and its Python reader

**Files:**
- Create: `lifecycle.py`
- Create: `tests/fixtures/lifecycle.json`
- Test: `tests/test_lifecycle.py`
- Modify: `refresh.sh` (deploy `lifecycle.py`); `tests/test_asm_memory.py` `load_mcp` (copy `lifecycle.py`)

**Interfaces — Produces:**
- `op_id(op: dict) -> str` returns `"lc_" + sha256(canonical JSON without id)[:16]`.
- `validate(op: dict) -> list[str]` lists the invalid field names.
- `append_op(path: Path, op: dict) -> dict` fills `ts`, validates, sets `id`, and appends with `O_APPEND` and fsync.
- `load_ops(path: Path) -> list[dict]` skips invalid lines.
- `fold(ops, records=None) -> Lifecycle` provides:
  - `.states: dict[str, dict]`, keyed `"<kind>:<id>"`, each value `{state, op_id, at, reason, superseded_by}`;
  - `.requested: dict[op_id, op]`;
  - `.hidden(kind, id) -> bool`;
  - `.thread_open(record_id, index) -> bool`.
- The target key format is `thread:<rec>#<n>`, `record:<rec>`, `page:vault:<id>`, `memory_file:mem:<file>` or `index_line:idx:<index>:<file>`.

- [ ] **Step 1:** Write `tests/fixtures/lifecycle.json`. It holds records `r1` (two threads), `r2` (supersedes `r3`), `r3` (one thread) and `r4` (two threads). The operations, in this order:
  1. close `r1#0`;
  2. mark_done `vault:plan-a`;
  3. retire `r4`;
  4. retire `vault:old-page`;
  5. restore of operation 4;
  6. a second restore of operation 4 (a no-op);
  7. a `correct` with `mode: "requested"`;
  8. a `correct` with `applies` pointing at a different, unknown request;
  9. an invalid line without `reason`.

  The expected results:
  - states: `thread:r1#0`=closed, `page:vault:plan-a`=done, `record:r4`=retired, `record:r3`=retired (superseded), and no state for `page:vault:old-page`;
  - `open_threads` = `["r1#1"]`;
  - `requested` = [the id of operation 7].
- [ ] **Step 2:** Write `tests/test_lifecycle.py`. It covers:
  - the fold against the fixture;
  - `append_op` computing a stable id and rejecting a missing reason;
  - `load_ops` skipping garbage;
  - a double restore staying a no-op.

  Run `nice uv run python -m unittest tests.test_lifecycle -v` and expect FAIL (no module).
- [ ] **Step 3:** Implement `lifecycle.py`. `before[op_id]` stores the target's prior state; `restore` reinstates it only when the undone operation's target still shows the undone operation's `op_id`, which makes a second restore a no-op. A `supersedes` list in the records is applied first, as an implicit retire with `superseded_by = memory:<superseding id>`.
- [ ] **Step 4:** Run the tests and expect PASS. Add `lifecycle.py` to `load_mcp`'s copy list and to `refresh.sh`'s `cp -f` line. Run the full suite and expect OK.
- [ ] **Step 5:** Commit.

### Task 2: The hook-side reader (`hook/asm-lifecycle.js`)

**Files:**
- Create: `hook/asm-lifecycle.js` (CommonJS). It exports `loadOps(file)`, `fold(ops, records)` and `targetKey(target)`, and has a CLI: `--fold <fixture>` prints `{states, open_threads, requested}`.
- Test: `tests/test_lifecycle.py` gains `test_js_fold_matches_fixture`, which runs `node hook/asm-lifecycle.js --fold tests/fixtures/lifecycle.json`.
- Modify: `refresh.sh` (deploy `asm-lifecycle.js` to `~/.asm/hooks/`).

- [ ] **Step 1:** Add the parity test and expect FAIL (no file).
- [ ] **Step 2:** Implement it with the same semantics as Task 1.
- [ ] **Step 3:** Expect PASS and a green full suite, then commit.

### Task 3: The TypeScript jobs package and its ledger fold

**Files:**
- Create: `jobs/package.json` (`"type": "module"`, scripts `build`, `typecheck`, `test`), `jobs/tsconfig.json` (`strict`, `module`/`moduleResolution` `NodeNext`, `outDir: dist`, `rootDir: src`) and `jobs/vitest.config.ts`.
- Create: `jobs/src/ledger/ledger.types.ts` (`LedgerOp`, `TargetKind`, `LifecycleState`), `jobs/src/ledger/fold.ts` (`fold`, `targetKey`) and `jobs/src/ledger/ledger-store.ts` (the `LedgerStore` class: `load()` and `append(op)` with the id hash and an fsynced append; zod validation at the boundary).
- Test: `jobs/src/ledger/fold.test.ts` (fixture parity) and `jobs/src/ledger/ledger-store.test.ts` (append/load round trip in a temp dir, and the id matching Python's `op_id` for the fixture's first operation).

- [ ] **Step 1:** `npm install --prefer-offline` of `typescript@~5.8`, `vitest`, `@types/node` and `zod` in `jobs/`.
- [ ] **Step 2:** Write the tests and expect FAIL.
- [ ] **Step 3:** Implement. The id is `lc_` + sha256 of the canonical JSON. Canonical JSON means keys sorted recursively, `ensure_ascii=False` in Python, and plain `JSON.stringify` of the sorted value in TypeScript. Both sides use `separators=(",", ":")` in Python, so the bytes match.
- [ ] **Step 4:** Run `nice npm test` and `npm run typecheck`, and expect PASS and 0 errors. Commit (`dist/` and `node_modules/` are ignored).

### Task 4: The frozen benchmark, with a baseline measured before any recall change

**Files:**
- Create in `jobs/src/bench/`:
  - `bench.types.ts`;
  - `snapshot.ts` (`createSnapshot(runtimeDir, outDir)`: copies `memory.jsonl`, `lifecycle.jsonl` if present, `brain.json`, `brain.index.json` and `brain.pages.json`, and writes `manifest.json` with each file's sha256);
  - `recall-probe.ts` (the `RecallProbe` class: assembles a run dir from a code dir plus a snapshot, runs the prompt hook per case, runs one MCP stdio server per run and calls `brain_search`);
  - `metrics.ts` (`scoreCase`, `summarize`);
  - `cli.ts` (`snapshot` and `run` commands).
- Test: `jobs/src/bench/metrics.test.ts` and `jobs/src/bench/recall-probe.test.ts` (a synthetic run dir with a two-node brain; proves both channels return ids).

**Metric, per case:** for the top 5 of the hook and the top 5 of `brain_search` separately, compute these flags:

- `current_hit`: any current id is in the top 5.
- `stale_hit`: any stale id is in the top 5.
- `stale_next_to_current`: both of the above.
- `stale_only`: `stale_hit` without `current_hit`.

The summary reports counts per channel.

- [ ] **Step 1:** Write the tests and expect FAIL.
- [ ] **Step 2:** Implement, then run the tests and typecheck, and expect PASS.
- [ ] **Step 3:** Take the snapshot `~/.asm/bench/snap-2026-09-29/`. Run the baseline with the Phase 0 code (the current `~/.asm` copies) and the cases in `~/.asm/bench/stale-recall-cases.json`. Save it as `~/.asm/bench/report-baseline.json`.
- [ ] **Step 4:** Commit the harness. The data stays private.

### Task 5: `memory_record(resolves=…, corrects=…)`

**Files:**
- Modify: `mcp_server.py` (new parameters, `LEDGER_PATH`, `_apply_resolves`, `_request_corrections`; the response gains `resolved`, `ignored_resolves`, `requested_corrections` and `ignored_corrects`)
- Test: `tests/test_asm_memory.py`, new class `ResolveProtocolTests`

**Rules:**

| `resolves` value | Operation written |
|---|---|
| `<16hex>#<n>` naming an existing thread | `close_thread` |
| `<16hex>` of an existing record | one `close_thread` per thread |
| `vault:<id>` present in the graph | `mark_done` on the page |
| anything else | nothing; the value goes to `ignored_resolves` |

- All `resolves` operations carry `actor.kind = "agent"`, `mode = "auto"`, `evidence = ["memory:<new id>"]` and `reason = "resolved by memory:<new id>: <summary[:200]>"`.
- `corrects` items need a `vault:`, `mem:` or `idx:` target plus non-empty `claimed` and `truth`. Each one becomes an `op: "correct"` with `mode: "requested"`, `claimed`, `truth`, `evidence + [memory:<new id>]`, and `class: "correction.apply"`.

- [ ] **Step 1:** Write the tests: a thread id closes exactly that thread; a record id closes all its threads; a vault id marks the page done; an unknown id is ignored; a correction is requested; an invalid correction is ignored. Expect FAIL.
- [ ] **Step 2:** Implement, expect PASS and a green full suite, then commit.

### Task 6: `merge.py` carries dates, type, status and curation into the graph

**Files:**
- Modify: `merge.py`:
  - the page meta gains `updatedAt`, `type`, `status` and `curated`;
  - the index rows gain `u`, `y`, `s` and `c`;
  - a new `page_flags(path) -> dict` reads the frontmatter `status` and detects `<!-- asm:state begin`.
- Test: `tests/test_asm_memory.py`, `DirectoryOverviewTests`-style: a temp vault with three pages (one `status: done`, one daily note, one with a curated block) produces those fields.

- [ ] **Step 1:** Write the tests and expect FAIL. **Step 2:** Implement. **Step 3:** Expect PASS and a green suite, then commit.

### Task 7: The MCP recall honors the ledger and dates

**Files:**
- Modify: `mcp_server.py`:
  - `memory_records` drops ledger-retired records and annotates `open_thread_indexes`;
  - `record_brief` lists only open threads;
  - `_record_fields` scores only open threads, keyed by id plus the open indexes;
  - `brain_search` skips retired pages, prefixes done pages, weights daily notes ×0.5, boosts curated pages ×1.25, and applies the record recency factor (`RECENCY_R = 0.15`, `RECENCY_DAYS = 60`);
  - `brain_node` adds `lifecycle`;
  - `brain_context.vault_pages` drops retired pages and prefixes done ones.
- Test: new class `LedgerRecallTests`:
  - a closed thread does not make its record match;
  - a retired record is absent from search, recent and context but opens by id with `lifecycle`;
  - a done page carries the `[DONE` prefix;
  - a retired page is absent;
  - a daily note ranks below an equal page;
  - the recency factor edges (0 days, 60 days, 120 days, future);
  - no ledger file at all behaves exactly as before.

- [ ] **Step 1:** Write the tests and expect FAIL. **Step 2:** Implement. **Step 3:** Expect PASS and a green suite, then commit.

### Task 8: The hook recall and the banner honor the ledger

**Files:**
- Modify: `hook/asm-prompt-recall.js`:
  - `loadMemory` uses the fold, uses only open threads in `extra`, and carries `at`;
  - `loadNodes` reads `s`, `y`, `c`, `u`;
  - it skips retired pages and daily notes, applies the recency factor and the curated ×1.25, and prefixes done pages.
- Modify: `hook/asm-session-start.js`. The banner counts open threads through the fold and prints the newest open thread's id.
- Test: `tests/test_asm_memory.py` `HookContractTests`:
  - a prompt whose only match is a daily note injects nothing;
  - a closed thread's words do not inject its record;
  - a done page line carries `[DONE`;
  - the banner prints `<id>#<n>` and excludes closed threads.

- [ ] **Step 1:** Write the tests and expect FAIL. **Step 2:** Implement. **Step 3:** Expect PASS and a green suite, then commit.

### Task 9: Deploy, measure after, review, commit

- [ ] **Step 1:** Full Python suite, `jobs` Vitest and typecheck.
- [ ] **Step 2:** Deploy through `refresh.sh --changed`, which also re-merges the graph with the new fields.
- [ ] **Step 3:** Run the benchmark with the new code on the same snapshot, and save `~/.asm/bench/report-phase1.json`. The acceptance bar:
  - no case regresses on `current_hit`;
  - `stale_*` does not grow;
  - with an empty ledger the only expected movement comes from dates and daily notes.
- [ ] **Step 4:** Live check: a real session's prompt hook no longer injects daily notes. `memory_record(resolves=[thread])` on a runtime copy closes the thread, and it disappears from the banner and from `memory_recent`.
- [ ] **Step 5:** Adversarial review, one fix pass, then commit.
