"""ASM offline MCP server for shared agent memory and the knowledge/code graph.

The deployed copy runs from ``~/.asm``. Claude, Codex, and any other MCP client point
at that same directory, so reads and writes share one local source of truth. The
visualization server on :8930 is optional.
"""
import functools
import hashlib
import json
import math
import os
import posixpath
import re
import threading
import time
import urllib.request
import subprocess
import sys

from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERE = Path(__file__).resolve().parent
BRAIN_PATH = HERE / "brain.json"
# Vault page bodies, as stemmed word sets (see merge.py). Optional: a runtime deployed
# before this file existed must still start, it simply cannot match on bodies.
PAGES_PATH = HERE / "brain.pages.json"
MEMORY_PATH = HERE / "memory.jsonl"
USAGE_PATH = HERE / "usage.jsonl"
PATHS_PATH = HERE / "asm-paths.json"
# The lifecycle ledger (see lifecycle.py): what happened to memory after it was written.
LEDGER_PATH = HERE / "lifecycle.jsonl"

# The graph. _load_graph() replaces every one of these together, so a search never mixes
# the nodes of one brain with the field cache of another; see _fresh_graph().
BRAIN: dict = {"nodes": [], "links": []}
PAGE_WORDS: dict[str, list[str]] = {}
NODES: dict[str, dict] = {}
ADJ: dict[str, list[tuple[str, str]]] = defaultdict(list)  # id -> [(neighbor, edge_type)]
_GRAPH_STAMP: int | None = None
_GRAPH_LOCK = threading.RLock()


# Not "a body word is better evidence than a description word" — it is the compensation for
# what this ranker does not otherwise reward: COVERAGE. A page whose body carries all four
# words of a question should beat one that carries two of them in its tags (weight 3 each),
# and at weight 1 it does not. Swept on 320 queries (tests/fixtures/recall/): 1.5 is the
# point where body-only recall@10 reaches 91% while metadata recall is at its own maximum
# on @1, @5 and @10 at the same time. Above 2.0 metadata starts paying for it.
BODY_WEIGHT = 1.5


def _node_fields(n: dict) -> list[tuple[set[str], float]]:
    """The weighted word sets one node is searched by.

    Built once per process: `field_words` on every node on every query costs ~0.5s, and an
    empty set per absent field costs more memory than the words do. Words are interned
    because the same few thousand of them repeat across 31k nodes.
    """
    meta = n.get("meta") or {}
    body = PAGE_WORDS.get(n["id"])
    raw: list[tuple[str, int]] = [
        (" ".join(meta.get("tags", [])), 3),
        (n["label"], 2),
        (" ".join(meta.get("aliases", []) or []), 2),
        (meta.get("description", ""), 1),
        (n.get("path", ""), 1),
    ]
    fields = []
    for text, weight in raw:
        if not text:
            continue
        words = {sys.intern(w) for w in field_words(text)}
        if words:
            fields.append((words, weight))
    if body:
        fields.append(({sys.intern(w) for w in body}, BODY_WEIGHT))
    return fields


def _last2(p: str) -> str:
    return "/".join(p.split("/")[-2:])


# Path lookups: exact absolute path, and a last-two-segments bucket that every suffix rule
# in find_by_path narrows further. Built with the graph so attaching 100+ memory records at
# startup does not scan 19k nodes per file.
ABS_INDEX: dict[str, str] = {}
SUFFIX2: dict[str, list[str]] = defaultdict(list)

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


# The query tokenizer and the index-side word splitter both live in asm_text.py so the
# server, merge.py and the tests cannot drift apart. hook/asm-prompt-recall.js carries the
# same two functions; tests/fixtures/tokenize.json is run against both implementations.
# The runtime is deployed as loose files in ~/.asm and is started in more than one way
# (uv --directory, a bare python, an import by path from a test). Only the first of those
# puts this directory on sys.path, so put it there explicitly before importing a sibling.
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from asm_text import STOP, field_words, query_parts, stem, tokenize  # noqa: E402,F401
try:
    from lifecycle import VISIBILITY, append_op as ledger_append  # noqa: E402
    from lifecycle import fold as ledger_fold, load_ops as ledger_load  # noqa: E402
except ImportError as _missing:  # a runtime deployed without lifecycle.py must still open
    print(f"[asm] lifecycle.py is missing ({_missing}); the ledger is off until refresh.sh deploys it",
          file=sys.stderr)
    VISIBILITY = {"close_thread": "closed", "mark_done": "done", "retire": "retired"}

    class _NoLedger:
        """What recall sees with no ledger module: nothing closed, nothing retired."""

        def state(self, kind: str, ident: str) -> None:
            return None

        def hidden(self, kind: str, ident: str) -> bool:
            return False

        def thread_open(self, record_id: str, index: int) -> bool:
            return True

    def ledger_load(path: Path) -> list[dict]:
        return []

    def ledger_fold(ops: list[dict], records: list[dict] | None = None) -> _NoLedger:
        return _NoLedger()

    def ledger_append(path: Path, op: dict) -> dict:
        raise RuntimeError("the lifecycle ledger is not deployed")


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
    life = ledger_fold(_ledger_ops(), records)
    out = []
    for record in records:
        by = superseded.get(record["id"])
        entry = life.state("record", record["id"])
        retired = entry if entry and entry["state"] == "retired" and not entry["op_id"].startswith("supersedes:") else None
        if by or retired:
            record = {**record}
            if by:
                record["superseded_by"] = by
            if retired:
                record["lifecycle"] = dict(retired)
            if not include_superseded:
                continue
        count = len(record.get("open_threads") or [])
        record = {**record, "open_thread_indexes": [i for i in range(count) if life.thread_open(record["id"], i)]}
        out.append(record)
    return out


_LEDGER_CACHE: tuple[tuple[int, int], list[dict]] | None = None


def _ledger_ops() -> list[dict]:
    """The lifecycle ledger's operations, re-read only when the file changed."""
    global _LEDGER_CACHE
    try:
        info = LEDGER_PATH.stat()
    except OSError:
        return []
    stamp = (info.st_mtime_ns, info.st_size)
    if _LEDGER_CACHE is None or _LEDGER_CACHE[0] != stamp:
        _LEDGER_CACHE = (stamp, ledger_load(LEDGER_PATH))
    return _LEDGER_CACHE[1]


