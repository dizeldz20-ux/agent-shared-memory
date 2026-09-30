# ASM Phase 0 — Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the MCP faults and garbage generators that make agents see ASM as broken, before any new layer is built.

**Architecture:** Surgical changes to existing code only:

- the Python MCP server (`mcp_server.py`);
- the source discovery (`source_manifest.py`);
- the zero-dependency CommonJS hooks (`hook/*.js`).

There are no new services. Every fix carries a regression test in the existing `unittest` suite.

**Tech Stack:** Python 3.11 (FastMCP, stdlib), Node CommonJS hooks, `unittest`, `uv`.

**Spec:** `docs/superpowers/specs/2026-09-29-asm-learning-and-cleanup-layers-design.md` (section 14, Phase 0)

## Global Constraints

- **Public repository:** synthetic test data only. No product names, no user paths, no private vault content in code, tests or docs.
- **Hebrew regular expressions** never use `\b`. Use `(?<![א-ת])` and `(?![א-ת])`.
- **Existing code stays in its language:** Python stays Python; hooks stay zero-dependency CommonJS.
- **Tests** run under `nice` and one run at a time. The full suite runs only at the task gate.
- **The deployed runtime is `~/.asm`,** a copy. Source changes reach it through `refresh.sh` or an explicit `cp` of the same files.
- **Commits:** Hebrew title and body, and no push.

## Review Focus

- **Hebrew summaries:** a summary that contains Hebrew text and `</summary>` markup must still be recovered, and the size cap must count characters the way the client does (`indent=2` JSON, non-ASCII kept).
- **Heredocs:** the body of a heredoc whose delimiter is quoted (`<<'EOF'`) or unquoted (`<<EOF`) is data. A `>` inside it is never a redirect, but the redirect on the heredoc's own command line still is.
- **Real redirects:** `echo x > "a b.txt"` must still mark `a b.txt` after quote masking.
- **Graph reload while a search runs:** a reload replaces all graph globals together, so a search never mixes old nodes with new field caches.
- **Worktrees:** a worktree whose main checkout is not a mapped source must stay mapped, so it is not lost from the graph.

---

### Task 1: Baseline commit of the deployed state

**Files:**
- Commit: every tracked change and untracked source file in the working tree (`asm_text.py`, `frontend/scripts/liveRoster.test.mjs`, the spec, this plan).

- [ ] **Step 1: Prove the deployed runtime equals the working tree**

Run:
```bash
cd "$ASM_REPO"   # the source checkout
for f in mcp_server.py asm_text.py pyproject.toml; do cmp "$f" ~/.asm/"$f" && echo "same $f"; done
for f in asm-activity-hook.js asm-session-start.js asm-prompt-recall.js asm-memory-gate.js asm-skill-router.js; do cmp "hook/$f" ~/.asm/hooks/"$f" && echo "same $f"; done
```
Expected: `same` for all 8 files.

- [ ] **Step 2: Privacy grep over the uncommitted diff**

Run:
```bash
git diff | grep -n -i -E -f ~/.asm/privacy-patterns.txt ; git ls-files --others --exclude-standard | xargs grep -l -i -E -f ~/.asm/privacy-patterns.txt
```
Expected: no output. Any hit is neutralized to a generic word before committing.

- [ ] **Step 3: Commit the baseline, then the docs**

```bash
git add -A -- . ':!docs/superpowers'
git commit -m "בסיס: המצב הפרוס של ASM לפני שכבות הלמידה והניקיון" -m "..."
git add docs/superpowers
git commit -m "מסמכי תכנון: spec ותוכנית שלב 0 לשכבות הלמידה והניקיון" -m "..."
```
Expected: `git status --short` is empty.

---

### Task 2: Brief records and a size cap in `memory_recent` and `brain_context`

**Files:**
- Modify: `mcp_server.py` (`memory_recent`, `brain_context`; new `record_brief`, `_cap`)
- Test: `tests/test_asm_memory.py` (new class `OutputSizeTests`)

**Interfaces:**
- Produces:
  - `record_brief(record: dict) -> dict` with keys `id, created_at, agent, summary, files, open_threads, details_preview` (plus `superseded_by` when present).
  - `open_threads` is a list of `{"id": "<record-id>#<n>", "text": str}`.
  - `RECENT_MAX_CHARS = 20000` and `PREVIEW_CHARS = 300`.

