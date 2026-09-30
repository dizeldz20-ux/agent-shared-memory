"""Contract tests for hook/asm-skill-router.js — the SKILL.state layer for skill loading.

Every test runs the real hook under an isolated ASM_HOME with fixture skill roots, the way
Claude Code would invoke it, and asserts on the injected text and the on-disk state.
"""

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
HOOK = PROJECT / "hook" / "asm-skill-router.js"


def skill_md(description: str, body: str = "# Skill\n\nBody.\n", block: bool = False) -> str:
    if block:
        indented = textwrap.indent(description.strip(), "  ")
        return f"---\nname: x\ndescription: >\n{indented}\n---\n\n{body}"
    return f"---\nname: x\ndescription: {description}\n---\n\n{body}"


class SkillRouterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.runtime = root / "asm"
        self.home = root / "home"
        self.skills = root / "roots" / "skills"
        self.commands = root / "roots" / "commands"
        self.plugins = self.home / ".claude" / "plugins" / "cache"
        for d in (self.runtime, self.skills, self.commands, self.plugins, self.home / ".claude"):
            d.mkdir(parents=True, exist_ok=True)
        self.env = {
            **os.environ,
            "ASM_HOME": str(self.runtime),
            "ASM_CONFIG_HOME": str(self.home),
            "ASM_SKILL_ROOTS": os.pathsep.join([str(self.skills), str(self.commands), str(self.plugins)]),
        }
        self.write_fixture_skills()

    def tearDown(self):
        self.temp.cleanup()

    # ------------------------------------------------------------------ fixtures

    def add_skill(self, name: str, description: str, body: str = "# Skill\n\nBody.\n", block: bool = False):
        d = self.skills / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(skill_md(description, body, block), encoding="utf-8")

    def write_fixture_skills(self):
        self.add_skill(
            "cardcom-payment-gateway",
            'Integrate Cardcom payment processing. Use when user mentions "Cardcom" or "Low Profile". '
            "Do NOT use for Tranzila integration (use tranzila-payment-gateway).",
        )
        self.add_skill("tranzila-payment-gateway", 'Integrate Tranzila payments. Use when user mentions "Tranzila".')
        self.add_skill(
            "research-web",
            'MUST USE when user wants to research anything on the internet — e.g. "search the web for X", '
            '"look this up". Also when the user shares a link to a platform. Finds deep results across platforms.\n\n'
            "NOT for: writing reports.",
            block=True,
        )
        self.add_skill("heavy-design", 'Anti-slop frontend for "landing page" work.', body="# Heavy\n\n" + ("lorem ipsum " * 1200))
        self.add_skill("hebrew-skill", 'Hebrew helper. Triggers on: סקיל, ניתוב')
        for i in range(5):
            self.add_skill(f"family-{i}", f'Family member {i}. Use when the user says "shared family phrase".')
        (self.commands / "smith").mkdir()
        (self.commands / "smith" / "smith.md").write_text(skill_md('Meta-skill for building skills. Use for "build a skill".'), encoding="utf-8")
        (self.commands / "smith" / "tasks").mkdir()
        (self.commands / "smith" / "tasks" / "audit.md").write_text("<purpose>Audit a skill.</purpose>\n", encoding="utf-8")
        (self.commands / "gsd-do.md").write_text(skill_md('Route free text to GSD. Use for "gsd".'), encoding="utf-8")
        overrides = {
            "version": 1,
            "suppress": ["gsd-*"],
            "skills": {
                "research-web": {"patterns": ["https?://(?:www\\.)?reddit\\.com/"]},
                "config-skill": {"builtin": True, "paths": ["**/.claude/settings*.json"], "triggers": ["settings.json"], "reason": "harness config"},
                "review-skill": {"builtin": True, "commands": ["\\bgit\\s+commit\\b"], "triggers": ["code review"], "reason": "review before commit"},
                "family-4": {"defer_to": ["family-0"]},
                "project-only": {"scope": "project", "triggers": ["project phrase"]},
                "product-ds": {"builtin": True, "cwd": ["**/Projects/Product*"], "requires_cwd": True, "triggers": ["restyle", "כפתור"], "reason": "product design system"},
            },
        }
        (self.runtime / "skill-map.overrides.json").write_text(json.dumps(overrides, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------------ helpers

    def run_cli(self, *args: str, env=None):
        return subprocess.run(["node", str(HOOK), *args], text=True, capture_output=True, env=env or self.env, timeout=10, check=True)

    def run_hook(self, payload, env=None):
        raw = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        return subprocess.run(["node", str(HOOK)], input=raw, text=True, capture_output=True, env=env or self.env, timeout=10, check=True)

    def build(self):
        self.run_cli("--build")
        return json.loads((self.runtime / "skill-map.json").read_text(encoding="utf-8"))

    def prompt(self, text: str, session: str = "s1", cwd: str = "/nowhere"):
        return self.run_hook({"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": cwd, "prompt": text}).stdout

    def tool(self, tool_name: str, tool_input: dict, session: str = "s1"):
        out = self.run_hook({"hook_event_name": "PreToolUse", "session_id": session, "tool_name": tool_name, "tool_input": tool_input}).stdout
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

    def state(self, session: str = "s1"):
        return json.loads((self.runtime / "sessions" / f"{session}.skills.json").read_text(encoding="utf-8"))

    def usage(self):
        text = (self.runtime / "skill-usage.jsonl").read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    # ------------------------------------------------------------------ build

    def test_build_reads_a_skill_saved_with_windows_line_endings(self):
        # A SKILL.md written on Windows (or checked out with autocrlf) ends every line in CRLF; the
        # frontmatter must still parse, or the router goes silent for that skill.
        d = self.skills / "crlf-skill"
        d.mkdir(parents=True)
        text = skill_md('Use when the user says "reconcile the ledger" or asks for a ledger reconciliation.')
        (d / "SKILL.md").write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
        block = self.skills / "crlf-block"
        block.mkdir(parents=True)
        text = skill_md('Use when the user says "rotate the keys" for the vault.', block=True)
        (block / "SKILL.md").write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
        by = {e["id"]: e for e in self.build()["skills"]}
        self.assertIn("reconcile the ledger", by["crlf-skill"]["strong"])
        self.assertIn("rotate the keys", by["crlf-block"]["strong"])

    def test_build_parses_frontmatter_and_derives_evidence(self):
        m = self.build()
        by = {e["id"]: e for e in m["skills"]}
        cardcom = by["cardcom-payment-gateway"]
        self.assertIn("cardcom", cardcom["strong"])
        self.assertIn("low profile", cardcom["strong"])
        # The negative sentence is shown as the boundary and removed from the evidence.
        self.assertIn("Tranzila", cardcom["not_for"])
        self.assertNotIn("tranzila", cardcom["weak"])
        self.assertNotIn("tranzila", cardcom["strong"])
        # Block-scalar (`>`) descriptions are parsed; quoted phrases become strong triggers.
        research = by["research-web"]
        self.assertIn("search the web for", research["strong"])
        self.assertIn("look this up", research["strong"])
        self.assertTrue(research["reason"])
        # Short generic words never become weak evidence.
        for word in ("deep", "link", "finds"):
            self.assertNotIn(word, research["weak"])
        self.assertIn("internet", research["weak"])
        self.assertTrue(by["heavy-design"]["heavy"])
        # Command sub-files are internal; the entry command is hintable; suppress globs apply.
        self.assertTrue(by["smith:smith"]["hint"])
        self.assertFalse(by["smith:tasks:audit"]["hint"])
        self.assertFalse(by["gsd-do"]["hint"])
        # Built-ins exist only as override entries; project-scoped rules are not orphans.
        self.assertTrue(by["config-skill"]["builtin"])
        self.assertEqual(m["orphans"], [])
        self.assertEqual(m["counts"]["skills"], len(m["skills"]))

    def test_marketplace_registry_pointing_at_another_machine_hides_plugin_skills(self):
        for market, plugin in (("gone-market", "gone-plugin"), ("here-market", "here-plugin")):
            d = self.plugins / market / plugin / "1.0.0" / "skills" / "thing"
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(skill_md(f'Plugin skill from {market}. Use for "{market} phrase".'), encoding="utf-8")
        (self.home / ".claude" / "plugins" / "known_marketplaces.json").write_text(json.dumps({
            "gone-market": {"installLocation": "C:\\Users\\User\\.claude\\plugins\\marketplaces\\gone-market"},
            "here-market": {"installLocation": str(self.home)},
        }), encoding="utf-8")
        (self.home / ".claude" / "settings.json").write_text(json.dumps({"enabledPlugins": {"here-plugin@here-market": True, "gone-plugin@gone-market": True}}), encoding="utf-8")
        ids = {e["id"] for e in self.build()["skills"]}
        self.assertIn("here-plugin:thing", ids)
        self.assertNotIn("gone-plugin:thing", ids)

    # ------------------------------------------------------------------ prompt routing

    def test_two_hit_rule_strong_phrase_pattern_and_hebrew_inflection(self):
        self.build()
        self.assertEqual(self.prompt("find the link in the file and fix the import"), "")
        self.assertIn("research-web", self.prompt("internet research across platforms", session="a"))
        self.assertIn("research-web", self.prompt("https://www.reddit.com/r/x/comments/1 what is this", session="b"))
        self.assertIn("research-web", self.prompt("please look this up", session="c"))
        # "הסקילים" must hit the trigger "סקיל" (prefix ה, suffix ים) — \b is ASCII-only in JS.
        self.assertIn("hebrew-skill", self.prompt("תסדר את הסקילים", session="d"))
        self.assertNotIn("hebrew-skill", self.prompt("hello", session="e"))

    def test_cwd_is_a_precondition_and_matches_from_any_subdirectory(self):
        self.build()
        self.assertEqual(self.prompt("תעצב מחדש את הכפתור", cwd="/Users/x/Desktop/other/repo"), "")
        inside = self.prompt("תעצב מחדש את הכפתור", session="p", cwd="/Users/x/Desktop/Projects/ProductA/server/src")
        self.assertIn("product-ds", inside)
        self.assertIn("product-ds", self.prompt("restyle the header", session="q", cwd="/Users/x/Desktop/Projects/ProductB"))

    def test_negative_sentence_never_routes_to_the_neighbor(self):
        self.build()
        out = self.prompt("tranzila refund flow")
        self.assertIn("tranzila-payment-gateway", out)
        self.assertNotIn("cardcom", out)
        out = self.prompt("cardcom low profile", session="s2")
        self.assertIn("cardcom-payment-gateway", out)
        self.assertIn("NOT: Do NOT use for Tranzila", out)

    def test_defer_to_and_cut_at_three(self):
        self.build()
        out = self.prompt("shared family phrase please")
        shown = [line for line in out.splitlines() if line.startswith("- ")]
        self.assertEqual(len(shown), 3)
        self.assertNotIn("family-4", out)  # defers to family-0, which also matched
        self.assertIn("heavy ~", self.prompt("landing page", session="h"))

    def test_slash_commands_and_garbage_are_silent_and_never_fail(self):
        self.build()
        self.assertEqual(self.prompt("/smith audit"), "")
        result = self.run_hook("not json at all")
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertEqual(self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": ""}).stdout, "")

    def test_project_skills_route_at_prompt_time_and_dedupe_against_the_map(self):
        self.build()
        cwd = Path(self.temp.name) / "repo"
        for name, desc in (("project-only", "Repo-local skill."), ("research-web", 'Shadow copy. Use for "shadow phrase".')):
            d = cwd / ".claude" / "skills" / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(skill_md(desc), encoding="utf-8")
        out = self.prompt("the project phrase applies", cwd=str(cwd))
        self.assertIn("project-only", out)           # override triggers apply to project skills
        self.assertEqual(self.prompt("shadow phrase", session="z", cwd=str(cwd)), "")  # mapped id wins, no duplicate entry

    # ------------------------------------------------------------------ Σ_skills

    def test_hint_cooldown_loaded_line_and_usage_rows(self):
        self.build()
        first = self.prompt("we need a code review now")
        self.assertIn("- review-skill", first)
        for _ in range(4):
            self.assertEqual(self.prompt("we need a code review now"), "")   # cooled
        self.assertIn("- review-skill", self.prompt("we need a code review now"))  # cooldown elapsed
        self.assertEqual(self.tool("Skill", {"skill": "review-skill", "args": ""}), "")  # loads are silent
        self.assertIn("review-skill", self.state()["loaded"])
        out = self.prompt("another code review round")
        self.assertIn("Already loaded this session", out)
        self.assertIn("review-skill (turn", out)
        self.assertNotIn("- review-skill", out)
        rows = self.usage()
        kinds = [(r["kind"], r["skill"]) for r in rows]
        self.assertIn(("hint", "review-skill"), kinds)
        load = next(r for r in rows if r["kind"] == "load")
        self.assertTrue(load["hinted"])
        self.assertFalse(load["reload"])
        # The docs name the field skill_name; this harness sends skill. Both are accepted.
        self.tool("Skill", {"skill_name": "cardcom-payment-gateway"})
        self.assertIn("cardcom-payment-gateway", self.state()["loaded"])

    def test_action_hints_by_path_and_command_with_cooldown(self):
        self.build()
        ctx = self.tool("Write", {"file_path": str(self.home / ".claude" / "settings.json"), "content": "{}"})
        self.assertIn("config-skill (writes settings.json)", ctx)
        self.assertEqual(self.tool("Edit", {"file_path": str(self.home / ".claude" / "settings.local.json")}), "")  # cooled
        self.assertIn("review-skill (command matches", self.tool("Bash", {"command": "git add -A && git commit -m x"}))
        # A fresh session gets the commit hint once; after the skill is loaded it stays silent
        # even when the 40-tool-turn cooldown has long expired.
        self.assertIn("review-skill (command matches", self.tool("Bash", {"command": "git commit -m x"}, session="s9"))
        self.tool("Skill", {"skill": "review-skill"}, session="s9")          # Skill loads do not count as tool turns
        for _ in range(45):
            self.tool("Read", {"file_path": "/x"}, session="s9")
        self.assertEqual(self.tool("Bash", {"command": "git commit -m again"}, session="s9"), "")
        self.assertEqual(self.state("s9")["tool_turn"], 47)
        action_rows = [r for r in self.usage() if r["kind"] == "action-hint"]
        self.assertEqual({r["skill"] for r in action_rows}, {"config-skill", "review-skill"})

    def test_compact_resets_loaded_and_clear_deletes_state(self):
        self.build()
        self.tool("Skill", {"skill": "review-skill"})
        self.prompt("cardcom low profile")
        self.assertTrue(self.state()["loaded"] and self.state()["hinted"])
        self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "compact"})
        s = self.state()
        self.assertEqual((s["loaded"], s["hinted"], s["compactions"]), ({}, {}, 1))
        # Hints return after the compaction — the SKILL.md is no longer in context.
        self.assertIn("- review-skill", self.prompt("we need a code review now"))
        self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "clear"})
        self.assertFalse((self.runtime / "sessions" / "s1.skills.json").exists())

    def test_session_start_rebuilds_a_stale_or_missing_map_and_reports_once(self):
        out = self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "startup"}).stdout
        self.assertIn("map rebuilt", out)
        self.assertTrue((self.runtime / "skill-map.json").exists())
        self.assertEqual(self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "resume"}).stdout, "")
        # Editing the overrides makes the map stale again.
        p = self.runtime / "skill-map.overrides.json"
        os.utime(p, (p.stat().st_atime + 5, p.stat().st_mtime + 5))
        self.assertIn("map rebuilt", self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "resume"}).stdout)
        # Cursor gets the structured shape.
        (self.runtime / "skill-map.json").unlink()
        cursor = json.loads(self.run_hook({"hook_event_name": "SessionStart", "session_id": "s1", "source": "startup", "client_type": "cursor"}).stdout)
        self.assertIn("map rebuilt", cursor["additional_context"])

    def test_corrupt_state_costs_one_turn_of_dedup_never_the_hint(self):
        self.build()
        (self.runtime / "sessions").mkdir()
        (self.runtime / "sessions" / "s1.skills.json").write_text("{not json", encoding="utf-8")
        self.assertIn("- review-skill", self.prompt("we need a code review now"))
        self.assertEqual(self.state()["turn"], 1)

    def test_prompt_without_session_id_hints_but_writes_no_state(self):
        self.build()
        out = self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": "we need a code review now"}).stdout
        self.assertIn("- review-skill", out)
        self.assertFalse((self.runtime / "sessions").exists())

    # ------------------------------------------------------------------ CLI

    def test_route_is_a_dry_run_and_report_measures_precision(self):
        self.build()
        dry = json.loads(self.run_cli("--route", "we need a code review now", "--session", "s1").stdout)
        self.assertEqual(dry["shown"], ["review-skill"])
        self.assertFalse((self.runtime / "sessions").exists())
        self.prompt("we need a code review now")
        self.prompt("cardcom low profile", session="s2")
        self.tool("Skill", {"skill": "review-skill"})
        rep = json.loads(self.run_cli("--report", "1").stdout)
        self.assertEqual(rep["totals"], {"hints": 2, "loads": 1, "loads_after_hint": 1, "reloads": 0, "reload_tokens": 0})
        self.assertEqual(rep["precision"], 0.5)
        status = json.loads(self.run_cli("--status", "s1").stdout)
        self.assertIn("review-skill", status["state"]["loaded"])
        self.assertFalse(status["map"]["stale"])


