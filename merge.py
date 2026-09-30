"""Merge vault (OKF) + graphify code graphs into data/brain.json.

Code graphs are collapsed to FILE level (see docs/implementation-notes.md).
Output uses nodes/links keys so react-force-graph-3d consumes it directly.
Stdlib only. Configure sources.json (see sources.example.json), then:
    uv run python merge.py
"""
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from asm_text import field_words
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


LANG_BY_EXT = {
    "py": "Python", "ts": "TypeScript", "tsx": "TypeScript", "js": "JavaScript", "mjs": "JavaScript",
    "cjs": "JavaScript", "jsx": "JavaScript", "rs": "Rust", "go": "Go", "sh": "Shell", "md": "Markdown",
    "json": "JSON", "yaml": "YAML", "yml": "YAML", "sql": "SQL", "html": "HTML", "css": "CSS",
    "swift": "Swift", "kt": "Kotlin", "java": "Java", "toml": "TOML",
}


def describe_directories(nodes: dict[str, dict], links: list[dict]) -> int:
    """Deterministic overview for every dir/project node — size, languages, hub files and
    the vault pages that point into it. No LLM: this is what brain_context on a directory
    returned nothing for, and what lets `brain_search("billing server")` land on the folder
    rather than on one of its 200 files. Returns the number of nodes described."""
    children: dict[str, list[str]] = defaultdict(list)
    degree: Counter[str] = Counter()
    pages: dict[str, list[str]] = defaultdict(list)
    for e in links:
        if e["type"] == "contains":
            children[e["source"]].append(e["target"])
        elif e["type"] == "code":
            degree[e["source"]] += e.get("weight", 1)
            degree[e["target"]] += e.get("weight", 1)
        elif e["type"] == "xlayer" and nodes.get(e["target"], {}).get("kind") == "file":
            pages[e["target"]].append(nodes[e["source"]]["label"])

    def files_under(did: str) -> list[str]:
        out, stack, seen = [], [did], set()
        while stack:
            for child in children.get(stack.pop(), []):
                if child in seen:
                    continue
                seen.add(child)
                kind = nodes[child]["kind"]
                if kind == "file":
                    out.append(child)
                elif kind == "dir":
                    stack.append(child)
        return out

    described = 0
    for nid, n in nodes.items():
        if n["kind"] != "dir":
            continue
        files = files_under(nid)
        if not files:
            continue
        langs: Counter[str] = Counter(
            LANG_BY_EXT.get(nodes[f]["label"].rsplit(".", 1)[-1].lower(), "") for f in files)
        langs.pop("", None)
        parts = [f"{len(files)} files" + (
            f" ({', '.join(lang for lang, _ in langs.most_common(3))})" if langs else "")]
        hubs = [nodes[f]["label"] for f in sorted(files, key=lambda f: (-degree[f], f))[:5] if degree[f]]
        if hubs:
            parts.append("hubs: " + ", ".join(hubs))
        titles = sorted({title for f in files for title in pages.get(f, [])})[:5]
        if titles:
            parts.append("knowledge: " + "; ".join(titles))
        n["meta"] = {**(n.get("meta") or {}), "description": " · ".join(parts), "tags": []}
        described += 1
    return described


FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)
CURATED_MARK = "<!-- asm:state begin"
LIFECYCLE_KEYS = ("status", "done_at", "retired_at", "superseded_by")
# Pages write their status in many words, often followed by a note ("done — shipped 22/09").
# Recall only needs to know finished from retired from anything else.
STATUS_WORDS = {"done": "done", "complete": "done", "completed": "done", "closed": "done",
                "shipped": "done", "deployed": "done", "retired": "retired", "archived": "retired",
                "superseded": "retired", "obsolete": "retired"}


def normalize_status(value: str) -> str:
    word = re.match(r"[\w-]+", value.strip().lower())
    if not word:
        return ""
    return STATUS_WORDS.get(word.group(0), word.group(0))


def page_flags(source: Path) -> dict:
    """The lifecycle facts recall needs from a page itself: its frontmatter `status` (active,
    done, retired) with its dates and replacement, and whether the curator keeps a
    current-state block in it. The OKF catalog does not carry these, so they are read here.
    A page that cannot be read has no flags."""
    try:
        text = source.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    flags: dict = {}
    front = FRONT.match(text)
    if front:
        for key in LIFECYCLE_KEYS:
            found = re.search(rf"^{key}:[ \t]*(.+?)[ \t]*$", front.group(1), re.M)
            if found:
                value = found.group(1).strip().strip("\"'")
                flags[key] = normalize_status(value) if key == "status" else value
    if CURATED_MARK in text:
        flags["curated"] = True
    return flags