- [ ] **Step 1: Write the failing tests**

```python
class OutputSizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()
        self.module = load_mcp(self.runtime)
        lines = []
        for index in range(60):
            lines.append(json.dumps({
                "id": f"rec{index:04d}", "session_id": "s", "created_at": "2026-09-01T10:00:00+03:00",
                "agent": "Test", "summary": f"alpha change {index} שינוי בעברית",
                "details": "x" * 10000, "files": [f"src/file{j}.py" for j in range(8)],
                "decisions": [], "open_threads": ["first thread", "second thread"],
            }, ensure_ascii=False))
        (self.runtime / "memory.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def serialized(self, value) -> int:
        return len(json.dumps(value, ensure_ascii=False, indent=2))

    def test_recent_is_capped_and_brief(self):
        result = self.module.memory_recent(limit=50)
        self.assertLessEqual(self.serialized(result), 20000)
        self.assertIn("truncated", result[-1])
        first = result[0]
        self.assertEqual(first["id"], "rec0059")
        self.assertEqual(len(first["details_preview"]), 300)
        self.assertEqual(len(first["files"]), 5)
        self.assertEqual(first["open_threads"][1], {"id": "rec0059#1", "text": "second thread"})

    def test_recent_query_matches_any_word(self):
        result = self.module.memory_recent(limit=5, query="alpha nonexistentword")
        self.assertTrue(result and result[0]["id"].startswith("rec"))

    def test_full_record_still_opens_by_id(self):
        record = self.module.brain_node("memory:rec0003")
        self.assertEqual(len(record["details"]), 10000)

    def test_context_shared_memory_is_brief_and_short(self):
        ctx = self.module.brain_context("/work/src/file1.py")
        self.assertLessEqual(len(ctx["shared_memory"]), 3)
        self.assertIn("details_preview", ctx["shared_memory"][0])
        self.assertLessEqual(self.serialized(ctx), 20000)
```

- [ ] **Step 2: Run to verify failure**

Run: `nice uv run python -m unittest tests.test_asm_memory.OutputSizeTests -v`
Expected: FAIL (`KeyError: 'details_preview'` / size assertion).

- [ ] **Step 3: Implement**

In `mcp_server.py` after `memory_brief`:
```python
RECENT_MAX_CHARS = 20000  # the client replaces results over ~50k characters with an error
PREVIEW_CHARS = 300


def record_brief(record: dict) -> dict:
    """A record as recall shows it: enough to decide whether to open it, never the full
    details. 43% of memory_recent calls went over the client's result cap before this."""
    threads = [str(value) for value in record.get("open_threads") or []]
    brief_record = {
        "id": record["id"],
        "created_at": record.get("created_at", ""),
        "agent": record.get("agent", ""),
        "summary": record.get("summary", ""),
        "files": list(record.get("files") or [])[:5],
        "open_threads": [{"id": f"{record['id']}#{i}", "text": text} for i, text in enumerate(threads)],
        "details_preview": str(record.get("details", ""))[:PREVIEW_CHARS],
    }
    if record.get("superseded_by"):
        brief_record["superseded_by"] = record["superseded_by"]
    return brief_record


def _cap(items: list[dict], limit: int = RECENT_MAX_CHARS) -> list[dict]:
    """Keep whole items until the serialized result would pass `limit` characters,
    counted the way FastMCP serializes (indent=2, non-ASCII kept)."""
    out: list[dict] = []
    used = 2
    for index, item in enumerate(items):
        size = len(json.dumps(item, ensure_ascii=False, indent=2)) + 4
        if used + size > limit - 200:
            out.append({"truncated": len(items) - index,
                        "hint": "open a full record with brain_node('memory:<id>')"})
            break
        out.append(item)
        used += size
    return out
```
Replace `memory_recent`:
```python
@mcp.tool()
def memory_recent(limit: int = 10, query: str = "") -> list[dict]:
    """Newest shared records from any agent, in brief form (summary, files, open threads with
    their ids, a details preview). Words in `query` filter the records; any word may match.
    Open a full record with brain_node('memory:<id>')."""
    records = list(reversed(memory_records()))
    tokens = tokenize(query) if query.strip() else []
    if tokens:
        records = [record for record in records if _field_hits(tokens, _record_fields(record))]
    return _cap([record_brief(record) for record in records[:max(1, min(limit, 50))]])
```
In `brain_context` replace the `shared_memory` block's final `[:10]` list with brief records capped at 3:
```python
    result["shared_memory"] = [record_brief(record) for record in reversed(memory_records())
                               if any(target == norm(str(item)) or target.endswith("/" + norm(str(item)))
                                      or norm(str(item)).endswith("/" + target)
                                      for item in record.get("files") or [])][:3]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -5`
