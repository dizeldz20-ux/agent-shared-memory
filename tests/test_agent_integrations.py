import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path, PureWindowsPath


PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "configure_agent_integrations",
    PROJECT / "tools" / "configure_agent_integrations.py",
)
assert SPEC and SPEC.loader
INTEGRATIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INTEGRATIONS)


class AgentIntegrationConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.runtime = self.home / ".asm"
        self.home.mkdir()
        self.runtime.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def json_at(self, relative: str):
        return json.loads((self.home / relative).read_text(encoding="utf-8"))

    def test_configure_preserves_settings_and_points_every_client_at_one_runtime(self):
        claude_path = self.home / ".claude" / "settings.json"
        claude_path.parent.mkdir()
        claude_path.write_text(
            json.dumps({
                "theme": "dark",
                "permissions": {"allow": ["Bash(git status)", "mcp__c2b__*"]},
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "Read|Write",
                        "hooks": [
                            {"type": "command", "command": "safe-hook"},
                            {
                                "type": "command",
                                "command": 'node "/old/hooks/asm-activity-hook.js"',
                            },
                        ],
                    }],
                },
            }),
            encoding="utf-8",
        )
        claude_mcp_path = self.home / ".claude.json"
        claude_mcp_path.write_text(
            json.dumps({
                "theme": "preserved",
                "mcpServers": {
                    "c2b": {"command": "old"},
                    "user-server": {"command": "keep-me"},
                },
            }),
            encoding="utf-8",
        )
        kimi_config = self.home / ".kimi-code" / "config.toml"
        kimi_config.parent.mkdir()
        kimi_config.write_text('telemetry = false\n', encoding="utf-8")

        configured = INTEGRATIONS.configure(self.home, self.runtime, "/opt/uv", include_legacy_kimi=True)
        self.assertIn("cursor_mcp", configured)

        claude = self.json_at(".claude/settings.json")
        self.assertEqual(claude["theme"], "dark")
        self.assertIn("Bash(git status)", claude["permissions"]["allow"])
        self.assertIn("mcp__asm__*", claude["permissions"]["allow"])
        self.assertNotIn("mcp__c2b__*", claude["permissions"]["allow"])
        commands = [
            handler["command"]
            for group in claude["hooks"]["PreToolUse"]
            for handler in group.get("hooks", [])
        ]
        self.assertIn("safe-hook", commands)
        self.assertTrue(any("asm-activity-hook.js" in command for command in commands))
        preserved_group = next(
            group for group in claude["hooks"]["PreToolUse"]
            if any(handler.get("command") == "safe-hook" for handler in group.get("hooks", []))
        )
        self.assertEqual(preserved_group["matcher"], "Read|Write")
        self.assertEqual(len(preserved_group["hooks"]), 1)

        claude_mcp = self.json_at(".claude.json")
        self.assertEqual(claude_mcp["theme"], "preserved")
        self.assertIn("user-server", claude_mcp["mcpServers"])
        self.assertNotIn("c2b", claude_mcp["mcpServers"])
        self.assertEqual(claude_mcp["mcpServers"]["asm"]["args"][2], str(self.runtime))

        for relative in (
            ".gemini/settings.json",
            ".cursor/mcp.json",
            ".kimi-code/mcp.json",
            ".kimi/mcp.json",
        ):
            entry = self.json_at(relative)["mcpServers"]["asm"]
            self.assertEqual(entry["command"], "/opt/uv")
            self.assertEqual(entry["args"][2], str(self.runtime))
        generic = json.loads((self.runtime / "client-configs" / "mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(generic["mcpServers"]["asm"]["args"][2], str(self.runtime))

        cursor_hooks = self.json_at(".cursor/hooks.json")
        self.assertEqual(cursor_hooks["version"], 1)
        self.assertEqual(set(cursor_hooks["hooks"]), {"sessionStart", "preToolUse", "postToolUse", "stop"})

        grok_hooks = self.json_at(".grok/hooks/asm.json")
        self.assertEqual(set(grok_hooks["hooks"]), {"PreToolUse", "PostToolUse", "Stop"})
        self.assertNotIn("SessionStart", grok_hooks["hooks"])
        self.assertNotIn("UserPromptSubmit", grok_hooks["hooks"])

        for relative in (".claude/settings.json", ".codex/hooks.json"):
            grouped = self.json_at(relative)["hooks"]
            pre = grouped["PreToolUse"][-1]["hooks"][0]
            post = grouped["PostToolUse"][-1]["hooks"][0]
            self.assertNotIn("async", pre)
            self.assertTrue(post["async"])
        grok_grouped = grok_hooks["hooks"]
        self.assertNotIn("async", grok_grouped["PreToolUse"][-1]["hooks"][0])
        self.assertNotIn("async", grok_grouped["PostToolUse"][-1]["hooks"][0])

        kimi_text = kimi_config.read_text(encoding="utf-8")
        self.assertIn("telemetry = false", kimi_text)
        self.assertEqual(kimi_text.count(INTEGRATIONS.KIMI_BLOCK_START), 1)
        self.assertIn('event = "PreToolUse"', kimi_text)

    def test_repeated_configuration_is_idempotent(self):
        INTEGRATIONS.configure(self.home, self.runtime, "/opt/uv")
        INTEGRATIONS.configure(self.home, self.runtime, "/opt/uv")

        cursor = self.json_at(".cursor/hooks.json")
        for handlers in cursor["hooks"].values():
            self.assertEqual(sum("asm-" in item["command"] for item in handlers), 1)

        codex = self.json_at(".codex/hooks.json")
        for groups in codex["hooks"].values():
            managed = [
                handler
                for group in groups
                for handler in group.get("hooks", [])
                if "asm-" in handler.get("command", "")
            ]
            self.assertEqual(len(managed), 1)

        kimi = (self.home / ".kimi-code" / "config.toml").read_text(encoding="utf-8")
        self.assertEqual(kimi.count(INTEGRATIONS.KIMI_BLOCK_START), 1)
        self.assertEqual(kimi.count(INTEGRATIONS.KIMI_BLOCK_END), 1)

    def test_grouped_hook_merge_preserves_user_handler_in_same_managed_group(self):
        document = {
            "hooks": {
                "Stop": [{
                    "matcher": "keep-group-metadata",
                    "custom": {"owner": "user"},
                    "hooks": [
                        {"type": "command", "command": "user-stop-hook"},
                        {
                            "type": "command",
                            "command": 'node "/stale/hooks/asm-memory-gate.js"',
                        },
                    ],
                }],
            },
        }

        INTEGRATIONS.merge_grouped_hooks(document, self.runtime)

        groups = document["hooks"]["Stop"]
        user_group = next(
            group for group in groups
            if any(handler.get("command") == "user-stop-hook" for handler in group.get("hooks", []))
        )
        self.assertEqual(user_group["matcher"], "keep-group-metadata")
        self.assertEqual(user_group["custom"], {"owner": "user"})
        self.assertEqual(user_group["hooks"], [{"type": "command", "command": "user-stop-hook"}])
        managed = [
            handler
            for group in groups
            for handler in group.get("hooks", [])
            if INTEGRATIONS.is_asm_hook(handler.get("command"))
        ]
        self.assertEqual(len(managed), 1)

    def test_windows_hook_commands_are_valid_and_idempotently_recognized(self):
        runtime = PureWindowsPath(r"C:\Users\Agent Name\.asm")
        expected = r'node "C:\Users\Agent Name\.asm\hooks\asm-activity-hook.js"'
        command = INTEGRATIONS.hook_command(runtime, "asm-activity-hook.js")
        self.assertEqual(command, expected)
        self.assertTrue(INTEGRATIONS.is_asm_hook(command))
        self.assertTrue(INTEGRATIONS.is_asm_hook(command.replace("\\", "\\\\")))

        document = {}
        INTEGRATIONS.merge_grouped_hooks(document, runtime)
        INTEGRATIONS.merge_grouped_hooks(document, runtime)
        for groups in document["hooks"].values():
            managed = [
                handler
                for group in groups
                for handler in group.get("hooks", [])
                if INTEGRATIONS.is_asm_hook(handler.get("command"))
            ]
            self.assertEqual(len(managed), 1)

    def test_invalid_json_is_not_overwritten_and_no_other_config_is_written(self):
        invalid = self.home / ".cursor" / "mcp.json"
        invalid.parent.mkdir()
        invalid.write_text("{not-json", encoding="utf-8")

        with self.assertRaises(INTEGRATIONS.ConfigError):
            INTEGRATIONS.configure(self.home, self.runtime, "/opt/uv")

        self.assertEqual(invalid.read_text(encoding="utf-8"), "{not-json")
        self.assertFalse((self.home / ".claude" / "settings.json").exists())

    def test_unterminated_kimi_managed_block_fails_before_json_writes(self):
        config = self.home / ".kimi-code" / "config.toml"
        config.parent.mkdir()
        config.write_text(f"{INTEGRATIONS.KIMI_BLOCK_START}\n", encoding="utf-8")

        with self.assertRaises(INTEGRATIONS.ConfigError):
            INTEGRATIONS.configure(self.home, self.runtime, "/opt/uv")

        self.assertFalse((self.home / ".cursor" / "mcp.json").exists())

    def _write_fake_cli(self, directory: Path, name: str, body: str = 'exit 0\n') -> None:
        path = directory / name
        path.write_text(
            '#!/bin/sh\nprintf "%s:%s\\n" "$(basename "$0")" "$*" >> "$ASM_TEST_LOG"\n' + body,
            encoding="utf-8",
        )
        path.chmod(0o755)

    def _installer_environment(self, fake_bin: Path, log: Path) -> dict[str, str]:
        env = os.environ.copy()
        env.update({
            "ASM_CONFIG_HOME": str(self.home),
            "ASM_HOME": str(self.runtime),
            "ASM_LEGACY_HOME": str(self.root / "no-legacy-runtime"),
            "ASM_SKIP_REFRESH": "1",
            "ASM_TEST_LOG": str(log),
            "PATH": os.pathsep.join((
                str(fake_bin),
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
            )),
        })
        return env

    def test_installer_runs_on_system_bash_and_upserts_before_legacy_cleanup(self):
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        log = self.root / "client.log"
        self._write_fake_cli(fake_bin, "uv")
        self._write_fake_cli(fake_bin, "codex")
        self._write_fake_cli(fake_bin, "grok")

        result = subprocess.run(
            ["/bin/bash", str(PROJECT / "install-agent-integrations.sh")],
            env=self._installer_environment(fake_bin, log),
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = log.read_text(encoding="utf-8").splitlines()
        codex_calls = [call for call in calls if call.startswith("codex:")]
        self.assertIn("mcp add asm --", codex_calls[0])
        self.assertIn("mcp remove c2b", codex_calls[1])
        self.assertFalse(any("mcp remove asm" in call for call in calls))
        self.assertTrue(any(call.startswith("grok:mcp add --scope user asm --") for call in calls))
        self.assertEqual(self.json_at(".claude.json")["mcpServers"]["asm"]["command"], str(fake_bin / "uv"))

    def test_failed_codex_upsert_does_not_remove_existing_registration(self):
        fake_bin = self.root / "failing-bin"
        fake_bin.mkdir()
        log = self.root / "failed-client.log"
        self._write_fake_cli(fake_bin, "uv")
        self._write_fake_cli(
            fake_bin,
            "codex",
            'case "$*" in\n  "mcp add asm"*) exit 19 ;;\nesac\nexit 0\n',
        )

        result = subprocess.run(
            ["/bin/bash", str(PROJECT / "install-agent-integrations.sh")],
            env=self._installer_environment(fake_bin, log),
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 19)
        calls = log.read_text(encoding="utf-8").splitlines()
        self.assertTrue(any("codex:mcp add asm --" in call for call in calls))
        self.assertFalse(any("mcp remove" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
