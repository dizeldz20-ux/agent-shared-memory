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


def expanded_sources(config_path: Path) -> list[dict]:
    config_path = config_path.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parent
    sources = [dict(source) for source in config.get("sources", [])]
    seen_paths = {
        (root / source["base"]).resolve() if not Path(source["base"]).is_absolute() else Path(source["base"]).resolve()
        for source in sources
    }
    raw_ids = {str(source["raw"]) for source in sources}

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
            sources.append({
                "layer": overrides.get(project.name, default_layer),
                "raw": raw,
                "base": str(project.resolve()),
                "prefix": f"{raw}/",
            })
            raw_ids.add(raw)
            seen_paths.add(project.resolve())
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
        print(json.dumps(sources, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