Expected: `OK` (existing tests that asserted full `shared_memory` fields are updated to the brief form in the same step).

---

### Task 3: Tolerant `memory_record` and thread ids

**Files:**
- Modify: `mcp_server.py` (`memory_record`; new `_recover_leaked_arguments`)
- Test: `tests/test_asm_memory.py` (new class `RecordToleranceTests`)

**Interfaces:**
- Produces:
  - `memory_record(..., details: str = "")`. The response gains `warnings: list[str]` and `thread_ids: list[str]`.
  - `_recover_leaked_arguments(summary: str) -> tuple[str, dict[str, object]]` returns the clean summary and the recovered fields.

- [ ] **Step 1: Write the failing tests**

```python
class RecordToleranceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()
        self.module = load_mcp(self.runtime)

    def tearDown(self):
        self.temp.cleanup()

    def test_leaked_details_are_recovered(self):
        leaked = ('Fixed the parser for Hebrew input — תוקן</summary>\n'
                  '<parameter name="details">Root cause was a missing branch; verified with 12 tests.')
        result = self.module.memory_record(session_id="s-1", summary=leaked)
        self.assertTrue(result["ok"], result)
        record = result["record"]
        self.assertEqual(record["summary"], "Fixed the parser for Hebrew input — תוקן")
        self.assertTrue(record["details"].startswith("Root cause was a missing branch"))
        self.assertTrue(any("recovered" in w for w in result["warnings"]))

    def test_leaked_list_fields_are_recovered(self):
        leaked = ('Summary text here</summary>\n<parameter name="details">Long enough details text.</details>\n'
                  '<parameter name="open_threads">["check the gate", "rerun the sweep"]</open_threads>')
        result = self.module.memory_record(session_id="s-2", summary=leaked)
        self.assertEqual(result["record"]["open_threads"], ["check the gate", "rerun the sweep"])
        self.assertEqual(result["thread_ids"], [f"{result['record']['id']}#0", f"{result['record']['id']}#1"])

    def test_long_summary_moves_overflow_into_details(self):
        summary = "word " * 150
        result = self.module.memory_record(session_id="s-3", summary=summary, details="the original details")
        record = result["record"]
        self.assertLessEqual(len(record["summary"]), 500)
        self.assertIn("the original details", record["details"])
        self.assertIn("word word", record["details"].split("\n\n")[0])

    def test_missing_details_is_accepted_with_a_warning(self):
        result = self.module.memory_record(session_id="s-4", summary="Changed one config value")
        self.assertTrue(result["ok"])
        self.assertTrue(result["warnings"])

    def test_session_and_summary_are_still_required(self):
        self.assertFalse(self.module.memory_record(session_id="", summary="Changed one config value")["ok"])
        self.assertFalse(self.module.memory_record(session_id="s-5", summary="short")["ok"])
```

- [ ] **Step 2: Run to verify failure**

Run: `nice uv run python -m unittest tests.test_asm_memory.RecordToleranceTests -v`
Expected: FAIL (`TypeError: missing required argument 'details'`).

- [ ] **Step 3: Implement**

