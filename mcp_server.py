"""ASM offline MCP server for shared agent memory and the knowledge/code graph.

The deployed copy runs from ``~/.asm``. Claude, Codex, and any other MCP client point
at that same directory, so reads and writes share one local source of truth. The
visualization server on :8930 is optional.
"""
import hashlib
import json
import math
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
USAGE_PATH = HERE / "usage.jsonl"
PATHS_PATH = HERE / "asm-paths.json"

NODES = {n["id"]: n for n in BRAIN["nodes"]}
ADJ: dict[str, list[tuple[str, str]]] = defaultdict(list)  # id -> [(neighbor, edge_type)]
for e in BRAIN["links"]:
    ADJ[e["source"]].append((e["target"], e["type"]))
    ADJ[e["target"]].append((e["source"], e["type"]))


def _last2(p: str) -> str:
    return "/".join(p.split("/")[-2:])


# Path lookups: exact absolute path, and a last-two-segments bucket that every suffix rule
# in find_by_path narrows further. Built once so attaching 100+ memory records at startup
# does not scan 19k nodes per file.
ABS_INDEX: dict[str, str] = {}
SUFFIX2: dict[str, list[str]] = defaultdict(list)
for _n in BRAIN["nodes"]:
    if _n.get("abs"):
        ABS_INDEX.setdefault(_n["abs"], _n["id"])
        SUFFIX2[_last2(_n["abs"])].append(_n["id"])

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


# Query tokenizer, kept identical to tokenize() in hook/asm-prompt-recall.js so the prompt
# hook and brain_search agree on what a query means. tests/fixtures/tokenize.json is run
# against both implementations.
STOP = {
    "את", "של", "על", "אני", "אתה", "לא", "כן", "זה", "זאת", "יש", "אין", "מה", "איך", "כמו",
    "גם", "אבל", "כדי", "כל", "הוא", "היא", "הם", "עם", "אם", "רק", "עוד", "שם", "פה", "צריך", "מול",
    "רוצה", "אפשר", "בבקשה", "תעשה", "תבדוק", "עכשיו", "קובץ", "קוד", "עבור", "בתוך", "לפי",
    "the", "and", "for", "with", "that", "this", "from", "have", "has", "you", "are", "was",
    "can", "not", "but", "all", "any", "now", "please", "need", "want", "make", "file", "code",
    "add", "fix", "run", "use", "let", "get", "set", "new", "why", "how", "what", "where",
}
_SPLIT = re.compile(r"[^\w.\-/]+")
_TRIM = re.compile(r"^[.\-/]+|[.\-/]+$")
_PLURAL = re.compile(r"(ים|ות|יה|ית)$")


def stem(t: str) -> str:
    """Hebrew is agglutinative: strip one leading particle and a plural ending."""
    s = t
    if len(s) >= 5 and s[0] in "הבלומשכ":
        s = s[1:]
    if len(s) >= 6:
        s = _PLURAL.sub("", s)
    return s


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in _SPLIT.split(str(text or "").lower()):
        t = _TRIM.sub("", raw)
        if len(t) < 3 or t in STOP:
            continue
        t = _TRIM.sub("", stem(t))  # "ב-aws" -> "-aws" -> "aws"
        if len(t) < 3 or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:25]


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


def memory_records(limit: int = 5000, include_superseded: bool = False) -> list[dict]:
    """Load the append-only live memory without making one malformed line fatal.

    A record named in a later record's `supersedes` is marked `superseded_by` and, by
    default, dropped — this is the one chokepoint, so search, context, recent and the
    prompt hook all honor a supersession without knowing about it.
    """
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
    superseded = {old: record["id"] for record in records for old in record.get("supersedes") or []}
    out = []
    for record in records:
        by = superseded.get(record["id"])
        if by:
            record = {**record, "superseded_by": by}
            if not include_superseded:
                continue
        out.append(record)
    return out


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


