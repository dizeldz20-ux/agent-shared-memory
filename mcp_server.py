"""ASM offline MCP server for shared agent memory and the knowledge/code graph.

The deployed copy runs from ``~/.asm``. Claude, Codex, and any other MCP client point
at that same directory, so reads and writes share one local source of truth. The
visualization server on :8930 is optional.
"""
import hashlib
import json
import os
import re
import urllib.request
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERE = Path(__file__).resolve().parent
BRAIN = json.loads((HERE / "brain.json").read_text(encoding="utf-8"))
MEMORY_PATH = HERE / "memory.jsonl"
PATHS_PATH = HERE / "asm-paths.json"

NODES = {n["id"]: n for n in BRAIN["nodes"]}
ADJ: dict[str, list[tuple[str, str]]] = defaultdict(list)  # id -> [(neighbor, edge_type)]
for e in BRAIN["links"]:
    ADJ[e["source"]].append((e["target"], e["type"]))
    ADJ[e["target"]].append((e["source"], e["type"]))

mcp = FastMCP(
    "asm",
    instructions=(
        "ASM is the shared memory for every coding agent on this machine. Search ASM before "
        "planning or editing mapped code; call brain_context before touching a mapped file. "
        "After a session changes files, call memory_record with the session id, a concrete "
        "summary, affected files, decisions, and open threads. Never store secrets."
    ),
)


def norm(p: str) -> str:
    return p.replace("\\", "/").lower()


def brief(nid: str) -> dict:
    n = NODES[nid]
    out = {"id": nid, "label": n["label"], "layer": n["layer"], "kind": n["kind"], "path": n["path"]}
    desc = (n.get("meta") or {}).get("description")
    if desc:
        out["description"] = desc
    return out


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def memory_records(limit: int = 5000) -> list[dict]:
    """Load the append-only live memory without making one malformed line fatal."""
    try:
        lines = MEMORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except OSError:
        return []
    records = []
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if isinstance(record, dict) and record.get("id"):
                records.append(record)
        except ValueError:
            continue
    return records


def memory_brief(record: dict) -> dict:
    return {
        "id": f"memory:{record['id']}",
        "label": record.get("summary", "Shared memory"),
        "layer": "memory",
        "kind": "memory",
        "path": (record.get("files") or [""])[0],
        "agent": record.get("agent", "agent"),
        "created_at": record.get("created_at", ""),
    }


def _append_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, value.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def _daily_section(record: dict) -> tuple[Path | None, str]:
    paths = _read_json(PATHS_PATH)
    vault = str(paths.get("vault") or "").strip()
    if not vault:
        return None, "vault is not configured; live memory was still recorded"

    now = datetime.now().astimezone()
    day = now.strftime("%Y-%m-%d")
    daily = Path(vault) / "wiki" / "main" / "daily" / f"{day}.md"
    if not daily.exists():
        header = (
            "---\n"
            f"id: daily-{day}\n"
            f'title: "{day}"\n'
            "pageType: report\n"
            "type: daily-note\n"
            f"updatedAt: {now.isoformat(timespec='minutes')}\n"
            "privacy: private\n"
            f'description: "Shared agent work recorded by ASM on {day}."\n'
            "tags: [daily, session, asm, agent-memory]\n"
            "related: []\n"
            "---\n\n"
            f"# {day}\n"
        )
        _append_text(daily, header)

    def bullets(values: list[str], empty: str = "None recorded") -> str:
        return "\n".join(f"- {value}" for value in values) if values else f"- {empty}"

    files = [str(value) for value in record.get("files") or []]
    decisions = [str(value) for value in record.get("decisions") or []]
    open_threads = [str(value) for value in record.get("open_threads") or []]
    section = (
        f"\n## ASM · {now.strftime('%H:%M')} · {record['agent']}\n\n"
        f"Session id: `{record['session_id']}`  \n"
        f"Memory id: `{record['id']}`\n\n"
        f"**What changed:** {record['summary']}\n\n"
        f"{record['details']}\n\n"
        "### Files touched\n\n"
        f"{bullets([f'`{value}`' for value in files])}\n\n"
        "### Decisions\n\n"
        f"{bullets(decisions)}\n\n"
        "### Open threads\n\n"
        f"{bullets(open_threads)}\n"
    )
    _append_text(daily, section)
    return daily, "appended to the Obsidian daily log"