Before `memory_record`:
```python
_LEAK_START = "</summary>"
_LEAK_PARAM = re.compile(r'<parameter name="(\w+)">(.*?)(?=</\1>|</parameter>|<parameter name="|</invoke>|\Z)', re.S)
_LIST_FIELDS = {"files", "decisions", "open_threads", "supersedes"}


def _recover_leaked_arguments(summary: str) -> tuple[str, dict[str, object]]:
    """Some clients serialize a long `summary` with the later arguments collapsed into it as
    literal `</summary><parameter name="details">…` text. 80 of 850 calls failed that way."""
    if _LEAK_START not in summary:
        return summary, {}
    head, tail = summary.split(_LEAK_START, 1)
    recovered: dict[str, object] = {}
    for name, raw in _LEAK_PARAM.findall(tail):
        value = raw.strip()
        if name in _LIST_FIELDS:
            try:
                parsed = json.loads(value)
                recovered[name] = [str(item) for item in parsed] if isinstance(parsed, list) else [value]
            except ValueError:
                recovered[name] = [line.strip("- ").strip() for line in value.splitlines() if line.strip()]
        else:
            recovered[name] = value
    return head.strip(), recovered
```
Change the signature to `details: str = ""` and, at the top of the body, add:
```python
    warnings: list[str] = []
    summary, leaked = _recover_leaked_arguments(str(summary))
    if leaked:
        warnings.append("recovered arguments that arrived inside summary: " + ", ".join(sorted(leaked)))
        details = str(details or leaked.get("details", "") or "")
        files = files or leaked.get("files")  # type: ignore[assignment]
        decisions = decisions or leaked.get("decisions")  # type: ignore[assignment]
        open_threads = open_threads or leaked.get("open_threads")  # type: ignore[assignment]
        supersedes = supersedes or leaked.get("supersedes")  # type: ignore[assignment]
```
Replace the summary/details lines:
```python
    full_summary = " ".join(clean(summary, 20000).split())
    summary = full_summary[:500]
    details = clean(details, 12000)
    if len(full_summary) > 500:
        details = (full_summary[500:] + ("\n\n" + details if details else ""))[:12000]
        warnings.append("summary over 500 characters; the rest moved to the head of details")
```
Replace the `details` length error with a warning:
```python
    if len(details) < 20:
        warnings.append("details are short; the next agent needs the verified context")
```
Return `warnings` and `thread_ids = [f"{digest}#{i}" for i in range(len(normalized_threads))]` in the success response, and in the duplicate response.

Update the tool docstring's first line to say: `summary` is one line (at most 500 characters) naming what changed; the narrative goes in `details`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -5`
Expected: `OK`.

---

### Task 4: Hooks — quote- and heredoc-aware redirects, CLI fallback, `ASM_JOB` guard

**Files:**
- Modify: `hook/asm-activity-hook.js` (`shellMutationPaths`; new `maskShellData`, `readShellWord`, `redirectTargets`)
- Modify: `hook/asm-memory-gate.js` (fallback text; `ASM_JOB`)
- Modify: `hook/asm-prompt-recall.js`, `hook/asm-session-start.js`, `hook/asm-skill-router.js` (`ASM_JOB` guard)
- Modify: `mcp_server.py` (`--record` CLI in `__main__`)
- Test: `tests/test_asm_memory.py` (`HookContractTests`: new tests)

**Interfaces:**
- Produces:
  - `uv run --directory ~/.asm python mcp_server.py --record < record.json` prints the `memory_record` result as JSON and exits 0 on success, 1 on failure.
  - `ASM_JOB=1` makes every ASM hook a no-op.

- [ ] **Step 1: Write the failing tests** (added to `HookContractTests`)

