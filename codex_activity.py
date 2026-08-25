"""Best-effort Codex activity fallback for already-running, pre-hook sessions.

Codex hooks remain the canonical stream. This watcher tails only newly appended tool-call
metadata from local rollout JSONL files and immediately discards raw arguments after deriving
tool names and file paths. Conversation text and tool output are never read into ASM events.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path


NESTED_TOOL_RE = re.compile(r"tools\.([A-Za-z0-9_]+)\s*\(")
ABS_PATH_RE = re.compile(r"/(?:Users|home|private|tmp|var|opt)/[^\"'`\s\\,;)}\]]+")
FILE_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_:/])(?:\.{0,2}/)?(?:[A-Za-z0-9_@.-]+/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9_-]{1,12}"
)
PATCH_PATH_RE = re.compile(r"\*\*\* (?:Add|Update|Delete) File:\s*([^\\\n\r\"'`]+)")


def _clean_path(value: str) -> str:
    return value.strip().strip("\"'`[]{}(),;:").replace("\\/", "/")


def code_mode_paths(source: str, cwd: str) -> list[str]:
    """Extract existing file paths from code-mode JS without evaluating the source."""
    text = source.replace("\\n", "\n").replace("\\t", " ")
    bases = [Path(cwd).expanduser()] if cwd else []
    absolute_candidates = [_clean_path(match.group(0)) for match in ABS_PATH_RE.finditer(text)]
    for candidate in absolute_candidates:
        path = Path(candidate).expanduser()
        if path.is_dir() and path not in bases:
            bases.append(path)

    found: list[str] = []

    def add(candidate: str, *, explicit: bool = False) -> None:
        clean = _clean_path(candidate)
        if not clean or "://" in clean or clean.startswith("-"):
            return
        path = Path(clean).expanduser()
        candidates = [path] if path.is_absolute() else [base / path for base in bases]
        for resolved in candidates:
            try:
                resolved = resolved.resolve()
            except OSError:
                continue
            if resolved.is_file() or (explicit and "." in resolved.name):
                value = str(resolved)
                if value not in found:
                    found.append(value)
                return

    for candidate in absolute_candidates:
        add(candidate)
    for match in PATCH_PATH_RE.finditer(text):
        add(match.group(1), explicit=True)
    for match in FILE_TOKEN_RE.finditer(text):
        add(match.group(0))
    return found[:160]


def _timestamp(value: object) -> float:
    if not value:
        return time.time()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def _tool_label(names: list[str]) -> str:
    if any(name == "apply_patch" for name in names):
        return "apply_patch"
    if any(name in {"exec_command", "write_stdin"} for name in names):
        return "Bash"
    if any(name == "view_image" for name in names):
        return "Read"
    if any(name == "web__run" for name in names):
        return "WebSearch"
    if any(name == "update_plan" for name in names):
        return "Plan"
    return names[-1] if names else "Codex"


def activity_from_rollout(obj: dict, meta: dict) -> dict | None:
    payload = obj.get("payload")
    if not isinstance(payload, dict) or obj.get("type") != "response_item":
        return None
    if payload.get("type") not in {"custom_tool_call", "function_call"}:
        return None
    source = payload.get("input", payload.get("arguments", ""))
    if not isinstance(source, str):
        source = json.dumps(source, ensure_ascii=False)
    outer_name = str(payload.get("name") or "")
    names = NESTED_TOOL_RE.findall(source) if outer_name == "exec" else [outer_name]
    names = [name for name in names if name and not name.startswith(("mcp__asm__", "mcp__c2b__"))]
    if not names:
        return None
    cwd = str(meta.get("cwd") or "")
    return {
        "ts": _timestamp(obj.get("timestamp")),
        "tool": _tool_label(names),
        "cwd": cwd,
        "session": str(meta.get("id") or payload.get("call_id") or "codex"),
        "agent": "Codex",
        "paths": code_mode_paths(source, cwd),
        "file_access": True,
        "source": "codex-rollout-fallback",
        "phase": "start",
        "operation_id": str(payload.get("call_id") or payload.get("id") or ""),
    }


class CodexRolloutWatcher:
    """Tail newly appended tool-call rows from active Codex rollout files."""

    def __init__(self, codex_home: Path):
        self.sessions_root = codex_home.expanduser() / "sessions"
        self.offsets: dict[Path, int] = {}
        self.meta: dict[Path, dict] = {}
        self.seen_calls: set[str] = set()
        self.last_scan = 0.0
        self.cached_files: list[Path] = []

    def _scan(self, force: bool = False) -> list[Path]:
        now = time.monotonic()
        # A newly opened Codex session should join the live trace in under a
        # second. The cached active files are still polled without an rglob.
        if not force and now - self.last_scan < 0.75:
            return self.cached_files
        self.last_scan = now
        if not self.sessions_root.exists():
            self.cached_files = []
            return []
        self.cached_files = sorted(
            self.sessions_root.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True
        )[:12]
        return self.cached_files

    @staticmethod
    def _read_meta(path: Path) -> dict:
        try:
            with path.open(encoding="utf-8", errors="replace") as handle:
                for _ in range(12):
                    line = handle.readline()
                    if not line:
                        break
                    obj = json.loads(line)
                    if obj.get("type") == "session_meta" and isinstance(obj.get("payload"), dict):
                        payload = obj["payload"]
                        return {"id": payload.get("id"), "cwd": payload.get("cwd")}
        except (OSError, ValueError):
            pass
        return {}

    def prime(self) -> None:
        for path in self._scan(force=True):
            try:
                self.offsets[path] = path.stat().st_size
            except OSError:
                continue
            self.meta[path] = self._read_meta(path)

    def poll(self) -> list[dict]:
        activities: list[dict] = []
        for path in self._scan():
            if path not in self.offsets:
                self.offsets[path] = 0
                self.meta[path] = self._read_meta(path)
            try:
                size = path.stat().st_size
                if size < self.offsets[path]:
                    self.offsets[path] = 0
                with path.open("rb") as handle:
                    handle.seek(self.offsets[path])
                    while True:
                        start = handle.tell()
                        raw = handle.readline()
                        if not raw:
                            break
                        if not raw.endswith(b"\n"):
                            handle.seek(start)
                            break
                        try:
                            obj = json.loads(raw)
                        except (UnicodeDecodeError, ValueError):
                            continue
                        if obj.get("type") == "session_meta" and isinstance(obj.get("payload"), dict):
                            payload = obj["payload"]
                            self.meta[path] = {"id": payload.get("id"), "cwd": payload.get("cwd")}
                            continue
                        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
                        call_id = str(payload.get("call_id") or payload.get("id") or "")
                        if call_id and call_id in self.seen_calls:
                            continue
                        activity = activity_from_rollout(obj, self.meta.get(path, {}))
                        if activity:
                            activities.append(activity)
                            if call_id:
                                self.seen_calls.add(call_id)
                    self.offsets[path] = handle.tell()
            except OSError:
                continue
        if len(self.seen_calls) > 4000:
            self.seen_calls.clear()
        return activities