def recent_access(file_path: str, nid: str | None) -> list[dict]:
    """Recent agent touches of this file: live server first, persisted log as fallback.

    The log is the reason the brain still knows what happened while nothing was running.
    """
    events: list[dict] = []
    try:
        with urllib.request.urlopen("http://127.0.0.1:8930/api/events/recent", timeout=1) as r:
            events = json.loads(r.read())
    except (OSError, ValueError):
        try:
            lines = (HERE / "events.jsonl").read_text(
                encoding="utf-8", errors="replace").splitlines()[-2000:]
            events = [json.loads(x) for x in lines if x.strip()]
        except (OSError, ValueError):
            return []
    if nid:
        # Once the node is known, match on it only. Matching on the bare filename would
        # report another project's api.py / settings.json as access to this one.
        hits = [e for e in events if e.get("node_id") == nid]
    else:
        name = norm(file_path).split("/")[-1]
        hits = [e for e in events if e.get("path", "").endswith("/" + name)]
    return hits[-10:]


def find_by_path(file_path: str) -> str | None:
    """Resolve a path to a node id, or None when it is too ambiguous to answer.

    A single-segment path like "api.py" matches dozens of nodes across projects; returning
    the first one would inject a different project's knowledge as authoritative context.
    """
    p = norm(file_path)
    for n in BRAIN["nodes"]:
        if n.get("abs") and n["abs"] == p:
            return n["id"]
    if p.count("/") < 1:
        return None  # too ambiguous — caller gets an empty context, not a wrong one
    matches = [n["id"] for n in BRAIN["nodes"]
               if n.get("abs") and (n["abs"].endswith("/" + p) or p.endswith(n["abs"]))]
    if len(matches) == 1:
        return matches[0]
    if matches:
        return None  # ambiguous: several projects have this suffix
    suffix = "/".join(p.split("/")[-2:])
    tail = [n["id"] for n in BRAIN["nodes"] if n.get("abs", "").endswith("/" + suffix)]
    return tail[0] if len(tail) == 1 else None


@mcp.tool()
def brain_search(query: str) -> list[dict]:
    """Search ASM across vault pages, mapped code, and immediate shared-memory records."""
    tokens = [t for t in query.lower().split() if t]
    scored = []
    for n in BRAIN["nodes"]:
        meta = n.get("meta") or {}
        hay = " ".join([n["label"].lower(), n.get("path", ""),
                        meta.get("description", "").lower(),
                        " ".join(meta.get("tags", []))]).lower()
        score = sum(1 for t in tokens if t in hay)
        if score:
            scored.append((score, n["id"]))
    results = [(score, brief(nid)) for score, nid in scored]
    for record in memory_records():
        hay = " ".join([
            str(record.get("summary", "")), str(record.get("details", "")),
            " ".join(map(str, record.get("files") or [])),
            " ".join(map(str, record.get("decisions") or [])),
            " ".join(map(str, record.get("open_threads") or [])),
        ]).lower()
        score = sum(1 for token in tokens if token in hay)
        if score:
            results.append((score + 1, memory_brief(record)))
    results.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [item for _, item in results[:20]]


@mcp.tool()
def brain_node(node_id: str) -> dict:
    """Get full details of a brain node by id (e.g. 'vault:api-agent-allowlist',
    'api:src/server/routes.py')."""
    if node_id.startswith("memory:"):
        wanted = node_id.removeprefix("memory:")
        record = next((item for item in reversed(memory_records()) if item.get("id") == wanted), None)
        return record or {"error": f"unknown memory id: {node_id}"}
    n = NODES.get(node_id)
    if not n:
        return {"error": f"unknown node id: {node_id}"}
    return {**n, "degree": len(ADJ[node_id])}


@mcp.tool()
def brain_neighbors(node_id: str, depth: int = 1) -> list[dict]:
    """Neighbors of a node up to `depth` hops (BFS, max 50 results).
    Includes cross-layer links between vault knowledge and code."""
    if node_id not in NODES:
        return [{"error": f"unknown node id: {node_id}"}]
    seen = {node_id}
    frontier = [node_id]
    out = []
    for _ in range(max(1, min(depth, 3))):
        nxt = []
        for nid in frontier:
            for nb, et in ADJ[nid]:
                if nb not in seen:
                    seen.add(nb)
                    out.append({**brief(nb), "via": et})
                    nxt.append(nb)
                    if len(out) >= 50:
                        return out
        frontier = nxt
    return out