```python
    def bash(self, session: str, command: str, cwd: str) -> Path:
        self.run_hook("asm-activity-hook.js", {
            "session_id": session, "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}, "cwd": cwd})
        return self.runtime / "sessions" / f"{session}.json"

    def test_greater_than_inside_quotes_or_heredoc_is_not_a_write(self):
        cwd = self.temp.name
        commands = [
            "jq 'select((.open_threads|length) > 1)' memory.jsonl",
            'python3 -c "print(1 if len(x) > 1 else 0)"',
            "awk '$3 > 1 {print}' file.txt",
            "python3 - <<'EOF'\nprint(\"age > 30d\")\nEOF",
            "python3 - <<EOF\nx = 2 > 1\nEOF",
        ]
        for index, command in enumerate(commands):
            marker = self.bash(f"quoted-{index}", command, cwd)
            self.assertFalse(marker.exists(), command)

    def test_real_redirects_still_mark_their_targets(self):
        cwd = self.temp.name
        marker = self.bash("real-1", 'echo hi > "out file.txt"', cwd)
        self.assertIn(str(Path(cwd) / "out file.txt"), json.loads(marker.read_text())["files"])
        marker = self.bash("real-2", "cat > notes.md <<'EOF'\nx > y\nEOF", cwd)
        self.assertEqual(json.loads(marker.read_text())["files"], [str(Path(cwd) / "notes.md")])

    def test_asm_job_turns_every_hook_off(self):
        env = {**self.env, "ASM_JOB": "1"}
        self.run_hook("asm-activity-hook.js", {"session_id": "job-1", "tool_name": "Write",
                                               "tool_input": {"file_path": "/work/a.py"}, "cwd": "/work"}, env=env)
        self.assertFalse((self.runtime / "sessions" / "job-1.json").exists())
        gate = self.run_hook("asm-memory-gate.js", {"session_id": "job-1"}, env=env)
        self.assertEqual(json.loads(gate.stdout), {"continue": True})
        start = self.run_hook("asm-session-start.js", {}, env=env)
        self.assertEqual(start.stdout, "")

    def test_gate_offers_a_shell_fallback(self):
        self.run_hook("asm-activity-hook.js", {"session_id": "fb-1", "tool_name": "Write",
                                               "tool_input": {"file_path": "/work/a.py"}, "cwd": "/work"})
        gate = json.loads(self.run_hook("asm-memory-gate.js", {"session_id": "fb-1"}).stdout)
        self.assertIn("mcp_server.py --record", gate["reason"])
```
And in `SharedMemoryTests`:
```python
    def test_record_cli_writes_the_same_record(self):
        payload = {"session_id": "cli-1", "summary": "Recorded from the shell fallback",
                   "details": "The MCP was not loaded in this session, so the CLI path was used."}
        done = subprocess.run([sys.executable, str(self.runtime / "mcp_server.py"), "--record"],
                              input=json.dumps(payload), text=True, capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(json.loads(done.stdout)["ok"])
        self.assertIn("cli-1", (self.runtime / "memory.jsonl").read_text(encoding="utf-8"))
```

- [ ] **Step 2: Run to verify failure**

Run: `nice uv run python -m unittest tests.test_asm_memory.HookContractTests tests.test_asm_memory.SharedMemoryTests -v 2>&1 | tail -20`
Expected: the new tests FAIL (a phantom `1` marker exists; no `--record`).

- [ ] **Step 3: Implement the activity-hook parser**

Add before `shellMutationPaths`:
```js
// Shell data — quoted strings and heredoc bodies — is text, not syntax. A `>` inside
// `jq '… > 1'`, `python -c "… > 1"` or a heredoc of Python code is a comparison, and
// reading it as a redirect marked phantom files named `1` and `30d` as written.
// Masking keeps every index, so a redirect found in the masked text is read back from
// the original (its target may itself be quoted).
function maskShellData(command) {
  const source = String(command || '');
  const out = source.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  const pendingHeredocs = [];
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += (ch === '"' && source[j] === '\\') ? 2 : 1;
      blank(i + 1, Math.min(j, source.length));
      i = j + 1;
      continue;
    }
    if (ch === '<' && source[i + 1] === '<' && source[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(["']?)([A-Za-z_][\w-]*)\2/.exec(source.slice(i));
      if (m) { pendingHeredocs.push({ strip: m[1] === '-', tag: m[3] }); i += m[0].length; continue; }
    }
    if (ch === '\n' && pendingHeredocs.length) {
      let j = i + 1;
      for (const doc of pendingHeredocs.splice(0)) {
        const start = j;
        while (j < source.length) {
          const end = source.indexOf('\n', j);
          const line = source.slice(j, end < 0 ? source.length : end);
          const closes = (doc.strip ? line.replace(/^\t+/, '') : line) === doc.tag;
          j = end < 0 ? source.length : end + 1;
          if (closes) { blank(start, j - line.length - (end < 0 ? 0 : 1)); break; }
          if (j >= source.length) blank(start, j);
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function readShellWord(source, start) {
  const ch = source[start];
  if (ch === '"' || ch === "'") {
    const end = source.indexOf(ch, start + 1);
    return end > start ? source.slice(start + 1, end) : '';
  }
  const m = /^[^\s|;&<>]+/.exec(source.slice(start));
  return m ? m[0] : '';
}

function redirectTargets(command) {
  const source = String(command || '');
  const masked = maskShellData(source);
  const targets = [];
  for (const m of masked.matchAll(/(?:^|\s)\d*(?:>>?|<>)[ \t]*(?!&)/g)) {
    const target = readShellWord(source, m.index + m[0].length);
    if (target) targets.push(target);
  }
  return targets;
}
```
In `shellMutationPaths` replace the redirect loop with:
```js
  for (const target of redirectTargets(command)) push(target);
```
and split segments on the masked text so a `|` or `;` inside quotes or heredocs does not start a new command. Keep the original text for `shellWords`:
```js
  const source = String(command || '');
  const masked = maskShellData(source);
  let from = 0;
  const segments = [];
  for (const m of masked.matchAll(/&&|\|\||[|;\n]/g)) { segments.push(source.slice(from, m.index)); from = m.index + m[0].length; }
  segments.push(source.slice(from));
  for (const segment of segments) { /* existing body unchanged */ }
```

