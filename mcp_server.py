"""C2B brain MCP server (stdio). Tools for querying the unified knowledge+code graph.

Runs from the runtime dir (~/.claude/c2b); brain.json sits alongside.
Works standalone — the visualization server (:8930) is optional and only used
for recent-access events in brain_context.
"""
import json
import urllib.request
from collections import defaultdict, deque
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERE = Path(__file__).resolve().parent
BRAIN = json.loads((HERE / "brain.json").read_text(encoding="utf-8"))

NODES = {n["id"]: n for n in BRAIN["nodes"]}
ADJ: dict[str, list[tuple[str, str]]] = defaultdict(list)  # id -> [(neighbor, edge_type)]
for e in BRAIN["links"]:
    ADJ[e["source"]].append((e["target"], e["type"]))
    ADJ[e["target"]].append((e["source"], e["type"]))

mcp = FastMCP("c2b")


def norm(p: str) -> str:
    return p.replace("\\", "/").lower()


def brief(nid: str) -> dict:
    n = NODES[nid]
    out = {"id": nid, "label": n["label"], "layer": n["layer"], "kind": n["kind"], "path": n["path"]}
    desc = (n.get("meta") or {}).get("description")
    if desc:
        out["description"] = desc
    return out


def recent_access(file_path: str, nid: str | None) -> list[dict]:
    """Recent Claude touches of this file: live server first, persisted log as fallback.

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
    """Search the unified second brain (vault knowledge pages + mapped code files)
    by name, path, tag or description. Returns up to 20 matching nodes."""
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
    scored.sort(key=lambda x: -x[0])
    return [brief(nid) for _, nid in scored[:20]]


@mcp.tool()
def brain_node(node_id: str) -> dict:
    """Get full details of a brain node by id (e.g. 'vault:api-agent-allowlist',
    'api:src/server/routes.py')."""
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
    knowledge pages (gotchas/decisions about it), and recent Claude access events."""
    nid = find_by_path(file_path)
    result: dict = {"file_path": file_path, "node": None, "vault_pages": [],
                    "code_neighbors": [], "recent_access": []}
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
    return result


if __name__ == "__main__":
    mcp.run()