# A record's rank moves by at most ±15% with its age, reaching the floor at 60 days: a
# handoff from yesterday should beat an equal one from last month, never a far better
# match. hook/asm-prompt-recall.js applies the same factor.
RECENCY_R = 0.15
RECENCY_DAYS = 60
# Daily notes copy every record verbatim; the records are candidates themselves, so a daily
# note is weighted down in search (and not injected by the hook at all).
DAILY_WEIGHT = 0.5
_DAILY_ID = re.compile(r"^vault:daily-\d{4}-\d{2}-\d{2}$")
# A page the curator keeps a current-state block in is the derived tier: prefer it.
CURATED_BOOST = 1.25


def _clock() -> datetime:
    """Now, or ASM_NOW when it is set: the recall benchmark runs a frozen snapshot at the
    snapshot's own time, so a code change is never confused with the clock moving on."""
    frozen = os.environ.get("ASM_NOW", "").strip()
    if frozen:
        try:
            at = datetime.fromisoformat(frozen.replace("Z", "+00:00"))
            return at if at.tzinfo else at.astimezone()
        except ValueError:
            pass
    return datetime.now().astimezone()


def recency_factor(created_at: str, now: datetime | None = None) -> float:
    try:
        at = datetime.fromisoformat(str(created_at))
    except ValueError:
        return 1.0
    if at.tzinfo is None:
        at = at.astimezone()
    age_days = max(0.0, ((now or _clock()) - at).total_seconds() / 86400)
    return 1 + RECENCY_R - 2 * RECENCY_R * min(age_days / RECENCY_DAYS, 1)


def _is_daily(nid: str, meta: dict) -> bool:
    return bool(_DAILY_ID.match(nid)) or meta.get("type") == "daily-note"


def _page_lifecycle(nid: str, life) -> dict | None:
    """A page's lifecycle: the ledger when it has an entry, else the page's own frontmatter."""
    entry = life.state("page", nid)
    if entry:
        return dict(entry)
    meta = (NODES.get(nid) or {}).get("meta") or {}
    status = str(meta.get("status") or "").strip().lower()
    if status in ("done", "retired"):
        return {"state": status, "op_id": "frontmatter", "reason": "status in the page frontmatter",
                "at": str(meta.get("done_at") or meta.get("retired_at") or ""),
                "superseded_by": meta.get("superseded_by")}
    return None


def _op_evidence(op_id: str) -> str:
    return next((str(next(iter(op.get("evidence") or []), "")) for op in _ledger_ops() if op.get("id") == op_id), "")


def _marked(item: dict, entry: dict | None) -> dict:
    """A finished plan keeps its place in recall, labelled so that no agent builds it again."""
    if not entry or entry.get("state") != "done":
        return item
    try:
        day = datetime.fromisoformat(str(entry.get("at") or "")).strftime("%d/%m")
    except ValueError:
        day = ""
    evidence = _op_evidence(entry["op_id"]) if entry["op_id"] != "frontmatter" else "status: done"
    tag = " ".join(part for part in ("DONE", day) if part) + (f" · {evidence}" if evidence else "")
    return {**item, "label": f"[{tag}] {item['label']}", "status": "done"}


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


# The client replaces a tool result of more than ~50k characters with an error, and a full
# record carries up to 12k characters of details: 43% of memory_recent calls and 13% of
# brain_context calls failed that way. Recall therefore returns records in brief form, and
# the full record stays one brain_node('memory:<id>') away.
RECENT_MAX_CHARS = 20000
PREVIEW_CHARS = 300


def record_brief(record: dict) -> dict:
    """A record as recall shows it: enough to decide whether to open it."""
    threads = [str(value) for value in record.get("open_threads") or []]
    out = {
        "id": record["id"],
        "session_id": record.get("session_id", ""),
        "created_at": record.get("created_at", ""),
        "agent": record.get("agent", ""),
        "summary": record.get("summary", ""),
        "files": list(record.get("files") or [])[:5],
        "open_threads": [{"id": f"{record['id']}#{index}", "text": text[:PREVIEW_CHARS]}
                         for index, text in enumerate(threads)
                         if index in record.get("open_thread_indexes", range(len(threads)))][:10],
        "details_preview": str(record.get("details", ""))[:PREVIEW_CHARS],
    }
    if record.get("superseded_by"):
        out["superseded_by"] = record["superseded_by"]
    return out


def _cap(items: list[dict], limit: int = RECENT_MAX_CHARS) -> list[dict]:
    """Keep whole items while the result stays under `limit` characters, and say how many
    were left out. Measured on the whole list the way FastMCP serializes it (indent=2,
    non-ASCII kept): an item nested in a list is indented deeper than the item alone."""
    out: list[dict] = []
    for index, item in enumerate(items):
        marker = {"truncated": len(items) - index - 1,
                  "hint": "open a full record with brain_node('memory:<id>')"}
        if len(json.dumps([*out, item, marker], ensure_ascii=False, indent=2)) > limit:
            out.append({**marker, "truncated": len(items) - index})
            break
        out.append(item)
    return out


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


def _access_key(event: dict) -> tuple:
    """Identity shared with the server's own replay guard, so a buffered copy of an
    event the server already persisted collapses into one row instead of two."""
    try:
        ts = round(float(event.get("ts", 0)), 3)
    except (TypeError, ValueError):
        ts = 0.0
    return (
        ts,
        event.get("agent", ""),
        event.get("session", ""),
        event.get("path", ""),
        event.get("tool", ""),
        event.get("phase", "finish"),
        event.get("operation_id", ""),
    )


EVENTS_PATH = HERE / "events.jsonl"
PENDING_PATH = HERE / "pending.jsonl"
STAGED_PATH = HERE / "pending.draining"   # the same name server.py recovers from
DRAIN_LOCK = HERE / "pending.drain.lock"
EVENTS_KEEP = 20000                        # matches the server's own trim_history
EVENTS_TRIM_BYTES = 8 * 1024 * 1024