# Secret scrubber, ported from agent-control-plane's memory_store.scrub_text. Only
# credentials and card numbers: ASM records are operational facts written by agents, and
# phone numbers or internal IPs in them are documented knowledge (PBX lines, fleet hosts),
# not end-user PII. The instruction text tells the model not to write secrets; this is
# the mechanical backstop, and only the finding KINDS are reported back.
_SCRUB_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,30}PRIVATE KEY-----"), "[redacted: private key]"),
    ("jwt", re.compile(r"\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}\b"), "[redacted: token]"),
    ("api-key", re.compile(r"\b(?:sk-ant-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[\w-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35})"), "[redacted: api-key]"),
    # A value must look like a secret — 12+ chars with a digit — before it is redacted:
    # `token: string`, `password: required field` and `secret = os.environ[...]` are code
    # discussion, not credentials, and handoffs are full of them.
    ("bearer", re.compile(r"(?i)\b(bearer|basic)\s+(?=[A-Za-z0-9\-._~+/=]*\d)[A-Za-z0-9\-._~+/=]{16,}"), r"\1 [redacted]"),
    ("credential-pair", re.compile(r"(?i)\b(password|passwd|סיסמה|api[_-]?key|token|client[_-]?secret|secret)\b(\s*[:=]\s*)(?=[^\s'\"]*\d)[^\s'\"]{12,}"), r"\1\2[redacted]"),
]
_LUHN_CANDIDATE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _luhn_ok(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def scrub_text(text: str) -> tuple[str, list[str]]:
    """Redact credentials and card numbers; returns (clean text, finding kinds)."""
    kinds: list[str] = []

    def note(kind: str) -> None:
        if kind not in kinds:
            kinds.append(kind)

    for kind, pattern, replacement in _SCRUB_PATTERNS:
        text, count = pattern.subn(replacement, text)
        if count:
            note(kind)

    def _card(match: re.Match[str]) -> str:
        digits = re.sub(r"[ -]", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            note("credit-card")
            return f"[redacted: card ****{digits[-4:]}]"
        return match.group(0)

    return _LUHN_CANDIDATE.sub(_card, text), kinds


def _append_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, value.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def _note_usage(nid: str) -> None:
    """Append one node-open event. This is the only signal of what recalled context was
    actually used; nothing scores on it yet — a hotness blend needs weeks of rows first."""
    try:
        stamp = datetime.now().astimezone().isoformat(timespec="seconds")
        _append_text(USAGE_PATH, json.dumps({"node_id": nid, "ts": stamp}) + "\n")
    except OSError:
        pass  # a full disk must not fail the read


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
    exact = ABS_INDEX.get(p)
    if exact:
        return exact
    if p.count("/") < 1:
        return None  # too ambiguous — caller gets an empty context, not a wrong one
    bucket = SUFFIX2.get(_last2(p), [])
    matches = [nid for nid in bucket
               if NODES[nid]["abs"].endswith("/" + p) or p.endswith(NODES[nid]["abs"])]
    if len(matches) == 1:
        return matches[0]
    if matches:
        return None  # ambiguous: several projects have this suffix
    return bucket[0] if len(bucket) == 1 else None


# Knowledge edges are rare and are the point; code/contains edges are the bulk. Every
# capped traversal walks them in this order so the cap eats `contains`, never a vault page
# or a memory record. Observed live: a hub file with 50+ code edges returned zero `touches`.
EDGE_PRIORITY = {"xlayer": 0, "touches": 1, "link": 2, "code": 3, "contains": 4}


def neighbors_of(nid: str) -> list[tuple[str, str]]:
    return sorted(ADJ[nid], key=lambda item: (EDGE_PRIORITY.get(item[1], 9), item[0]))


def _detach_memory(record_id: str) -> None:
    """A superseded record leaves the graph the same way it leaves search."""
    mid = f"memory:{record_id}"
    if mid not in NODES:
        return
    for nb, _ in ADJ.pop(mid, []):
        ADJ[nb] = [item for item in ADJ[nb] if item[0] != mid]
    NODES.pop(mid, None)


def _attach_memory(record: dict) -> None:
    """Give a shared-memory record a graph node and `touches` edges to the files it names.

    Done at MCP start and on every memory_record, never in merge.py: the runtime copy is
    always current while brain.json is a snapshot, and find_by_path is the fail-closed
    resolver — a bare `README.md` or an ambiguous suffix attaches to nothing.
    """
    mid = f"memory:{record['id']}"
    if mid in NODES or record.get("superseded_by"):
        return
    NODES[mid] = {**memory_brief(record), "abs": "",
                  "meta": {"description": record.get("summary", ""),
                           "open_threads": record.get("open_threads") or []}}
    for value in record.get("files") or []:
        fid = find_by_path(str(value))
        if fid and (fid, "touches") not in ADJ[mid]:
            ADJ[mid].append((fid, "touches"))
            ADJ[fid].append((mid, "touches"))


def _field_hits(tokens: list[str], fields: list[tuple[str, int]]) -> list[tuple[str, int]]:
    hits = []
    for t in tokens:
        s = sum(w for text, w in fields if t in text)
        if s:
            hits.append((t, s))
    return hits


for _record in memory_records(include_superseded=True):
    _attach_memory(_record)


@mcp.tool()
def brain_search(query: str) -> list[dict]:
    """Search ASM across vault pages, mapped code, and immediate shared-memory records."""
    tokens = tokenize(query)
    if not tokens:
        return []
    # Same field weights as the prompt hook; IDF over the matched candidates does the
    # ranking so `index.ts` (hundreds of files) cannot outrank a token that lands on five.
    candidates: list[tuple[list[tuple[str, int]], bool, dict]] = []
    for n in BRAIN["nodes"]:
        meta = n.get("meta") or {}
        hits = _field_hits(tokens, [
            (" ".join(meta.get("tags", [])).lower(), 3),
            (n["label"].lower(), 2),
            (" ".join(meta.get("aliases", [])).lower(), 2),
            (meta.get("description", "").lower(), 1),
            (n.get("path", "").lower(), 1),
        ])
        if hits:
            candidates.append((hits, n["kind"] == "page", brief(n["id"])))
    records = memory_records()
    for record in records:
        # Explicit search does read `details` (the prompt hook does not — see the hook).
        hits = _field_hits(tokens, [
            (str(record.get("summary", "")).lower(), 2),
            (" ".join(map(str, (record.get("decisions") or []) + (record.get("open_threads") or [])
                          + (record.get("files") or []))).lower(), 1),
            (str(record.get("details", "")).lower(), 1),
        ])
        if hits:
            candidates.append((hits, True, memory_brief(record)))
    total = len(BRAIN["nodes"]) + len(records)
    df: dict[str, int] = defaultdict(int)
    for hits, _, _ in candidates:
        for t, _ in hits:
            df[t] += 1
    results = []
    for hits, knowledge, item in candidates:
        rank = sum(s * math.log((total - df[t] + 0.5) / (df[t] + 0.5) + 1) for t, s in hits)
        if knowledge:
            rank *= 1.25  # knowledge and fresh handoffs outrank a file at equal evidence
        results.append((rank, item))
    results.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [item for _, item in results[:20]]


@mcp.tool()
def brain_node(node_id: str) -> dict:
    """Get full details of a brain node by id (e.g. 'vault:api-agent-allowlist',
    'api:src/server/routes.py')."""
    if node_id.startswith("memory:"):
        wanted = node_id.removeprefix("memory:")
        record = next((item for item in reversed(memory_records(include_superseded=True))
                       if item.get("id") == wanted), None)
        if record:
            _note_usage(node_id)
        return record or {"error": f"unknown memory id: {node_id}"}
    n = NODES.get(node_id)
    if not n:
        return {"error": f"unknown node id: {node_id}"}
    _note_usage(node_id)
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
            for nb, et in neighbors_of(nid):
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
        _note_usage(nid)
        result["node"] = brief(nid)
        for nb, et in neighbors_of(nid)[:80]:
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
    supersedes: list[str] | None = None,
) -> dict:
    """Persist a completed unit of work into immediate ASM memory and the Obsidian daily log.

    Call after changing files. Record concrete outcomes and unresolved work; never include
    secrets, credentials, raw private transcripts, or claims that were not verified.
    `supersedes` names earlier memory ids this record replaces (a corrected fact, a thread
    now closed); they stop surfacing in search and recall but stay readable by id.
    Credentials and card numbers are redacted mechanically; `redactions` lists what kinds.
    """
    session = re.sub(r"[^\w.-]", "", session_id.strip())[:160]
    redactions: list[str] = []

    def clean(value: str, limit: int) -> str:
        text, kinds = scrub_text(str(value).strip())
        for kind in kinds:
            if kind not in redactions:
                redactions.append(kind)
        return text[:limit]

    summary = " ".join(clean(summary, 500).split())
    details = clean(details, 12000)
    agent = re.sub(r"[^\w .:/-]", "", agent.strip())[:80] or "agent"
    if not session:
        return {"ok": False, "error": "session_id is required"}
    if len(summary) < 8:
        return {"ok": False, "error": "summary must name what actually changed"}
    if len(details) < 20:
        return {"ok": False, "error": "details must include enough context for the next agent"}

    normalized_files = [str(value).strip()[:1000] for value in (files or []) if str(value).strip()][:80]
    normalized_decisions = [clean(value, 2000) for value in (decisions or []) if str(value).strip()][:30]
    normalized_threads = [clean(value, 2000) for value in (open_threads or []) if str(value).strip()][:30]
    digest = hashlib.sha256(
        json.dumps([session, summary, details, normalized_files], ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    known = memory_records(include_superseded=True)
    existing = next((record for record in known if record.get("id") == digest), None)
    if existing:
        return {"ok": True, "duplicate": True, "record": existing}
    # Only ids that exist can be superseded: a typo must not silently retire nothing, and a
    # record can never retire itself.
    known_ids = {record["id"] for record in known}
    requested = [re.sub(r"[^\w-]", "", str(value).removeprefix("memory:"))[:32] for value in (supersedes or [])]
    normalized_supersedes = [value for value in requested if value in known_ids and value != digest][:30]
    ignored_supersedes = [value for value in requested if value and value not in normalized_supersedes]

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
    if normalized_supersedes:
        record["supersedes"] = normalized_supersedes
    _append_text(MEMORY_PATH, json.dumps(record, ensure_ascii=False) + "\n")
    for old in normalized_supersedes:
        _detach_memory(old)
    _attach_memory(record)
    daily_path, vault_status = _daily_section(record)
    return {
        "ok": True,
        "record": record,
        "redactions": redactions,
        "ignored_supersedes": ignored_supersedes,
        "daily_path": str(daily_path) if daily_path else None,
        "vault_status": vault_status,
    }


if __name__ == "__main__":
    mcp.run()