@mcp.tool()
def brain_path(from_id: str, to_id: str) -> list[dict]:
    """Shortest path between two brain nodes (BFS over all edge types)."""
    if from_id not in NODES or to_id not in NODES:
        return [{"error": "unknown node id"}]
    prev: dict[str, str] = {from_id: ""}
    q = deque([from_id])
    while q:
        cur = q.popleft()
        if cur == to_id:
            break
        for nb, _ in ADJ[cur]:
            if nb not in prev:
                prev[nb] = cur
                q.append(nb)
    if to_id not in prev:
        return [{"error": "no path"}]
    path = []
    cur = to_id
    while cur:
        path.append(brief(cur))
        cur = prev[cur]
    return list(reversed(path))


@mcp.tool()
def brain_context(file_path: str) -> dict:
    """THE tool to call before touching a file: given an absolute or relative file path,
    returns what the brain knows — the matching node, its code neighbors, linked vault
    knowledge pages (gotchas/decisions about it), and recent cross-agent access events."""
    nid = find_by_path(file_path)
    result: dict = {"file_path": file_path, "node": None, "vault_pages": [],
                    "code_neighbors": [], "recent_access": [], "shared_memory": []}
    if nid:
        result["node"] = brief(nid)
        for nb, et in ADJ[nid][:80]:
            b = {**brief(nb), "via": et}
            if NODES[nb]["layer"] == "vault":
                result["vault_pages"].append(b)
            elif NODES[nb]["kind"] == "file":
                result["code_neighbors"].append(b)
        result["code_neighbors"] = result["code_neighbors"][:15]
    else:
        result["note"] = ("no unambiguous node for this path — pass more path segments "
                          "(e.g. src/pkg/file.py) or use brain_search")
    result["recent_access"] = recent_access(file_path, nid)
    target = norm(file_path)
    result["shared_memory"] = [
        record for record in reversed(memory_records())
        if any(target == norm(str(item)) or target.endswith("/" + norm(str(item)))
               or norm(str(item)).endswith("/" + target)
               for item in record.get("files") or [])
    ][:10]
    return result


@mcp.tool()
def memory_recent(limit: int = 10, query: str = "") -> list[dict]:
    """Read the newest shared records written by any agent, optionally filtered by text."""
    records = list(reversed(memory_records()))
    if query.strip():
        tokens = query.lower().split()
        records = [record for record in records if all(
            token in json.dumps(record, ensure_ascii=False).lower() for token in tokens)]
    return records[:max(1, min(limit, 50))]


@mcp.tool()
def memory_record(
    session_id: str,
    summary: str,
    details: str,
    files: list[str] | None = None,
    decisions: list[str] | None = None,
    open_threads: list[str] | None = None,
    agent: str = "agent",
) -> dict:
    """Persist a completed unit of work into immediate ASM memory and the Obsidian daily log.

    Call after changing files. Record concrete outcomes and unresolved work; never include
    secrets, credentials, raw private transcripts, or claims that were not verified.
    """
    session = re.sub(r"[^\w.-]", "", session_id.strip())[:160]
    summary = " ".join(summary.strip().split())[:500]
    details = details.strip()[:12000]
    agent = re.sub(r"[^\w .:/-]", "", agent.strip())[:80] or "agent"
    if not session:
        return {"ok": False, "error": "session_id is required"}
    if len(summary) < 8:
        return {"ok": False, "error": "summary must name what actually changed"}
    if len(details) < 20:
        return {"ok": False, "error": "details must include enough context for the next agent"}

    normalized_files = [str(value).strip()[:1000] for value in (files or []) if str(value).strip()][:80]
    normalized_decisions = [str(value).strip()[:2000] for value in (decisions or []) if str(value).strip()][:30]
    normalized_threads = [str(value).strip()[:2000] for value in (open_threads or []) if str(value).strip()][:30]
    digest = hashlib.sha256(
        json.dumps([session, summary, details, normalized_files], ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    existing = next((record for record in memory_records() if record.get("id") == digest), None)
    if existing:
        return {"ok": True, "duplicate": True, "record": existing}

    record = {
        "id": digest,
        "session_id": session,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "agent": agent,
        "summary": summary,
        "details": details,
        "files": normalized_files,
        "decisions": normalized_decisions,
        "open_threads": normalized_threads,
    }
    _append_text(MEMORY_PATH, json.dumps(record, ensure_ascii=False) + "\n")
    daily_path, vault_status = _daily_section(record)
    return {
        "ok": True,
        "record": record,
        "daily_path": str(daily_path) if daily_path else None,
        "vault_status": vault_status,
    }


if __name__ == "__main__":
    mcp.run()
