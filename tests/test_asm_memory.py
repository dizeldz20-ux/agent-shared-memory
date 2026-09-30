import asyncio
import concurrent.futures
import importlib.util
import json
import re
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from codex_activity import ABS_PATH_RE, CodexRolloutWatcher, activity_from_rollout, code_mode_paths, js_text
from source_manifest import expanded_sources


PROJECT = Path(__file__).resolve().parents[1]


def load_mcp(runtime: Path, nodes=None, links=None):
    shutil.copy2(PROJECT / "mcp_server.py", runtime / "mcp_server.py")
    # asm_text.py is imported by the server; refresh.sh deploys it the same way.
    shutil.copy2(PROJECT / "asm_text.py", runtime / "asm_text.py")
    # lifecycle.py is the ledger reader the server imports; refresh.sh deploys it too.
    shutil.copy2(PROJECT / "lifecycle.py", runtime / "lifecycle.py")
    (runtime / "brain.json").write_text(json.dumps({
        "generatedAt": "2026-08-25T00:00:00Z",
        "nodes": nodes if nodes is not None else [
            {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "src/app.py", "abs": "/work/src/app.py"},
            {"id": "vault:app-rule", "label": "App rule", "layer": "vault", "kind": "page",
             "path": "wiki/app-rule.md", "meta": {"description": "Important regression rule", "tags": ["app"]}},
        ],
        "links": links if links is not None else [
            {"source": "agents:src/app.py", "target": "vault:app-rule", "type": "xlayer"}],
    }), encoding="utf-8")
    spec = importlib.util.spec_from_file_location(f"asm_mcp_test_{id(runtime)}", runtime / "mcp_server.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def load_server(runtime: Path, codex_home: Path):
    name = f"asm_server_test_{id(runtime)}"
    spec = importlib.util.spec_from_file_location(name, PROJECT / "server.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    try:
        with mock.patch.dict(os.environ, {
            "ASM_HOME": str(runtime),
            "CODEX_HOME": str(codex_home),
            "ASM_CODEX_ROLLOUT_FALLBACK": "0",
        }):
            spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return name, module


class SharedMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.vault = Path(self.temp.name) / "vault"
        self.runtime.mkdir()
        self.module = load_mcp(self.runtime)
        (self.runtime / "asm-paths.json").write_text(
            json.dumps({"vault": str(self.vault), "repo": str(PROJECT)}), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_record_is_immediate_durable_and_idempotent(self):
        result = self.module.memory_record(
            session_id="codex-test-1",
            summary="Added shared memory regression coverage",
            details="Verified that immediate JSONL and the Obsidian daily note receive the same record.",
            files=["src/app.py"],
            decisions=["Keep the runtime append-only"],
            open_threads=[],
            agent="Codex",
        )
        self.assertTrue(result["ok"])
        record = result["record"]
        memory_lines = (self.runtime / "memory.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(memory_lines), 1)
        self.assertEqual(json.loads(memory_lines[0])["session_id"], "codex-test-1")

        daily = Path(result["daily_path"])
        daily_text = daily.read_text(encoding="utf-8")
        self.assertIn("ASM ·", daily_text)
        self.assertIn("Added shared memory regression coverage", daily_text)
        self.assertIn("`src/app.py`", daily_text)

        duplicate = self.module.memory_record(
            session_id="codex-test-1",
            summary="Added shared memory regression coverage",
            details="Verified that immediate JSONL and the Obsidian daily note receive the same record.",
            files=["src/app.py"],
            decisions=["Keep the runtime append-only"],
            open_threads=[],
            agent="Codex",
        )
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len((self.runtime / "memory.jsonl").read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(daily.read_text(encoding="utf-8").count(f"Memory id: `{record['id']}`"), 1)

    def test_search_and_context_include_newer_shared_memory(self):
        self.module.memory_record(
            session_id="claude-test-2",
            summary="Prevented app startup regression",
            details="Kept the launch contract compatible and verified the mapped target file.",
            files=["/work/src/app.py"],
            decisions=[],
            open_threads=["Recheck on Windows"],
            agent="Claude Code",
        )
        search = self.module.brain_search("startup regression")
        self.assertTrue(any(item["id"].startswith("memory:") for item in search))
        context = self.module.brain_context("/work/src/app.py")
        self.assertEqual(context["node"]["id"], "agents:src/app.py")
        self.assertEqual(context["vault_pages"][0]["id"], "vault:app-rule")
        self.assertEqual(context["shared_memory"][0]["session_id"], "claude-test-2")

    @unittest.skipIf(os.name == "nt", "Windows cannot send SIGINT to a child process; Ctrl+C events need a shared console")
    def test_sigint_exits_quickly(self):
        # 290 of 296 logged shutdowns ignored SIGINT and had to be escalated to SIGTERM.
        proc = subprocess.Popen([sys.executable, str(self.runtime / "mcp_server.py")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            proc.send_signal(signal.SIGINT)
            proc.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            pass
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
                self.fail("the server was still running 1.5s after SIGINT")

    def test_record_cli_writes_the_same_record(self):
        # The gate's fallback for a session in which the ASM MCP tools are not loaded.
        payload = {"session_id": "cli-1", "summary": "Recorded from the shell fallback",
                   "details": "The MCP was not loaded in this session, so the CLI path was used."}
        done = subprocess.run([sys.executable, str(self.runtime / "mcp_server.py"), "--record"],
                              input=json.dumps(payload), text=True, capture_output=True, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(json.loads(done.stdout)["ok"])
        self.assertIn("cli-1", (self.runtime / "memory.jsonl").read_text(encoding="utf-8"))

    def run_record_cli(self, stdin: str):
        return subprocess.run([sys.executable, str(self.runtime / "mcp_server.py"), "--record"],
                              input=stdin, text=True, capture_output=True, timeout=10)

    def test_record_cli_validates_its_input(self):
        done = self.run_record_cli(json.dumps({"session_id": "cli-2", "summary": "Recorded from the shell fallback",
                                               "details": "One file and one thread, given as plain strings.",
                                               "files": "src/app.py", "open_threads": "rerun the sweep"}))
        record = json.loads(done.stdout)["record"]
        self.assertEqual(record["files"], ["src/app.py"])
        self.assertEqual(record["open_threads"], ["rerun the sweep"])
        for bad in ("", "[1, 2]", "not json"):
            done = self.run_record_cli(bad)
            self.assertEqual(done.returncode, 1, bad)
            self.assertFalse(json.loads(done.stdout)["ok"], bad)

    def test_record_rejects_empty_handoffs(self):
        result = self.module.memory_record("", "short", "too short")
        self.assertFalse(result["ok"])

    def test_record_scrubs_credentials_and_reports_only_the_kinds(self):
        key = "sk-ant-" + "a1b2c3d4e5" * 4
        result = self.module.memory_record(
            session_id="scrub-1",
            summary="Rotated the provider key",
            details=f"New key {key} stored in the vault; password: hunter22hunter is the DB one.",
            files=[], decisions=[f"Authorization: Bearer {'x1' * 12} was the old header"],
            open_threads=["Card 4111 1111 1111 1111 must be removed from the test fixture"],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["redactions"], ["api-key", "credential-pair", "bearer", "credit-card"])
        stored = (self.runtime / "memory.jsonl").read_text(encoding="utf-8")
        self.assertNotIn(key, stored)
        self.assertNotIn("hunter22hunter", stored)
        self.assertIn("[redacted: api-key]", stored)
        self.assertIn("****1111", stored)
        # Operational facts and code talk stay: phones, internal addresses, `token: string`.
        plain = self.module.memory_record(
            "scrub-2", "Support line documented",
            "The bot answers on 0500000000 via 192.0.2.12; token: string, password: required field, "
            "secret = os.environ['TOWER_CREDENTIAL_KEY'], Basic authentication-header parsing.")
        self.assertEqual(plain["redactions"], [])
        self.assertIn("0500000000", plain["record"]["details"])
        self.assertIn("password: required field", plain["record"]["details"])
        self.assertIn("os.environ['TOWER_CREDENTIAL_KEY']", plain["record"]["details"])

    def test_superseded_record_leaves_recall_but_stays_readable_by_id(self):
        first = self.module.memory_record("sup-1", "Startup flag defaults to off", "Verified the launcher reads STARTUP_FLAG=0 by default.")["record"]
        second = self.module.memory_record(
            "sup-2", "Startup flag defaults to on since v2", "Re-verified after the v2 launcher change.",
            supersedes=[f"memory:{first['id']}"])["record"]
        self.assertEqual(second["supersedes"], [first["id"]])
        ids = [item["id"] for item in self.module.brain_search("startup flag")]
        self.assertIn(f"memory:{second['id']}", ids)
        self.assertNotIn(f"memory:{first['id']}", ids)
        self.assertEqual([r["id"] for r in self.module.memory_recent()], [second["id"]])
        by_id = self.module.brain_node(f"memory:{first['id']}")
        self.assertEqual(by_id["superseded_by"], second["id"])
        # The retired record also leaves the graph; a typo'd id is reported, not obeyed.
        self.assertNotIn(f"memory:{first['id']}", self.module.NODES)
        self.assertIn(f"memory:{second['id']}", self.module.NODES)
        typo = self.module.memory_record("sup-3", "Unrelated note about the launcher", "Nothing to retire here really.",
                                         supersedes=["deadbeefdeadbeef", "sup-3"])
        self.assertEqual(typo["ignored_supersedes"], ["deadbeefdeadbeef", "sup-3"])
        self.assertNotIn("supersedes", typo["record"])
        # Explicit search still reads details, unlike the prompt hook.
        self.assertTrue(any(item["id"] == f"memory:{typo['record']['id']}"
                            for item in self.module.brain_search("retire")))

    def test_records_join_the_graph_through_fail_closed_touches_edges(self):
        record = self.module.memory_record(
            "graph-1", "Hardened the app entrypoint", "Added the guard and the regression test.",
            files=["/work/src/app.py", "README.md", "nowhere/else.py"])["record"]
        mid = f"memory:{record['id']}"
        neighbors = self.module.brain_neighbors("agents:src/app.py")
        touching = [n for n in neighbors if n["id"] == mid]
        self.assertEqual(len(touching), 1)
        self.assertEqual(touching[0]["via"], "touches")
        self.assertEqual(touching[0]["kind"], "memory")
        # README.md (one segment) and nowhere/else.py (unknown) attach to nothing.
        self.assertEqual([n["id"] for n in self.module.brain_neighbors(mid)], ["agents:src/app.py"])
        self.assertIsNone(self.module.find_by_path("app.py"))
        self.assertEqual(self.module.find_by_path("src/app.py"), "agents:src/app.py")

    def test_neighbor_cap_never_hides_knowledge_behind_code_edges(self):
        hub = {"id": "agents:src/hub.py", "label": "hub.py", "layer": "agents", "kind": "file",
               "path": "src/hub.py", "abs": "/work/src/hub.py"}
        leaves = [{"id": f"agents:src/leaf{i}.py", "label": f"leaf{i}.py", "layer": "agents", "kind": "file",
                   "path": f"src/leaf{i}.py", "abs": f"/work/src/leaf{i}.py"} for i in range(70)]
        page = {"id": "vault:hub-rule", "label": "Hub rule", "layer": "vault", "kind": "page",
                "path": "wiki/hub.md", "meta": {"description": "Hub trap", "tags": []}}
        links = [{"source": hub["id"], "target": leaf["id"], "type": "code", "weight": 1} for leaf in leaves]
        links.append({"source": page["id"], "target": hub["id"], "type": "xlayer"})
        module = load_mcp(self.runtime, nodes=[hub, page, *leaves], links=links)
        record = module.memory_record("cap-1", "Refactored the hub module", "Split the hub into leaves.",
                                      files=["/work/src/hub.py"])["record"]
        vias = [n["via"] for n in module.brain_neighbors(hub["id"])]
        self.assertEqual(len(vias), 50)
        self.assertEqual(vias[:2], ["xlayer", "touches"])
        context = module.brain_context("/work/src/hub.py")
        self.assertEqual(context["vault_pages"][0]["id"], "vault:hub-rule")
        self.assertEqual(context["shared_memory"][0]["id"], record["id"])

    def test_find_by_path_refuses_an_ambiguous_suffix(self):
        module = load_mcp(self.runtime, nodes=[
            {"id": "a:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "src/app.py", "abs": "/work/a/src/app.py"},
            {"id": "b:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "src/app.py", "abs": "/work/b/src/app.py"},
        ], links=[])
        self.assertIsNone(module.find_by_path("src/app.py"))
        self.assertEqual(module.find_by_path("/work/a/src/app.py"), "a:src/app.py")
        self.assertEqual(module.find_by_path("b/src/app.py"), "b:src/app.py")

    def test_node_opens_are_logged_to_usage(self):
        self.module.brain_node("vault:app-rule")
        self.module.brain_node("vault:does-not-exist")
        self.module.brain_context("/work/src/app.py")
        self.module.brain_context("nowhere.py")
        rows = [json.loads(line) for line in (self.runtime / "usage.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["node_id"] for row in rows], ["vault:app-rule", "agents:src/app.py"])
        self.assertTrue(all(row["ts"] for row in rows))


class RetrievalTests(unittest.TestCase):
    """The prompt hook and brain_search must agree on tokens and rank by evidence, not volume."""

    FIXTURES = json.loads((PROJECT / "tests" / "fixtures" / "tokenize.json").read_text(encoding="utf-8"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_python_and_hook_tokenizers_agree_on_the_fixtures(self):
        module = load_mcp(self.runtime)
        for case in self.FIXTURES:
            with self.subTest(text=case["text"]):
                self.assertEqual(module.tokenize(case["text"]), case["tokens"])
                hook = subprocess.run(
                    ["node", str(PROJECT / "hook" / "asm-prompt-recall.js"), "--tokenize", case["text"]],
                    capture_output=True, text=True, check=True, timeout=8)
                self.assertEqual(json.loads(hook.stdout), case["tokens"])

    def test_search_ranks_a_rare_token_above_a_token_shared_by_many_files(self):
        nodes = [
            {"id": f"agents:{d}/index.ts", "label": "index.ts", "layer": "agents", "kind": "file",
             "path": f"{d}/index.ts", "abs": f"/work/{d}/index.ts"} for d in ("a", "b", "c")
        ] + [
            {"id": "vault:startup-rule", "label": "Regression guide", "layer": "vault", "kind": "page",
             "path": "wiki/guide.md", "meta": {"description": "startup regression rule", "tags": []}},
            {"id": "vault:scanner", "label": "Scanner", "layer": "vault", "kind": "page",
             "path": "wiki/scanner.md",
             "meta": {"description": "AWS fleet monitor", "tags": ["ops"], "aliases": ["סורק"]}},
        ]
        module = load_mcp(self.runtime, nodes=nodes, links=[])
        # Raw field weights alone put the three index.ts files (label+path = 3) above the
        # page (description only = 1, x1.25); IDF over the hit set inverts that.
        results = module.brain_search("index.ts startup")
        self.assertEqual(results[0]["id"], "vault:startup-rule")
        self.assertEqual(len(results), 4)
        # A Hebrew alias is matched after the same stemming the hook applies.
        self.assertEqual(module.brain_search("הסורק")[0]["id"], "vault:scanner")
        self.assertEqual(module.brain_search("   "), [])



class MissingLedgerModuleTests(unittest.TestCase):
    """A runtime where mcp_server.py was deployed without lifecycle.py must still open: a
    partial deploy used to take the whole brain down with an ImportError at start."""

    def test_the_server_records_without_the_ledger_module(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp)
            for name in ("mcp_server.py", "asm_text.py"):
                shutil.copy2(PROJECT / name, runtime / name)
            (runtime / "brain.json").write_text(json.dumps({"generatedAt": "x", "nodes": [], "links": []}), encoding="utf-8")
            payload = {"session_id": "no-ledger", "summary": "Recorded without the ledger module",
                       "details": "lifecycle.py was not deployed next to the server.", "resolves": ["vault:x"]}
            done = subprocess.run([sys.executable, "-S", str(runtime / "mcp_server.py"), "--record"],
                                  input=json.dumps(payload), text=True, capture_output=True, timeout=20,
                                  env={**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if p and "site-packages" in p)})
            self.assertEqual(done.returncode, 0, done.stderr)
            result = json.loads(done.stdout)
            self.assertTrue(result["ok"])
            self.assertEqual(result["resolved"], [])
            self.assertIn("lifecycle.py is missing", done.stderr)

class HookContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "asm"
        self.runtime.mkdir()
        self.env = {
            **os.environ,
            "ASM_HOME": str(self.runtime),
            "ASM_EVENT_URL": "http://127.0.0.1:9/api/events",
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_hook(self, name: str, payload: dict, *, env=None):
        return subprocess.run(
            ["node", str(PROJECT / "hook" / name)],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            env=self.env if env is None else env,
            timeout=8,
            check=True,
        )

    def test_activity_marks_codex_mutation_and_stop_gate_allows_after_record(self):
        payload = {
            "session_id": "codex-hook-1",
            "turn_id": "turn-1",
            "model": "gpt-test",
            "tool_name": "apply_patch",
            "tool_input": {"command": "*** Update File: /work/src/app.py\n@@\n-old\n+new"},
            "cwd": "/work",
        }
        self.run_hook("asm-activity-hook.js", payload)
        marker = json.loads((self.runtime / "sessions" / "codex-hook-1.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["files"], ["/work/src/app.py"])
        self.assertTrue(marker["agent"].startswith("Codex"))
        self.assertTrue((self.runtime / "pending.jsonl").exists())

        blocked = self.run_hook("asm-memory-gate.js", {"session_id": "codex-hook-1"})
        gate = json.loads(blocked.stdout)
        self.assertEqual(gate["decision"], "block")
        self.assertIn("mcp__asm__memory_record", gate["reason"])

        with (self.runtime / "memory.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "m1", "session_id": "codex-hook-1"}) + "\n")
        allowed = self.run_hook("asm-memory-gate.js", {"session_id": "codex-hook-1"})
        self.assertEqual(json.loads(allowed.stdout), {"continue": True})

    def test_read_only_session_is_never_blocked(self):
        allowed = self.run_hook("asm-memory-gate.js", {"session_id": "read-only"})
        self.assertEqual(json.loads(allowed.stdout), {"continue": True})

    def test_pre_tool_use_reports_file_and_marks_mutation_before_stop_can_race(self):
        target = Path(self.temp.name) / "project" / "src" / "live.ts"
        target.parent.mkdir(parents=True)
        target.write_text("export const live = true;\n", encoding="utf-8")
        payload = {
            "hook_event_name": "PreToolUse",
            "tool_use_id": "toolu_live_file_1",
            "session_id": "claude-live-1",
            "tool_name": "Edit",
            "tool_input": {"file_path": str(target)},
            "cwd": str(target.parents[1]),
        }
        self.run_hook("asm-activity-hook.js", payload)
        buffered = [json.loads(line) for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(buffered[-1]["phase"], "start")
        self.assertEqual(buffered[-1]["operation_id"], "toolu_live_file_1")
        self.assertEqual(buffered[-1]["paths"], [str(target)])
        self.assertTrue(buffered[-1]["file_access"])
        marker = json.loads(
            (self.runtime / "sessions" / "claude-live-1.json").read_text(encoding="utf-8")
        )
        self.assertTrue(marker["mutated"])
        self.assertEqual(marker["files"], [str(target)])

        payload["hook_event_name"] = "PostToolUse"
        self.run_hook("asm-activity-hook.js", payload)
        buffered = [json.loads(line) for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(buffered[-1]["phase"], "finish")
        self.assertEqual(buffered[-1]["operation_id"], "toolu_live_file_1")
        self.assertTrue((self.runtime / "sessions" / "claude-live-1.json").exists())

    def test_codex_bash_hook_extracts_existing_file_paths_and_keeps_presence(self):
        target = Path(self.temp.name) / "project" / "src" / "widget.tsx"
        target.parent.mkdir(parents=True)
        target.write_text("export const widget = true;\n", encoding="utf-8")
        payload = {
            "session_id": "codex-bash-1",
            "turn_id": "turn-2",
            "model": "gpt-test",
            "tool_name": "Bash",
            "tool_input": {"command": "sed -n '1,80p' src/widget.tsx"},
            "cwd": str(target.parents[1]),
        }
        self.run_hook("asm-activity-hook.js", payload)
        buffered = [json.loads(line) for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(buffered[-1]["paths"], [str(target)])
        self.assertTrue(buffered[-1]["agent"].startswith("Codex"))

        payload["tool_name"] = "update_plan"
        payload["tool_input"] = {"plan": []}
        self.run_hook("asm-activity-hook.js", payload)
        buffered = [json.loads(line) for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(buffered[-1]["paths"], [])

    def test_bash_hook_rejects_globs_and_shell_code_from_parallel_agent_lanes(self):
        target = Path(self.temp.name) / "project" / "src" / "widget.tsx"
        target.parent.mkdir(parents=True)
        target.write_text("export const widget = true;\n", encoding="utf-8")
        payload = {
            "session_id": "claude-bash-noise",
            "tool_name": "Bash",
            "tool_input": {
                "command": (
                    "node -e 'console.log(json.stringify(msgs:r.messages.length))' "
                    "&& rg pattern src/widget.tsx *.ts r.status"
                ),
            },
            "cwd": str(target.parents[1]),
        }
        self.run_hook("asm-activity-hook.js", payload)
        buffered = [
            json.loads(line)
            for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(buffered[-1]["paths"], [str(target)])
        self.assertEqual(buffered[-1]["agent"], "Claude Code")

    def test_grep_and_glob_directories_never_become_file_access(self):
        directory = Path(self.temp.name) / "project" / "src"
        directory.mkdir(parents=True)
        for tool in ("Grep", "Glob"):
            self.run_hook("asm-activity-hook.js", {
                "hook_event_name": "PreToolUse",
                "tool_use_id": f"toolu_{tool.lower()}_directory",
                "session_id": "claude-directory-search",
                "tool_name": tool,
                "tool_input": {"path": str(directory), "pattern": "*.ts"},
                "cwd": str(directory.parent),
            })
        buffered = [
            json.loads(line)
            for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual([event["paths"] for event in buffered[-2:]], [[], []])
        self.assertEqual([event["file_access"] for event in buffered[-2:]], [False, False])

    def test_grok_camel_case_activity_is_normalized_and_gated(self):
        target = Path(self.temp.name) / "project" / "src" / "grok.ts"
        target.parent.mkdir(parents=True)
        target.write_text("export const before = true;\n", encoding="utf-8")
        payload = {
            "hookEventName": "pre_tool_use",
            "sessionId": "grok-camel-1",
            "toolUseId": "grok-tool-1",
            "toolName": "search_replace",
            "toolInput": {"path": str(target), "old_string": "before", "new_string": "after"},
            "workspaceRoot": str(target.parents[1]),
        }
        self.run_hook("asm-activity-hook.js", payload)
        payload["hookEventName"] = "post_tool_use"
        self.run_hook("asm-activity-hook.js", payload)

        buffered = [
            json.loads(line)
            for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual([item["phase"] for item in buffered[-2:]], ["start", "finish"])
        self.assertEqual(buffered[-1]["agent"], "Grok Build")
        self.assertEqual(buffered[-1]["tool"], "Edit")
        self.assertEqual(buffered[-1]["paths"], [str(target)])
        marker = json.loads((self.runtime / "sessions" / "grok-camel-1.json").read_text(encoding="utf-8"))
        self.assertTrue(marker["mutated"])

        blocked = self.run_hook("asm-memory-gate.js", {
            "hookEventName": "stop",
            "sessionId": "grok-camel-1",
            "stopHookActive": False,
        })
        self.assertEqual(json.loads(blocked.stdout)["decision"], "block")

    def test_cursor_session_start_uses_stdin_contract_without_cursor_environment(self):
        (self.runtime / "brain.json").write_text(json.dumps({
            "generatedAt": "2026-08-25T00:00:00Z",
            "nodes": [{"id": "asm:one", "layer": "asm"}],
        }), encoding="utf-8")
        env = dict(self.env)
        env.pop("CURSOR_VERSION", None)
        result = self.run_hook("asm-session-start.js", {
            "hook_event_name": "sessionStart",
            "cursor_version": "2.4.1",
            "session_id": "cursor-session-start-1",
            "is_background_agent": False,
            "composer_mode": "agent",
        }, env=env)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {"additional_context"})
        self.assertIn("ASM — AGENT SHARED MEMORY ONLINE", output["additional_context"])
        self.assertIn("asm:1", output["additional_context"])

    def test_kimi_and_cursor_activity_keep_the_correct_agent_identity(self):
        project = Path(self.temp.name) / "project"
        project.mkdir()
        kimi_payload = {
            "hook_event_name": "PostToolUse",
            "client_type": "kimi_code_cli",
            "session_id": "kimi-1",
            "tool_name": "Write",
            "tool_input": {"path": "src/new-kimi.ts"},
            "cwd": str(project),
        }
        self.run_hook("asm-activity-hook.js", kimi_payload)

        cursor_target = project / "src" / "cursor.ts"
        cursor_target.parent.mkdir()
        cursor_target.write_text("export {};\n", encoding="utf-8")
        cursor_payload = {
            "hook_event_name": "postToolUse",
            "cursor_version": "test",
            "session_id": "cursor-1",
            "model": "claude-test",
            "tool_name": "Write",
            "tool_input": {"path": str(cursor_target)},
            "cwd": str(project),
        }
        self.run_hook("asm-activity-hook.js", cursor_payload)

        buffered = [
            json.loads(line)
            for line in (self.runtime / "pending.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(buffered[-2]["agent"], "Kimi Code")
        self.assertEqual(buffered[-2]["paths"], ["src/new-kimi.ts"])
        self.assertEqual(buffered[-1]["agent"], "Cursor")
        self.assertNotIn("Codex", buffered[-1]["agent"])

        kimi_blocked = self.run_hook("asm-memory-gate.js", {
            "hook_event_name": "Stop",
            "client_type": "kimi_code_cli",
            "session_id": "kimi-1",
            "stop_hook_active": False,
        })
        kimi_gate = json.loads(kimi_blocked.stdout)
        reason = kimi_gate["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertEqual(kimi_gate, {
            "hookSpecificOutput": {
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            },
        })
        self.assertIn("ASM memory gate", reason)

        kimi_allowed = self.run_hook("asm-memory-gate.js", {
            "hook_event_name": "Stop",
            "client_type": "kimi_code_cli",
            "session_id": "kimi-1",
            "stop_hook_active": True,
        })
        self.assertEqual(kimi_allowed.stdout, "")

        blocked = self.run_hook("asm-memory-gate.js", {
            "cursor_version": "test",
            "session_id": "cursor-1",
            "loop_count": 0,
        })
        self.assertIn("followup_message", json.loads(blocked.stdout))

    def test_cursor_delete_and_narrow_shell_mutations_are_gated(self):
        project = Path(self.temp.name) / "project"
        source = project / "src" / "input.ts"
        deleted = project / "src" / "deleted.ts"
        source.parent.mkdir(parents=True)
        source.write_text("export const input = true;\n", encoding="utf-8")
        deleted.write_text("export const deleted = true;\n", encoding="utf-8")

        self.run_hook("asm-activity-hook.js", {
            "hook_event_name": "postToolUse",
            "cursor_version": "test",
            "session_id": "cursor-delete-1",
            "tool_name": "Delete",
            "tool_input": {"path": str(deleted)},
            "cwd": str(project),
        })
        delete_marker = json.loads(
            (self.runtime / "sessions" / "cursor-delete-1.json").read_text(encoding="utf-8")
        )
        self.assertEqual(delete_marker["files"], [str(deleted)])
        self.assertEqual(delete_marker["agent"], "Cursor")

        self.run_hook("asm-activity-hook.js", {
            "hook_event_name": "PostToolUse",
            "client_type": "kimi_code_cli",
            "session_id": "kimi-shell-copy-1",
            "tool_name": "Shell",
            "tool_input": {"command": "cp src/input.ts src/output.ts"},
            "cwd": str(project),
        })
        copy_marker = json.loads(
            (self.runtime / "sessions" / "kimi-shell-copy-1.json").read_text(encoding="utf-8")
        )
        self.assertEqual(copy_marker["files"], [str(project / "src" / "output.ts")])
        self.assertEqual(copy_marker["agent"], "Kimi Code")

        self.run_hook("asm-activity-hook.js", {
            "hook_event_name": "PostToolUse",
            "cursor_version": "test",
            "session_id": "cursor-shell-read-only-1",
            "tool_name": "Shell",
            "tool_input": {"command": "sed -n '1p' src/input.ts"},
            "cwd": str(project),
        })
        self.assertFalse((self.runtime / "sessions" / "cursor-shell-read-only-1.json").exists())

    def write_index(self):
        (self.runtime / "brain.index.json").write_text(json.dumps([
            {"i": "vault:app-rule", "l": "App rule", "k": "page", "p": "wiki/app-rule.md",
             "d": "Important regression rule for widget startup", "t": ["app"]},
            {"i": "vault:other-rule", "l": "Other rule", "k": "page", "p": "wiki/other-rule.md",
             "d": "Unrelated deployment checklist", "t": ["ops"]},
            {"i": "vault:scanner", "l": "Scanner", "k": "page", "p": "wiki/scanner.md",
             "d": "AWS fleet monitor", "t": ["ops"], "a": ["סורק"]},
        ], ensure_ascii=False), encoding="utf-8")

    def test_prompt_recall_matches_hebrew_aliases_and_fresh_memory_records(self):
        self.write_index()
        (self.runtime / "memory.jsonl").write_text(json.dumps({
            "id": "abc123", "created_at": "2026-08-28T09:00:00+03:00", "agent": "Codex",
            "summary": "Widget deploy pipeline repaired",
            "details": "x" * 3000, "files": ["src/widget.ts"], "decisions": [],
            "open_threads": ["Re-run the deploy on staging"],
        }) + "\n", encoding="utf-8")
        hebrew = self.run_hook("asm-prompt-recall.js", {"prompt": "תבדוק את הסורק ב-AWS"}).stdout
        self.assertIn("vault:scanner", hebrew)
        self.assertNotIn("vault:app-rule", hebrew)
        # One alias hit stands alone: the two-hit rule is for coincidences, not curated names.
        self.assertIn("vault:scanner", self.run_hook("asm-prompt-recall.js", {"prompt": "תבדוק את הסורק"}).stdout)
        fresh = self.run_hook("asm-prompt-recall.js", {"prompt": "widget deploy staging"}).stdout
        self.assertIn("memory:abc123 — Widget deploy pipeline repaired", fresh)
        # One long word that merely appears in a summary is not evidence (it was: the summary
        # scored as a label made any 8-char token a "strong" single hit).
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "pipeline"}).stdout, "")
        with (self.runtime / "memory.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "def456", "created_at": "2026-08-28T10:00:00+03:00",
                                     "summary": "Something unrelated", "supersedes": ["abc123"]}) + "\n")
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "widget deploy staging"}).stdout, "")

    def ledger_op(self, **fields) -> None:
        sys.path.insert(0, str(PROJECT))
        try:
            from lifecycle import append_op
        finally:
            sys.path.remove(str(PROJECT))
        append_op(self.runtime / "lifecycle.jsonl",
                  {"reason": "test", "actor": {"kind": "owner", "name": "test"}, "mode": "approved", **fields})

    def test_prompt_recall_never_injects_daily_notes(self):
        (self.runtime / "brain.index.json").write_text(json.dumps([
            {"i": "vault:daily-2026-09-01", "l": "2026-09-01", "k": "page", "p": "wiki/daily/2026-09-01.md",
             "d": "zebra migration budget review", "t": []},
        ]), encoding="utf-8")
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "zebra migration budget review"}).stdout, "")

    def test_prompt_recall_ignores_closed_threads_and_retired_records(self):
        (self.runtime / "brain.index.json").write_text("[]", encoding="utf-8")
        now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
        records = [
            {"id": "d000000000000001", "created_at": now, "summary": "Harbor work", "decisions": [],
             "files": [], "open_threads": ["walrus harbor survey plan"]},
            {"id": "d000000000000002", "created_at": now, "summary": "Gateway rollout not deployed",
             "decisions": [], "files": [], "open_threads": []},
        ]
        (self.runtime / "memory.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        before = self.run_hook("asm-prompt-recall.js", {"prompt": "walrus harbor survey", "session_id": "h1"}).stdout
        self.assertIn("memory:d000000000000001", before)
        self.ledger_op(op="close_thread", target={"kind": "thread", "id": "d000000000000001#0"})
        self.ledger_op(op="retire", target={"kind": "record", "id": "d000000000000002"})
        self.assertNotIn("memory:d000000000000001",
                         self.run_hook("asm-prompt-recall.js", {"prompt": "walrus harbor survey", "session_id": "h2"}).stdout)
        self.assertNotIn("memory:d000000000000002",
                         self.run_hook("asm-prompt-recall.js", {"prompt": "gateway rollout deployed", "session_id": "h3"}).stdout)

    def test_prompt_recall_reads_the_clock_from_ASM_NOW(self):
        (self.runtime / "brain.index.json").write_text("[]", encoding="utf-8")
        records = [{"id": f"f00000000000000{n}", "created_at": at, "summary": "Lighthouse beacon calibration",
                    "decisions": [], "files": [], "open_threads": []}
                   for n, at in ((1, "2029-10-01T10:00:00+00:00"), (2, "2029-12-31T10:00:00+00:00"))]
        (self.runtime / "memory.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        out = self.run_hook("asm-prompt-recall.js", {"prompt": "lighthouse beacon calibration", "session_id": "n1"},
                            env={**self.env, "ASM_NOW": "2030-01-01T00:00:00+00:00"}).stdout
        newer, older = out.find("memory:f000000000000002"), out.find("memory:f000000000000001")
        self.assertGreaterEqual(newer, 0, out)
        self.assertTrue(older == -1 or newer < older, out)

    def test_prompt_recall_marks_done_pages_and_drops_retired_ones(self):
        (self.runtime / "brain.index.json").write_text(json.dumps([
            {"i": "vault:plan-a", "l": "Importer plan", "k": "page", "p": "wiki/plan-a.md",
             "d": "importer rollout plan for the gateway", "t": []},
            {"i": "vault:plan-b", "l": "Importer notes", "k": "page", "p": "wiki/plan-b.md",
             "d": "importer rollout notes for the gateway", "t": [], "s": "retired"},
        ]), encoding="utf-8")
        self.ledger_op(op="mark_done", target={"kind": "page", "id": "vault:plan-a"}, evidence=["memory:e000000000000001"])
        out = self.run_hook("asm-prompt-recall.js", {"prompt": "importer rollout gateway", "session_id": "h4"}).stdout
        line = next(line for line in out.splitlines() if line.startswith("- vault:plan-a"))
        self.assertIn("[DONE ", line)
        self.assertIn("memory:e000000000000001", line)
        self.assertNotIn("vault:plan-b", out)

    def test_prompt_recall_scores_bodies_and_stays_case_insensitive(self):
        """Two things at once, because they broke together.

        The hook screens candidates with a cheap substring test before the exact word test.
        That gate is only sound while it is case-folded: a template literal that lowercased
        only its second half dropped every node whose label or description was capitalised,
        silently and with no failing assertion anywhere else in this suite.
        """
        self.write_index()
        (self.runtime / "brain.pages.json").write_text(json.dumps({
            "vault:other-rule": sorted(["robocopy", "rsync", "readlink"]),
        }, ensure_ascii=False), encoding="utf-8")
        # 'Important' and 'App' are capitalised in the index and nowhere else.
        cased = self.run_hook("asm-prompt-recall.js", {"prompt": "important regression widget"}).stdout
        self.assertIn("vault:app-rule", cased)
        # A word written only in a page BODY now reaches the prompt on its own.
        body = self.run_hook("asm-prompt-recall.js", {"prompt": "how do I replace robocopy with rsync"}).stdout
        self.assertIn("vault:other-rule", body)

    def test_prompt_recall_ledger_cools_a_node_for_six_prompts(self):
        self.write_index()
        payload = {"session_id": "claude-recall-1", "prompt": "widget startup regression"}
        first = self.run_hook("asm-prompt-recall.js", payload)
        self.assertIn("vault:app-rule", first.stdout)
        # Served at turn 1, the node stays out of the next six prompts (turns 2-7).
        for _ in range(6):
            self.assertEqual(self.run_hook("asm-prompt-recall.js", payload).stdout, "")
        ledger_path = self.runtime / "sessions" / "claude-recall-1.recall.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        self.assertEqual(ledger["turn"], 7)
        self.assertEqual(ledger["entries"]["vault:app-rule"]["turn"], 1)
        self.assertIn("vault:app-rule", self.run_hook("asm-prompt-recall.js", payload).stdout)

        # A half-written ledger costs dedup for one prompt, never the injection.
        ledger_path.write_text("{not json", encoding="utf-8")
        self.assertIn("vault:app-rule", self.run_hook("asm-prompt-recall.js", payload).stdout)
        self.assertEqual(json.loads(ledger_path.read_text(encoding="utf-8"))["turn"], 1)

    def test_prompt_recall_without_session_id_never_writes_a_ledger(self):
        self.write_index()
        payload = {"prompt": "widget startup regression"}
        for _ in range(2):
            self.assertIn("vault:app-rule", self.run_hook("asm-prompt-recall.js", payload).stdout)
        self.assertFalse((self.runtime / "sessions").exists())

    def test_shell_mutation_marker_ignores_device_temp_and_date_format_junk(self):
        home = Path.home()
        self.run_hook("asm-activity-hook.js", {
            "session_id": "claude-junk-1",
            "tool_name": "Bash",
            "tool_input": {"command": (
                "ls > /dev/null 2>&1; date +%Y%m%dT%H%M%S > /private/tmp/scratch/out.txt; "
                "tee /var/folders/h9/x/T/log.txt; mv ~/asm-junk-test.txt ~/asm-junk-test2.txt; "
                "touch inside-cwd.txt; touch +page.svelte"
            )},
            "cwd": str(Path(self.temp.name)),
        })
        marker = json.loads((self.runtime / "sessions" / "claude-junk-1.json").read_text(encoding="utf-8"))
        # The cwd itself sits under the macOS temp tree: mutations inside it stay real, and
        # a SvelteKit `+page.svelte` is a file, not a date format.
        self.assertEqual(marker["files"], [
            str(home / "asm-junk-test.txt"), str(home / "asm-junk-test2.txt"),
            str(Path(self.temp.name) / "inside-cwd.txt"),
            str(Path(self.temp.name) / "+page.svelte"),
        ])

    def test_shell_mutation_marker_ignores_the_os_temp_folder_wherever_it_is(self):
        # Windows keeps temp under the user profile (AppData\\Local\\Temp), not under /tmp.
        fake_temp = Path.home() / "asm-fake-temp-tree"
        temp_env = {"TMPDIR": str(fake_temp), "TEMP": str(fake_temp), "TMP": str(fake_temp)}
        self.run_hook("asm-activity-hook.js", {
            "session_id": "claude-junk-2",
            "tool_name": "Bash",
            "tool_input": {"command": f"touch {fake_temp.as_posix()}/scratch.txt; touch inside-cwd.txt"},
            "cwd": str(Path(self.temp.name)),
        }, env={**self.env, **temp_env})
        marker = json.loads((self.runtime / "sessions" / "claude-junk-2.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["files"], [str(Path(self.temp.name) / "inside-cwd.txt")])

    def test_session_start_reports_open_threads_of_live_records_only(self):
        # Vault dreaming is retired (the curator replaces it), so its age is no longer
        # reported even when the old state file is still there; and a record that a later
        # record superseded no longer counts as unfinished work.
        vault = Path(self.temp.name) / "vault"
        (vault / "dreaming").mkdir(parents=True)
        five_days_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 5 * 86400 - 60))
        (vault / "dreaming" / "state.json").write_text(json.dumps({"lastRun": five_days_ago}), encoding="utf-8")
        (self.runtime / "asm-paths.json").write_text(json.dumps({"vault": str(vault)}), encoding="utf-8")
        (self.runtime / "brain.json").write_text(json.dumps({
            "generatedAt": "2026-08-25T00:00:00Z",
            "nodes": [{"id": "asm:one", "layer": "asm"}],
        }), encoding="utf-8")
        now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
        old = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - 9 * 86400))
        (self.runtime / "memory.jsonl").write_text(
            json.dumps({"id": "a", "created_at": now, "open_threads": ["one", "two"]}) + "\n"
            + json.dumps({"id": "b", "created_at": old, "open_threads": ["stale"]}) + "\n"
            + json.dumps({"id": "c", "created_at": now, "open_threads": ["closed later"]}) + "\n"
            + json.dumps({"id": "d", "created_at": now, "supersedes": ["c"], "open_threads": []}) + "\n",
            encoding="utf-8")
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertNotIn("Dreaming:", output)
        self.assertIn('Open threads: 2 open in 1 record(s) from the last 2 days — newest: a#0 "one"', output)

    def test_session_start_counts_only_threads_the_ledger_left_open(self):
        (self.runtime / "brain.json").write_text(json.dumps({
            "generatedAt": "2026-08-25T00:00:00Z", "nodes": [{"id": "asm:one", "layer": "asm"}]}), encoding="utf-8")
        now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
        (self.runtime / "memory.jsonl").write_text(
            json.dumps({"id": "f000000000000001", "created_at": now, "open_threads": ["first", "second"]}) + "\n",
            encoding="utf-8")
        sys.path.insert(0, str(PROJECT))
        try:
            from lifecycle import append_op
        finally:
            sys.path.remove(str(PROJECT))
        append_op(self.runtime / "lifecycle.jsonl", {"op": "close_thread", "reason": "done",
                  "target": {"kind": "thread", "id": "f000000000000001#0"}})
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertIn('Open threads: 1 open in 1 record(s) from the last 2 days — newest: f000000000000001#1 "second"', output)

    def jobs_runtime(self) -> Path:
        (self.runtime / "brain.json").write_text(json.dumps({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "nodes": [{"id": "asm:one", "layer": "asm"}]}),
            encoding="utf-8")
        cli = self.runtime / "jobs" / "dist" / "runner" / "cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_text("require('fs').writeFileSync(require('path').join(process.env.ASM_HOME, 'jobs', 'spawned'), "
                       "process.argv.slice(2).join(' ') + ' job=' + process.env.ASM_JOB);\n", encoding="utf-8")
        return self.runtime / "jobs"

    def wait_for(self, path: Path, seconds: float = 5.0) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            if path.exists():
                return True
            time.sleep(0.1)
        return path.exists()

    def iso(self, hours_ago: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours_ago * 3600))

    def test_session_start_shows_a_failed_job(self):
        jobs = self.jobs_runtime()
        (jobs / "state.json").write_text(json.dumps({"janitor": {
            "last_success": self.iso(72), "last_error": self.iso(0.5), "error_text": "claude exited 1"}}), encoding="utf-8")
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertIn("Jobs: janitor FAILED", output)
        self.assertIn("claude exited 1", output)

    def test_session_start_launches_due_jobs_in_the_background(self):
        jobs = self.jobs_runtime()
        started = time.time()
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertLess(time.time() - started, 3)
        self.assertTrue(self.wait_for(jobs / "spawned"))
        self.assertEqual((jobs / "spawned").read_text(encoding="utf-8"), "run --job all job=1")

    def test_session_start_launches_jobs_lowered_without_nice_on_path(self):
        # Windows has no `nice`: the launch must not depend on it, and the jobs still run lowered.
        jobs = self.jobs_runtime()
        cli = jobs / "dist" / "runner" / "cli.js"
        cli.write_text("require('fs').writeFileSync(require('path').join(process.env.ASM_HOME, 'jobs', 'spawned'), "
                       "process.argv.slice(2).join(' ') + ' prio=' + require('os').getPriority());\n", encoding="utf-8")
        node_dir = str(Path(shutil.which("node")).parent)
        self.assertIsNone(shutil.which("nice", path=node_dir), "this test needs a node folder without nice")
        self.run_hook("asm-session-start.js", {"session_id": "s"}, env={**self.env, "PATH": node_dir})
        self.assertTrue(self.wait_for(jobs / "spawned"))
        self.assertEqual((jobs / "spawned").read_text(encoding="utf-8"), "run --job all prio=10")

    def test_session_start_shows_jobs_that_were_launched_and_never_reported(self):
        # A job that dies at import writes no state: without this line the banner says nothing, forever.
        jobs = self.jobs_runtime()
        (jobs / "state.json").write_text(json.dumps({"janitor": {"last_success": self.iso(30)}}), encoding="utf-8")
        (jobs / "launch.json").write_text(json.dumps({"at": self.iso(3), "pid": 1}), encoding="utf-8")
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertIn("jobs launched 3h ago and never reported", output)
        (jobs / "launch.json").write_text(json.dumps({"at": self.iso(3), "pid": 1}), encoding="utf-8")
        (jobs / "state.json").write_text(json.dumps({"janitor": {"last_success": self.iso(1)}}), encoding="utf-8")
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertNotIn("never reported", output)

    def test_session_start_records_each_launch(self):
        jobs = self.jobs_runtime()
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertTrue(self.wait_for(jobs / "spawned"))
        launch = json.loads((jobs / "launch.json").read_text(encoding="utf-8"))
        self.assertIsInstance(launch["pid"], int)
        launched = datetime.fromisoformat(launch["at"].replace("Z", "+00:00"))
        self.assertLess(abs((datetime.now(timezone.utc) - launched).total_seconds()), 120)

    def test_session_start_backs_off_after_consecutive_failures(self):
        jobs = self.jobs_runtime()
        failing = {"last_success": self.iso(72), "last_error": self.iso(3), "error_text": "claude exited 1"}
        (jobs / "state.json").write_text(json.dumps({"janitor": {**failing, "consecutive_failures": 3}}), encoding="utf-8")
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertFalse(self.wait_for(jobs / "spawned", 1.5))  # three failures in a row: wait 4 hours, not 1
        (jobs / "state.json").write_text(json.dumps({"janitor": {**failing, "consecutive_failures": 1}}), encoding="utf-8")
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertTrue(self.wait_for(jobs / "spawned"))

    def test_session_start_does_not_launch_after_a_recent_run_or_under_a_live_lock(self):
        jobs = self.jobs_runtime()
        (jobs / "state.json").write_text(json.dumps({"janitor": {"last_success": self.iso(1)}}), encoding="utf-8")
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertFalse(self.wait_for(jobs / "spawned", 1.5))
        (jobs / "state.json").write_text(json.dumps({"janitor": {"last_success": self.iso(30)}}), encoding="utf-8")
        (jobs / "run.lock").write_text(json.dumps({"pid": os.getpid(), "started_at": self.iso(0.1)}), encoding="utf-8")
        self.run_hook("asm-session-start.js", {"session_id": "s"})
        self.assertFalse(self.wait_for(jobs / "spawned", 1.5))

    def test_parallel_post_tool_hooks_merge_session_marker_without_lost_files(self):
        session = "parallel-marker-1"
        expected = [f"src/concurrent-{index}.ts" for index in range(16)]

        def emit(file_path):
            self.run_hook("asm-activity-hook.js", {
                "hook_event_name": "PostToolUse",
                "client_type": "kimi_code_cli",
                "session_id": session,
                "tool_name": "Write",
                "tool_input": {"path": file_path},
                "cwd": str(Path(self.temp.name) / "project"),
            })

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
            list(executor.map(emit, expected))

        marker_path = self.runtime / "sessions" / f"{session}.json"
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        self.assertEqual(set(marker["files"]), set(expected))
        self.assertFalse(marker_path.with_suffix(".json.lock").exists())

    def bash(self, session: str, command: str, cwd: str) -> Path:
        self.run_hook("asm-activity-hook.js", {
            "session_id": session, "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}, "cwd": cwd})
        return self.runtime / "sessions" / f"{session}.json"

    def test_greater_than_inside_quotes_or_heredoc_is_not_a_write(self):
        # Read-only analysis commands marked phantom files `1` and `30d` as written, and the
        # memory gate then blocked read-only sessions asking them to document those files.
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

    def test_command_boundaries_ignore_quoted_separators(self):
        cwd = self.temp.name
        self.assertFalse(self.bash("sep-1", 'echo "a; rm victim.txt"', cwd).exists())
        marker = self.bash("sep-2", 'rm "my file.txt"', cwd)
        self.assertEqual(json.loads(marker.read_text())["files"], [str(Path(cwd) / "my file.txt")])

    def test_gate_fallback_uses_the_runtime_and_writes_no_file(self):
        self.run_hook("asm-activity-hook.js", {"session_id": "fb-2", "tool_name": "Write",
                                               "tool_input": {"file_path": "/work/a.py"}, "cwd": "/work"})
        reason = json.loads(self.run_hook("asm-memory-gate.js", {"session_id": "fb-2"}).stdout)["reason"]
        self.assertIn(f"uv run --directory {self.runtime} python mcp_server.py --record <<'JSON'", reason)
        self.assertNotIn("record.json", reason)
        # Pasted as printed, the heredoc must end and deliver valid JSON: an indented
        # terminator never closes it, and bash then feeds the terminator into the JSON.
        lines = reason.splitlines()
        start = next(i for i, line in enumerate(lines) if "--record <<'JSON'" in line)
        end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "JSON")
        block = "\n".join(["cat <<'JSON'", *lines[start + 1:end + 1]])
        bash = shutil.which("bash")  # Git Bash on Windows, where agents' shell commands run
        if bash is None:
            self.skipTest("no bash to paste the heredoc into")
        pasted = subprocess.run([bash, "-c", block], text=True, capture_output=True, timeout=5)
        self.assertEqual(json.loads(pasted.stdout)["session_id"], "fb-2", pasted.stderr)

    def test_asm_job_turns_every_hook_off(self):
        env = {**self.env, "ASM_JOB": "1"}
        self.run_hook("asm-activity-hook.js", {"session_id": "job-1", "tool_name": "Write",
                                               "tool_input": {"file_path": "/work/a.py"}, "cwd": "/work"}, env=env)
        self.assertFalse((self.runtime / "sessions" / "job-1.json").exists())
        gate = self.run_hook("asm-memory-gate.js", {"session_id": "job-1"}, env=env)
        self.assertEqual(json.loads(gate.stdout), {"continue": True})
        self.assertEqual(self.run_hook("asm-session-start.js", {}, env=env).stdout, "")
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "anything at all here"}, env=env).stdout, "")

    def test_gate_offers_a_shell_fallback(self):
        self.run_hook("asm-activity-hook.js", {"session_id": "fb-1", "tool_name": "Write",
                                               "tool_input": {"file_path": "/work/a.py"}, "cwd": "/work"})
        gate = json.loads(self.run_hook("asm-memory-gate.js", {"session_id": "fb-1"}).stdout)
        self.assertIn("mcp_server.py --record", gate["reason"])


class PathMatchingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.runtime = root / "runtime"
        self.runtime.mkdir()
        self.module_name, self.server = load_server(self.runtime, root / ".codex")
        self.server.nodes_by_id.clear()
        self.server.abs_index.clear()
        self.server.suffix_index.clear()

    def tearDown(self):
        sys.modules.pop(self.module_name, None)
        self.temp.cleanup()

    def test_suffix_fallback_matches_only_one_unambiguous_graph_file(self):
        self.server.suffix_index["src/unique.ts"] = {"project-a:src/unique.ts"}
        self.assertEqual(
            self.server.match_path("/container/src/unique.ts"),
            ("project-a:src/unique.ts", True),
        )

        self.server.suffix_index["src/app.tsx"] = {
            "project-a:src/app.tsx",
            "project-b:src/app.tsx",
        }
        node_id, matched = self.server.match_path("/container/src/app.tsx")
        self.assertFalse(matched)
        self.assertRegex(node_id, r"^ephemeral:src-[a-f0-9]{8}:app\.tsx:")

    def test_unmatched_files_with_the_same_basename_get_distinct_ids(self):
        first, first_matched = self.server.match_path("/work/alpha/src/index.ts")
        second, second_matched = self.server.match_path("/work/beta/src/index.ts")
        self.assertFalse(first_matched)
        self.assertFalse(second_matched)
        self.assertNotEqual(first, second)

    def test_relative_paths_resolve_against_cwd_and_use_distinct_project_anchors(self):
        first = self.server.build_events({
            "ts": time.time(), "cwd": "/work/repo-a", "session": "a", "paths": ["src/new.ts"],
        })[0]
        second = self.server.build_events({
            "ts": time.time(), "cwd": "/work/repo-b", "session": "b", "paths": ["src/new.ts"],
        })[0]
        self.assertEqual(first["path"], "/work/repo-a/src/new.ts")
        self.assertEqual(second["path"], "/work/repo-b/src/new.ts")
        self.assertNotEqual(first["node_id"].split(":")[1], second["node_id"].split(":")[1])

    def test_staged_pending_file_recovers_even_when_fresh_pending_is_absent(self):
        staged = self.runtime / "pending.draining"
        staged.write_text(json.dumps({
            "ts": time.time(), "cwd": "/work/repo", "session": "recovery",
            "agent": "Claude Code", "tool": "Read", "paths": ["src/recovered.ts"],
        }) + "\n", encoding="utf-8")
        self.assertEqual(self.server.drain_pending(), 1)
        self.assertFalse(staged.exists())
        self.assertEqual(self.server.recent[-1]["path"], "/work/repo/src/recovered.ts")

    def test_pending_finish_is_not_deduped_against_same_millisecond_start(self):
        timestamp = time.time()
        base = {
            "ts": timestamp, "cwd": "/work/repo", "session": "claude-live",
            "agent": "Claude Code", "tool": "Read", "paths": ["src/live.ts"],
            "operation_id": "toolu_same_millisecond",
        }
        start = self.server.build_events({**base, "phase": "start"})[0]
        self.server.recent.append(start)
        (self.runtime / "pending.draining").write_text(
            json.dumps({**base, "phase": "start"}) + "\n"
            + json.dumps({**base, "phase": "finish"}) + "\n",
            encoding="utf-8",
        )

        self.assertEqual(self.server.drain_pending(), 1)
        self.assertEqual([event["phase"] for event in self.server.recent], ["start", "finish"])
        persisted = [
            json.loads(line)
            for line in (self.runtime / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual([event["phase"] for event in persisted], ["finish"])

    def test_legacy_pending_events_for_two_tools_do_not_collide(self):
        timestamp = time.time()
        base = {
            "ts": timestamp, "cwd": "/work/repo", "session": "legacy-live",
            "agent": "Claude Code", "paths": ["src/live.ts"], "phase": "finish",
        }
        self.server.recent.append(self.server.build_events({**base, "tool": "Read"})[0])
        (self.runtime / "pending.draining").write_text(
            json.dumps({**base, "tool": "Read"}) + "\n"
            + json.dumps({**base, "tool": "Edit"}) + "\n",
            encoding="utf-8",
        )

        self.assertEqual(self.server.drain_pending(), 1)
        self.assertEqual([event["tool"] for event in self.server.recent], ["Read", "Edit"])

    def test_failed_pending_persist_keeps_staged_replay_out_of_recent(self):
        staged = self.runtime / "pending.draining"
        staged.write_text(json.dumps({
            "ts": time.time(), "cwd": "/work/repo", "session": "retry",
            "agent": "Claude Code", "tool": "Read", "paths": ["src/retry.ts"],
        }) + "\n", encoding="utf-8")
        original_persist = self.server.persist
        self.server.persist = lambda _events: False
        try:
            self.assertEqual(self.server.drain_pending(), 0)
        finally:
            self.server.persist = original_persist
        self.assertTrue(staged.exists())
        self.assertEqual(list(self.server.recent), [])

        self.assertEqual(self.server.drain_pending(), 1)
        self.assertFalse(staged.exists())
        self.assertEqual(len(self.server.recent), 1)

    def test_old_buffered_timestamp_stays_old_while_future_skew_is_clamped(self):
        now = time.time()
        old = self.server.build_events({"ts": now - 3600, "cwd": "/work/repo", "paths": ["old.ts"]})[0]
        future = self.server.build_events({"ts": now + 3600, "cwd": "/work/repo", "paths": ["future.ts"]})[0]
        self.assertLess(old["ts"], now - 3500)
        self.assertLess(abs(future["ts"] - time.time()), 2)


class LiveTrackingLatencyTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.runtime = cls.root / "runtime"
        cls.codex_home = cls.root / ".codex"
        cls.runtime.mkdir()
        cls.module_name, cls.server = load_server(cls.runtime, cls.codex_home)

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop(cls.module_name, None)
        cls.temp.cleanup()

    def setUp(self):
        self.server.clients.clear()
        self.server.recent.clear()

    async def test_publish_events_persists_and_fans_out_in_the_same_call(self):
        delivered = asyncio.Event()

        class RecordingSocket:
            def __init__(self):
                self.messages = []

            async def send_text(self, value):
                await asyncio.sleep(0)
                self.messages.append(value)
                delivered.set()

        first = RecordingSocket()
        second = RecordingSocket()
        self.server.clients.update({first, second})
        event = {
            "ts": time.time(),
            "tool": "apply_patch",
            "session": "latency-session",
            "path": "/work/src/app.py",
            "node_id": "agents:src/app.py",
            "matched": True,
        }
        persisted = []

        def record_persisted(events):
            persisted.extend(events)
            return True

        original_persist = self.server.persist
        self.server.persist = record_persisted
        try:
            started = time.monotonic()
            publishing = asyncio.create_task(self.server.publish_events([event]))
            await asyncio.wait_for(delivered.wait(), timeout=0.5)
            result = await asyncio.wait_for(publishing, timeout=0.5)
            elapsed = time.monotonic() - started
        finally:
            self.server.persist = original_persist

        self.assertTrue(result)
        self.assertLess(elapsed, 0.5)
        self.assertEqual(persisted, [event])
        self.assertEqual(self.server.recent[-1], event)
        self.assertEqual(json.loads(first.messages[0]), [event])
        self.assertEqual(json.loads(second.messages[0]), [event])

    async def test_failed_live_persist_is_not_exposed_as_recent_or_broadcast(self):
        class RecordingSocket:
            def __init__(self):
                self.messages = []

            async def send_text(self, value):
                self.messages.append(value)

        socket = RecordingSocket()
        self.server.clients.add(socket)
        original_persist = self.server.persist
        self.server.persist = lambda _events: False
        try:
            self.assertFalse(await self.server.publish_events([{
                "ts": time.time(), "path": "/work/not-durable.ts",
            }]))
        finally:
            self.server.persist = original_persist
        self.assertEqual(list(self.server.recent), [])
        self.assertEqual(socket.messages, [])

    async def test_publish_uses_a_client_snapshot_when_a_socket_disconnects_mid_fanout(self):
        messages = []

        class Socket:
            def __init__(self, remove=None):
                self.remove = remove

            async def send_text(self, value):
                messages.append(value)
                if self.remove is not None:
                    self.server.clients.discard(self.remove)
                await asyncio.sleep(0)

        stable = Socket()
        mutating = Socket(stable)
        mutating.server = self.server
        stable.server = self.server
        self.server.clients.update({stable, mutating})
        original_persist = self.server.persist
        self.server.persist = lambda _events: True
        try:
            self.assertTrue(await self.server.publish_events([{"ts": time.time(), "path": "/work/file.ts"}]))
        finally:
            self.server.persist = original_persist
        self.assertEqual(len(messages), 2)

    async def test_slow_websocket_cannot_block_fast_clients_or_event_ingest(self):
        fast_received = asyncio.Event()

        class FastSocket:
            async def send_text(self, _value):
                fast_received.set()

        class StalledSocket:
            async def send_text(self, _value):
                await asyncio.sleep(10)

        fast = FastSocket()
        stalled = StalledSocket()
        self.server.clients.update({fast, stalled})
        original_persist = self.server.persist
        self.server.persist = lambda _events: True
        started = time.monotonic()
        try:
            publishing = asyncio.create_task(
                self.server.publish_events([{"ts": time.time(), "path": "/work/live.ts"}]),
            )
            await asyncio.wait_for(fast_received.wait(), timeout=0.1)
            fast_elapsed = time.monotonic() - started
            self.assertTrue(await asyncio.wait_for(publishing, timeout=0.7))
        finally:
            self.server.persist = original_persist

        self.assertLess(fast_elapsed, 0.1)
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertIn(fast, self.server.clients)
        self.assertNotIn(stalled, self.server.clients)

    def test_rollout_payload_keeps_a_real_graph_match_when_path_is_known(self):
        project = self.root / "project"
        target = project / "frontend" / "src" / "App.tsx"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export default null;\n", encoding="utf-8")
        node_id = "asm:frontend/src/app.tsx"
        normalized = self.server.norm(str(target.resolve()))
        self.server.nodes_by_id.clear()
        self.server.abs_index.clear()
        self.server.suffix_index.clear()
        self.server.nodes_by_id[node_id] = {
            "id": node_id,
            "label": "App.tsx",
            "layer": "asm",
            "kind": "file",
            "abs": normalized,
        }
        self.server.abs_index[normalized] = node_id

        source = 'const r = await tools.exec_command({cmd:"sed -n 1,80p frontend/src/App.tsx"}); text(r.output)'
        payload = activity_from_rollout({
            "timestamp": rollout_now(),
            "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "matched-live", "input": source},
        }, {"id": "matched-session", "cwd": str(project)})
        events = self.server.build_events(payload)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["session"], "matched-session")
        self.assertEqual(events[0]["source"], "codex-rollout-fallback")
        self.assertEqual(events[0]["path"], str(target.resolve()).replace("\\", "/"))
        self.assertEqual(events[0]["node_id"], node_id)
        self.assertEqual(events[0]["layer"], "asm")
        self.assertEqual(events[0]["label"], "App.tsx")
        self.assertTrue(events[0]["matched"])
        self.assertFalse(events[0]["presence"])


def rollout_now() -> str:
    """A rollout row's timestamp is the wall clock it was written at, and the
    watcher drops rows older than MAX_ROLLOUT_AGE_SECONDS so a replayed session
    cannot re-enter the graph as live work. A fixture pinned to a fixed date was
    only ever incidental to what these tests assert, and ages out of the window."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class CodexFallbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.target = self.project / "frontend" / "src" / "App.tsx"
        self.target.parent.mkdir(parents=True)
        self.target.write_text("export default null;\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_code_mode_metadata_extracts_paths_without_retaining_raw_arguments(self):
        source = (
            'const r = await tools.exec_command({cmd:"sed -n 1,80p frontend/src/App.tsx",'
            # A path in JS source is a JS string: on Windows its backslashes arrive escaped.
            f'workdir:{json.dumps(str(self.project))}}}); text(r.output)'
        )
        self.assertEqual(code_mode_paths(source, str(self.root)), [str(self.target.resolve())])
        activity = activity_from_rollout({
            "timestamp": rollout_now(),
            "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "call-1", "input": source},
        }, {"id": "session-1", "cwd": str(self.root)})
        self.assertEqual(activity["tool"], "Bash")
        self.assertEqual(activity["paths"], [str(self.target.resolve())])
        self.assertEqual(activity["operation_id"], "call-1")
        self.assertEqual(activity["phase"], "start")
        self.assertTrue(activity["file_access"])
        self.assertNotIn("input", activity)

    def test_code_mode_reads_a_windows_path_without_taking_its_backslash_t_for_a_tab(self):
        # C:\\Users\\x\\Temp\\tmp1 written in JS: the escaped backslash before "tmp1" is not a \\t.
        source = 'const r = await tools.exec_command({cmd:"type out.txt", workdir:"C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\Temp\\\\tmp1"})'
        text = js_text(source)
        self.assertIn("C:\\Users\\x\\AppData\\Local\\Temp\\tmp1", text)
        self.assertEqual([m.group(0) for m in ABS_PATH_RE.finditer(text)], ["C:\\Users\\x\\AppData\\Local\\Temp\\tmp1"])
        self.assertEqual(js_text("a\\nb\\tc"), "a\nb c")

    def test_rollout_watcher_tails_only_new_tool_calls(self):
        codex_home = self.root / ".codex"
        rollout = codex_home / "sessions" / "2026" / "08" / "25" / "rollout.jsonl"
        rollout.parent.mkdir(parents=True)
        meta = {"type": "session_meta", "payload": {"id": "live-session", "cwd": str(self.project)}}
        rollout.write_text(json.dumps(meta) + "\n", encoding="utf-8")
        watcher = CodexRolloutWatcher(codex_home)
        watcher.prime()
        source = 'const r = await tools.exec_command({cmd:"sed -n 1,80p frontend/src/App.tsx"}); text(r.output)'
        call = {
            "timestamp": rollout_now(),
            "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "call-live", "input": source},
        }
        with rollout.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(call) + "\n")
        # Appends to an already-active rollout must be tailed from the cached file
        # immediately; they must not wait for the next recursive session scan.
        watcher.last_scan = time.monotonic()
        started = time.monotonic()
        with mock.patch.object(Path, "rglob", side_effect=AssertionError("active rollout unexpectedly rescanned")):
            activities = watcher.poll()
        elapsed = time.monotonic() - started
        self.assertEqual(len(activities), 1)
        self.assertLess(elapsed, 0.5)
        self.assertEqual(activities[0]["session"], "live-session")
        self.assertEqual(activities[0]["paths"], [str(self.target.resolve())])


@unittest.skipUnless((PROJECT / "sources.json").exists(), "merge.py needs a local sources.json")
class DirectoryOverviewTests(unittest.TestCase):
    def test_directories_get_a_deterministic_overview_from_their_files(self):
        spec = importlib.util.spec_from_file_location("asm_merge_test", PROJECT / "merge.py")
        merge = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(merge)
        nodes = {
            "agents:project:app": {"id": "agents:project:app", "kind": "dir", "label": "app"},
            "agents:dir:app/src": {"id": "agents:dir:app/src", "kind": "dir", "label": "app/src"},
            "agents:app/src/main.py": {"id": "agents:app/src/main.py", "kind": "file", "label": "main.py"},
            "agents:app/src/util.py": {"id": "agents:app/src/util.py", "kind": "file", "label": "util.py"},
            "agents:app/README.md": {"id": "agents:app/README.md", "kind": "file", "label": "README.md"},
            "agents:dir:app/empty": {"id": "agents:dir:app/empty", "kind": "dir", "label": "app/empty"},
            "vault:app-rule": {"id": "vault:app-rule", "kind": "page", "label": "App rule"},
        }
        links = [
            {"source": "agents:project:app", "target": "agents:dir:app/src", "type": "contains"},
            {"source": "agents:project:app", "target": "agents:app/README.md", "type": "contains"},
            {"source": "agents:project:app", "target": "agents:dir:app/empty", "type": "contains"},
            {"source": "agents:dir:app/src", "target": "agents:app/src/main.py", "type": "contains"},
            {"source": "agents:dir:app/src", "target": "agents:app/src/util.py", "type": "contains"},
            {"source": "agents:app/src/main.py", "target": "agents:app/src/util.py", "type": "code", "weight": 4},
            {"source": "vault:app-rule", "target": "agents:app/src/main.py", "type": "xlayer"},
        ]
        self.assertEqual(merge.describe_directories(nodes, links), 2)
        self.assertEqual(nodes["agents:dir:app/src"]["meta"]["description"],
                         "2 files (Python) · hubs: main.py, util.py · knowledge: App rule")
        self.assertEqual(nodes["agents:project:app"]["meta"]["description"],
                         "3 files (Python, Markdown) · hubs: main.py, util.py · knowledge: App rule")
        self.assertNotIn("meta", nodes["agents:dir:app/empty"])



def load_merge():
    spec = importlib.util.spec_from_file_location("asm_merge_flags_test", PROJECT / "merge.py")
    merge = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(merge)
    return merge


@unittest.skipUnless((PROJECT / "sources.json").exists(), "merge.py needs a local sources.json")
class UnindexedNotesTests(unittest.TestCase):
    def test_empty_notes_never_become_brain_nodes(self):
        # Obsidian creates an empty note for every click on a link it cannot resolve; eight of them
        # sat at the vault root as live nodes, one ranking third for its own topic.
        merge = load_merge()
        with tempfile.TemporaryDirectory() as temp:
            vault = Path(temp)
            (vault / "okf").mkdir()
            (vault / ".obsidian").mkdir()
            (vault / "_new").mkdir()
            (vault / "empty-stub.md").write_text("", encoding="utf-8")
            (vault / "_new" / "clicked-link.md").write_text("", encoding="utf-8")
            (vault / "draft.md").write_text("a real draft\n", encoding="utf-8")
            (vault / "okf" / "index.md").write_text("generated\n", encoding="utf-8")
            (vault / ".obsidian" / "notes.md").write_text("config\n", encoding="utf-8")
            (vault / "cataloged.md").write_text("---\nid: x\n---\n", encoding="utf-8")
            notes = merge.unindexed_notes(vault, {"cataloged.md"})
            self.assertEqual([note.name for note in notes], ["draft.md"])


@unittest.skipUnless((PROJECT / "sources.json").exists(), "merge.py needs a local sources.json")
class PageFlagsTests(unittest.TestCase):
    """Recall needs a page's lifecycle facts: its frontmatter status, its dates, its type,
    and whether the curator keeps a current-state block in it."""

    def test_page_flags_read_status_and_the_curated_block(self):
        merge = load_merge()
        with tempfile.TemporaryDirectory() as temp:
            done = Path(temp) / "done.md"
            done.write_text("---\nid: plan-a\nstatus: done\ndone_at: \"2026-09-27\"\n---\n# Plan\n", encoding="utf-8")
            curated = Path(temp) / "proj.md"
            curated.write_text("---\nid: proj\n---\n# Proj\n<!-- asm:state begin seen=memory:x at=t -->\n- a\n"
                               "<!-- asm:state end -->\n", encoding="utf-8")
            plain = Path(temp) / "plain.md"
            plain.write_text("no frontmatter here\nstatus: done in the body\n", encoding="utf-8")
            self.assertEqual(merge.page_flags(done), {"status": "done", "done_at": "2026-09-27"})
            self.assertEqual(merge.page_flags(curated), {"curated": True})
            self.assertEqual(merge.page_flags(plain), {})
            self.assertEqual(merge.page_flags(Path(temp) / "missing.md"), {})

    def test_page_status_is_normalized_to_a_lifecycle_word(self):
        merge = load_merge()
        cases = {
            "done — all ten items shipped on 22/09 (main=0a1b2c3)": "done",
            "complete": "done",
            "closed": "done",
            "archived": "retired",
            "superseded": "retired",
            "Active": "active",
            "ready-for-review": "ready-for-review",
        }
        with tempfile.TemporaryDirectory() as temp:
            for raw, expected in cases.items():
                page = Path(temp) / "p.md"
                page.write_text(f"---\nid: p\nstatus: {raw}\n---\nbody\n", encoding="utf-8")
                self.assertEqual(merge.page_flags(page).get("status"), expected, raw)

    def test_index_rows_carry_the_lifecycle_fields_only_when_present(self):
        merge = load_merge()
        row = merge.index_row({"id": "vault:plan-a", "label": "Plan", "kind": "page", "path": "p.md",
                               "meta": {"description": "d", "tags": [], "updatedAt": "2026-09-27T10:00:00+03:00",
                                        "type": "plan", "status": "done", "curated": True}})
        self.assertEqual({key: row[key] for key in ("u", "y", "s", "c")},
                         {"u": "2026-09-27T10:00:00+03:00", "y": "plan", "s": "done", "c": True})
        bare = merge.index_row({"id": "agents:a.py", "label": "a.py", "kind": "file", "path": "a.py"})
        self.assertEqual(set(bare), {"i", "l", "k", "p", "d", "t"})

class BodyIndexAndWordMatchTests(unittest.TestCase):
    """brain_search used to read frontmatter only — about 1.4% of what the vault holds —
    and matched query tokens as substrings, so `gnu` scored the bundled `gnuplot-*.js`."""

    NODES = [
        {"id": "vault:bsd-vs-gnu", "label": "Translating a Windows runbook", "layer": "vault",
         "kind": "page", "path": "wiki/translate.md",
         "meta": {"description": "What to do with pre-migration content", "tags": ["migration"]}},
        {"id": "agents:web/deps/gnuplot-q7elnnri.js", "label": "gnuplot-q7elnnri.js",
         "layer": "agents", "kind": "file", "path": "web/deps/gnuplot-q7elnnri.js",
         "abs": "/work/web/deps/gnuplot-q7elnnri.js"},
        {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
         "path": "src/app.py", "abs": "/work/src/app.py"},
        {"id": "agents:other/app.py", "label": "app.py", "layer": "agents", "kind": "file",
         "path": "other/app.py", "abs": "/work/other/app.py"},
    ]
    # merge.py writes these: stemmed, sorted, one entry per vault page.
    PAGES = {"vault:bsd-vs-gnu": sorted(["robocopy", "rsync", "readlink", "findstr", "grep"])}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def load(self, pages=None):
        module = load_mcp(self.runtime, nodes=self.NODES, links=[])
        (self.runtime / "brain.pages.json").write_text(
            json.dumps(self.PAGES if pages is None else pages, ensure_ascii=False),
            encoding="utf-8")
        return load_mcp(self.runtime, nodes=self.NODES, links=[])

    def test_a_word_written_only_in_a_page_body_is_findable(self):
        module = self.load()
        self.assertEqual(module.brain_search("robocopy")[0]["id"], "vault:bsd-vs-gnu")
        # Two body words together still resolve to the one page that holds both.
        self.assertEqual(module.brain_search("robocopy readlink")[0]["id"], "vault:bsd-vs-gnu")

    def test_a_body_word_is_not_reachable_without_the_body_index(self):
        """A runtime deployed before brain.pages.json existed must still start, and must
        simply not match bodies — not crash and not pretend to have found something."""
        module = self.load(pages={})
        self.assertEqual(module.brain_search("robocopy"), [])

    def test_a_query_token_matches_whole_words_not_prefixes(self):
        module = self.load()
        self.assertEqual([r["id"] for r in module.brain_search("gnu")], [])
        self.assertEqual([r["id"] for r in module.brain_search("gnuplot")],
                         ["agents:web/deps/gnuplot-q7elnnri.js"])

    def test_every_word_of_a_compound_token_has_to_be_present(self):
        module = self.load()
        found = [r["id"] for r in module.brain_search("src/app.py")]
        self.assertEqual(found, ["agents:src/app.py"])

    def test_the_hook_and_the_server_agree_on_the_body_weight(self):
        """Two implementations ranking the same prompt differently is the failure this
        codebase already pays a fixture to prevent for the tokenizer."""
        hook = (PROJECT / "hook" / "asm-prompt-recall.js").read_text(encoding="utf-8")
        match = re.search(r"const BODY_WEIGHT = ([\d.]+);", hook)
        self.assertIsNotNone(match, "BODY_WEIGHT not declared in the prompt hook")
        module = self.load()
        self.assertEqual(float(match.group(1)), float(module.BODY_WEIGHT))


class SourceDiscoveryTests(unittest.TestCase):
    def test_discovery_maps_every_top_level_project_and_explicit_source_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            projects = root / "Projects"
            (projects / "Alpha").mkdir(parents=True)
            (projects / "Beta Lab").mkdir()
            config = root / "sources.json"
            config.write_text(json.dumps({
                "sources": [{"layer": "asm", "raw": "alpha-explicit", "base": "Projects/Alpha", "prefix": "asm/"}],
                "discoverSources": [{
                    "root": "Projects",
                    "defaultLayer": "agents",
                    "layerOverrides": {"Beta Lab": "lab"},
                }],
            }), encoding="utf-8")
            sources = expanded_sources(config)
            self.assertEqual([source["raw"] for source in sources], ["alpha-explicit", "beta-lab"])
            self.assertEqual(sources[1]["layer"], "lab")
            self.assertEqual(sources[1]["prefix"], "beta-lab/")

    def test_an_explicit_base_is_absolute_so_the_tsv_does_not_depend_on_the_cwd(self):
        """refresh.sh feeds `base` to graphify from the caller's cwd while merge.py
        resolves it against sources.json. A bare "." that meant two different trees
        mapped the whole workspace root into the asm layer with dead abs paths."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "Projects" / "Alpha").mkdir(parents=True)
            config = root / "sources.json"
            config.write_text(json.dumps({
                "sources": [
                    {"layer": "asm", "raw": "self", "base": ".", "prefix": "asm/"},
                    {"layer": "lab", "raw": "alpha", "base": "Projects/Alpha", "prefix": "a/"},
                ],
            }), encoding="utf-8")
            bases = [source["base"] for source in expanded_sources(config)]
            self.assertTrue(all(Path(base).is_absolute() for base in bases), bases)
            self.assertEqual(bases, [str(root), str(root / "Projects" / "Alpha")])


class OutputSizeTests(unittest.TestCase):
    """The client replaces any tool result over ~50k characters with an error. Full records
    carry up to 12k characters of details each, so recall must return them in brief form."""

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

    @staticmethod
    def serialized(value) -> int:
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
        self.assertTrue(result and result[0]["id"].startswith("rec"), result)

    def test_recent_finds_a_record_by_id_or_session_and_ignores_empty_queries(self):
        self.assertEqual([item["id"] for item in self.module.memory_recent(limit=5, query="rec0007")], ["rec0007"])
        self.assertEqual(self.module.memory_recent(limit=5, query="PR"), [])

    def test_one_record_with_huge_threads_still_fits(self):
        (self.runtime / "memory.jsonl").write_text(json.dumps({
            "id": "big0000000000001", "session_id": "s", "created_at": "2026-09-01T10:00:00+03:00", "agent": "t",
            "summary": "big", "details": "d", "files": [], "decisions": [],
            "open_threads": ["y" * 2000 for _ in range(30)]}) + "\n", encoding="utf-8")
        result = self.module.memory_recent(limit=1)
        self.assertEqual(result[0]["id"], "big0000000000001")
        self.assertLessEqual(len(result[0]["open_threads"]), 10)
        self.assertTrue(all(len(thread["text"]) <= 300 for thread in result[0]["open_threads"]))

    def test_full_record_still_opens_by_id(self):
        record = self.module.brain_node("memory:rec0003")
        self.assertEqual(len(record["details"]), 10000)

    def test_context_shared_memory_is_brief_and_short(self):
        ctx = self.module.brain_context("/work/src/file1.py")
        self.assertLessEqual(len(ctx["shared_memory"]), 3)
        self.assertIn("details_preview", ctx["shared_memory"][0])
        self.assertLessEqual(self.serialized(ctx), 20000)


class RecordToleranceTests(unittest.TestCase):
    """80 of 850 memory_record calls failed validation: with a long summary, the model's
    argument serialization collapsed the later arguments into it as literal markup."""

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
        self.assertTrue(record["details"].startswith("Root cause was a missing branch"), record["details"])
        self.assertTrue(any("recovered" in warning for warning in result["warnings"]))

    def test_leaked_list_fields_are_recovered(self):
        leaked = ('Summary text here</summary>\n<parameter name="details">Long enough details text.</details>\n'
                  '<parameter name="open_threads">["check the gate", "rerun the sweep"]</open_threads>')
        result = self.module.memory_record(session_id="s-2", summary=leaked)
        record_id = result["record"]["id"]
        self.assertEqual(result["record"]["open_threads"], ["check the gate", "rerun the sweep"])
        self.assertEqual(result["thread_ids"], [f"{record_id}#0", f"{record_id}#1"])

    def test_long_summary_moves_overflow_into_details(self):
        summary = "word " * 150
        result = self.module.memory_record(session_id="s-3", summary=summary, details="the original details")
        record = result["record"]
        self.assertLessEqual(len(record["summary"]), 500)
        self.assertIn("the original details", record["details"])
        self.assertIn("word word", record["details"].split("\n\n")[0])

    def test_missing_details_is_accepted_with_a_warning(self):
        result = self.module.memory_record(session_id="s-4", summary="Changed one config value")
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["warnings"])

    def test_bare_element_leak_is_recovered_in_hebrew(self):
        # 37 of 82 real leaks carried bare elements, with no <parameter name=…> at all.
        leaked = ('תוקן הפרסר — Fixed the parser</summary>\n<details>Root cause was a missing branch; verified.</details>\n'
                  '<files>["src/p.py"]</files>\n<open_threads>["check the gate"]</open_threads>')
        result = self.module.memory_record(session_id="s-6", summary=leaked)
        record = result["record"]
        self.assertEqual(record["summary"], "תוקן הפרסר — Fixed the parser")
        self.assertEqual(record["details"], "Root cause was a missing branch; verified.")
        self.assertEqual(record["files"], ["src/p.py"])
        self.assertEqual(record["open_threads"], ["check the gate"])

    def test_a_summary_that_merely_contains_the_closing_tag_is_kept_whole(self):
        summary = "Wrapped the log in <details><summary>Logs</summary> blocks for the report"
        result = self.module.memory_record(session_id="s-7", summary=summary,
                                           details="The report renders collapsed log blocks now.")
        self.assertEqual(result["record"]["summary"], summary)
        self.assertFalse(any("recovered" in warning for warning in result["warnings"]))

    def test_a_leak_that_starts_in_details_is_recovered(self):
        details = 'Real details text for the next agent.</details>\n<parameter name="files">["a.py"]</parameter>'
        result = self.module.memory_record(session_id="s-8", summary="Changed the importer config", details=details)
        self.assertEqual(result["record"]["details"], "Real details text for the next agent.")
        self.assertEqual(result["record"]["files"], ["a.py"])

    def test_details_that_quote_the_closing_tag_are_kept_whole(self):
        # `</details> <details>` in prose is never a leak: nothing is cut from an append-only store.
        details = "The old template closed </details> <details> twice; verified in Safari after the fix."
        result = self.module.memory_record(session_id="s-10", summary="Fixed the collapsible template", details=details)
        self.assertEqual(result["record"]["details"], details)

    def test_a_leaked_agent_is_applied(self):
        result = self.module.memory_record(session_id="s-11", summary="Fixed the importer retry</summary>\n<agent>Codex</agent>",
                                           details="Verified the importer retry end to end on the host.")
        self.assertEqual(result["record"]["agent"], "Codex")
        self.assertEqual(result["record"]["summary"], "Fixed the importer retry")

    def test_duplicate_call_returns_the_stored_thread_ids(self):
        args = dict(session_id="s-9", summary="Changed one config value",
                    details="Changed and verified in the unit suite.", open_threads=["one", "two"])
        first = self.module.memory_record(**args)
        again = self.module.memory_record(**{**args, "open_threads": ["one", "two", "three"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["thread_ids"], first["thread_ids"])

    def test_session_and_summary_are_still_required(self):
        self.assertFalse(self.module.memory_record(session_id="", summary="Changed one config value")["ok"])
        self.assertFalse(self.module.memory_record(session_id="s-5", summary="short")["ok"])



class ResolveProtocolTests(unittest.TestCase):
    """memory_record(resolves=…) closes threads and finishes plans through the ledger;
    memory_record(corrects=…) files a correction for the curator to apply."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()
        self.module = load_mcp(self.runtime)
        first = self.module.memory_record(
            session_id="s-1", summary="Built the importer, not deployed yet",
            details="Deploy waits for the owner; verified locally with the unit suite.",
            open_threads=["deploy the importer", "add the retry test"])
        self.first = first["record"]["id"]

    def tearDown(self):
        self.temp.cleanup()

    def ledger(self) -> list[dict]:
        path = self.runtime / "lifecycle.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def test_thread_id_closes_exactly_that_thread(self):
        result = self.module.memory_record(
            session_id="s-2", summary="Deployed the importer to the host",
            details="Deployed and verified live; the retry test is still open.", resolves=[f"{self.first}#0"])
        self.assertEqual(len(result["resolved"]), 1)
        op = self.ledger()[0]
        self.assertEqual((op["op"], op["target"]), ("close_thread", {"kind": "thread", "id": f"{self.first}#0"}))
        self.assertEqual(op["evidence"], [f"memory:{result['record']['id']}"])
        self.assertEqual(op["actor"]["kind"], "agent")

    def test_record_id_closes_all_its_threads_once(self):
        result = self.module.memory_record(
            session_id="s-2", summary="Finished the importer work",
            details="Deployed and the retry test was added; nothing left.", resolves=[f"memory:{self.first}"])
        self.assertEqual(len(result["resolved"]), 2)
        again = self.module.memory_record(
            session_id="s-3", summary="Confirmed the importer is finished",
            details="Nothing left open on the importer after the second check.", resolves=[self.first])
        self.assertEqual(again["resolved"], [])
        self.assertEqual(len(self.ledger()), 2)

    def test_vault_id_marks_the_page_done(self):
        self.module.memory_record(
            session_id="s-2", summary="Shipped the app rule change",
            details="The plan in the app rule page is fully shipped.", resolves=["vault:app-rule"])
        op = self.ledger()[0]
        self.assertEqual((op["op"], op["target"]["id"], op["class"]), ("mark_done", "vault:app-rule", "page.mark_done"))

    def test_a_repeated_target_is_written_once(self):
        result = self.module.memory_record(
            session_id="s-2", summary="Finished the importer work, listed twice",
            details="The same targets were listed more than once in resolves.",
            resolves=[f"{self.first}#0", f"{self.first}#0", self.first, "vault:app-rule", "vault:app-rule"])
        ids = [op["id"] for op in self.ledger()]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sorted(result["resolved"]), sorted(ids))
        self.assertEqual(len(ids), 3)  # thread #0, thread #1, the page

    def test_unknown_ids_are_ignored(self):
        result = self.module.memory_record(
            session_id="s-2", summary="Closed nothing real here",
            details="Every id in resolves is unknown to the store.",
            resolves=["ffffffffffffffff#0", f"{self.first}#9", "vault:no-such-page", "garbage"])
        self.assertEqual(result["resolved"], [])
        self.assertEqual(len(result["ignored_resolves"]), 4)
        self.assertEqual(self.ledger(), [])

    def test_a_correction_is_requested(self):
        result = self.module.memory_record(
            session_id="s-2", summary="Found a stale claim about the importer",
            details="The rule page still says the importer is not deployed.",
            corrects=[{"target": "vault:app-rule", "claimed": "not deployed", "truth": "deployed on 29/09",
                       "evidence": [f"memory:{self.first}"]},
                      {"target": "nowhere", "claimed": "x", "truth": "y"}])
        self.assertEqual(len(result["requested_corrections"]), 1)
        self.assertEqual(len(result["ignored_corrects"]), 1)
        op = self.ledger()[0]
        self.assertEqual((op["op"], op["mode"], op["claimed"], op["truth"]),
                         ("correct", "requested", "not deployed", "deployed on 29/09"))
        self.assertEqual(op["target"], {"kind": "page", "id": "vault:app-rule"})


def iso_days_ago(days: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - days * 86400))


class LedgerRecallTests(unittest.TestCase):
    """Recall honors the lifecycle ledger and dates: closed threads and retired items stop
    reaching agents, finished plans are marked, daily notes and old records rank lower."""

    NODES = [
        {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
         "path": "src/app.py", "abs": "/work/src/app.py"},
        {"id": "vault:plan-a", "label": "Importer plan", "layer": "vault", "kind": "page",
         "path": "wiki/plan-a.md", "abs": "", "meta": {"description": "importer rollout plan"}},
        {"id": "vault:old-page", "label": "Legacy importer notes", "layer": "vault", "kind": "page",
         "path": "wiki/old.md", "abs": "", "meta": {"description": "legacy importer rollout notes"}},
        {"id": "vault:zz-budget-rules", "label": "Notes", "layer": "vault", "kind": "page",
         "path": "wiki/zz.md", "abs": "", "meta": {"description": "quarterly budget review"}},
        {"id": "vault:daily-2026-09-01", "label": "Notes", "layer": "vault", "kind": "page",
         "path": "wiki/daily/2026-09-01.md", "abs": "",
         "meta": {"description": "quarterly budget review", "type": "daily-note"}},
    ]
    LINKS = [{"source": "agents:src/app.py", "target": "vault:plan-a", "type": "xlayer"},
             {"source": "agents:src/app.py", "target": "vault:old-page", "type": "xlayer"}]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()
        self.module = load_mcp(self.runtime, nodes=self.NODES, links=self.LINKS)
        records = [
            {"id": "c000000000000001", "session_id": "s", "created_at": iso_days_ago(1), "agent": "t",
             "summary": "Importer built", "details": "Built and verified locally.",
             "files": ["/work/src/app.py"], "decisions": [], "open_threads": ["zebra migration pending"]},
            {"id": "c000000000000002", "session_id": "s", "created_at": iso_days_ago(1), "agent": "t",
             "summary": "Importer status snapshot not deployed", "details": "Waiting for approval.",
             "files": ["/work/src/app.py"], "decisions": [], "open_threads": []},
            {"id": "c000000000000003", "session_id": "s", "created_at": iso_days_ago(50), "agent": "t",
             "summary": "walrus harbor survey", "details": "old", "files": [], "decisions": [], "open_threads": []},
            {"id": "c000000000000004", "session_id": "s", "created_at": iso_days_ago(1), "agent": "t",
             "summary": "walrus harbor survey", "details": "new", "files": [], "decisions": [], "open_threads": []},
        ]
        (self.runtime / "memory.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        sys.path.insert(0, str(self.runtime))
        import lifecycle  # the copy load_mcp deployed next to the server
        sys.path.remove(str(self.runtime))
        ledger = self.runtime / "lifecycle.jsonl"
        base = {"reason": "test", "actor": {"kind": "owner", "name": "test"}, "mode": "approved"}
        lifecycle.append_op(ledger, {**base, "op": "close_thread", "target": {"kind": "thread", "id": "c000000000000001#0"}})
        lifecycle.append_op(ledger, {**base, "op": "retire", "target": {"kind": "record", "id": "c000000000000002"},
                                     "superseded_by": "memory:c000000000000001"})
        lifecycle.append_op(ledger, {**base, "op": "mark_done", "target": {"kind": "page", "id": "vault:plan-a"},
                                     "evidence": ["memory:c000000000000001"]})
        lifecycle.append_op(ledger, {**base, "op": "retire", "target": {"kind": "page", "id": "vault:old-page"}})

    def tearDown(self):
        self.temp.cleanup()

    def ids(self, results) -> list[str]:
        return [item["id"] for item in results]

    def test_brain_node_splits_open_and_closed_threads(self):
        record = self.module.brain_node("memory:c000000000000001")
        self.assertEqual(record["open_threads"], [])
        self.assertEqual(record["closed_threads"], [{"id": "c000000000000001#0", "text": "zebra migration pending"}])

    def test_graph_walks_leave_out_retired_records_and_mark_finished_pages(self):
        brain = self.runtime / "brain.json"
        os.utime(brain, (brain.stat().st_atime, brain.stat().st_mtime + 10))  # reload: records attach now
        near = {item["id"]: item for item in self.module.brain_neighbors("agents:src/app.py")}
        self.assertIn("memory:c000000000000001", near)
        self.assertNotIn("memory:c000000000000002", near)
        self.assertEqual(near["vault:old-page"]["lifecycle"]["state"], "retired")
        self.assertEqual(near["vault:plan-a"]["lifecycle"]["state"], "done")
        self.assertEqual(self.module.brain_path("agents:src/app.py", "vault:old-page")[-1]["lifecycle"]["state"], "retired")

    def test_a_closed_thread_neither_matches_nor_shows(self):
        self.assertNotIn("memory:c000000000000001", self.ids(self.module.brain_search("zebra migration")))
        brief = next(item for item in self.module.memory_recent(limit=10) if item["id"] == "c000000000000001")
        self.assertEqual(brief["open_threads"], [])

    def test_a_retired_record_leaves_recall_but_opens_by_id(self):
        self.assertNotIn("memory:c000000000000002", self.ids(self.module.brain_search("importer status snapshot")))
        self.assertNotIn("c000000000000002", self.ids(self.module.memory_recent(limit=10)))
        context = self.module.brain_context("/work/src/app.py")
        self.assertNotIn("c000000000000002", self.ids(context["shared_memory"]))
        record = self.module.brain_node("memory:c000000000000002")
        self.assertEqual(record["lifecycle"]["state"], "retired")
        self.assertEqual(record["lifecycle"]["superseded_by"], "memory:c000000000000001")

    def test_a_done_page_is_marked_and_a_retired_page_is_gone(self):
        results = self.module.brain_search("importer rollout")
        plan = next(item for item in results if item["id"] == "vault:plan-a")
        self.assertTrue(plan["label"].startswith("[DONE "), plan)
        self.assertIn("memory:c000000000000001", plan["label"])
        self.assertNotIn("vault:old-page", self.ids(results))
        pages = self.ids(self.module.brain_context("/work/src/app.py")["vault_pages"])
        self.assertIn("vault:plan-a", pages)
        self.assertNotIn("vault:old-page", pages)
        self.assertEqual(self.module.brain_node("vault:old-page")["lifecycle"]["state"], "retired")

    def test_a_daily_note_ranks_below_an_equal_page(self):
        order = self.ids(self.module.brain_search("quarterly budget review"))
        self.assertLess(order.index("vault:zz-budget-rules"), order.index("vault:daily-2026-09-01"))

    def test_a_newer_record_outranks_an_equal_older_one(self):
        order = self.ids(self.module.brain_search("walrus harbor survey"))
        self.assertLess(order.index("memory:c000000000000004"), order.index("memory:c000000000000003"))

    def test_recency_reads_the_clock_from_ASM_NOW(self):
        # The benchmark freezes the clock at the snapshot's time; otherwise the same snapshot
        # ranks differently every day and a code change cannot be told from clock drift.
        with mock.patch.dict(os.environ, {"ASM_NOW": "2030-01-01T00:00:00+00:00"}):
            self.assertAlmostEqual(self.module.recency_factor("2029-10-01T00:00:00+00:00"), 0.85, places=2)
            self.assertAlmostEqual(self.module.recency_factor("2029-12-31T00:00:00+00:00"), 1.145, places=2)

    def test_recency_factor_edges(self):
        factor = self.module.recency_factor
        self.assertAlmostEqual(factor(iso_days_ago(0)), 1.15, places=2)
        self.assertAlmostEqual(factor(iso_days_ago(60)), 0.85, places=2)
        self.assertAlmostEqual(factor(iso_days_ago(120)), 0.85, places=2)
        self.assertAlmostEqual(factor(iso_days_ago(-3)), 1.15, places=2)
        self.assertEqual(factor("not a date"), 1.0)

    def test_without_a_ledger_nothing_is_hidden(self):
        (self.runtime / "lifecycle.jsonl").unlink()
        brief = next(item for item in self.module.memory_recent(limit=10) if item["id"] == "c000000000000001")
        self.assertEqual([thread["id"] for thread in brief["open_threads"]], ["c000000000000001#0"])
        self.assertIn("c000000000000002", self.ids(self.module.memory_recent(limit=10)))

def make_worktree(root: Path, main: str, name: str) -> Path:
    (root / main / ".git" / "worktrees" / name).mkdir(parents=True)
    tree = root / name
    tree.mkdir()
    (tree / ".git").write_text(f"gitdir: {root / main / '.git' / 'worktrees' / name}\n", encoding="utf-8")
    return tree


class WorktreeTests(unittest.TestCase):
    """Dated git worktrees were 55% of all graph nodes (the same code again), and a path
    inside a new worktree resolved to nothing in brain_context."""

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

    def discovered_names(self) -> set[str]:
        config = self.root / "cfg" / "sources.json"
        config.parent.mkdir(exist_ok=True)
        config.write_text(json.dumps({"sources": [], "discoverSources": [{"root": str(self.root)}]}),
                          encoding="utf-8")
        return {Path(source["base"]).name for source in expanded_sources(config)}

    def test_manifest_json_is_ascii_so_a_hebrew_path_survives_a_windows_pipe(self):
        # On Windows, Python writes to a pipe in the ANSI code page: a raw Hebrew path arrives
        # mangled and its source silently drops out of the refresh. JSON escapes survive any page.
        (self.root / "פרויקט").mkdir()
        config = self.root / "cfg" / "sources.json"
        config.parent.mkdir(exist_ok=True)
        config.write_text(json.dumps({"sources": [], "discoverSources": [{"root": str(self.root)}]}), encoding="utf-8")
        done = subprocess.run([sys.executable, str(PROJECT / "source_manifest.py"), str(config)],
                              capture_output=True, check=True)
        self.assertTrue(done.stdout.isascii(), done.stdout[:200])
        self.assertIn("פרויקט", {Path(source["base"]).name for source in json.loads(done.stdout)})

    def test_manifest_skips_worktrees_of_mapped_repos(self):
        names = self.discovered_names()
        self.assertIn("Main", names)
        self.assertNotIn("Main-feature-20260101", names)

    def test_manifest_keeps_a_worktree_whose_main_is_not_mapped(self):
        elsewhere = Path(self.temp.name).resolve() / "Elsewhere"
        make_worktree(elsewhere, "Repo", "Repo-x")
        (self.root / "Repo-x").symlink_to(elsewhere / "Repo-x")
        self.assertIn("Repo-x", self.discovered_names())

    def test_context_resolves_a_worktree_path_to_the_main_checkout(self):
        runtime = Path(self.temp.name) / "runtime"
        runtime.mkdir()
        module = load_mcp(runtime, nodes=[
            {"id": "agents:main/src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "main/src/app.py", "abs": (self.root / "Main" / "src" / "app.py").as_posix().lower()},
            # A second project with the same last two segments, so the suffix bucket alone
            # is ambiguous and only the worktree rewrite can resolve the path.
            {"id": "agents:other/src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "other/src/app.py", "abs": "/elsewhere/other/src/app.py"},
        ], links=[])
        ctx = module.brain_context(str(self.tree / "src" / "app.py"))
        self.assertIsNotNone(ctx["node"], ctx)
        self.assertEqual(ctx["node"]["id"], "agents:main/src/app.py")
        self.assertIn("Main", ctx["resolved_via"])


@unittest.skipIf(shutil.which("git") is None, "needs git")
class StaleMainCheckoutTests(unittest.TestCase):
    """On 30/09 the mapped main checkout of one repo was 271 commits behind the worktrees agents
    worked in: brain_context answered from old code, with nothing but a resolved_via field."""

    def git(self, cwd: Path, *args: str) -> None:
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True, env=env)

    def context_after(self, commits: int) -> dict:
        root = Path(self.temp.name).resolve()
        main = root / "Main"
        (main / "src").mkdir(parents=True)
        (main / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
        self.git(main, "init", "-q", "-b", "main")
        self.git(main, "add", ".")
        self.git(main, "commit", "-q", "-m", "one")
        tree = root / "Main-feature"
        self.git(main, "worktree", "add", "-q", "-b", "feature", str(tree))
        for index in range(commits):
            (tree / "src" / f"new{index}.py").write_text(f"y = {index}\n", encoding="utf-8")
            self.git(tree, "add", ".")
            self.git(tree, "commit", "-q", "-m", f"c{index}")
        runtime = root / "runtime"
        runtime.mkdir()
        module = load_mcp(runtime, nodes=[
            {"id": "agents:main/src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "main/src/app.py", "abs": (main / "src" / "app.py").as_posix().lower()},
        ], links=[])
        return module.brain_context(str(tree / "src" / "app.py"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_context_warns_when_the_main_checkout_is_far_behind_the_worktree(self):
        ctx = self.context_after(12)
        self.assertEqual(ctx["node"]["id"], "agents:main/src/app.py")
        self.assertEqual(ctx["main_checkout_behind"]["commits"], 12)
        self.assertIn("read the file itself", ctx["main_checkout_behind"]["note"])

    def test_context_stays_quiet_when_the_main_checkout_is_close(self):
        ctx = self.context_after(3)
        self.assertEqual(ctx["node"]["id"], "agents:main/src/app.py")
        self.assertNotIn("main_checkout_behind", ctx)


class GraphReloadTests(unittest.TestCase):
    def test_a_rewritten_brain_is_served_without_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp)
            module = load_mcp(runtime)
            self.assertIn("error", module.brain_node("vault:new-page"))
            brain = json.loads((runtime / "brain.json").read_text(encoding="utf-8"))
            brain["nodes"].append({"id": "vault:new-page", "label": "New", "layer": "vault", "kind": "page",
                                   "path": "wiki/new.md", "abs": "", "meta": {"description": "freshly written"}})
            (runtime / "brain.json").write_text(json.dumps(brain), encoding="utf-8")
            stamp = time.time() + 5
            os.utime(runtime / "brain.json", (stamp, stamp))
            self.assertEqual(module.brain_node("vault:new-page")["label"], "New")
            self.assertTrue(any(item["id"] == "vault:new-page" for item in module.brain_search("freshly written")))

    def test_a_broken_brain_keeps_the_old_graph(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp)
            module = load_mcp(runtime)
            (runtime / "brain.json").write_text("{not json", encoding="utf-8")
            stamp = time.time() + 5
            os.utime(runtime / "brain.json", (stamp, stamp))
            self.assertEqual(module.brain_node("vault:app-rule")["label"], "App rule")


class OfflineRecallTests(unittest.TestCase):
    """The visualization server is optional; the shared memory is the product.

    Hook posts go to :8930 and fall back to pending.jsonl when nothing answers, and only
    a server start ever drains that buffer into events.jsonl. Before this, a machine with
    the UI off recorded everything and could read back none of it — six days of that left
    4,794 touches buffered and invisible to every agent.
    """

    NODES = [
        {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
         "path": "src/app.py", "abs": "/work/src/app.py"},
        {"id": "other:src/app.py", "label": "app.py", "layer": "lab", "kind": "file",
         "path": "src/app.py", "abs": "/elsewhere/src/app.py"},
    ]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name)
        self.mcp = load_mcp(self.runtime, nodes=self.NODES, links=[])
        # Hermetic: a developer running these with the UI up must not pull real events.
        self.offline = mock.patch.object(
            self.mcp.urllib.request, "urlopen", side_effect=OSError("no server"))
        self.offline.start()
        self.addCleanup(self.offline.stop)

    def tearDown(self):
        self.temp.cleanup()

    def buffer(self, *records):
        (self.runtime / "pending.jsonl").write_text(
            "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")

    def test_a_touch_that_never_reached_the_server_is_still_recalled(self):
        self.buffer({
            "ts": 1789000000.5, "tool": "Edit", "cwd": "/work",
            "session": "s1", "agent": "Claude Code", "paths": ["/work/src/app.py"],
            "file_access": True, "phase": "finish", "operation_id": "op-1",
        })
        hits = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["node_id"], "agents:src/app.py")
        self.assertEqual(hits[0]["agent"], "Claude Code")
        self.assertEqual(hits[0]["label"], "app.py")
        self.assertEqual(hits[0]["layer"], "agents")
        self.assertTrue(hits[0]["matched"])
        self.assertTrue(hits[0]["pending"], "a buffered row must say so")

    def test_the_hook_sends_relative_paths_and_they_resolve_through_cwd(self):
        self.buffer({
            "ts": 1789000001.0, "tool": "Read", "cwd": "/work",
            "session": "s1", "agent": "Codex", "paths": ["src/app.py"],
            "file_access": True, "phase": "start", "operation_id": "op-2",
        })
        hits = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual([h["path"] for h in hits], ["/work/src/app.py"])

    def test_the_same_event_in_both_sources_is_one_row_and_the_durable_one_wins(self):
        record = {
            "ts": 1789000002.25, "tool": "Edit", "cwd": "/work", "session": "s1",
            "agent": "Claude Code", "paths": ["/work/src/app.py"],
            "file_access": True, "phase": "finish", "operation_id": "op-3",
        }
        self.buffer(record)
        (self.runtime / "events.jsonl").write_text(json.dumps({
            "ts": 1789000002.25, "tool": "Edit", "cwd": "/work", "session": "s1",
            "agent": "Claude Code", "path": "/work/src/app.py",
            "node_id": "agents:src/app.py", "matched": True, "presence": False,
            "layer": "agents", "label": "app.py", "source": "hook",
            "phase": "finish", "operation_id": "op-3", "file_access": True,
        }) + "\n", encoding="utf-8")
        hits = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual(len(hits), 1)
        self.assertNotIn("pending", hits[0], "the persisted row owns the identity")

    def test_the_buffer_cannot_report_another_project_as_this_file(self):
        """The guarantee that survived from the log path: a bare filename is not a match."""
        self.buffer({
            "ts": 1789000003.0, "tool": "Edit", "cwd": "/elsewhere",
            "session": "s2", "agent": "Codex", "paths": ["/elsewhere/src/app.py"],
            "file_access": True, "phase": "finish", "operation_id": "op-4",
        })
        self.assertEqual(self.mcp.recent_access("/work/src/app.py", "agents:src/app.py"), [])
        other = self.mcp.recent_access("/elsewhere/src/app.py", "other:src/app.py")
        self.assertEqual([h["node_id"] for h in other], ["other:src/app.py"])

    def test_presence_beats_and_the_overflow_marker_are_not_file_access(self):
        self.buffer(
            {"ts": 1789000004.0, "tool": "Bash", "cwd": "/work", "session": "s1",
             "agent": "Claude Code", "paths": [], "file_access": False},
            {"dropped": 1200, "ts": 1789000004.5},
            {"ts": 1789000005.0, "tool": "Edit", "cwd": "/work", "session": "s1",
             "agent": "Claude Code", "paths": ["/work/src/app.py"],
             "file_access": True, "phase": "finish", "operation_id": "op-5"},
        )
        hits = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual([h["operation_id"] for h in hits], ["op-5"])

    def test_recall_is_ordered_oldest_last_seen_and_capped(self):
        self.buffer(*[{
            "ts": 1789000000.0 + index, "tool": "Edit", "cwd": "/work", "session": "s1",
            "agent": "Claude Code", "paths": ["/work/src/app.py"],
            "file_access": True, "phase": "finish", "operation_id": f"op-{index}",
        } for index in range(14)])
        hits = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual(len(hits), 10)
        self.assertEqual(hits[-1]["operation_id"], "op-13", "newest last")
        self.assertEqual([h["ts"] for h in hits], sorted(h["ts"] for h in hits))

    def test_brain_context_carries_the_buffered_touch_end_to_end(self):
        self.buffer({
            "ts": 1789000006.0, "tool": "Edit", "cwd": "/work", "session": "s1",
            "agent": "Claude Code", "paths": ["/work/src/app.py"],
            "file_access": True, "phase": "finish", "operation_id": "op-ctx",
        })
        context = self.mcp.brain_context("/work/src/app.py")
        self.assertEqual(
            [e["operation_id"] for e in context["recent_access"]], ["op-ctx"])


class BufferDrainTests(unittest.TestCase):
    """With the UI retired the buffer is where new activity lands, and the hook caps it
    at 2MB by dropping the older half — so the record of what every agent touched was a
    rolling window that quietly forgot its own past. The drain turns it into an archive.
    """

    NODES = [
        {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
         "path": "src/app.py", "abs": "/work/src/app.py"},
    ]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name)
        self.mcp = load_mcp(self.runtime, nodes=self.NODES, links=[])
        self.offline = mock.patch.object(
            self.mcp.urllib.request, "urlopen", side_effect=OSError("no server"))
        self.offline.start()
        self.addCleanup(self.offline.stop)

    def tearDown(self):
        self.temp.cleanup()

    def touch(self, op, ts=1789000000.0, paths=("/work/src/app.py",)):
        return {"ts": ts, "tool": "Edit", "cwd": "/work", "session": "s1",
                "agent": "Claude Code", "paths": list(paths), "file_access": True,
                "phase": "finish", "operation_id": op}

    def buffer(self, *records, path=None):
        (path or self.runtime / "pending.jsonl").write_text(
            "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")

    def events(self):
        text = (self.runtime / "events.jsonl").read_text(encoding="utf-8")
        return [json.loads(x) for x in text.splitlines() if x.strip()]

    def test_the_buffer_becomes_durable_history_and_is_cleared(self):
        self.buffer(self.touch("op-1", 1789000001.0), self.touch("op-2", 1789000002.0))
        self.assertEqual(self.mcp.drain_buffer(), 2)
        self.assertFalse((self.runtime / "pending.jsonl").exists())
        self.assertFalse((self.runtime / "pending.draining").exists())
        rows = self.events()
        self.assertEqual([r["operation_id"] for r in rows], ["op-1", "op-2"])
        self.assertEqual(rows[0]["node_id"], "agents:src/app.py")
        self.assertTrue(rows[0]["matched"])
        self.assertNotIn("pending", rows[0], "a persisted row is no longer buffered")

    def test_draining_twice_does_not_duplicate_a_touch(self):
        self.buffer(self.touch("op-1", 1789000001.0))
        self.assertEqual(self.mcp.drain_buffer(), 1)
        self.buffer(self.touch("op-1", 1789000001.0))  # the hook re-buffered the same post
        self.assertEqual(self.mcp.drain_buffer(), 0)
        self.assertEqual(len(self.events()), 1)

    def test_only_one_session_drains_at_a_time(self):
        self.buffer(self.touch("op-1"))
        (self.runtime / "pending.drain.lock").write_text("", encoding="utf-8")
        self.assertEqual(self.mcp.drain_buffer(), 0, "a held lock must stop a second drainer")
        self.assertTrue((self.runtime / "pending.jsonl").exists(), "the buffer is left intact")

    def test_a_lock_left_by_a_dead_process_is_taken_over(self):
        self.buffer(self.touch("op-1"))
        lock = self.runtime / "pending.drain.lock"
        lock.write_text("", encoding="utf-8")
        os.utime(lock, (time.time() - 600, time.time() - 600))
        self.assertEqual(self.mcp.drain_buffer(), 1)
        self.assertFalse(lock.exists(), "the lock is released on the way out")

    def test_a_crash_mid_drain_leaves_the_staged_file_and_the_next_start_recovers_it(self):
        self.buffer(self.touch("op-staged", 1789000001.0),
                    path=self.runtime / "pending.draining")
        self.buffer(self.touch("op-fresh", 1789000002.0))
        self.assertEqual(self.mcp.drain_buffer(), 2, "both the staged batch and the new one")
        self.assertEqual([r["operation_id"] for r in self.events()],
                         ["op-staged", "op-fresh"])

    def test_presence_and_the_overflow_marker_never_become_events(self):
        self.buffer(
            {"ts": 1789000001.0, "tool": "Bash", "cwd": "/work", "session": "s1",
             "agent": "Claude Code", "paths": [], "file_access": False},
            {"dropped": 900, "ts": 1789000001.5},
        )
        self.assertEqual(self.mcp.drain_buffer(), 0)
        self.assertFalse((self.runtime / "events.jsonl").exists())
        self.assertFalse((self.runtime / "pending.jsonl").exists(), "the buffer still clears")

    def test_a_drained_touch_is_recalled_exactly_once(self):
        """The read path reads both sources; draining must not make a touch count twice."""
        self.buffer(self.touch("op-1", 1789000001.0))
        before = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual([h["operation_id"] for h in before], ["op-1"])
        self.mcp.drain_buffer()
        after = self.mcp.recent_access("/work/src/app.py", "agents:src/app.py")
        self.assertEqual([h["operation_id"] for h in after], ["op-1"])

    def test_an_unwritable_log_keeps_the_batch_for_the_next_session(self):
        self.buffer(self.touch("op-1"))
        blocked = self.runtime / "events.jsonl"
        blocked.mkdir()  # any OSError on the append; a directory is the simplest real one
        self.assertEqual(self.mcp.drain_buffer(), 0)
        self.assertTrue((self.runtime / "pending.draining").exists(),
                        "nothing is dropped on the floor when the log cannot be written")
        blocked.rmdir()
        self.assertEqual(self.mcp.drain_buffer(), 1, "and the next start picks it up")


if __name__ == "__main__":
    unittest.main()