def events_from_buffer(line: str) -> list[dict]:
    """Shape one buffered hook post into event rows, resolving paths against the graph.

    One shaping function for both readers: `buffered_access` filters these down to a
    single file, `drain_buffer` persists them. Were the two to shape a row differently,
    the same touch would become two distinct events the moment one of them landed in
    events.jsonl and the other was still in the buffer.
    """
    try:
        body = json.loads(line)
    except ValueError:
        return []
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        return []  # presence heartbeats, and the hook's {"dropped": n} overflow marker
    cwd = str(body.get("cwd", "")).replace("\\", "/")
    rows: list[dict] = []
    for raw in paths:
        resolved = str(raw).replace("\\", "/")
        absolute = resolved.startswith("/") or (
            len(resolved) >= 3 and resolved[0].isalpha() and resolved[1:3] == ":/")
        if cwd and not absolute:
            resolved = posixpath.normpath(f"{cwd.rstrip('/')}/{resolved}")
        hit = find_by_path(resolved)
        node = NODES.get(hit) if hit else None
        rows.append({
            "ts": body.get("ts", 0),
            "tool": body.get("tool", ""),
            "cwd": norm(cwd),
            "session": body.get("session", ""),
            "agent": body.get("agent", "agent"),
            "path": resolved,
            # An unresolved path keeps an empty id rather than an invented one: the
            # server mints `ephemeral:<project>-<digest>:...` from state this process
            # does not have, and two different spellings of the same miss would defeat
            # the deduplication that keeps a drained row and a buffered row as one.
            "node_id": hit or "",
            "matched": bool(hit),
            "presence": False,
            "layer": node["layer"] if node else "ephemeral",
            "label": node["label"] if node else resolved.split("/")[-1],
            "source": body.get("source", "hook"),
            "phase": body.get("phase", "finish"),
            "operation_id": body.get("operation_id", ""),
            "file_access": bool(body.get("file_access", False)),
        })
    return rows


def buffered_access(nid: str | None, file_path: str) -> list[dict]:
    """File touches the hook buffered because nothing answered on :8930.

    The visualization server is optional — but it used to be the only thing that ever
    turned a hook post into a row in events.jsonl, so while it was down every agent kept
    working and the brain went blind to all of it. Measured: six days with the server off
    left 4,794 touches sitting in pending.jsonl, unreadable by anything.

    The buffer is read here rather than taught to the hook because resolving a path to a
    node needs the graph, and this process is the one that holds it.
    """
    try:
        lines = PENDING_PATH.read_text(
            encoding="utf-8", errors="replace").splitlines()[-4000:]
    except OSError:
        return []
    leaf = norm(file_path).split("/")[-1]
    out: list[dict] = []
    for line in lines:
        if not line.strip():
            continue
        for row in events_from_buffer(line):
            if nid:
                if row["node_id"] != nid:
                    continue
            elif not norm(row["path"]).endswith("/" + leaf):
                continue
            out.append({**row, "pending": True})
    return out


