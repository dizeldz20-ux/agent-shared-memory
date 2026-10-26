"""Contract tests for hook/asm-recall-gate.js — the first code search of a prompt into a
mapped project is bounced once to ASM unless the session already asked the map."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
HOOK = PROJECT / "hook" / "asm-recall-gate.js"


class RecallGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.runtime = base / "runtime"
        self.runtime.mkdir()
        self.projects = base / "Projects"
        repo = self.projects / "agent-shared-memory"
        repo.mkdir(parents=True)
        (repo / "sources.json").write_text(json.dumps({"discoverSources": [{"root": "..", "exclude": ["backups"]}]}))
        self.paco = self.projects / "PacoBot"
        (self.paco / "src").mkdir(parents=True)
        (self.paco / "src" / "a.ts").write_text("x")
        (self.projects / "backups").mkdir()
        self.vault = base / "vault"
        self.vault.mkdir()
        (self.runtime / "asm-paths.json").write_text(json.dumps({"repo": str(repo), "vault": str(self.vault)}))
        self.env = {**os.environ, "ASM_HOME": str(self.runtime)}
        self.env.pop("ASM_JOB", None)

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, env=None):
        result = subprocess.run(["node", str(HOOK)], input=json.dumps({"session_id": "s1", **payload}),
                                text=True, capture_output=True, env=env or self.env, timeout=8, check=True)
        return json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"] if result.stdout else "allow"

    def prompt(self):
        self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": "x"})

    def grep(self, path, cwd=None):
        return self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "Grep",
                              "tool_input": {"pattern": "foo", "path": str(path)}, "cwd": str(cwd or self.projects.parent)})

    def bash(self, command, cwd):
        return self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                              "tool_input": {"command": command}, "cwd": str(cwd)})

    def test_first_search_is_bounced_once_per_prompt(self):
        self.prompt()
        self.assertEqual(self.grep(self.paco / "src"), "deny")
        self.assertEqual(self.grep(self.paco), "allow")
        self.prompt()
        self.assertEqual(self.grep(self.paco), "deny")

    def test_asking_the_map_first_opens_the_gate(self):
        self.prompt()
        self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "mcp__asm__brain_search", "tool_input": {"query": "x"}})
        self.assertEqual(self.grep(self.paco), "allow")
        self.prompt()
        self.assertEqual(self.grep(self.paco), "deny")

    def test_unmapped_and_excluded_trees_pass(self):
        self.prompt()
        self.assertEqual(self.grep(Path(self.tmp.name) / "runtime"), "allow")
        self.assertEqual(self.grep(self.projects / "backups"), "allow")
        self.assertEqual(self.grep(self.vault), "deny")

    def test_shell_searches(self):
        self.prompt()
        self.assertEqual(self.bash("ps aux | grep node", self.paco), "allow")
        self.assertEqual(self.bash("grep -n foo src/a.ts", self.paco), "allow")
        self.assertEqual(self.bash(f'cd {self.paco} && grep -rn "a|b" .', self.projects.parent), "deny")
        self.prompt()
        self.assertEqual(self.bash("rg foo", self.paco), "deny")
        self.prompt()
        self.assertEqual(self.bash("ls && git grep foo", self.paco), "deny")
        self.prompt()
        self.assertEqual(self.bash("git commit -F - <<'EOF'\ngrep -r is slow, don't\nEOF", self.paco), "allow")
        for command in (f"git -C {self.paco} --no-pager grep foo", "timeout 10 grep -r foo .", "nice -n 5 rg foo"):
            self.prompt()
            self.assertEqual(self.bash(command, self.projects.parent if "-C" in command else self.paco), "deny", command)

    def test_grep_of_one_known_file_passes(self):
        self.prompt()
        self.assertEqual(self.grep(self.paco / "src" / "a.ts"), "allow")

    def test_background_jobs_are_never_gated(self):
        self.prompt()
        self.assertEqual(self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "Grep",
                                        "tool_input": {"path": str(self.paco)}}, env={**self.env, "ASM_JOB": "1"}), "allow")

    def test_installed_for_claude_code_only(self):
        spec = importlib.util.spec_from_file_location("cai", PROJECT / "tools" / "configure_agent_integrations.py")
        cai = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cai)
        claude, codex = {}, {}
        for _ in range(2):  # re-running stays idempotent
            cai.merge_grouped_hooks(claude, Path("/rt"), include_skill_router=True)
        cai.merge_grouped_hooks(codex, Path("/rt"))
        gate = lambda doc, event: [g for g in doc["hooks"].get(event, []) if any("asm-recall-gate.js" in h["command"] for h in g["hooks"])]
        self.assertEqual(len(gate(claude, "UserPromptSubmit")), 1)
        self.assertEqual(gate(claude, "PreToolUse")[0]["matcher"], "Grep|Glob|Bash|mcp__asm__.*")
        self.assertEqual(gate(codex, "PreToolUse"), [])


if __name__ == "__main__":
    unittest.main()
