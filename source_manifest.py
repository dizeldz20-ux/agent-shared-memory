"""Expand explicit and auto-discovered ASM code sources.

The manifest stays deterministic: directory discovery is sorted, explicit entries win,
and every discovered project receives a stable raw id and graph prefix.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def slug(value: str) -> str:
    clean = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return clean or "project"


def worktree_main(project: Path) -> Path | None:
    """The main checkout of a git worktree — its `.git` is a file pointing into
    <main>/.git/worktrees/<name> — or None for anything else. mcp_server.py carries the same
    function, because the runtime is deployed without this module."""
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


def expanded_sources(config_path: Path) -> list[dict]:
    config_path = config_path.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parent
    sources = [dict(source) for source in config.get("sources", [])]
    # An explicit base is written relative to sources.json — usually the bare "." of the
    # self-source. merge.py resolves it against this file's directory, but the --tsv
    # consumer (refresh.sh) feeds it straight to `graphify extract` from the CALLER's cwd.
    # One `./refresh.sh` launched from the workspace root therefore extracted the whole
    # tree into the asm layer, and merge.py then rebased it onto the ASM repo: 28,658 file
    # nodes whose abs pointed at nothing. Resolve here so both consumers read one path.
    for source in sources:
        source["base"] = str((root / source["base"]).resolve())
    seen_paths = {Path(source["base"]) for source in sources}
    raw_ids = {str(source["raw"]) for source in sources}
    discovered: list[tuple[dict, Path]] = []

    for discovery in config.get("discoverSources", []):
        discovery_root = Path(discovery["root"])
        if not discovery_root.is_absolute():
            discovery_root = (root / discovery_root).resolve()
        if not discovery_root.is_dir():
            continue
        excluded = set(discovery.get("exclude", []))
        overrides = discovery.get("layerOverrides", {})
        default_layer = discovery.get("defaultLayer", "agents")
        for project in sorted((path for path in discovery_root.iterdir() if path.is_dir()), key=lambda path: path.name.lower()):
            if project.name.startswith(".") or project.name in excluded or project.resolve() in seen_paths:
                continue
            raw = slug(project.name)
            if raw in raw_ids:
                raise ValueError(f"duplicate ASM source id {raw!r} from {project}")
            discovered.append(({
                "layer": overrides.get(project.name, default_layer),
                "raw": raw,
                "base": str(project.resolve()),
                "prefix": f"{raw}/",
            }, project))
            raw_ids.add(raw)
            seen_paths.add(project.resolve())

    # A git worktree of a mapped repository is the same code a second time: dated
    # worktrees were more than half of all file nodes. Its main checkout already carries
    # the knowledge, and the MCP resolves a worktree path onto that checkout at lookup
    # time. A worktree whose main checkout is not mapped stays: it is the only copy.
    mapped = seen_paths | {Path(source["base"]).resolve() for source in sources}
    for source, project in discovered:
        main = worktree_main(project)
        if main is not None and main.resolve() in mapped and main.resolve() != project.resolve():
            continue
        sources.append(source)
    return sources


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    parser.add_argument("--tsv", action="store_true")
    args = parser.parse_args()
    sources = expanded_sources(args.config)
    if args.tsv:
        for source in sources:
            print(f"{source['raw']}\t{source['base']}")
    else:
        # ASCII escapes: on Windows Python writes pipes in the ANSI code page, and a raw non-ASCII
        # path would reach the reader mangled (the TSV form is for POSIX shells only).
        print(json.dumps(sources, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