- [ ] **Step 4: Implement the `ASM_JOB` guard and the gate fallback**

At the start of each stdin `end` handler, or at the top of the script for `asm-session-start.js` and `asm-skill-router.js`:
```js
if (process.env.ASM_JOB === '1') { /* ASM's own background jobs never feed ASM's hooks */ }
```
Per hook:
- Activity: `return process.exit(0);`
- Gate: `return allow(input);`, placed before the marker read.
- Prompt recall: `return;`
- Session start: wrap the main `try` so nothing prints.
- Skill router: exit before any output.

Append to the gate's `reason` text:
```
If the ASM MCP tools are not loaded in this session, record from the shell instead:
  uv run --directory ~/.asm python mcp_server.py --record < record.json
with record.json holding the same fields as JSON.
```

- [ ] **Step 5: Implement the `--record` CLI** (in `mcp_server.py` `__main__`, before the drain)

```python
    if "--record" in sys.argv[1:]:
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError as exc:
            print(json.dumps({"ok": False, "error": f"invalid JSON on stdin: {exc}"}))
            sys.exit(1)
        allowed = {"session_id", "summary", "details", "files", "decisions",
                   "open_threads", "agent", "supersedes"}
        outcome = memory_record(**{k: v for k, v in payload.items() if k in allowed})
        print(json.dumps(outcome, ensure_ascii=False))
        sys.exit(0 if outcome.get("ok") else 1)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -5`
Expected: `OK`.

---

### Task 5: Graph hot-reload, worktree exclusion, canonical-path fallback

**Files:**
- Modify: `mcp_server.py` (new `_load_graph`, `_fresh_graph`, `_worktree_main`, `_canonical_path`; `find_by_path`; every graph tool calls `_fresh_graph()`)
- Modify: `source_manifest.py` (`worktree_main`, and the worktree exclusion in `expanded_sources`)
- Test: `tests/test_asm_memory.py` (new classes `GraphReloadTests` and `WorktreeTests`)

**Interfaces:**
- Produces:
  - `source_manifest.worktree_main(project: Path) -> Path | None`
  - `mcp_server._canonical_path(file_path: str) -> str | None`
  - `brain_context` result key `resolved_via` (str) when the canonical fallback resolved the node.

- [ ] **Step 1: Write the failing tests**

