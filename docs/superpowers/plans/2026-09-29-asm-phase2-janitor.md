# ASM Phase 2 — Janitor (Cleanup Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background job finds open threads, status snapshots and plan pages that later evidence has already settled, and closes or retires them. It also archives mechanical debris. Each action is written through the ledger and is either reversible-automatic or proposed for the owner, according to a trust ladder and a judge-precision gate.

**Architecture:** TypeScript in `jobs/`, built to `jobs/dist/` and deployed to `~/.asm/jobs/`:

| Stage | Where it runs | What it does |
|---|---|---|
| Candidates, pre-pass, evidence | Deterministic code | Finds what to check and what later records say about it |
| Judge | `claude -p` (model `sonnet` by default, tools off, no MCP, `ASM_JOB=1`) | Returns one strict JSON verdict per candidate |
| Applier | Code | Writes ledger operations and edits files (hash-checked, atomic) |
| Runner | Code | Owns the lock, the state file, the logs and the trust ladder |

The SessionStart hook spawns the runner detached when a job is due. The owner reviews proposals through the `/asm-review` skill.

**Tech Stack:** TypeScript 5.8 `strict` NodeNext, Vitest, zod, Node child processes, CommonJS hooks.

**Spec:** `docs/superpowers/specs/2026-09-29-asm-learning-and-cleanup-layers-design.md` (sections 6.4, 6.5, 9, 11, 12, 13, 14 Phase 2)

## Global Constraints

- **Public repo:** synthetic fixtures only. Labels, cases and the real store stay under `~/.asm/`.
- **TypeScript rules:** no `any`; `readonly` by default; one class per file; constructor injection; errors are classes; `async/await` only; zod at the boundary; `.js` import suffixes; files ≤200 lines and functions ≤50 lines.
- **Hebrew regular expressions** never use `\b`. Use `(?<![א-ת])` and `(?![א-ת])`.
- **Nothing is deleted.** Moves go to `~/.asm/archive/`, and every file edit stores its `before` text in the ledger.
- **Classes.** Every thread-closure class stays `propose` until the judge gate passes (precision ≥0.95 on the 60 labelled threads). `hygiene.archive` is `auto` from the first run. Content classes follow the trust ladder: 3 consecutive runs approved without edits switch a class to `auto`.
- **Tests:** Vitest `maxWorkers=2` under `nice`, one run at a time.
- **Commits:** Hebrew title and body, and no push.

## Review Focus

- **Model output edge cases:**
  - a verdict whose `resolved_by` is not in the item's evidence pack is dropped;
  - a batch whose JSON is truncated counts one failure per item;
  - a model that answers in prose instead of JSON is a failure, not a verdict.
- **Concurrent edits:** a file edited by a live session between proposal and apply is deferred. It is never overwritten.
- **Runner locking:** a lock from a crashed runner is broken after 2 hours or when its pid is gone; a second runner exits without work.
- **Hebrew phrases:**
  - Status phrases in Hebrew ("לא נפרס", "ממתין לאישור") match with a prefix letter attached: "ו-לא נפרס" is not a word boundary problem; "שלא נפרס" must still match.
  - "נפרסה" must not match "לא נפרס".
- **Loud failures:** a runner that throws before writing its state still leaves `last_error` behind, so the banner shows it.

---

### Task 1: Store readers and shared types

**Files:**
- Create in `jobs/src/store/`:
  - `store.types.ts` (`MemoryRecord`, `VaultPage`);
  - `memory-store.ts` (the `MemoryStore` class: `load()`);
  - `vault-store.ts` (the `VaultStore` class: `pages()` reads `wiki/main/**/*.md` frontmatter — id, title, status, updatedAt, type — and `read(path)`);
  - `runtime-paths.ts` (`RuntimePaths`: resolves `~/.asm` or `ASM_HOME`, the vault and memory directory from `asm-paths.json`, plus the jobs directory layout).
- Test: `jobs/src/store/*.test.ts` against synthetic temp dirs.

### Task 2: Candidates, deterministic pre-pass and evidence packs

**Files:**
- Create in `jobs/src/janitor/`:
  - `candidates.ts` (`openThreads`, `statusSnapshots`, `planPages`);
  - `status-phrases.ts` (English and Hebrew negative-status patterns with Hebrew-safe boundaries);
  - `prepass.ts` (`duplicateThreads`);
  - `hygiene.ts` (`zeroBytePages`, `indexBackups`, `staleSessionFiles`, `orphanMemoryFiles`);
  - `evidence.ts` (`evidencePack`: at most 6 later records, scored +3 same session, +2 per shared file, +3 per shared commit hash (7–40 hex) or task tag, then by recency).
- Test: `candidates.test.ts`, `status-phrases.test.ts` (the Review Focus Hebrew cases), `prepass.test.ts`, `evidence.test.ts`.

### Task 3: The model runner and the judge