def index_row(n: dict) -> dict:
    """One row of brain.index.json, the compact index the prompt hook reads. The lifecycle
    fields (u: updatedAt, y: type, s: status, c: curated) are written only when present."""
    meta = n.get("meta") or {}
    row = {"i": n["id"], "l": n["label"], "k": n["kind"], "p": n["path"],
           "d": meta.get("description", ""), "t": meta.get("tags", [])}
    if meta.get("aliases"):
        row["a"] = meta["aliases"]
    for short, key in (("u", "updatedAt"), ("y", "type"), ("s", "status"), ("c", "curated")):
        if meta.get(key):
            row[short] = meta[key]
    return row


def last2(rel: str) -> str:
    parts = rel.split("/")
    return "/".join(parts[-2:])


IGNORED_VAULT_PARTS = {".git", ".obsidian", ".trash", "node_modules"}


def unindexed_notes(vault: Path, catalog_paths: set[str]) -> list[Path]:
    """Vault notes outside the OKF catalog that the brain still accounts for. An empty note is
    left out: Obsidian creates one for every click on a link it cannot resolve, and it holds
    nothing to find."""
    notes = []
    for note in sorted(vault.rglob("*.md")):
        rel = norm(note.relative_to(vault))
        if any(part in IGNORED_VAULT_PARTS for part in note.relative_to(vault).parts) or rel in catalog_paths:
            continue
        if rel.startswith("okf/index/") or rel == "okf/index.md" or note.stat().st_size == 0:
            continue
        notes.append(note)
    return notes


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
                # A real path, so brain_context("Projects/x/server") resolves the folder
                # and returns its generated overview instead of nothing.
                add_node(did, label=dkey, layer=layer, kind="dir", path=dkey,
                         abs=norm(base / (dkey[len(prefix):] if prefix else dkey)))
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
        # Real (case-preserving) paths of the page nodes, so the body index below never has
        # to rebuild them from the lowercased `abs`.
        page_files: dict[str, Path] = {}

        for c in catalog["concepts"]:
            catalog_paths.add(norm(c["path"]))
            vid = f"vault:{c['id']}"
            add_node(vid, label=c.get("title") or c["id"], layer="vault", kind="page",
                     path=c["path"], abs=norm(VAULT / c["path"]),
                     meta={"description": c.get("description", ""),
                           "tags": c.get("tags", []),
                           # Hebrew/alternate names for recall. Deliberately not tags:
                           # tags also create xlayer edges, aliases only affect search.
                           "aliases": [c["aliases"]] if isinstance(c.get("aliases"), str)
                           else list(c.get("aliases") or []),
                           "pageType": c.get("pageType", ""),
                           "updatedAt": str(c.get("updatedAt") or ""),
                           "type": str(c.get("type") or ""),
                           **page_flags(VAULT / c["path"])})
            page_files[vid] = VAULT / c["path"]
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
        # intentionally outside it (drafts, AGENTS guidance, historical material). Bodies
        # stay out of brain.json; they are written to data/brain.pages.json below.
        for note in unindexed_notes(VAULT, catalog_paths):
            rel = norm(note.relative_to(VAULT))
            nid = f"vault:file:{rel}"
            add_node(nid, label=note.name, layer="vault", kind="page", path=rel,
                     abs=norm(note), meta={"description": "", "tags": [], "pageType": "unindexed",
                                           **page_flags(note)})
            page_files[nid] = note
            links.append({"source": "vault:__root__", "target": nid, "type": "contains"})
    else:
        page_files = {}
        print("no vault configured (or okf/catalog.json missing) — building a code-only brain")

    # drop links pointing at unknown nodes (safety)
    links = [e for e in links if e["source"] in nodes and e["target"] in nodes]
    described = describe_directories(nodes, links)

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
    index = [index_row(n) for n in nodes.values() if n["kind"] in ("page", "file", "dir")]
    (ROOT / "data/brain.index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8")

    # Body index for the vault. Until this file existed brain_search read only the
    # frontmatter — roughly 1.4% of what is actually written in the vault — so a page could
    # document `robocopy` or `readlink -f` in a table and still be unreachable by that word.
    # Word sets, not prose: the server needs the set to match against, and deduplicating
    # inside a page is most of the size saving. Kept out of brain.json because the 3D UI
    # and the prompt hook both parse that file and neither one searches bodies.
    front = re.compile(r"\A---\n.*?\n---\n", re.S)
    pages_index: dict[str, list[str]] = {}
    unreadable = 0
    for nid, source in sorted(page_files.items()):
        try:
            body = source.read_text(encoding="utf-8", errors="replace")
        except OSError:
            unreadable += 1            # a note deleted between the scan and here
            continue
        words = field_words(front.sub("", body))
        if words:
            pages_index[nid] = sorted(words)
    (ROOT / "data/brain.pages.json").write_text(
        json.dumps(pages_index, ensure_ascii=False), encoding="utf-8")
    print(f"brain.pages.json: {len(pages_index)} page bodies indexed"
          + (f", {unreadable} unreadable" if unreadable else ""))
    print(f"directories described: {described}")
    print(f"brain.json: {len(nodes)} nodes {len(links)} links "
          f"(kinds: {out['counts']}, xlayer: {xlayer_count})")


if __name__ == "__main__":
    sys.exit(main())
