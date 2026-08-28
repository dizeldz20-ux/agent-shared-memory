import asyncio
import concurrent.futures
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from codex_activity import CodexRolloutWatcher, activity_from_rollout, code_mode_paths
from source_manifest import expanded_sources


PROJECT = Path(__file__).resolve().parents[1]


def load_mcp(runtime: Path, nodes=None, links=None):
    shutil.copy2(PROJECT / "mcp_server.py", runtime / "mcp_server.py")
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
            "scrub-2", "Noa line documented",
            "Noa answers on 0733861992 via 10.0.0.12; token: string, password: required field, "
            "secret = os.environ['TOWER_CREDENTIAL_KEY'], Basic authentication-header parsing.")
        self.assertEqual(plain["redactions"], [])
        self.assertIn("0733861992", plain["record"]["details"])
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
            {"id": "vault:sweeper", "label": "Sweeper", "layer": "vault", "kind": "page",
             "path": "wiki/sweeper.md",
             "meta": {"description": "AWS fleet monitor", "tags": ["ops"], "aliases": ["סוויפר"]}},
        ]
        module = load_mcp(self.runtime, nodes=nodes, links=[])
        # Raw field weights alone put the three index.ts files (label+path = 3) above the
        # page (description only = 1, x1.25); IDF over the hit set inverts that.
        results = module.brain_search("index.ts startup")
        self.assertEqual(results[0]["id"], "vault:startup-rule")
        self.assertEqual(len(results), 4)
        # A Hebrew alias is matched after the same stemming the hook applies.
        self.assertEqual(module.brain_search("הסוויפר")[0]["id"], "vault:sweeper")
        self.assertEqual(module.brain_search("   "), [])


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
            {"i": "vault:sweeper", "l": "Sweeper", "k": "page", "p": "wiki/sweeper.md",
             "d": "AWS fleet monitor", "t": ["ops"], "a": ["סוויפר"]},
        ], ensure_ascii=False), encoding="utf-8")

    def test_prompt_recall_matches_hebrew_aliases_and_fresh_memory_records(self):
        self.write_index()
        (self.runtime / "memory.jsonl").write_text(json.dumps({
            "id": "abc123", "created_at": "2026-08-28T09:00:00+03:00", "agent": "Codex",
            "summary": "Widget deploy pipeline repaired",
            "details": "x" * 3000, "files": ["src/widget.ts"], "decisions": [],
            "open_threads": ["Re-run the deploy on staging"],
        }) + "\n", encoding="utf-8")
        hebrew = self.run_hook("asm-prompt-recall.js", {"prompt": "תבדוק את הסוויפר ב-AWS"}).stdout
        self.assertIn("vault:sweeper", hebrew)
        self.assertNotIn("vault:app-rule", hebrew)
        # One alias hit stands alone: the two-hit rule is for coincidences, not curated names.
        self.assertIn("vault:sweeper", self.run_hook("asm-prompt-recall.js", {"prompt": "תבדוק את הסוויפר"}).stdout)
        fresh = self.run_hook("asm-prompt-recall.js", {"prompt": "widget deploy staging"}).stdout
        self.assertIn("memory:abc123 — Widget deploy pipeline repaired", fresh)
        # One long word that merely appears in a summary is not evidence (it was: the summary
        # scored as a label made any 8-char token a "strong" single hit).
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "pipeline"}).stdout, "")
        with (self.runtime / "memory.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "def456", "created_at": "2026-08-28T10:00:00+03:00",
                                     "summary": "Something unrelated", "supersedes": ["abc123"]}) + "\n")
        self.assertEqual(self.run_hook("asm-prompt-recall.js", {"prompt": "widget deploy staging"}).stdout, "")

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

    def test_session_start_reports_dreaming_age_and_open_threads(self):
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
            + json.dumps({"id": "b", "created_at": old, "open_threads": ["stale"]}) + "\n",
            encoding="utf-8")
        output = self.run_hook("asm-session-start.js", {"session_id": "s"}).stdout
        self.assertIn("Dreaming: last ran 5d ago", output)
        self.assertIn("consolidation is not running", output)
        self.assertIn('Open threads: 1 record(s) in the last 2 days ended with unfinished work — latest: "one"', output)

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
            "timestamp": "2026-08-25T01:00:01Z",
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
            f'workdir:"{self.project}"}}); text(r.output)'
        )
        self.assertEqual(code_mode_paths(source, str(self.root)), [str(self.target.resolve())])
        activity = activity_from_rollout({
            "timestamp": "2026-08-25T01:00:00Z",
            "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "call-1", "input": source},
        }, {"id": "session-1", "cwd": str(self.root)})
        self.assertEqual(activity["tool"], "Bash")
        self.assertEqual(activity["paths"], [str(self.target.resolve())])
        self.assertEqual(activity["operation_id"], "call-1")
        self.assertEqual(activity["phase"], "start")
        self.assertTrue(activity["file_access"])
        self.assertNotIn("input", activity)

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
            "timestamp": "2026-08-25T01:00:01Z",
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


if __name__ == "__main__":
    unittest.main()