```python
def make_worktree(root: Path, main: str, name: str) -> Path:
    (root / main / ".git" / "worktrees" / name).mkdir(parents=True)
    tree = root / name
    tree.mkdir()
    (tree / ".git").write_text(f"gitdir: {root / main / '.git' / 'worktrees' / name}\n", encoding="utf-8")
    return tree


class WorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "Projects"
        (self.root / "Main" / "src").mkdir(parents=True)
        (self.root / "Main" / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
        self.tree = make_worktree(self.root, "Main", "Main-feature-20260101")
        (self.tree / "src").mkdir()
        (self.tree / "src" / "app.py").write_text("x = 2\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_manifest_skips_worktrees_of_mapped_repos(self):
        config = self.root / "cfg" / "sources.json"
        config.parent.mkdir()
        config.write_text(json.dumps({"sources": [], "discoverSources": [{"root": str(self.root)}]}), encoding="utf-8")
        names = {Path(s["base"]).name for s in expanded_sources(config)}
        self.assertIn("Main", names)
        self.assertNotIn("Main-feature-20260101", names)
        self.assertIn("cfg", names)

    def test_manifest_keeps_a_worktree_whose_main_is_not_mapped(self):
        other = Path(self.temp.name).resolve() / "Elsewhere"
        make_worktree(other, "Repo", "Repo-x")
        (self.root / "Repo-x").symlink_to(other / "Repo-x")
        config = self.root / "cfg" / "sources.json"
        config.parent.mkdir(exist_ok=True)
        config.write_text(json.dumps({"sources": [], "discoverSources": [{"root": str(self.root)}]}), encoding="utf-8")
        names = {Path(s["base"]).name for s in expanded_sources(config)}
        self.assertIn("Repo-x", names)

    def test_context_resolves_a_worktree_path_to_the_main_checkout(self):
        runtime = Path(self.temp.name) / "runtime"
        runtime.mkdir()
        abs_main = str(self.root / "Main" / "src" / "app.py").lower()
        module = load_mcp(runtime, nodes=[{"id": "agents:main/src/app.py", "label": "app.py", "layer": "agents",
                                           "kind": "file", "path": "main/src/app.py", "abs": abs_main}], links=[])
        ctx = module.brain_context(str(self.tree / "src" / "app.py"))
        self.assertEqual(ctx["node"]["id"], "agents:main/src/app.py")
        self.assertIn("Main", ctx["resolved_via"])


class GraphReloadTests(unittest.TestCase):
    def test_a_rewritten_brain_is_served_without_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp)
            module = load_mcp(runtime)
            self.assertIn("error", module.brain_node("vault:new-page"))
            brain = json.loads((runtime / "brain.json").read_text(encoding="utf-8"))
            brain["nodes"].append({"id": "vault:new-page", "label": "New", "layer": "vault", "kind": "page",
                                   "path": "wiki/new.md", "abs": "", "meta": {"description": "fresh"}})
            (runtime / "brain.json").write_text(json.dumps(brain), encoding="utf-8")
            stamp = time.time() + 5
            os.utime(runtime / "brain.json", (stamp, stamp))
            self.assertEqual(module.brain_node("vault:new-page")["label"], "New")
            self.assertTrue(any(item["id"] == "vault:new-page" for item in module.brain_search("fresh")))
```

- [ ] **Step 2: Run to verify failure**

Run: `nice uv run python -m unittest tests.test_asm_memory.WorktreeTests tests.test_asm_memory.GraphReloadTests -v`
Expected: FAIL.

- [ ] **Step 3: Implement the manifest exclusion** (`source_manifest.py`)

```python
def worktree_main(project: Path) -> Path | None:
    """The main checkout of a git worktree (its `.git` is a file pointing into
    <main>/.git/worktrees/<name>), or None for anything else."""
    marker = project / ".git"
    try:
        if not marker.is_file():
            return None
        text = marker.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not text.startswith("gitdir:"):
        return None
    gitdir = Path(text.split(":", 1)[1].strip())
    if not gitdir.is_absolute():
        gitdir = (project / gitdir).resolve()
    parts = gitdir.parts
    if "worktrees" not in parts:
        return None
    cut = len(parts) - 1 - parts[::-1].index("worktrees")
    git_root = Path(*parts[:cut])
    return git_root.parent if git_root.name == ".git" else None
```
In `expanded_sources`, collect discovered projects first. Then drop every one whose `worktree_main(project)` resolves to the base of another kept source (explicit or discovered). Worktrees of a main checkout that is not mapped stay mapped.

- [ ] **Step 4: Implement the reload and the canonical fallback** (`mcp_server.py`)

