"""The Codex fallback must publish live work and nothing else.

Its events are indistinguishable from a hook's once they reach the graph: they are
persisted to events.jsonl and returned by brain_context as "recent cross-agent
access". A replayed session therefore does not merely look wrong on screen, it
teaches every agent that a four-day-old read happened a moment ago.
"""
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codex_activity", PROJECT / "codex_activity.py")
assert SPEC and SPEC.loader
CODEX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CODEX)


def rollout(path: Path, session_id: str, cwd: str, calls: list[tuple[str, float]]) -> None:
    """Write a rollout file: session_meta, then one exec tool call per entry."""
    lines = [json.dumps({
        "timestamp": "2026-09-10T14:29:13.111Z", "type": "session_meta",
        "payload": {"id": session_id, "cwd": cwd},
    })]
    for index, (name, ts) in enumerate(calls):
        lines.append(json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + "Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": f"{session_id}-{index}",
                "input": f"tools.{name}({{}})",
            },
        }))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class CodexRolloutWatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.sessions = self.home / "sessions" / "2026" / "09" / "11"
        self.sessions.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def watcher(self) -> CODEX.CodexRolloutWatcher:
        return CODEX.CodexRolloutWatcher(self.home)

    def test_old_session_entering_the_window_replays_nothing(self):
        """The bug this file exists for: `codex resume`, or any touch that lifts an
        old rollout to the top by mtime, used to republish the whole session."""
        old = self.sessions / "rollout-old.jsonl"
        rollout(old, "old", "/repo", [("apply_patch", time.time() - 4 * 86400)] * 1)
        watcher = self.watcher()
        watcher.prime()                       # primed while `old` was NOT in the window
        watcher.offsets.pop(old)              # ... which is what a 13th file looks like
        watcher.meta.pop(old, None)
        self.assertEqual(watcher.poll(), [])
        self.assertEqual(watcher.offsets[old], old.stat().st_size)

    def test_new_appends_after_registration_are_published(self):
        live = self.sessions / "rollout-live.jsonl"
        rollout(live, "live", "/repo", [])
        watcher = self.watcher()
        watcher.prime()
        with live.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                "type": "response_item",
                "payload": {"type": "custom_tool_call", "name": "exec",
                            "call_id": "live-1", "input": "tools.apply_patch({})"},
            }) + "\n")
        published = watcher.poll()
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["tool"], "apply_patch")
        self.assertEqual(published[0]["agent"], "Codex")
        self.assertEqual(published[0]["source"], "codex-rollout-fallback")

    def test_history_is_dropped_even_when_the_offset_is_reset(self):
        """A truncated or rotated file sends poll back to byte 0 by design, so the
        age gate — not the offset — is what makes the guarantee unconditional."""
        stale = self.sessions / "rollout-stale.jsonl"
        old_ts = time.time() - CODEX.MAX_ROLLOUT_AGE_SECONDS - 60
        rollout(stale, "stale", "/repo", [("apply_patch", old_ts), ("exec_command", old_ts)])
        watcher = self.watcher()
        watcher.offsets[stale] = 0            # the truncation branch, reproduced exactly
        watcher.meta[stale] = {"id": "stale", "cwd": "/repo"}
        self.assertEqual(watcher.poll(), [])

    def test_a_fresh_row_read_from_byte_zero_still_publishes(self):
        """The age gate must not swallow a real session that was read from the start."""
        fresh = self.sessions / "rollout-fresh.jsonl"
        rollout(fresh, "fresh", "/repo", [("apply_patch", time.time())])
        watcher = self.watcher()
        watcher.offsets[fresh] = 0
        watcher.meta[fresh] = {"id": "fresh", "cwd": "/repo"}
        self.assertEqual(len(watcher.poll()), 1)


if __name__ == "__main__":
    unittest.main()