**Files:**
- Create in `jobs/src/model/`: `model-runner.ts` (interface `ModelRunner { run(prompt): Promise<ModelResult> }`) and `claude-runner.ts` (class `ClaudeRunner`: `claude -p --output-format json --tools "" --no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model <m>`, prompt on stdin, `ASM_JOB=1`, 180 s timeout; it maps a rate limit or auth error to `ModelUnavailableError`).
- Create in `jobs/src/janitor/`: `judge.prompt.ts` (the prompt builder) and `judge.ts` (class `Judge`: batches of 8, zod-validated output, `resolved_by` must be in the item's own pack).
- Test: `judge.test.ts` with a fake `ModelRunner` covering:
  - a valid batch;
  - a foreign `resolved_by`, which is dropped;
  - prose output, which counts as a failure;
  - a missing item, which becomes `unknown`;
  - a rate limit, which stops the run.

### Task 4: Trust ladder, proposals, applier

**Files:**
- Create in `jobs/src/trust/`: `trust-store.ts` (class `TrustStore`: `modeFor(class)`, `recordReview(class, outcome)`, `setGate(result)`).
- Create in `jobs/src/apply/`:
  - `proposal-store.ts` (class `ProposalStore`: `proposals/<run-id>.json`, `pending()`, `resolve(ids, decision)`);
  - `applier.ts` (class `Applier`: ledger operations, frontmatter `status` edits with before/after hashes, moves into the archive, and a hash check before every write);
  - `frontmatter.ts` (`setFrontmatterFields`, pure).
- Test:
  - the trust ladder switches after 3 clean approvals and resets on an edit or a restore;
  - `setFrontmatterFields` keeps every other byte;
  - the applier defers when the hash changed;
  - an archive move writes an operation whose `before.path` restores the file.

### Task 5: The janitor job and the judge gate

**Files:**
- Create in `jobs/src/janitor/`:
  - `janitor.ts` (class `Janitor`: candidates, then pre-pass, then evidence, then judge, then proposals or apply, with `items.json` state, a per-run cap and newest-first order);
  - `gate.ts` (`runGate(labels, judge)`: precision of the `resolved` and `not_actionable` verdicts against the labels).
- Test: `janitor.test.ts` covers a synthetic store end to end with a fake judge:
  - `propose` mode writes proposals only;
  - `auto` mode writes ledger operations;
  - a quarantine after 3 failures;
  - the cap is honored.

  `gate.test.ts` covers the precision computation, and shows that `unknown` verdicts are neither counted as right nor as wrong.

### Task 6: Runner, lock, state, CLI, scheduler hook

**Files:**
- Create in `jobs/src/runner/`:
  - `runner.ts` (class `Runner`: lock, `state.json`, logs, dispatch);
  - `lock.ts` (class `RunLock`);
  - `cli.ts`, with these commands:
    - `run --job janitor|curator|refresh|all [--dry-run] [--max-calls N]`
    - `review --list [--json]`
    - `apply <run-id> <ids|all|class:<name>>`
    - `reject <run-id> <ids>`
    - `restore <op-id>`
    - `gate --labels <file>`
    - `status`
- Modify: `hook/asm-session-start.js`:
  - spawn `nice -n 10 node ~/.asm/jobs/dist/runner/cli.js run --job all` detached when a job is due (20 h) and no live lock exists;
  - print a `Jobs:` line from `state.json` (last success and the last error, when the run failed or the last success is more than 48 h old) and the number of pending proposals.
- Modify: `refresh.sh`. It builds `jobs/` and deploys `dist/`, `package.json` and `package-lock.json` to `~/.asm/jobs/`, then runs `npm ci --omit=dev --prefer-offline` there.
- Test:
  - `lock.test.ts`;
  - `runner.test.ts` (a failure writes `last_error`);
  - `tests/test_asm_memory.py` hook tests: the banner shows a failed job; SessionStart spawns nothing under `ASM_JOB`.

### Task 7: The spike, the `/asm-review` skill, gate run, first real run

- [ ] **Spike.** From a Claude Code session, a detached child spawned by the SessionStart hook must, after the session ends:
  - read a file under the user's Desktop;
  - open more than 256 files.

  Record the result. If it fails, switch to the in-session fallback and record the ruling.
- [ ] **Skill.** `skills/asm-review/SKILL.md` (Hebrew UI, at most 5 items per group) is deployed by `refresh.sh` to `~/.claude/skills/asm-review/` and `~/.agents/skills/asm-review/`.
- [ ] **Gate.** Run it on `~/.asm/bench/thread-labels.json` and record the precision in `trust.json`.
- [ ] **First real run.** It stays in propose mode for every class except hygiene. Report the counts.
- [ ] **Benchmark.** Run it again on the snapshot, after applying the approved ledger operations to a copy of its ledger.
- [ ] **Review.** Adversarial review, one fix pass, then commit.