def _hold_drain_lock() -> int | None:
    """Exactly one process may fold the buffer into the durable log.

    Roughly eighteen MCP instances run at once on this machine, one per open editor
    session, and they all start by draining. An O_EXCL create is the whole election; a
    lock older than two minutes belonged to a process that died mid-drain, and the
    staged file it left behind is recovered on the next attempt either way.
    """
    try:
        return os.open(DRAIN_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        try:
            if time.time() - DRAIN_LOCK.stat().st_mtime < 120:
                return None
            DRAIN_LOCK.unlink(missing_ok=True)
            return os.open(DRAIN_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except (OSError, FileExistsError):
            return None
    except OSError:
        return None


def _trim_events() -> None:
    """Without the server nothing else caps the log, and recent_access reads its tail."""
    try:
        if EVENTS_PATH.stat().st_size < EVENTS_TRIM_BYTES:
            return
        lines = EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) <= EVENTS_KEEP:
            return
        EVENTS_PATH.write_text("\n".join(lines[-EVENTS_KEEP:]) + "\n", encoding="utf-8")
    except (OSError, ValueError):
        pass


def drain_buffer() -> int:
    """Fold the hook's buffer into the durable log. Returns how many rows were added.

    With the UI retired the buffer is the only place new activity ever lands, and the
    hook caps it at 2MB by dropping the older half — so the record of what every agent
    touched was a rolling window that quietly forgot its own past. This turns it back
    into an archive without the server having to exist.

    Staged with a rename first, exactly as the server does: appends racing the drain
    would otherwise land in a file the unlink already destroyed, and a crash leaves a
    `pending.draining` that both this and the server know how to pick up.
    """
    if not PENDING_PATH.exists() and not STAGED_PATH.exists():
        return 0
    lock = _hold_drain_lock()
    if lock is None:
        return 0  # another session is already doing it
    try:
        os.close(lock)
        try:
            if STAGED_PATH.exists() and PENDING_PATH.exists():
                with STAGED_PATH.open("a", encoding="utf-8") as staged:
                    staged.write(PENDING_PATH.read_text(encoding="utf-8", errors="replace"))
                PENDING_PATH.unlink(missing_ok=True)
            elif PENDING_PATH.exists():
                PENDING_PATH.replace(STAGED_PATH)
            lines = STAGED_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return 0

        rows: list[dict] = []
        for line in lines:
            if line.strip():
                rows.extend(events_from_buffer(line))
        if not rows:
            STAGED_PATH.unlink(missing_ok=True)
            return 0

        try:
            known = {
                _access_key(json.loads(x))
                for x in EVENTS_PATH.read_text(
                    encoding="utf-8", errors="replace").splitlines()[-EVENTS_KEEP:]
                if x.strip()
            }
        except (OSError, ValueError):
            known = set()

        fresh = []
        for row in rows:
            key = _access_key(row)
            if key in known:
                continue
            known.add(key)
            fresh.append(row)
        if fresh:
            fresh.sort(key=lambda e: float(e.get("ts") or 0))
            try:
                with EVENTS_PATH.open("a", encoding="utf-8") as log:
                    for row in fresh:
                        log.write(json.dumps(row, ensure_ascii=False) + "\n")
            except OSError:
                return 0  # keep the staged file; the next session retries it
        STAGED_PATH.unlink(missing_ok=True)
        _trim_events()
        return len(fresh)
    finally:
        DRAIN_LOCK.unlink(missing_ok=True)


def recent_access(file_path: str, nid: str | None) -> list[dict]:
    """Recent agent touches of this file, from every durable source there is.

    The live server first when it happens to be up (it holds the same rows in memory),
    otherwise the persisted log — and always the hook's buffer on top of whichever
    answered, because the server is optional and everything that happened while it was
    down exists only in that buffer until it next starts.
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
            events = []  # no log yet is not "nothing happened" — the buffer may still know
    if nid:
        # Once the node is known, match on it only. Matching on the bare filename would
        # report another project's api.py / settings.json as access to this one.
        hits = [e for e in events if e.get("node_id") == nid]
    else:
        name = norm(file_path).split("/")[-1]
        hits = [e for e in events if e.get("path", "").endswith("/" + name)]

    # Durable rows win the identity; the buffer only adds what nothing else recorded.
    merged: dict[tuple, dict] = {}
    for event in hits + buffered_access(nid, file_path):
        merged.setdefault(_access_key(event), event)
    return sorted(merged.values(), key=lambda e: float(e.get("ts") or 0))[-10:]


def _worktree_main(project: Path) -> Path | None:
    """The main checkout of a git worktree, or None. Mirrors source_manifest.worktree_main:
    the runtime is deployed as loose files without that module."""
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


@functools.lru_cache(maxsize=4096)
def _canonical_path(file_path: str) -> str | None:
    """A path inside a git worktree, rewritten onto the worktree's main checkout.

    New worktrees appear every day and are never in the graph (and worktrees of mapped
    repositories are left out of it on purpose). Their files are the main checkout's
    files, so that is where their knowledge lives: 23 of 69 empty brain_context answers
    were worktree paths. A relative `Projects/...` path is taken from the workspace root.
    """
    found = _worktree_of(file_path)
    return str(found[2] / found[0].relative_to(found[1])) if found else None


def _worktree_of(file_path: str) -> tuple[Path, Path, Path] | None:
    """(the path, its worktree's root, that worktree's main checkout), or None outside a worktree."""
    raw = file_path.replace("\\", "/")
    path = Path(raw)
    if not path.is_absolute():
        repo = str(_read_json(PATHS_PATH).get("repo") or "")
        if not repo or not raw.startswith("Projects/"):
            return None
        path = Path(repo).parent.parent / raw
    for parent in [path.parent, *path.parent.parents]:
        marker = parent / ".git"
        try:
            if marker.is_dir():
                return None  # a main checkout: nothing to rewrite
            if marker.is_file():
                main = _worktree_main(parent)
                return (path, parent, main) if main else None
        except (OSError, ValueError):
            return None
    return None


STALE_MAIN_COMMITS = 10
_BEHIND: dict[tuple[str, str], tuple[float, int | None]] = {}


def _commits_behind(tree: Path, main: Path) -> int | None:
    """Commits the worktree's HEAD has that the main checkout's HEAD lacks; cached five minutes."""
    key = (str(tree), str(main))
    cached = _BEHIND.get(key)
    if cached and time.time() - cached[0] < 300:
        return cached[1]
    quiet = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        head = subprocess.run(["git", "-C", str(main), "rev-parse", "HEAD"], capture_output=True, text=True,
                              timeout=5, check=True, **quiet).stdout.strip()
        count = int(subprocess.run(["git", "-C", str(tree), "rev-list", "--count", f"{head}..HEAD"], capture_output=True,
                                   text=True, timeout=5, check=True, **quiet).stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        count = None
    _BEHIND[key] = (time.time(), count)
    return count


def _stale_main(file_path: str, node_abs: str) -> dict | None:
    """The code map of a worktree's files comes from its main checkout. When that checkout lags far
    behind the worktree, files added since are missing from it and changed files show old
    neighbours: say so, instead of answering from old code as if it were current. A node from
    another tree (a worktree mapped on its own) is not the main checkout's, and gets no note."""
    found = _worktree_of(file_path)
    if not found or (node_abs and not norm(node_abs).startswith(norm(str(found[2])).rstrip("/") + "/")):
        return None
    behind = _commits_behind(found[1], found[2])
    if behind is None or behind < STALE_MAIN_COMMITS:
        return None
    return {"commits": behind, "main_checkout": str(found[2]),
            "note": (f"the code map comes from {found[2]}, which is {behind} commits behind this worktree: files added "
                     "since are missing from it and changed files show old neighbours — read the file itself for "
                     "its current content")}


def resolve_path(file_path: str) -> tuple[str | None, str | None]:
    """(node id, the rewritten path when the worktree fallback resolved it)."""
    hit = find_by_path(file_path, canonical=False)
    if hit:
        return hit, None
    alt = _canonical_path(file_path)
    if alt and norm(alt) != norm(file_path):
        hit = find_by_path(alt, canonical=False)
        if hit:
            return hit, alt
    return None, None


def find_by_path(file_path: str, canonical: bool = True) -> str | None:
    """Resolve a path to a node id, or None when it is too ambiguous to answer.

    A single-segment path like "api.py" matches dozens of nodes across projects; returning
    the first one would inject a different project's knowledge as authoritative context.
    With `canonical`, a path inside a git worktree falls back to its main checkout.
    """
    if canonical:
        return resolve_path(file_path)[0]
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
    if mid in NODES or record.get("superseded_by") or record.get("lifecycle"):
        return  # superseded, or retired in the ledger: out of the graph, still readable by id
    NODES[mid] = {**memory_brief(record), "abs": "",
                  "meta": {"description": record.get("summary", ""),
                           "open_threads": record.get("open_threads") or []}}
    for value in record.get("files") or []:
        fid = find_by_path(str(value))
        if fid and (fid, "touches") not in ADJ[mid]:
            ADJ[mid].append((fid, "touches"))
            ADJ[fid].append((mid, "touches"))


def _field_hits(tokens: list[str], fields: list[tuple[set[str], float]]) -> list[tuple[str, float]]:
    """Score one candidate. Each field arrives as its stemmed word set.

    The match is whole-word and every word of a compound query token has to be present:
    `src/app.py` needs `src` and `app` in the same field. The previous `t in text`
    substring test let `gnu` hit the vendored bundle `gnuplot-q7elnnri.js`, and three of
    those outranked the page that documents the GNU/BSD split.
    """
    hits = []
    for t in tokens:
        parts = query_parts(t)
        s = sum(w for words, w in fields if parts <= words)
        if s:
            hits.append((t, s))
    return hits


_NODE_FIELDS: list[list[tuple[set[str], float]]] | None = None


def _load_graph() -> None:
    """(Re)build every graph global from brain.json in one step.

    refresh.sh swaps brain.json atomically, but each MCP process used to load it once at
    start and serve that snapshot for its whole life — up to five days: 40 of 69 empty
    brain_context answers resolved in the brain on disk, just not in the one in memory.
    """
    global BRAIN, PAGE_WORDS, NODES, ADJ, ABS_INDEX, SUFFIX2, _NODE_FIELDS, _GRAPH_STAMP
    stamp = BRAIN_PATH.stat().st_mtime_ns
    brain = json.loads(BRAIN_PATH.read_text(encoding="utf-8"))
    try:
        pages = json.loads(PAGES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pages = {}
    nodes = {n["id"]: n for n in brain["nodes"]}
    adj: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for e in brain["links"]:
        adj[e["source"]].append((e["target"], e["type"]))
        adj[e["target"]].append((e["source"], e["type"]))
    abs_index: dict[str, str] = {}
    suffix2: dict[str, list[str]] = defaultdict(list)
    for n in brain["nodes"]:
        if n.get("abs"):
            abs_index.setdefault(n["abs"], n["id"])
            suffix2[_last2(n["abs"])].append(n["id"])
    BRAIN, PAGE_WORDS, NODES, ADJ, ABS_INDEX, SUFFIX2 = brain, pages, nodes, adj, abs_index, suffix2
    _NODE_FIELDS = None
    _GRAPH_STAMP = stamp
    for record in memory_records(include_superseded=True):
        _attach_memory(record)


def _fresh_graph() -> None:
    """Serve the brain that is on disk now. A reload that fails keeps the old graph."""
    try:
        stamp = BRAIN_PATH.stat().st_mtime_ns
    except OSError:
        return
    if stamp == _GRAPH_STAMP:
        return
    with _GRAPH_LOCK:
        if stamp == _GRAPH_STAMP:
            return
        try:
            _load_graph()
        except (OSError, ValueError, KeyError, TypeError) as exc:
            print(f"[asm] brain.json could not be loaded; serving the previous graph: {exc}", file=sys.stderr)


# A runtime without a brain yet still records and recalls memory; the graph appears on the
# first call after refresh.sh deploys one.
_fresh_graph()


def _node_field_cache() -> list[list[tuple[set[str], float]]]:
    """Built on the first search, not at import: most sessions never call brain_search and
    every MCP process would otherwise pay 0.15s and ~40MB for an index it never reads."""
    global _NODE_FIELDS
    if _NODE_FIELDS is None:
        _NODE_FIELDS = [_node_fields(n) for n in BRAIN["nodes"]]
    return _NODE_FIELDS


_RECORD_FIELDS: dict[str, list[tuple[set[str], float]]] = {}


def _record_fields(record: dict) -> list[tuple[set[str], float]]:
    """Records are re-read from memory.jsonl on every call, so cache by id; `details` runs
    to a few KB and re-splitting 600 of them per search is the whole cost of a search."""
    threads = list(record.get("open_threads") or [])
    open_indexes = tuple(record.get("open_thread_indexes", range(len(threads))))
    key = f"{record.get('id', '')}|{','.join(map(str, open_indexes))}"
    cached = _RECORD_FIELDS.get(key)
    if cached is None:
        open_threads = [threads[index] for index in open_indexes if index < len(threads)]
        cached = [
            (field_words(str(record.get("summary", ""))), 2),
            (field_words(" ".join(map(str, (record.get("decisions") or [])
                                      + open_threads
                                      + (record.get("files") or [])))), 1),
            (field_words(str(record.get("details", ""))), 1),
        ]
        cached = [(words, weight) for words, weight in cached if words]
        if record.get("id"):
            _RECORD_FIELDS[key] = cached
    return cached


@mcp.tool()
def brain_search(query: str) -> list[dict]:
    """Search ASM across vault pages, mapped code, and immediate shared-memory records."""
    _fresh_graph()
    tokens = tokenize(query)
    if not tokens:
        return []
    # Same field weights as the prompt hook; IDF over the matched candidates does the
    # ranking so `index.ts` (hundreds of files) cannot outrank a token that lands on five.
    records = memory_records()
    life = ledger_fold(_ledger_ops(), records)
    candidates: list[tuple[list[tuple[str, float]], bool, dict, float]] = []
    for n, fields in zip(BRAIN["nodes"], _node_field_cache()):
        hits = _field_hits(tokens, fields)
        if not hits:
            continue
        item, weight = brief(n["id"]), 1.0
        if n["kind"] == "page":
            entry = _page_lifecycle(n["id"], life)
            if entry and entry["state"] == "retired":
                continue  # retired knowledge leaves automatic recall; brain_node still opens it
            item = _marked(item, entry)
            meta = n.get("meta") or {}
            weight *= (DAILY_WEIGHT if _is_daily(n["id"], meta) else 1.0) * (CURATED_BOOST if meta.get("curated") else 1.0)
        candidates.append((hits, n["kind"] == "page", item, weight))
    for record in records:
        # Explicit search does read `details` (the prompt hook does not — see the hook).
        hits = _field_hits(tokens, _record_fields(record))
        if hits:
            candidates.append((hits, True, memory_brief(record), recency_factor(record.get("created_at", ""))))
    total = len(BRAIN["nodes"]) + len(records)
    df: dict[str, int] = defaultdict(int)
    for hits, _, _, _ in candidates:
        for t, _ in hits:
            df[t] += 1
    results = []
    for hits, knowledge, item, weight in candidates:
        rank = sum(s * math.log((total - df[t] + 0.5) / (df[t] + 0.5) + 1) for t, s in hits)
        if knowledge:
            rank *= 1.25  # knowledge and fresh handoffs outrank a file at equal evidence
        results.append((rank * weight, item))
    results.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [item for _, item in results[:20]]


@mcp.tool()
def brain_node(node_id: str) -> dict:
    """Get full details of a brain node by id (e.g. 'vault:api-agent-allowlist',
    'api:src/server/routes.py')."""
    _fresh_graph()
    if node_id.startswith("memory:"):
        wanted = node_id.removeprefix("memory:")
        record = next((item for item in reversed(memory_records(include_superseded=True))
                       if item.get("id") == wanted), None)
        if record:
            _note_usage(node_id)
            return _record_detail(record)
        return {"error": f"unknown memory id: {node_id}"}
    n = NODES.get(node_id)
    if not n:
        return {"error": f"unknown node id: {node_id}"}
    _note_usage(node_id)
    out = {**n, "degree": len(ADJ[node_id])}
    if n.get("kind") == "page":
        entry = _page_lifecycle(node_id, ledger_fold(_ledger_ops(), []))
        if entry:
            out["lifecycle"] = entry
    return out


def _record_detail(record: dict) -> dict:
    """A full record as brain_node shows it: its threads by id, the open ones apart from those
    the ledger closed, so a closed thread is never read as work still to do."""
    texts = record.get("open_threads") or []
    still_open = set(record.get("open_thread_indexes") or [])
    detail = {key: value for key, value in record.items() if key not in ("open_threads", "open_thread_indexes")}
    detail["open_threads"] = [{"id": f"{record['id']}#{i}", "text": text} for i, text in enumerate(texts) if i in still_open]
    closed = [{"id": f"{record['id']}#{i}", "text": text} for i, text in enumerate(texts) if i not in still_open]
    if closed:
        detail["closed_threads"] = closed
    return detail


def _graph_brief(nid: str, life) -> dict:
    """brief() plus a page's done or retired state: a graph walk never passes off a finished
    plan or a retired page as live."""
    out = brief(nid)
    entry = _page_lifecycle(nid, life) if NODES[nid].get("kind") == "page" else None
    if entry:
        out["lifecycle"] = {"state": entry["state"], "reason": entry.get("reason", "")}
    return out


@mcp.tool()
def brain_neighbors(node_id: str, depth: int = 1) -> list[dict]:
    """Neighbors of a node up to `depth` hops (BFS, max 50 results).
    Includes cross-layer links between vault knowledge and code."""
    _fresh_graph()
    if node_id not in NODES:
        return [{"error": f"unknown node id: {node_id}"}]
    seen = {node_id}
    frontier = [node_id]
    out = []
    life = ledger_fold(_ledger_ops(), [])
    for _ in range(max(1, min(depth, 3))):
        nxt = []
        for nid in frontier:
            for nb, et in neighbors_of(nid):
                if nb not in seen:
                    seen.add(nb)
                    out.append({**_graph_brief(nb, life), "via": et})
                    nxt.append(nb)
                    if len(out) >= 50:
                        return out
        frontier = nxt
    return out


@mcp.tool()
def brain_path(from_id: str, to_id: str) -> list[dict]:
    """Shortest path between two brain nodes (BFS over all edge types)."""
    _fresh_graph()
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
    life = ledger_fold(_ledger_ops(), [])
    while cur:
        path.append(_graph_brief(cur, life))
        cur = prev[cur]
    return list(reversed(path))


@mcp.tool()
def brain_context(file_path: str) -> dict:
    """THE tool to call before touching a file: given an absolute or relative file path,
    returns what the brain knows — the matching node, its code neighbors, linked vault
    knowledge pages (gotchas/decisions about it), and recent cross-agent access events."""
    _fresh_graph()
    nid, via = resolve_path(file_path)
    result: dict = {"file_path": file_path, "node": None, "vault_pages": [],
                    "code_neighbors": [], "recent_access": [], "shared_memory": []}
    if via:
        result["resolved_via"] = via  # a git worktree path, resolved on its main checkout
    stale = _stale_main(file_path, str(NODES[nid].get("abs") or "") if nid else "")
    if stale:
        result["main_checkout_behind"] = stale
    if nid:
        _note_usage(nid)
        result["node"] = brief(nid)
        life = ledger_fold(_ledger_ops(), [])
        for nb, et in neighbors_of(nid)[:80]:
            b = {**brief(nb), "via": et}
            if NODES[nb]["layer"] == "vault":
                entry = _page_lifecycle(nb, life) if NODES[nb].get("kind") == "page" else None
                if entry and entry["state"] == "retired":
                    continue
                result["vault_pages"].append(_marked(b, entry))
            elif NODES[nb]["kind"] == "file":
                result["code_neighbors"].append(b)
        result["code_neighbors"] = result["code_neighbors"][:15]
    else:
        result["note"] = ("no unambiguous node for this path — pass more path segments "
                          "(e.g. src/pkg/file.py) or use brain_search")
    result["recent_access"] = recent_access(file_path, nid)
    target = norm(file_path)
    result["shared_memory"] = [
        record_brief(record) for record in reversed(memory_records())
        if any(target == norm(str(item)) or target.endswith("/" + norm(str(item)))
               or norm(str(item)).endswith("/" + target)
               for item in record.get("files") or [])
    ][:3]
    return result


@mcp.tool()
def memory_recent(limit: int = 10, query: str = "") -> list[dict]:
    """Newest shared records from any agent, in brief form: summary, files, open threads with
    their ids, and a details preview. Words in `query` filter the records; any word may match.
    Open a full record with brain_node('memory:<id>')."""
    records = list(reversed(memory_records()))
    if query.strip():
        tokens = tokenize(query)
        exact = {word.removeprefix("memory:") for word in query.split()}
        records = [record for record in records
                   if record["id"] in exact or record.get("session_id") in exact
                   or (tokens and _field_hits(tokens, _record_fields(record)))]
    return _cap([record_brief(record) for record in records[:max(1, min(limit, 50))]])


_LEAK_FIELDS = ("details", "files", "decisions", "open_threads", "supersedes", "resolves", "corrects", "agent")
_LEAK_OPEN = re.compile(r'<parameter name="(\w+)">|<(' + "|".join(_LEAK_FIELDS) + r')>')
_TRAILING_CLOSERS = re.compile(r"(?:\s*</[\w:]+>)+\s*$")
_LIST_FIELDS = {"files", "decisions", "open_threads", "supersedes", "resolves"}


def _split_leak(text: str, marker: str) -> tuple[str, dict[str, object]]:
    """Split arguments that arrived inside another argument back out of it.

    With a long argument, some clients serialize the later ones into it as literal text:
    `…</summary><parameter name="details">…` or bare `…</summary><details>…</details>`
    (80 of 850 calls failed validation that way, up to 18 retries in one session). Only a
    marker immediately followed by an opening tag counts; text that merely contains the
    marker is left whole.
    """
    if marker not in text:
        return text, {}
    head, tail = text.split(marker, 1)
    opens = list(_LEAK_OPEN.finditer(tail))
    if not opens or opens[0].start() != len(tail) - len(tail.lstrip()):
        return text, {}
    if (opens[0].group(1) or opens[0].group(2)) == marker.strip("</>"):
        return text, {}  # `</details> <details>` is prose about the tag; a field never reopens itself
    recovered: dict[str, object] = {}
    for index, match in enumerate(opens):
        name = match.group(1) or match.group(2)
        stop = opens[index + 1].start() if index + 1 < len(opens) else len(tail)
        value = _TRAILING_CLOSERS.sub("", tail[match.end():stop]).strip()
        if name in _LIST_FIELDS:
            try:
                parsed = json.loads(value)
                recovered[name] = [str(item) for item in parsed] if isinstance(parsed, list) else [value]
            except ValueError:
                recovered[name] = [line.strip("- ").strip() for line in value.splitlines() if line.strip()]
        elif name == "corrects":
            try:
                parsed = json.loads(value)
                recovered[name] = parsed if isinstance(parsed, list) else []
            except ValueError:
                recovered[name] = []
        else:
            recovered[name] = value
    return head.strip(), recovered


_THREAD_ID = re.compile(r"^([0-9a-f]{16})#(\d+)$")
_RECORD_ID = re.compile(r"^[0-9a-f]{16}$")
_CORRECTION_KINDS = {"vault:": "page", "mem:": "memory_file", "idx:": "index_line"}


def _resolve_ops(value: str, record: dict, known: dict[str, dict]) -> list[dict]:
    """The ledger operations one `resolves` value asks for; empty when it names nothing real."""
    raw = str(value).strip()
    text = raw.removeprefix("memory:")
    base = {"reason": f"resolved by memory:{record['id']}: {record['summary'][:200]}",
            "evidence": [f"memory:{record['id']}"], "mode": "auto",
            "actor": {"kind": "agent", "name": record["agent"], "session": record["session_id"]}}
    thread = _THREAD_ID.match(text)
    if thread:
        owner = known.get(thread.group(1))
        index = int(thread.group(2))
        if not owner or owner["id"] == record["id"] or index >= len(owner.get("open_threads") or []):
            return []
        return [{**base, "op": "close_thread", "class": "thread.close.resolved",
                 "target": {"kind": "thread", "id": f"{owner['id']}#{index}"}}]
    if _RECORD_ID.match(text):
        owner = known.get(text)
        if not owner or owner["id"] == record["id"]:
            return []
        return [{**base, "op": "close_thread", "class": "thread.close.resolved",
                 "target": {"kind": "thread", "id": f"{text}#{index}"}}
                for index in range(len(owner.get("open_threads") or []))]
    if raw.startswith("vault:") and raw in NODES:
        return [{**base, "op": "mark_done", "class": "page.mark_done", "target": {"kind": "page", "id": raw}}]
    return []


def _apply_resolves(values: list[str], record: dict, known: dict[str, dict]) -> tuple[list[str], list[str]]:
    """Write the operations `resolves` asks for, skipping any target already in that state."""
    life = ledger_fold(ledger_load(LEDGER_PATH), list(known.values()))
    resolved: list[str] = []
    ignored: list[str] = []
    written: set[str] = set()  # a target listed twice in one call is written once
    for value in values:
        ops = [op for op in _resolve_ops(value, record, known)
               if f"{op['target']['kind']}:{op['target']['id']}" not in written
               and (life.state(op["target"]["kind"], op["target"]["id"]) or {}).get("state") != VISIBILITY[op["op"]]]
        if not ops:
            ignored.append(str(value)[:200])
            continue
        try:
            for op in ops:
                resolved.append(ledger_append(LEDGER_PATH, op)["id"])
                written.add(f"{op['target']['kind']}:{op['target']['id']}")
        except RuntimeError:
            ignored.append(f"{str(value)[:200]} (the ledger is not deployed)")
    return resolved, ignored


def _request_corrections(items: list[dict], record: dict) -> tuple[list[str], list[str]]:
    """File each `corrects` item as a requested correction for the curator to apply."""
    requested: list[str] = []
    ignored: list[str] = []
    for item in items:
        target = str(item.get("target") or "").strip() if isinstance(item, dict) else ""
        kind = next((name for prefix, name in _CORRECTION_KINDS.items() if target.startswith(prefix)), None)
        claimed = scrub_text(str(item.get("claimed") or "").strip())[0] if isinstance(item, dict) else ""
        truth = scrub_text(str(item.get("truth") or "").strip())[0] if isinstance(item, dict) else ""
        if not kind or not claimed or not truth:
            ignored.append(target or str(item)[:120])
            continue
        evidence = [str(value) for value in (item.get("evidence") or []) if str(value).strip()][:10]
        try:
            op = ledger_append(LEDGER_PATH, {
                "op": "correct", "mode": "requested", "class": "correction.apply",
                "target": {"kind": kind, "id": target}, "claimed": claimed[:2000], "truth": truth[:2000],
                "reason": f"correction requested by memory:{record['id']}",
                "evidence": [*evidence, f"memory:{record['id']}"],
                "actor": {"kind": "agent", "name": record["agent"], "session": record["session_id"]}})
        except RuntimeError:
            ignored.append(f"{target} (the ledger is not deployed)")
            continue
        requested.append(op["id"])
    return requested, ignored


@mcp.tool()
def memory_record(
    session_id: str,
    summary: str,
    details: str = "",
    files: list[str] | None = None,
    decisions: list[str] | None = None,
    open_threads: list[str] | None = None,
    agent: str = "agent",
    supersedes: list[str] | None = None,
    resolves: list[str] | None = None,
    corrects: list[dict] | None = None,
) -> dict:
    """Persist a completed unit of work into immediate ASM memory and the Obsidian daily log.

    Call after changing files. `summary` is one line, at most 500 characters, naming what
    actually changed; the narrative, verification and context go in `details`. Record
    concrete outcomes and unresolved work; never include secrets, credentials, raw private
    transcripts, or claims that were not verified.
    `supersedes` names earlier memory ids this record replaces (a corrected fact, a thread
    now closed); they stop surfacing in search and recall but stay readable by id.
    Credentials and card numbers are redacted mechanically; `redactions` lists what kinds.
    The response lists `thread_ids` (`<record-id>#<n>`) for the open threads it stored.
    `resolves` closes what this work finished: a thread id `<record-id>#<n>`, a record id
    (all its threads), or a plan page `vault:<id>` (marked done). `corrects` files stale
    claims for the curator: [{"target": "vault:<id>" | "mem:<file>" | "idx:<index>:<file>",
    "claimed": ..., "truth": ..., "evidence": [...]}]. Both are recorded in the lifecycle ledger.
    """
    _fresh_graph()
    session = re.sub(r"[^\w.-]", "", str(session_id).strip())[:160]
    redactions: list[str] = []
    warnings: list[str] = []

    def clean(value: str, limit: int) -> str:
        text, kinds = scrub_text(str(value).strip())
        for kind in kinds:
            if kind not in redactions:
                redactions.append(kind)
        return text[:limit]

    summary, leaked = _split_leak(str(summary), "</summary>")
    details, leaked_from_details = _split_leak(str(details or leaked.get("details") or ""), "</details>")
    leaked = {**leaked_from_details, **leaked}
    if leaked:
        warnings.append("recovered arguments that arrived inside another argument: " + ", ".join(sorted(leaked)))
        files = files or leaked.get("files")  # type: ignore[assignment]
        decisions = decisions or leaked.get("decisions")  # type: ignore[assignment]
        open_threads = open_threads or leaked.get("open_threads")  # type: ignore[assignment]
        supersedes = supersedes or leaked.get("supersedes")  # type: ignore[assignment]
        resolves = resolves or leaked.get("resolves")  # type: ignore[assignment]
        corrects = corrects or leaked.get("corrects")  # type: ignore[assignment]

    full_summary = " ".join(clean(summary, 20000).split())
    summary = full_summary[:500]
    details = clean(details or "", 12000)
    if len(full_summary) > 500:
        details = (full_summary[500:] + ("\n\n" + details if details else ""))[:12000]
        warnings.append("summary was over 500 characters; the rest moved to the head of details")
    if str(agent).strip() in ("", "agent") and leaked.get("agent"):
        agent = str(leaked["agent"])
    agent = re.sub(r"[^\w .:/-]", "", str(agent).strip())[:80] or "agent"
    if not session:
        return {"ok": False, "error": "session_id is required"}
    if len(summary) < 8:
        return {"ok": False, "error": "summary must name what actually changed"}
    if len(details) < 20:
        warnings.append("details are short; the next agent needs the verified context")

    normalized_files = [str(value).strip()[:1000] for value in (files or []) if str(value).strip()][:80]
    normalized_decisions = [clean(value, 2000) for value in (decisions or []) if str(value).strip()][:30]
    normalized_threads = [clean(value, 2000) for value in (open_threads or []) if str(value).strip()][:30]
    digest = hashlib.sha256(
        json.dumps([session, summary, details, normalized_files], ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    thread_ids = [f"{digest}#{index}" for index in range(len(normalized_threads))]
    known = memory_records(include_superseded=True)
    existing = next((record for record in known if record.get("id") == digest), None)
    if existing:
        stored = [f"{digest}#{index}" for index in range(len(existing.get("open_threads") or []))]
        return {"ok": True, "duplicate": True, "record": existing,
                "thread_ids": stored, "warnings": warnings}
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
    known_by_id = {item["id"]: item for item in known}
    resolved, ignored_resolves = _apply_resolves(list(resolves or []), record, known_by_id)
    requested, ignored_corrects = _request_corrections(list(corrects or []), record)
    daily_path, vault_status = _daily_section(record)
    return {
        "ok": True,
        "record": record,
        "thread_ids": thread_ids,
        "warnings": warnings,
        "redactions": redactions,
        "ignored_supersedes": ignored_supersedes,
        "resolved": resolved,
        "ignored_resolves": ignored_resolves,
        "requested_corrections": requested,
        "ignored_corrects": ignored_corrects,
        "daily_path": str(daily_path) if daily_path else None,
        "vault_status": vault_status,
    }


def _record_cli_args(payload: dict) -> dict:
    """The MCP validates a call's argument types; the shell path does it here. A list field
    given as one string becomes a one-item list, and anything else of the wrong type is dropped."""
    args: dict = {key: "" if payload.get(key) is None else str(payload[key])
                  for key in ("session_id", "summary", "details", "agent") if key in payload}
    args.setdefault("session_id", "")
    args.setdefault("summary", "")
    for key in ("files", "decisions", "open_threads", "supersedes", "resolves"):
        value = payload.get(key)
        if isinstance(value, str):
            args[key] = [value]
        elif isinstance(value, list):
            args[key] = [str(item) for item in value]
    if isinstance(payload.get("corrects"), list):
        args["corrects"] = [item for item in payload["corrects"] if isinstance(item, dict)]
    return args


if __name__ == "__main__":
    import signal
    # The memory gate's fallback for a session in which the MCP tools are not loaded:
    # the same memory_record, fed a JSON object on stdin, printing its JSON result.
    if "--record" in sys.argv[1:]:
        try:
            payload = json.loads(sys.stdin.read() or "null")
        except ValueError as exc:
            print(json.dumps({"ok": False, "error": f"invalid JSON on stdin: {exc}"}))
            sys.exit(1)
        if not isinstance(payload, dict):
            print(json.dumps({"ok": False, "error": "stdin must hold one JSON object with the memory_record fields"}))
            sys.exit(1)
        outcome = memory_record(**_record_cli_args(payload))
        print(json.dumps(outcome, ensure_ascii=False))
        sys.exit(0 if outcome.get("ok") else 1)
    # Session start is the one moment a single process holds the graph and is not yet
    # answering anyone, so it is where the buffer becomes history. Never fatal: a brain
    # that cannot tidy its log must still open.
    try:
        drain_buffer()
    except Exception:  # noqa: BLE001 - startup must survive any log corruption
        pass
    # The stdio loop swallowed SIGINT: 290 of 296 logged shutdowns had to be escalated to
    # SIGTERM. Installed after the drain, so a kill can never cut a line of events.jsonl;
    # records are fsynced appends, so exiting at once loses nothing.
    signal.signal(signal.SIGINT, lambda *_: os._exit(130))
    mcp.run()
