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


def load_mcp(runtime: Path):
    shutil.copy2(PROJECT / "mcp_server.py", runtime / "mcp_server.py")
    (runtime / "brain.json").write_text(json.dumps({
        "generatedAt": "2026-08-25T00:00:00Z",
        "nodes": [
            {"id": "agents:src/app.py", "label": "app.py", "layer": "agents", "kind": "file",
             "path": "src/app.py", "abs": "/work/src/app.py"},
            {"id": "vault:app-rule", "label": "App rule", "layer": "vault", "kind": "page",
             "path": "wiki/app-rule.md", "meta": {"description": "Important regression rule", "tags": ["app"]}},
        ],
        "links": [{"source": "agents:src/app.py", "target": "vault:app-rule", "type": "xlayer"}],
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