- **Graph load.** Replace the import-time graph construction (`BRAIN`, `PAGE_WORDS`, `NODES`, `ADJ`, `ABS_INDEX`, `SUFFIX2`) with a module-level `_load_graph()`. It builds all of them into locals and then assigns every global in one statement, resetting `_NODE_FIELDS` and re-attaching memory records.
- **Freshness check.** `_fresh_graph()` compares `brain.json`'s `st_mtime_ns` with the loaded stamp. It reloads under a `threading.RLock`, and a failed reload keeps the old graph.
- **Wiring.** Call `_fresh_graph()` first in `brain_search`, `brain_node`, `brain_neighbors`, `brain_path`, `brain_context` and `memory_record`. The initial `_load_graph()` runs where the old record-attach loop ran.
- **Canonical fallback.** `_worktree_main` mirrors `source_manifest.worktree_main`, since the runtime is deployed without that module. `_canonical_path(file_path)` walks up from an absolute path (or from `<repo>/../../<path>` for a `Projects/…` relative path) to the first directory holding `.git`:
  - a `.git` directory returns `None`;
  - a `.git` file returns the path rewritten onto the main checkout.

  `find_by_path` tries it once when the normal lookup returns `None`, and `brain_context` adds `resolved_via` when the rewrite was used.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -5`
Expected: `OK`.

---

### Task 6: SIGINT exits the server

**Files:**
- Modify: `mcp_server.py` (`__main__`)
- Test: `tests/test_asm_memory.py` (`SharedMemoryTests.test_sigint_exits_quickly`)

- [ ] **Step 1: Write the failing test**

```python
    def test_sigint_exits_quickly(self):
        proc = subprocess.Popen([sys.executable, str(self.runtime / "mcp_server.py")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            proc.send_signal(signal.SIGINT)
            proc.wait(timeout=1.5)
        finally:
            if proc.poll() is None:
                proc.kill()
        self.assertIsNotNone(proc.returncode)
```
(`import signal` at the top of the test module.)

- [ ] **Step 2: Run to verify failure**

Run: `nice uv run python -m unittest tests.test_asm_memory.SharedMemoryTests.test_sigint_exits_quickly -v`
Expected: FAIL with `TimeoutExpired`.

- [ ] **Step 3: Implement** (first line of `__main__`)

```python
    import signal
    signal.signal(signal.SIGINT, lambda *_: os._exit(130))  # 290 of 296 shutdowns needed SIGTERM
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -3`
Expected: `OK`.

---

### Task 7: Retire the dreaming job and its banner line

**Files:**
- Modify: `hook/asm-session-start.js` (drop `dreamingLine`; count open threads only on non-superseded records)
- Test: `tests/test_asm_memory.py` (update the SessionStart dreaming test to assert the line is gone; add a superseded-record case to the open-threads test)
- Operational: unload `<dreaming-job-label>` and move its plist to `~/.asm/archive/launchd/`.

- [ ] **Step 1: Update the tests first**

- The dreaming test asserts that `"Dreaming:"` is absent from the SessionStart output.
- The open-thread test writes two records: one superseded by the other. The banner reports only one record.

- [ ] **Step 2: Run them to verify they fail**

Run: `nice uv run python -m unittest tests.test_asm_memory -k SessionStart -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Remove `dreamingLine()` and its use.
- In `openThreadsLine()`, first collect the `supersedes` ids of all records, then skip any record whose id is in that set.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice uv run python -m unittest tests.test_asm_memory -v 2>&1 | tail -3`
Expected: `OK`.

- [ ] **Step 5: Retire the launchd job (reversible)**

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/<dreaming-job-label>.plist
mkdir -p ~/.asm/archive/launchd
mv ~/Library/LaunchAgents/<dreaming-job-label>.plist ~/.asm/archive/launchd/
launchctl print "gui/$(id -u)/<dreaming-job-label>" 2>&1 | head -1
```
Expected: the last command reports that the service could not be found.

---

### Task 8: Deploy, verify on the live runtime, review, commit

- [ ] **Step 1: Full suite at the gate**

Run: `nice uv run python -m unittest discover -s tests 2>&1 | tail -3`
Expected: `OK`.

- [ ] **Step 2: Deploy the code files** (no graph re-extraction in this step)

```bash
cp -f mcp_server.py asm_text.py pyproject.toml ~/.asm/
cp -f hook/asm-activity-hook.js hook/asm-session-start.js hook/asm-prompt-recall.js hook/asm-memory-gate.js hook/asm-skill-router.js ~/.asm/hooks/
```

- [ ] **Step 3: Live checks against a copy of the real runtime**

Start the deployed server over stdio from a scratch copy of `~/.asm`. Brain files are symlinked; memory and event files are copied, so nothing real is written. Then:

- Call `memory_recent(limit=50)` and assert the result text is under 20,000 characters.
- Call `memory_record` with a leaked-argument summary and assert `ok` plus a warning.
- Call `brain_context` on a real worktree path and assert `resolved_via` is present.
- Send SIGINT and assert the process exits within 1 second.

Nothing is left running (checked with `pgrep`).

- [ ] **Step 4: Refresh the graph** without dated worktree copies: `./refresh.sh --changed`. Assert that the SessionStart node count dropped by roughly the worktree share and that no `*-2026MMDD` project node remains for a worktree of a mapped repo.

- [ ] **Step 5: Adversarial review** by a fresh reviewer over `git diff`. Fix the findings.

- [ ] **Step 6: Commit** with a Hebrew title and body, the verified numbers, and no push.