class SkillRouterConfiguratorTests(unittest.TestCase):
    """The installer registers the router for Claude only, idempotently, with the PreToolUse matcher."""

    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cai_router_test", PROJECT / "tools" / "configure_agent_integrations.py")
        self.cai = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(self.cai)

    def router_groups(self, document, event):
        return [g for g in document.get("hooks", {}).get(event, []) if any("asm-skill-router.js" in h["command"] for h in g["hooks"])]

    def test_claude_gets_router_on_three_events_codex_gets_none_and_rerun_is_idempotent(self):
        runtime = Path("/rt")
        claude = {"hooks": {"PreToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "user-guard"}]}]}}
        codex = {}
        self.cai.merge_grouped_hooks(claude, runtime, include_skill_router=True)
        self.cai.merge_grouped_hooks(codex, runtime)
        for event in ("SessionStart", "UserPromptSubmit", "PreToolUse"):
            self.assertEqual(len(self.router_groups(claude, event)), 1, event)
            self.assertEqual(self.router_groups(codex, event), [])
        pre = self.router_groups(claude, "PreToolUse")[0]
        self.assertEqual(pre["matcher"], "Skill|Write|Edit|MultiEdit|NotebookEdit|Bash")
        self.assertNotIn("matcher", self.router_groups(claude, "UserPromptSubmit")[0])
        # The user's own PreToolUse guard survives, and the memory hooks are still there.
        self.assertIn({"matcher": "Write", "hooks": [{"type": "command", "command": "user-guard"}]}, claude["hooks"]["PreToolUse"])
        self.assertTrue(any("asm-activity-hook.js" in h["command"] for g in claude["hooks"]["PreToolUse"] for h in g["hooks"]))
        before = json.dumps(claude, sort_keys=True)
        self.cai.merge_grouped_hooks(claude, runtime, include_skill_router=True)
        self.assertEqual(json.dumps(claude, sort_keys=True), before)
        self.assertTrue(self.cai.is_asm_hook('node "/rt/hooks/asm-skill-router.js"'))


if __name__ == "__main__":
    unittest.main()
