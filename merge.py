"""Merge vault (OKF) + graphify code graphs into data/brain.json.

Code graphs are collapsed to FILE level (see docs/implementation-notes.md).
Output uses nodes/links keys so react-force-graph-3d consumes it directly.
Stdlib only. Configure sources.json (see sources.example.json), then:
    uv run python merge.py
"""
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from source_manifest import expanded_sources

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))

VAULT = (ROOT / CONFIG["vault"]).resolve() if CONFIG.get("vault") else None
LAYER_LABELS: dict[str, str] = CONFIG["layers"]
XLAYER_TAGS = {layer: set(tags) for layer, tags in CONFIG.get("xlayerTags", {}).items()}
# source: {"layer": ..., "raw": <dir under data/raw>, "base": <project path>, "prefix": ""}
CODE_SOURCES = [
    (s["layer"], s["raw"], (ROOT / s["base"]).resolve(), s.get("prefix", ""))
    for s in expanded_sources(ROOT / "sources.json")
]


def norm(p) -> str:
    return str(p).replace("\\", "/").lower()


def last2(rel: str) -> str:
    parts = rel.split("/")
    return "/".join(parts[-2:])


def main() -> None:
    nodes: dict[str, dict] = {}
    links: list[dict] = []
    suffix_index: dict[str, str] = {}  # last-2-segments -> file node id

    def add_node(nid: str, **fields) -> None:
        if nid not in nodes:
            nodes[nid] = {"id": nid, **fields}

    # ---- code layers ----
    for layer in LAYER_LABELS:
        add_node(f"{layer}:__root__", label=LAYER_LABELS[layer], layer=layer,
                 kind="root", path="", abs="")

    extracted_sources = 0
    skipped_sources: list[str] = []
    for layer, raw, base, prefix in CODE_SOURCES:
        project_id = f"{layer}:project:{raw}"
        project_path = prefix.rstrip("/") or raw
        add_node(project_id, label=base.name, layer=layer, kind="dir",
                 path=project_path, abs=norm(base))
        links.append({"source": f"{layer}:__root__", "target": project_id, "type": "contains"})
        raw_path = ROOT / "data/raw" / raw / "graphify-out/graph.json"
        if not raw_path.exists():
            skipped_sources.append(raw)
            print(f"source {raw}: no graphify output — project root retained without AST nodes")
            continue
        try:
            g = json.loads(raw_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            skipped_sources.append(raw)
            print(f"source {raw}: invalid graphify output ({exc}) — project root retained")
            continue
        extracted_sources += 1
        sym2file: dict[str, str] = {}
        for n in g["nodes"]:
            sf = n.get("source_file") or ""
            if sf:
                sym2file[n["id"]] = norm(prefix + sf)

        # one node per distinct file
        dir_depth = 1 if prefix == "" else 2  # prefixed rel paths start with the prefix segment
        for rel in sorted(set(sym2file.values())):
            fid = f"{layer}:{rel}"
            src_rel = rel[len(prefix):] if prefix else rel
            add_node(fid, label=rel.split("/")[-1], layer=layer, kind="file",
                     path=rel, abs=norm(base / src_rel))
            suffix_index.setdefault(last2(rel), fid)
            # directory grouping
            parts = rel.split("/")
            if len(parts) > dir_depth:
                dkey = "/".join(parts[:dir_depth])
                did = f"{layer}:dir:{dkey}"
                add_node(did, label=dkey, layer=layer, kind="dir", path=dkey, abs="")
                links.append({"source": did, "target": fid, "type": "contains"})
                links.append({"source": project_id, "target": did, "type": "contains"})
            else:
                links.append({"source": project_id, "target": fid, "type": "contains"})

        # aggregate symbol links to file->file edges
        agg: Counter[tuple[str, str]] = Counter()
        for e in g["links"]:
            s, t = sym2file.get(e["source"]), sym2file.get(e["target"])
            if s and t and s != t:
                agg[(f"{layer}:{s}", f"{layer}:{t}")] += 1
        for (s, t), w in agg.items():
            links.append({"source": s, "target": t, "type": "code", "weight": w})

    # dedupe root->dir contains edges
    seen = set()
    deduped = []
    for e in links:
        key = (e["source"], e["target"], e["type"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(e)
    links = deduped

    # ---- vault layer (optional: skipped when no vault is configured) ----
    xlayer_count = 0
    if VAULT and (VAULT / "okf/catalog.json").exists():
        add_node("vault:__root__", label="Obsidian Vault", layer="vault", kind="root", path="", abs=norm(VAULT))
        catalog = json.loads((VAULT / "okf/catalog.json").read_text(encoding="utf-8"))
        okf_graph = json.loads((VAULT / "okf/graph.json").read_text(encoding="utf-8"))

        catalog_paths: set[str] = set()

        for c in catalog["concepts"]:
            catalog_paths.add(norm(c["path"]))
            vid = f"vault:{c['id']}"
            add_node(vid, label=c.get("title") or c["id"], layer="vault", kind="page",
                     path=c["path"], abs=norm(VAULT / c["path"]),
                     meta={"description": c.get("description", ""),
                           "tags": c.get("tags", []),
                           "pageType": c.get("pageType", "")})
            links.append({"source": "vault:__root__", "target": vid, "type": "contains"})
            tags = {t.lower() for t in c.get("tags", [])}
            for layer, layer_tags in XLAYER_TAGS.items():
                if tags & layer_tags:
                    links.append({"source": vid, "target": f"{layer}:__root__", "type": "xlayer"})
                    xlayer_count += 1
            # path-like resource/related -> direct file edge
            for cand in [c.get("resource", ""), *c.get("related", [])]:
                cand = norm(cand).lstrip("/")
                if "/" in cand and "." in cand.split("/")[-1]:
                    fid = suffix_index.get(last2(cand))
                    if fid:
                        links.append({"source": vid, "target": fid, "type": "xlayer"})
                        xlayer_count += 1

        vault_ids = {f"vault:{c['id']}" for c in catalog["concepts"]}
        for e in okf_graph["edges"]:
            s, t = f"vault:{e['from']}", f"vault:{e['to']}"
            if s in vault_ids and t in vault_ids:
                links.append({"source": s, "target": t, "type": "link"})

        # OKF is the semantic index, but the brain must still account for notes that are
        # intentionally outside it (drafts, AGENTS guidance, historical material). Only
        # path metadata is indexed here; note bodies never enter brain.json.
        ignored_parts = {".git", ".obsidian", ".trash", "node_modules"}
        for note in sorted(VAULT.rglob("*.md")):
            rel = norm(note.relative_to(VAULT))
            if any(part in ignored_parts for part in note.relative_to(VAULT).parts):
                continue
            if rel in catalog_paths or rel.startswith("okf/index/") or rel == "okf/index.md":
                continue
            nid = f"vault:file:{rel}"
            add_node(nid, label=note.name, layer="vault", kind="page", path=rel,
                     abs=norm(note), meta={"description": "", "tags": [], "pageType": "unindexed"})
            links.append({"source": "vault:__root__", "target": nid, "type": "contains"})
    else:
        print("no vault configured (or okf/catalog.json missing) — building a code-only brain")

    # drop links pointing at unknown nodes (safety)
    links = [e for e in links if e["source"] in nodes and e["target"] in nodes]

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "counts": dict(Counter(n["kind"] for n in nodes.values())),
        "sourceCoverage": {
            "configured": len(CODE_SOURCES),
            "extracted": extracted_sources,
            "skipped": skipped_sources,
        },
        "nodes": list(nodes.values()),
        "links": links,
    }
    out_path = ROOT / "data/brain.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

    # Compact index for the UserPromptSubmit hook: it runs synchronously in front of every
    # prompt, so it must not parse the full graph (links are ~80% of the bytes).
    index = [
        {"i": n["id"], "l": n["label"], "k": n["kind"], "p": n["path"],
         "d": (n.get("meta") or {}).get("description", ""),
         "t": (n.get("meta") or {}).get("tags", [])}
        for n in nodes.values() if n["kind"] in ("page", "file")
    ]
    (ROOT / "data/brain.index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"brain.json: {len(nodes)} nodes {len(links)} links "
          f"(kinds: {out['counts']}, xlayer: {xlayer_count})")


if __name__ == "__main__":
    sys.exit(main())
