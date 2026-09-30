#!/usr/bin/env python3
"""Merge ASM into supported agent configuration files without replacing user settings.

The public installer calls this module after deploying the runtime.  It deliberately
uses only the Python standard library: configuration must still work before the ASM
virtual environment has been created.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path, PurePath
from typing import Any


ASM_HOOK_FILES = {
    "asm-session-start.js",
    "asm-prompt-recall.js",
    "asm-activity-hook.js",
    "asm-memory-gate.js",
    "asm-skill-router.js",
}
# The skill router speaks Claude Code's Skill tool and skill roots; other clients get
# only the shared memory hooks. The PreToolUse matcher keeps it off Read/Grep/MCP calls.
SKILL_ROUTER_EVENTS = {
    "SessionStart": ("asm-skill-router.js", 10, None),
    "UserPromptSubmit": ("asm-skill-router.js", 10, None),
    "PreToolUse": ("asm-skill-router.js", 5, "Skill|Write|Edit|MultiEdit|NotebookEdit|Bash"),
}
KIMI_BLOCK_START = "# >>> ASM managed hooks >>>"
KIMI_BLOCK_END = "# <<< ASM managed hooks <<<"


class ConfigError(RuntimeError):
    """Raised before any write when an existing JSON configuration is invalid."""


def _target(path: Path) -> Path:
    """Write through dotfile-manager symlinks instead of replacing the symlink itself."""

    return path.resolve(strict=False) if path.is_symlink() else path


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"Refusing to overwrite invalid JSON configuration: {path}") from exc
    if not isinstance(value, dict):
        raise ConfigError(f"Refusing to overwrite non-object JSON configuration: {path}")
    return value


def atomic_write(path: Path, content: str) -> None:
    path = _target(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def mcp_entry(uv_bin: str, runtime: Path, **extra: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "command": uv_bin,
        "args": ["run", "--directory", str(runtime), "python", "mcp_server.py"],
    }
    entry.update(extra)
    return entry


def merge_mcp(document: dict[str, Any], entry: dict[str, Any]) -> None:
    servers = document.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise ConfigError("mcpServers must be a JSON object")
    servers["asm"] = entry


def hook_command(runtime: PurePath, filename: str) -> str:
    # Backslashes are path separators in a Windows command, not JSON escapes here.
    # json.dumps() performs the JSON escaping later; doubling them at this layer
    # produces a command containing two literal backslashes and breaks the hook.
    escaped = str(runtime / "hooks" / filename).replace('"', '\\"')
    return f'node "{escaped}"'


def is_asm_hook(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = value.replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    return any(f"/hooks/{filename}" in normalized for filename in ASM_HOOK_FILES)


def _without_managed_grouped_handlers(groups: list[Any]) -> list[Any]:
    """Remove only ASM handlers, retaining user handlers and group metadata."""

    cleaned: list[Any] = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            cleaned.append(group)
            continue
        handlers = group["hooks"]
        retained = [
            handler
            for handler in handlers
            if not (isinstance(handler, dict) and is_asm_hook(handler.get("command")))
        ]
        if len(retained) == len(handlers):
            cleaned.append(group)
            continue
        if retained:
            preserved = group.copy()
            preserved["hooks"] = retained
            cleaned.append(preserved)
    return cleaned


def merge_grouped_hooks(
    document: dict[str, Any],
    runtime: PurePath,
    events: tuple[str, ...] | None = None,
    include_async: bool = True,
    include_skill_router: bool = False,
) -> None:
    commands = {
        "SessionStart": ("asm-session-start.js", 10, False),
        "UserPromptSubmit": ("asm-prompt-recall.js", 10, False),
        # PreToolUse must finish before Stop can observe the mutation marker.
        "PreToolUse": ("asm-activity-hook.js", 5, False),
        "PostToolUse": ("asm-activity-hook.js", 5, True),
        "Stop": ("asm-memory-gate.js", 10, False),
    }
    selected = events or tuple(commands)
    hooks = document.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ConfigError("hooks must be a JSON object")
    for event in selected:
        filename, timeout, asynchronous = commands[event]
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ConfigError(f"hooks.{event} must be a JSON array")
        groups[:] = _without_managed_grouped_handlers(groups)
        handler: dict[str, Any] = {
            "type": "command",
            "command": hook_command(runtime, filename),
            "timeout": timeout,
        }
        if asynchronous and include_async:
            handler["async"] = True
        groups.append({"hooks": [handler]})
    if not include_skill_router:
        return
    for event, (filename, timeout, matcher) in SKILL_ROUTER_EVENTS.items():
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ConfigError(f"hooks.{event} must be a JSON object")
        # The main loop above already stripped every managed handler for events it
        # selected; events it did not select are cleaned here so a re-run stays idempotent.
        if event not in selected:
            groups[:] = _without_managed_grouped_handlers(groups)
        group: dict[str, Any] = {"hooks": [{
            "type": "command",
            "command": hook_command(runtime, filename),
            "timeout": timeout,
        }]}
        if matcher:
            group = {"matcher": matcher, **group}
        groups.append(group)


def merge_cursor_hooks(document: dict[str, Any], runtime: Path) -> None:
    document["version"] = 1
    hooks = document.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ConfigError("Cursor hooks must be a JSON object")
    commands = {
        "sessionStart": "asm-session-start.js",
        "preToolUse": "asm-activity-hook.js",
        "postToolUse": "asm-activity-hook.js",
        "stop": "asm-memory-gate.js",
    }
    for event, filename in commands.items():
        handlers = hooks.setdefault(event, [])
        if not isinstance(handlers, list):
            raise ConfigError(f"Cursor hooks.{event} must be a JSON array")
        handlers[:] = [
            handler
            for handler in handlers
            if not (isinstance(handler, dict) and is_asm_hook(handler.get("command")))
        ]
        handler: dict[str, Any] = {"command": hook_command(runtime, filename)}
        if event == "stop":
            handler["loop_limit"] = 1
        handlers.append(handler)


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def kimi_hooks_block(runtime: Path) -> str:
    rules = [
        ("SessionStart", "", "asm-session-start.js", 10),
        ("UserPromptSubmit", "", "asm-prompt-recall.js", 10),
        ("PreToolUse", "", "asm-activity-hook.js", 5),
        ("PostToolUse", "", "asm-activity-hook.js", 5),
        ("Stop", "", "asm-memory-gate.js", 10),
    ]
    lines = [KIMI_BLOCK_START]
    for event, matcher, filename, timeout in rules:
        lines.extend(["[[hooks]]", f"event = {_toml_string(event)}"])
        if matcher:
            lines.append(f"matcher = {_toml_string(matcher)}")
        lines.extend(
            [
                f"command = {_toml_string(hook_command(runtime, filename))}",
                f"timeout = {timeout}",
                "",
            ]
        )
    lines.append(KIMI_BLOCK_END)
    return "\n".join(lines)


def merge_kimi_toml(text: str, runtime: Path) -> str:
    if KIMI_BLOCK_START in text:
        before, remainder = text.split(KIMI_BLOCK_START, 1)
        if KIMI_BLOCK_END not in remainder:
            raise ConfigError("Kimi config contains an unterminated ASM managed block")
        _, after = remainder.split(KIMI_BLOCK_END, 1)
        text = before.rstrip() + "\n" + after.lstrip("\n")
    prefix = text.rstrip()
    return f"{prefix}\n\n{kimi_hooks_block(runtime)}\n" if prefix else f"{kimi_hooks_block(runtime)}\n"


def configure(home: Path, runtime: Path, uv_bin: str, include_legacy_kimi: bool = False) -> list[str]:
    paths = {
        "claude": home / ".claude" / "settings.json",
        "claude_mcp": home / ".claude.json",
        "codex": home / ".codex" / "hooks.json",
        "gemini": home / ".gemini" / "settings.json",
        "cursor_mcp": home / ".cursor" / "mcp.json",
        "cursor_hooks": home / ".cursor" / "hooks.json",
        "grok_hooks": home / ".grok" / "hooks" / "asm.json",
        "kimi_code_mcp": home / ".kimi-code" / "mcp.json",
        "generic": runtime / "client-configs" / "mcp.json",
    }
    if include_legacy_kimi:
        paths["kimi_legacy_mcp"] = home / ".kimi" / "mcp.json"

    # Validate every existing JSON file before the first write.
    documents = {name: load_json(path) for name, path in paths.items()}
    standard_entry = mcp_entry(uv_bin, runtime)

    claude = documents["claude"]
    permission_root = claude.setdefault("permissions", {})
    if not isinstance(permission_root, dict):
        raise ConfigError("Claude permissions must be a JSON object")
    permissions = permission_root.setdefault("allow", [])
    if not isinstance(permissions, list):
        raise ConfigError("Claude permissions.allow must be a JSON array")
    if "mcp__asm__*" not in permissions:
        permissions.append("mcp__asm__*")
    merge_grouped_hooks(claude, runtime, include_skill_router=True)

    # Claude's user-scoped MCP registry is JSON, so merge it atomically instead
    # of deleting a working registration before invoking `claude mcp add`.
    merge_mcp(documents["claude_mcp"], standard_entry.copy())

    codex = documents["codex"]
    codex["description"] = "ASM lifecycle hooks for shared cross-agent memory."
    merge_grouped_hooks(codex, runtime)

    merge_mcp(documents["gemini"], mcp_entry(uv_bin, runtime, timeout=30000, trust=True))
    merge_mcp(documents["cursor_mcp"], mcp_entry(uv_bin, runtime, type="stdio"))
    merge_cursor_hooks(documents["cursor_hooks"], runtime)
    # Grok Build has a native, always-trusted global hook directory. Session and
    # prompt hook stdout is passive in Grok, so native integration installs only
    # the lifecycle events that have useful semantics there.
    merge_grouped_hooks(
        documents["grok_hooks"],
        runtime,
        events=("PreToolUse", "PostToolUse", "Stop"),
        include_async=False,
    )
    merge_mcp(documents["kimi_code_mcp"], standard_entry.copy())
    merge_mcp(documents["generic"], standard_entry.copy())
    if "kimi_legacy_mcp" in documents:
        merge_mcp(documents["kimi_legacy_mcp"], standard_entry.copy())

    kimi_config = home / ".kimi-code" / "config.toml"
    kimi_text = kimi_config.read_text(encoding="utf-8") if kimi_config.exists() else ""
    kimi_merged = merge_kimi_toml(kimi_text, runtime)

    for name, path in paths.items():
        write_json(path, documents[name])
    atomic_write(kimi_config, kimi_merged)
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge ASM into local coding-agent configs")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--uv", required=True, dest="uv_bin")
    parser.add_argument("--include-legacy-kimi", action="store_true")
    args = parser.parse_args()
    configured = configure(
        args.home.expanduser().resolve(),
        args.runtime.expanduser().resolve(),
        args.uv_bin,
        include_legacy_kimi=args.include_legacy_kimi,
    )
    print("Configured ASM JSON/TOML integrations: " + ", ".join(configured))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
