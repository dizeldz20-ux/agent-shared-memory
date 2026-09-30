# ASM learning and cleanup layers — design

- **Date:** 2026-09-29
- **Status:** design approved section by section in brainstorming; this written spec awaits owner review.
- **Private companion:** the vault page `asm-memory-layers-gap-analysis-2026-09-29` holds the measurements and real examples. This repository is public, so the spec stays generic.

## 1. Problem

ASM keeps four kinds of memory:

- raw work records (`memory.jsonl`);
- daily notes, which copy every record;
- vault pages;
- outside ASM's index, the agent memory index (`MEMORY.md`), its memory files, and the hub pages that list them.

Nothing turns raw records into current truth, and nothing retires what became false. Measured on the live store:

- **Open threads never close.** About 3.6k open threads exist, and a single thread cannot be closed. In a random sample, 7% were closed properly and 31% had been resolved but were still served as open.
- **Status snapshots outlive the work.** Records and pages that say "not deployed" or "awaiting approval" stay recallable after the work shipped, and plan pages contradict their own descriptions.
- **Overwritten facts stay retrievable.** One fact, the production version of a service, is asserted with dozens of different values across files.
- **Nothing is dated in ranking.** No ranking path uses dates. Daily notes are about 40% of indexed body words and are injected into prompts.
- **Consolidation is dead and silent.** The only consolidation job has failed every night since 2026-08-12 (launchd's 256 file-descriptor limit), and its wrapper exits 0, so the failure never surfaced.
- **The MCP returns errors that look like outages.**
  - `memory_recent` goes over the client's result-size cap in 43% of calls.
  - `memory_record` fails validation in 9.4% of calls.
  - `brain_context` returns a null node in 48% of calls, because the graph is stale and never reloaded.

As a result, agents redo finished work, act on superseded facts, and spend context on narrative.

## 2. Goals

- **G1 — cleanup layer.** Finished, superseded and duplicate items leave automatic recall. Every removal is reversible and carries a reason and evidence.
- **G2 — learning layer.** A small set of important files stays true over time. Their current state is rewritten in place, with a source for every claim, instead of accreting dated updates.
- **G3 — stop the generators.** Fix the garbage generators and MCP faults that feed the problem.
- **G4 — autonomy by trust ladder.** Mechanical actions run automatically once the judge passes a precision gate. Content edits are proposed as diffs until three consecutive runs of that action class are approved without correction.
- **G5 — measurable.** A frozen private benchmark decides. The target is zero cases of a stale value shown next to the current value, and zero cases where only the stale value is shown.

## 3. Non-goals

- **No deletion.** Everything retired can be restored.
- **No new memory notes.** Nothing promotes recurring facts into new notes (the old dreaming promotion); agents keep writing memory as they do today.
- **No embeddings** or vector store in this round.
- **No hindsight server or Postgres.** This design ports hindsight's mechanisms, not its infrastructure.
- **No change to how the agent loads its memory index.** Cleanup edits the index file itself.

## 4. Principles taken from hindsight

Taken from vectorize-io/hindsight at commit 7a00d58:

1. **Raw is append-only.** The raw tier is never edited: `memory.jsonl` stays append-only, and all curation state lives beside it.
2. **Every derived claim has a source.** A derived claim carries its sources, and a claim without a source is never written.
3. **The model only touches what it was shown.** It may cite or modify only ids that were in its input, and every change carries a reason.
4. **Silence is not evidence.** Absence is not contradiction: only an explicit later statement closes or rewrites something.
5. **Latest statement wins.** On the same facet the latest statement wins. A record that arrives late with an older statement adds history only.
6. **Edit blocks, not documents.** Edits are block-level, and untouched text stays byte-identical. An empty result never overwrites content, and every edit can be previewed as a diff.
7. **Invalidate, don't delete.** Invalidation moves an item to an archive with a reason, and a restore brings it back.
8. **Track each item.** Processing state is kept per item. An item that keeps failing is quarantined, and work whose inputs changed mid-run is discarded.

## 5. Architecture

```text
 memory.jsonl (raw, append-only)      vault pages      memory index + memory files + hubs
          │                               │                         │
          └──────────────┬────────────────┴─────────────┬───────────┘
                         ▼                              ▼
                ┌──────────────────┐          ┌──────────────────┐
                │  janitor (TS)    │          │  curator (TS)    │
                │  cleanup layer   │          │  learning layer  │
                └────────┬─────────┘          └────────┬─────────┘
                         │ ops (propose / auto)        │ ops (propose / auto)
                         ▼                             ▼
                ~/.asm/lifecycle.jsonl  (append-only ledger, reversible)
                         │
          ┌──────────────┼───────────────────────────┐
          ▼              ▼                           ▼
   prompt hook (JS)   MCP server (Python)     /asm-review (owner, Hebrew)
   honors ledger      honors ledger           approves proposals
```

Components:

1. **Ledger.** `~/.asm/lifecycle.jsonl`, append-only.
2. **Ledger readers,** one each in JavaScript (hooks), Python (MCP server) and TypeScript (jobs), all run against one shared fixture file.
3. **Protocol additions:** `memory_record(resolves=[…], corrects=[…])`.
4. **Recall changes.** The hook and the MCP honor the ledger and dates, and daily notes are no longer injected.
5. **Janitor job,** the cleanup layer.
6. **Curator job,** the learning layer.
7. **Runner.** A scheduler started from the SessionStart hook, with a state file and a lock.
8. **Review command** `/asm-review`, which shows proposals to the owner in Hebrew.
9. **Benchmark harness.** The harness is in the repo; its data is private, under `~/.asm/bench/`.

**Language:**

- **New code** is TypeScript: Node 22, ESM, `strict`, Vitest, built with `tsc`. It lives in `jobs/`.
- **Changes to existing Python** (`mcp_server.py`, `merge.py`, `source_manifest.py`) stay Python.
- **Changes to existing hooks** stay zero-dependency CommonJS JavaScript.

## 6. Data model

### 6.1 Ledger operation

One JSON object per line:

```json
{
  "id": "lc_<16 hex>",
  "ts": "2026-09-30T08:00:00+03:00",
  "op": "close_thread | mark_done | retire | restore | correct | compact",
  "target": { "kind": "thread | record | page | memory_file | index_line", "id": "..." },
  "reason": "required, at most 500 characters",
  "evidence": ["memory:<record-id>", "commit:<sha>", "path:<relative path>"],
  "superseded_by": "memory:<id> | vault:<id> | null",
  "actor": { "kind": "agent | janitor | curator | owner", "name": "...", "session": "..." },
  "mode": "auto | approved",
  "class": "<action class, section 6.5>",
  "before": { "path": "...", "sha256": "...", "text": "..." },
  "after": { "path": "...", "sha256": "..." },
  "undoes": "lc_<id>"
}
```

- `id` is the first 16 hex characters of the sha256 of the canonical JSON of the operation without `id`.
- `before` and `after` appear only on operations that edit a file. `before.text` holds the exact replaced text, so a restore is byte-exact.
- `undoes` appears only on `restore`.

**Target ids**

| kind | id | Notes |
|---|---|---|
| thread | `<record-id>#<n>` | `n` is the 0-based index into the record's `open_threads`. It is stable because records are immutable. |
| record | `<record-id>` | |
| page | `vault:<page-id>` | |
| memory_file | `mem:<file name>` | Relative to the configured memory directory. |
| index_line | `idx:<index file name>:<linked file name>` | The index or hub line that links to that file. |

**State fold**

The same fold is implemented in all three languages.

- Operations apply in file order.
- `close_thread`, `mark_done` and `retire` set the target's state (`closed`, `done`, `retired`) and remember the operation id.
- `restore` returns its `undoes` target to the state it had before that operation.
- `correct` and `compact` do not change visibility; they record edits.
- A `supersedes` list in `memory.jsonl` is read as an implicit `retire` of each superseded record, so both mechanisms agree.
- Readers cache the fold and refresh it when the ledger's mtime changes.

### 6.2 States of pages, memory files and records

- **Vault pages** stay in place, so links never break.
  - Frontmatter `status: active | done | retired`, plus either `done_at` and `done_evidence`, or `retired_at`, `retired_reason` and `superseded_by`.
  - A job writes the ledger operation first and the file second.
- **Memory files.** To retire one, move it to `~/.asm/archive/memory/<file>`, outside the memory directory so grep no longer finds it. Record the move in the ledger with `before`. The index line that points to it is rewritten or removed by its own `index_line` operation.
- **Records** are never edited. Their state lives only in the ledger.

### 6.3 Curated block in a project page

```markdown
<!-- asm:state begin seen=memory:<last-record-id> at=<ISO timestamp> -->
## Current state
- <claim> — since <DD/MM> · memory:<record-id8> ^s-<slug>
<!-- asm:state end -->
```

- **Bullets.** Each bullet has a stable Obsidian block id (`^s-<slug>`) and cites at least one record id.
- **Watermark.** `seen` is the data watermark: the newest in-scope record the block has seen. It is not wall-clock time.
- **Outside the block.** Nothing outside the two markers is ever touched. A test proves that the bytes outside the markers are identical after every edit.

### 6.4 Job files under `~/.asm/jobs/`

| File | Content |
|---|---|
| `state.json` | For each job (`janitor`, `curator`, `refresh`): `last_success`, `last_error`, `error_text`, `consecutive_failures`. |
| `items.json` | Map from item id to `{job, last_checked_at, verdict, failures, quarantined}`. Rewritten atomically. |
| `trust.json` | For each action class: `{mode: "propose" \| "auto", approved_runs, required: 3}`, plus `judge_gate: {precision, sample_size, passed}`. |
| `proposals/<run-id>.json` | Pending proposals, each a complete ledger operation minus `mode`. |
| `runs/<run-id>.json` | Run report: counts per class, LLM calls, tokens, errors, duration. |
| `run.lock` | `{pid, started_at}`. |
| `logs/<date>.log` | stdout and stderr of detached runs. |
| `curated.json` | Private curator scope (section 10.1). |

### 6.5 Action classes

| Class | Kind | Starting mode |
|---|---|---|
| `thread.close.resolved` | mechanical, judged | propose until the judge gate passes, then auto |
| `thread.close.not_actionable` | mechanical, judged | propose until the judge gate passes, then auto |
| `thread.close.duplicate` | mechanical, deterministic | auto from the first run (owner's decision, 29/09) |
| `thread.close.superseded` | mechanical, deterministic | propose until the judge gate passes, then auto |
| `hygiene.archive` | mechanical, deterministic | auto from the first run |
| `record.retire.status` | content | trust ladder |
| `page.mark_done` | content | trust ladder |
| `index.rewrite` | content | trust ladder |
| `memfile.archive` | content | trust ladder |
| `memfile.compact` | content | trust ladder |
| `block.refresh` | content | trust ladder |
| `correction.apply` | content | trust ladder |

**Trust ladder rules:**

- **Earning auto.** `approved_runs` goes up by one when the owner approves every proposal of a class in a run without editing any. After 3 such runs the class switches to `auto`.
- **Losing it.** A rejection or an edit resets the count to 0. An `auto` class drops back to `propose` when the owner restores any automatic operation of that class.
- **Batches.** Proposals of one class can be approved together.

Judged thread closures stay proposals until the judge gate passes. `hygiene.archive` is automatic from the first run, and so is `thread.close.duplicate`: a thread repeated verbatim is closed mechanically while its newest copy stays open, and it uses no judge. The owner decided this on 29/09, after the first real run's 110 duplicate proposals were all verified correct; until then no thread closed automatically before the gate. `thread.close.superseded` writes no operation (the fold already hides a superseded record's threads).

## 7. Protocol changes to `memory_record`

1. **`resolves: list[str]`** accepts three kinds of target. Each valid target writes an operation with `actor.kind = "agent"` and `evidence = [the new record id]`.

   | Target | Operation written |
   |---|---|
   | Thread id (`<id>#<n>`) | `close_thread` |
   | Record id | `close_thread` for each of its open threads |
   | Plan page id (`vault:<id>`) | `mark_done` |

   Unknown ids are ignored and returned in `ignored_resolves`, mirroring the existing `ignored_supersedes`.
2. **`corrects: list[{target, claimed, truth, evidence}]`** writes one `correct` operation per item, marked pending. The curator applies it (class `correction.apply`). `target` is a `vault:`, `mem:` or `idx:` id.
3. **`details` becomes optional** (default `""`).
4. **Leaked-argument repair.** Sometimes a long `summary` arrives with later arguments leaked into it, visible as markup such as `</details>`, `</open_threads>` or `</files>`. The server then recovers those fields from the markup, stores them, and returns a `warnings` list instead of failing.
5. **Summary length.** Any `summary` text beyond 500 characters moves to the head of `details`. The input schema declares `maxLength: 500` for `summary`.
6. **Thread ids in the response.** The response lists every open thread with its id (`<record-id>#<n>`), so agents can close it by id later.

## 8. Recall changes

1. **Ledger filter.** It applies to the prompt hook, `brain_search`, `brain_context.shared_memory`, `memory_recent` and the SessionStart banner.
   - Closed threads are neither scored nor listed as open.
   - Retired records, pages and memory files are excluded.
   - `brain_node` still returns retired items, with `lifecycle: {state, op_id, reason, superseded_by, at}`.
2. **Done pages** stay recallable, with the prefix `[DONE <DD/MM> · <evidence id>]` in hook injections and search results.
3. **Dates.**
   - `merge.py` carries each page's `updatedAt` into `brain.json` and `brain.index.json`.
   - Record scores are multiplied by a bounded recency factor `f = 1 + r − 2r · min(age_days / h, 1)`. It runs from `1 + r` for a new record down to `1 − r` at age `h` and beyond.
   - Initial values are `r = 0.15` and `h = 60`. The benchmark sets the final values.
4. **Daily notes** (`type: daily-note`) are no longer injected by the prompt hook. `brain_search` weights them ×0.5.
5. **Curated pages,** those containing an `asm:state` block, get a ×1.25 knowledge boost in the hook and in `brain_search`. This is an initial value; the benchmark tunes it.
6. **Size caps.**
   - `memory_recent` returns brief records: `{id, created_at, agent, summary, files[:5], open_threads (open ones only, with ids), details_preview (first 300 characters)}`.
   - Its total response stays at or under 20,000 characters and ends with `truncated: <n> more` when records were cut.
   - `brain_context.shared_memory` returns at most 3 brief records.
   - The full record stays available through `brain_node("memory:<id>")`.
7. **`memory_recent` query.** It uses the shared tokenizer, so any matching token counts. Today it is a substring-AND over the raw JSON, which returns nothing for multi-word queries.

## 9. Janitor: the cleanup layer

### 9.1 Candidates

1. **Open threads** that the ledger does not already close.
2. **Status snapshots:** records whose summary states a negative status (not deployed, not pushed, awaiting approval, plan only, uncommitted, and the Hebrew equivalents).
   - Detection uses a phrase list.
   - Hebrew phrases use `(?<![א-ת])…(?![א-ת])`, never `\b`, because `\b` is ASCII-only in JavaScript.
3. **Plan pages** whose frontmatter `status` or status line is still open.
4. **Hygiene:**
   - zero-byte vault pages;
   - backup copies of the memory index inside the memory directory;
   - session files under `~/.asm/sessions/` older than 30 days;
   - orphan memory files, which no index line links to;
   - references to paths that no longer exist.

### 9.2 Evidence (deterministic, no LLM)

For each candidate the janitor collects:

- later records from the same session;
- later records that touch the same files;
- later records that name the same commit hash, branch or task id;
- current ledger state.

Git is read locally only: no fetch, no ref changes. Evidence packs use the brief record form from section 8.6.

### 9.3 Deterministic pre-pass

These are proposed without calling the judge:

- **Duplicates.** Threads repeated verbatim across records: the newest copy is kept and the others are proposed as `thread.close.duplicate`.
- **Superseded records.** Threads on a superseded record: `thread.close.superseded`.
- **Hygiene archive** (auto): zero-byte pages, index backup copies, and session files older than 30 days.
- **Report only.** Orphan memory files and dangling references are proposed for review, never acted on automatically. An orphan may be the only place a resolution is recorded.

### 9.4 Judge contract

- **Engine.** `claude -p` with `--output-format json`, the environment variable `ASM_JOB=1`, and no tools. The prompt goes in and JSON comes out.
- **Batch.** 8 candidates per call, each with its evidence pack.

Output schema:

```json
{ "items": [ {
  "item_id": "<candidate id>",
  "verdict": "resolved | still_open | not_actionable | unknown",
  "resolved_by": "memory:<id> | null",
  "reason": "one sentence"
} ] }
```

**Prompt rules:**

- `resolved` requires an explicit later statement that the item was done, deployed, answered, decided or abandoned.
- Absence of a mention is `unknown`, never `resolved`.
- `not_actionable` is for caveats that require no action.
- `resolved_by` must be an id from the candidate's own evidence pack.

**Validation:**

- A verdict whose `resolved_by` is not in the pack is discarded.
- A missing item counts as `unknown`.
- Invalid JSON counts as one failure for every item in the batch.

**Actions:**

| Verdict | Candidate | Proposed class |
|---|---|---|
| `resolved` | thread | `thread.close.resolved` |
| `resolved` | status snapshot | `record.retire.status`, with `superseded_by` |
| `resolved` | plan page | `page.mark_done` |
| `not_actionable` | thread | `thread.close.not_actionable` |

`still_open` and `unknown` change nothing and update `items.json`.

### 9.5 Judge precision gate

Before any thread class can switch to `auto`:

1. The judge runs in dry-run mode on a labeled sample of 60 threads, each labeled by hand with its evidence.
2. The gate passes when at least 95% of the judge's `resolved` and `not_actionable` verdicts agree with the labels.
3. The result is stored in `trust.json.judge_gate`.
4. The sample is private and lives under `~/.asm/bench/`.

## 10. Curator: the learning layer

### 10.1 Scope

`~/.asm/jobs/curated.json` is private config that is never committed. It lists entries of the form `{project, page: "vault:<id>", repo_prefixes: [...], index_lines: ["idx:…"]}`.

**Project map:**

- Repository prefixes come from the existing external project map that another sync already maintains. Its path is set in the private config, and the curator reads it at run time.
- `curated.json` holds only the additions for projects that map lacks, so two maps never drift apart.
- A record belongs to the project with the longest matching path prefix among its `files`.

**Initial important set:**

- every index line in the memory index and in the hub pages;
- one page per active project.

### 10.2 Staleness

A curated block is stale when:

- a record in scope has `created_at` later than the block's watermark; or
- a record or thread the block cites was retired or closed after the watermark (retraction).

A block that is not stale is never sent to the model.

### 10.3 Delta refresh

**Input:**

- the current block, with bullet ids;
- the in-scope records newer than the watermark, in brief form;
- the list of retracted citations.

**Output:**

```json
{ "ops": [ {
  "op": "replace | remove | append",
  "block_id": "s-<slug>",
  "text": "…",
  "cites": ["memory:<id>"],
  "reason": "…"
} ] }
```

**Prompt rules:**

- Use the smallest operation.
- Keep anything that is not refuted.
- Remove or replace only on an explicit later statement about the same facet, or on a retraction.
- Every `text` cites at least one id from the input.
- Write "since <date>" for states that change over time.
- Never reword a bullet that no operation targets.

**Guards:**

- Operations on unknown block ids are dropped.
- Citations must come from the input.
- If every operation is dropped, the refresh fails and both content and watermark stay as they were.
- A result that would leave the block empty fails.
- The block has a budget of 1,500 characters. An `append` over budget is rejected unless another operation in the same response frees the space.

### 10.4 First build

A page without a block gets an initial one, built in full mode from in-scope records of the last 30 days. It is always a proposal (`block.refresh`), whatever the trust state.

### 10.5 Index lines

The curator proposes a rewrite for a curated `idx:` line only when the line contains two or more dated segments, or when the block of its project changed in the same run. The rewrite is one line of current state, at most 300 characters, taken from the page block and the memory file.

Dated segments in an index line move into the memory file's `## History` section in the same proposal (class `index.rewrite`).

### 10.6 Compaction

A memory file with two or more dated update sections gets a rewrite proposal (class `memfile.compact`):

- `## Current state`, derived from the dated sections;
- `## History`, which holds every dated section verbatim, newest first.

A mechanical check rejects the proposal unless every original non-empty line appears in the output.

### 10.7 Corrections

A pending `correct` operation is applied to its target file:

1. The claimed text is replaced with the truth.
2. A `History` line records the date, the claim, the truth and the evidence.

## 11. Runtime

### 11.1 Package and entry points

- The package is `jobs/`. `tsc` builds it into `jobs/dist/`, and `refresh.sh` deploys it to `~/.asm/jobs/`.
- The runner has two forms:
  - `node run.js --job janitor|curator|refresh|all [--dry-run] [--max-calls N]`
  - `node run.js --apply <run-id> <proposal-id…>`

### 11.2 Scheduler

**Detached run.** The SessionStart hook spawns `nice -n 10 node ~/.asm/jobs/run.js --job all` detached, with output going to `logs/<date>.log`, when all of these hold:

- `ASM_JOB` is unset;
- a job's `last_success` is older than 20 hours;
- no live lock exists.

The hook returns immediately.

**The spike comes first.** Plan task 1 verifies two things:

- a process detached from a SessionStart hook, both in the desktop app and in the CLI, can still read files under the user's Desktop after the parent session ends;
- it is not limited to 256 file descriptors.

If either check fails, the runner runs inside the session instead of detached. Per-item atomicity makes an interrupted run harmless.

### 11.3 Recursion guard

With `ASM_JOB=1`, every ASM hook is a no-op: session start, prompt recall, activity, memory gate and skill router. Model calls run with tools disabled; the exact CLI flag is confirmed in the spike.

### 11.4 Lock

`run.lock` holds `{pid, started_at}`. It counts as stale after 2 hours or when its process is gone.

### 11.5 Graph refresh

The `refresh` job runs `refresh.sh --changed` once a day, after Phase 0 has removed dated worktree copies from the graph.

### 11.6 Review

The `/asm-review` skill works in Hebrew and shows at most 5 items per group:

- It reads pending proposals and groups them by class.
- It supports approve all, approve by class, approve by item, reject, and edit.
- It applies approved proposals through `run.js --apply` and updates `trust.json`.

## 12. Failure handling

- **Loud failures.** `state.json` records the last success and the last error. The SessionStart banner prints the error when the last run failed, or when the last success is more than 48 hours old. No wrapper converts a failure into exit code 0.
- **Quarantine.** An item that fails 3 times is quarantined: skipped by later runs and listed in `/asm-review`. The run continues without it.
- **No clobbering.** Before writing, a job compares the target file's sha256 with the hash taken when the proposal was built. If a live session edited the file in between, the item is deferred to the next run.
- **Atomic writes.** Files are written to a temporary file and renamed into place. The ledger is appended with `O_APPEND` and fsync, like `memory.jsonl`.
- **Model errors.** A rate limit or an auth error stops the run without losing state; the next run resumes. Malformed JSON counts as one failure for each item in the batch.

## 13. Cost

- **Per-run caps.** The janitor makes at most 30 judge calls of 8 items each; the curator makes at most 10 page refreshes. Both caps are configurable.
- **Token reporting.** Each run report records the token usage parsed from the CLI's JSON output, and the banner shows the last run's call count.
- **Backlog.** The deterministic pre-pass runs first. After it, judged candidates are processed newest first, in daily slices.

## 14. Phases and acceptance

Implementation plans are written one phase at a time. Each phase must pass its acceptance check before the next phase's plan is written.

### Phase 0 — stop the bleeding

| # | Change | Acceptance |
|---|---|---|
| 0.1 | Baseline commit of the currently deployed state, taken before anything else (owner go-ahead) | `git status` is clean in the source tree, and the deployed runtime files match it byte for byte |
| 0.2 | Size caps and the tokenized query for `memory_recent` and `brain_context` (section 8.6–8.7) | `memory_recent(limit=50)` returns under 20,000 characters on the live store |
| 0.3 | `memory_record` tolerance and thread ids (section 7.3–7.6) | A call whose arguments leaked into `summary` succeeds with a warning, and a test reproduces the leaked form |
| 0.4 | Gate: quote-aware redirect parsing; a CLI fallback for recording when the MCP is absent; a no-op under `ASM_JOB` | `>` inside a quoted `jq`, `python -c` or `awk` argument marks no file, and a real redirect still does |
| 0.5 | Graph: hot-reload `brain.json` when its mtime changes; drop dated worktree copies from the merge | A changed `brain.json` is served without restarting the server, and the node count falls by the dated copies |
| 0.6 | SIGINT handler in the MCP server | The server exits on SIGINT within 1 second |
| 0.7 | One-time manual correction of the verified dangerous lines in the memory index, shown to the owner as a diff | The owner approves the diff |
| 0.8 | Archive the dead dreaming launchd job; do not revive it (owner approval) | The job is no longer loaded, and the plist is kept in the archive |

### Phase 1 — ledger and recall

- Ledger fold in JavaScript, Python and TypeScript, with a shared `tests/fixtures/lifecycle.json`.
- `resolves` and `corrects` in `memory_record`.
- The recall changes in section 8.
- The banner counts only open threads and prints their ids.
- The benchmark harness, with a baseline measured **before** the recall changes.

**Acceptance:** the parity fixtures pass in all three languages, the benchmark reports before and after, and no thread the ledger closed appears in recall.

### Phase 2 — janitor

- The spike (section 11.2).
- Runner, state, lock and logs.
- The deterministic pre-pass.
- The judge.
- The 60-thread labeled sample and the precision gate.
- `/asm-review` and `trust.json`.

**Acceptance:**

- The judge reaches at least 95% precision on the sample.
- The first real run produces a report.
- The benchmark does not regress.
- No content-class change is written without approval.

### Phase 3 — curator

- `curated.json`.
- Initial blocks for the important pages.
- Delta refresh and the retraction check.
- Index lines.
- Compaction.
- Corrections.

**Acceptance:**

- The benchmark shows 0 stale values next to current ones and 0 stale-only answers.
- Compaction keeps every original line.
- Bytes outside curated blocks are identical, proven by a test.

## 15. Constraints

- **Public repository.** Fixtures are synthetic. Scope config, benchmark data and labeled samples live under `~/.asm/`. Before any push, run the existing privacy grep.
- **Hebrew regular expressions** never use `\b`.
- **Test runs** use low parallelism (at most 2 workers, under `nice`), and the full suite runs only at the gate.
- **Review.** Every commit passes an adversarial review.
- **No commit or push** without the owner's explicit request.

## 16. Risks

| Risk | Mitigation |
|---|---|
| The judge closes a live thread | Precision gate, reversible ledger, proposals until trusted |
| The curator states a false current state | Citations from shown ids only, block-level operations, diffs until trusted, dry runs |
| A live session edits a file during a run | Hash check; defer the item |
| Model rate limits or cost | Per-run caps; stop and resume |
| A detached process behaves differently under TCC | Spike first; in-session fallback |
| The benchmark's "truth" drifts as projects move | The benchmark runs on a frozen snapshot of the stores, recorded with its sha256 |

## 17. Later, not now

- Observation notes: promoting recurring facts into new memory notes.
- Embeddings and a vector channel.
- A hotness signal from `usage.jsonl`.
