"""ASM server: shared graph API, memory records, and agent activity fanout. Port 8930.

Activity is persisted to events.jsonl and events buffered by the hook while the server was
down are drained on start, so the brain's memory of what every agent touched survives restarts
and does not depend on anyone watching.

Run: uv run uvicorn server:app --port 8930
"""
import asyncio
import hashlib
import json
import os
import posixpath
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from codex_activity import CodexRolloutWatcher

ROOT = Path(__file__).resolve().parent
BRAIN_PATH = ROOT / "data/brain.json"
RUNTIME = Path(os.environ.get("ASM_HOME", Path.home() / ".asm")).expanduser()
PENDING_PATH = RUNTIME / "pending.jsonl"
EVENTS_PATH = RUNTIME / "events.jsonl"
MEMORY_PATH = RUNTIME / "memory.jsonl"

app = FastAPI(title="ASM — Agent Shared Memory")

brain: dict = {}
nodes_by_id: dict[str, dict] = {}
abs_index: dict[str, str] = {}           # normalized abs path -> node id
suffix_index: dict[str, set[str]] = {}   # last-2-segments -> every candidate node id
recent: deque = deque(maxlen=2000)  # must match the MCP's disk-fallback window
clients: set[WebSocket] = set()
FUTURE_SKEW_SECONDS = 300
WEBSOCKET_SEND_TIMEOUT_SECONDS = 0.35
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
CODEX_FALLBACK_ENABLED = os.environ.get("ASM_CODEX_ROLLOUT_FALLBACK", "1") not in {"0", "false", "False"}
codex_watcher = CodexRolloutWatcher(CODEX_HOME) if CODEX_FALLBACK_ENABLED else None
codex_watcher_task: asyncio.Task | None = None


def norm(p: str) -> str:
    return p.replace("\\", "/").lower()


def load_brain() -> None:
    """Rebuild the graph indexes. A corrupt brain.json must not stop the server from
    booting — recording activity is the part that cannot be recovered later; the graph
    can be fixed and reloaded with POST /api/reload."""
    global brain
    try:
        brain = json.loads(BRAIN_PATH.read_text(encoding="utf-8"))
        if not isinstance(brain.get("nodes"), list):
            raise ValueError("brain.json has no nodes list")
    except (OSError, ValueError) as exc:
        print(f"[asm] BRAIN NOT LOADED ({exc}) — serving an empty graph; "
              f"run the refresh script then POST /api/reload")
        brain = {"nodes": [], "links": [], "generatedAt": None}
    nodes_by_id.clear()
    abs_index.clear()
    suffix_index.clear()
    for n in brain["nodes"]:
        nodes_by_id[n["id"]] = n
        a = n.get("abs")
        if a:
            normalized = norm(str(a))
            abs_index[normalized] = n["id"]
            parts = [part for part in normalized.split("/") if part]
            if len(parts) >= 2:
                suffix_index.setdefault("/".join(parts[-2:]), set()).add(n["id"])


def match_path(path: str, cwd: str = "") -> tuple[str, bool]:
    """Return (node_id, matched). Unmatched paths become ephemeral ids."""
    p = norm(path)
    nid = abs_index.get(p)
    if not nid:
        parts = [part for part in p.split("/") if part]
        candidates = suffix_index.get("/".join(parts[-2:])) if len(parts) >= 2 else None
        # Container/remote paths may have a different root. A suffix match is
        # safe only when that suffix identifies exactly one mapped file; an
        # arbitrary first match can otherwise light up another repository.
        if candidates and len(candidates) == 1:
            nid = next(iter(candidates))
    if nid:
        return nid, True
    # ephemeral: group by containing directory name
    parts = [x for x in p.split("/") if x]
    cwd_parts = [x for x in norm(cwd).split("/") if x]
    project_root = norm(cwd).rstrip("/")
    project = cwd_parts[-1] if cwd_parts else (parts[-2] if len(parts) >= 2 else "misc")
    lowered_parts = [part.lower() for part in parts]
    if "projects" in lowered_parts:
        project_index = lowered_parts.index("projects") + 1
        if project_index < len(parts):
            project = parts[project_index]
            project_root = "/".join(parts[:project_index + 1])
    project = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in project.lower()).strip("-") or "misc"
    project_digest = hashlib.sha1((project_root or project).encode("utf-8", errors="replace")).hexdigest()[:8]
    basename = parts[-1] if parts else "unknown"
    path_digest = hashlib.sha1(p.encode("utf-8", errors="replace")).hexdigest()[:12]
    return f"ephemeral:{project}-{project_digest}:{basename}:{path_digest}", False


def build_events(body: dict) -> list[dict]:
    now = time.time()
    try:
        ts = float(body.get("ts") or now)
    except (TypeError, ValueError):
        ts = now
    if ts - now > FUTURE_SKEW_SECONDS:
        ts = now
    out = []
    paths = body.get("paths") or []
    if not paths:
        session = str(body.get("session", "unknown"))
        return [{
            "ts": ts,
            "tool": body.get("tool", ""),
            "cwd": norm(str(body.get("cwd", ""))),
            "session": session,
            "agent": body.get("agent", "agent"),
            "path": "",
            "node_id": f"agent:{session}",
            "matched": False,
            "presence": True,
            "layer": "presence",
            "label": body.get("tool", "activity") or "activity",
            "source": body.get("source", "hook"),
            "phase": body.get("phase", "finish"),
            "operation_id": body.get("operation_id", ""),
            "file_access": False,
        }]
    for path in paths:
        event_path = str(path).replace("\\", "/")
        cwd = str(body.get("cwd", "")).replace("\\", "/")
        is_absolute = event_path.startswith("/") or (
            len(event_path) >= 3 and event_path[0].isalpha() and event_path[1:3] == ":/"
        )
        if cwd and not is_absolute:
            event_path = posixpath.normpath(f"{cwd.rstrip('/')}/{event_path}")
        nid, matched = match_path(event_path, cwd)
        node = nodes_by_id.get(nid) if matched else None
        out.append({
            "ts": ts,
            "tool": body.get("tool", ""),
            "cwd": norm(str(body.get("cwd", ""))),
            "session": body.get("session", ""),
            "agent": body.get("agent", "agent"),
            "path": event_path,
            "node_id": nid,
            "matched": matched,
            "presence": False,
            "layer": node["layer"] if node else "ephemeral",
            "label": node["label"] if node else event_path.split("/")[-1],
            "source": body.get("source", "hook"),
            "phase": body.get("phase", "finish"),
            "operation_id": body.get("operation_id", ""),
            "file_access": bool(body.get("file_access", False)),
        })
    return out


def persist(events: list[dict]) -> bool:
    """Append to the durable log. Returns False so the caller can tell the hook to buffer
    instead of silently losing the event behind a 200."""
    try:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with EVENTS_PATH.open("a", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return True
    except OSError as exc:
        print(f"[asm] could not persist events: {exc}")
        return False


def event_key(ev: dict) -> tuple:
    """Identity for replay protection, not for UI coalescing.

    Claude emits PreToolUse and PostToolUse with the same operation id and can emit them
    within the same millisecond.  Phase must therefore be part of the key: otherwise a
    buffered ``finish`` is mistaken for a replay of its persisted ``start`` and the live
    file access never closes.  Source is deliberately omitted so the rollout fallback
    and the native hook can still collapse when they carry the same operation.
    """
    return (
        round(float(ev.get("ts", 0)), 3),
        ev.get("agent", ""),
        ev.get("session", ""),
        ev.get("path", ""),
        ev.get("tool", ""),
        ev.get("phase", "finish"),
        ev.get("operation_id", ""),
    )


def drain_pending() -> int:
    """Ingest whatever the hook buffered while the server was down.

    Renames the buffer first: appends racing the drain would otherwise land in a file the
    unlink already destroyed (confirmed on Windows — both sides report success).
    """
    staged = PENDING_PATH.with_suffix(".draining")
    if not PENDING_PATH.exists() and not staged.exists():
        return 0
    try:
        if staged.exists() and PENDING_PATH.exists():  # fold a fresh buffer into the staged recovery file
            with staged.open("a", encoding="utf-8") as dst:
                dst.write(PENDING_PATH.read_text(encoding="utf-8"))
            PENDING_PATH.unlink(missing_ok=True)
        elif PENDING_PATH.exists():
            PENDING_PATH.replace(staged)  # atomic; hooks immediately get a fresh pending
    except OSError as exc:
        print(f"[asm] could not stage pending buffer: {exc}")
        return 0

    drained, bad = [], 0
    try:
        lines = staged.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        print(f"[asm] could not read staged buffer: {exc}")
        return 0
    for line in lines:
        if not line.strip():
            continue
        try:
            body = json.loads(line)
            if "paths" not in body:
                continue  # a {"dropped": n} marker written by the hook's overflow path
            drained.extend(build_events(body))
        except (json.JSONDecodeError, TypeError, AttributeError):
            bad += 1

    # A hook that aborts after the server already persisted buffers a copy; drop replays.
    known = {event_key(e) for e in recent}
    fresh = []
    for event in drained:
        key = event_key(event)
        if key in known:
            continue
        known.add(key)
        fresh.append(event)
    dupes = len(drained) - len(fresh)
    if fresh:
        fresh.sort(key=lambda e: e["ts"])
        if not persist(fresh):
            return 0  # keep `staged` on disk — next start retries instead of losing it
        recent.extend(fresh)
    staged.unlink(missing_ok=True)
    print(f"[asm] drained {len(fresh)} buffered events"
          + (f", {dupes} duplicate(s) skipped" if dupes else "")
          + (f", {bad} unparsable line(s) dropped" if bad else ""))
    return len(fresh)


def trim_history(keep: int = 20000) -> None:
    """Cap events.jsonl on start. The MCP reads this whole file to slice its tail, so
    unbounded growth would turn every brain_context call into a big read."""
    try:
        if not EVENTS_PATH.exists() or EVENTS_PATH.stat().st_size < 8 * 1024 * 1024:
            return
        lines = EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) <= keep:
            return
        EVENTS_PATH.write_text("\n".join(lines[-keep:]) + "\n", encoding="utf-8")
        print(f"[asm] trimmed events.jsonl to the last {keep} events")
    except (OSError, ValueError) as exc:
        print(f"[asm] could not trim events.jsonl: {exc}")


def load_recent_history() -> None:
    """Seed `recent` from the tail of the persisted log so restarts keep context.

    errors="replace": one bad byte in the log must never stop the server from starting —
    that would turn a cosmetic corruption into permanent, total loss of new activity.
    """
    if not EVENTS_PATH.exists():
        return
    try:
        lines = EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-recent.maxlen:]
    except OSError as exc:
        print(f"[asm] could not read events.jsonl: {exc}")
        return
    for line in lines:
        try:
            event = json.loads(line)
            # Normalize clock mistakes in memory only. The durable log stays append-only,
            # while a single bad future timestamp cannot keep an agent "active" forever.
            if float(event.get("ts", 0)) > time.time() + FUTURE_SKEW_SECONDS:
                event["ts"] = time.time()
            recent.append(event)
        except ValueError:
            pass


load_brain()
trim_history()
load_recent_history()
drain_pending()


@app.get("/api/graph")
def get_graph():
    return brain


@app.post("/api/reload")
def reload_brain():
    load_brain()
    return {"ok": True, "nodes": len(brain["nodes"])}


@app.get("/api/events/recent")
def recent_events(limit: int = 160):
    return list(recent)[-max(1, min(limit, 1000)):]


@app.get("/api/memory/recent")
def recent_memory(limit: int = 30):
    """Newest cross-agent work records. A malformed line never takes the UI down."""
    try:
        lines = MEMORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    records = []
    for line in reversed(lines):
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                records.append(value)
        except ValueError:
            continue
        if len(records) >= max(1, min(limit, 100)):
            break
    return records


@app.post("/api/events")
async def post_event(body: dict, response: Response):
    events = build_events(body)
    if not events:
        return {"ok": True, "events": 0}
    if not await publish_events(events):
        # 200 here would tell the hook "stored" and the event would die with the process.
        # A non-2xx makes the hook buffer it instead.
        response.status_code = 500
        return {"ok": False, "error": "persist failed", "events": len(events)}
    return {"ok": True, "events": len(events)}


async def publish_events(events: list[dict]) -> bool:
    """Persist and fan out one event batch from hooks or the Codex fallback."""
    if not persist(events):
        return False
    recent.extend(events)
    if clients:
        msg = json.dumps(events)
        snapshot = list(clients)

        async def send(ws: WebSocket) -> None:
            try:
                await asyncio.wait_for(
                    ws.send_text(msg), timeout=WEBSOCKET_SEND_TIMEOUT_SECONDS,
                )
            except Exception:
                clients.discard(ws)

        # A suspended browser tab must not delay the activity hook, the Codex
        # rollout watcher, or another live UI. Every client gets the same batch
        # concurrently and a bounded opportunity to accept it.
        await asyncio.gather(*(send(ws) for ws in snapshot))
    return True


async def watch_codex_rollouts() -> None:
    assert codex_watcher is not None
    while True:
        try:
            payloads = await asyncio.to_thread(codex_watcher.poll)
            for payload in payloads:
                await publish_events(build_events(payload))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[asm] Codex rollout fallback error: {exc}")
        await asyncio.sleep(0.12)


@app.on_event("startup")
async def start_codex_watcher() -> None:
    global codex_watcher_task
    if codex_watcher is None:
        return
    await asyncio.to_thread(codex_watcher.prime)
    codex_watcher_task = asyncio.create_task(watch_codex_rollouts())


@app.on_event("shutdown")
async def stop_codex_watcher() -> None:
    global codex_watcher_task
    if codex_watcher_task:
        codex_watcher_task.cancel()
        try:
            await codex_watcher_task
        except asyncio.CancelledError:
            pass
        codex_watcher_task = None


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        # Hydrate a newly opened/reloaded UI before waiting for the next tool call.
        snapshot = list(recent)[-160:]
        if snapshot:
            await ws.send_text(json.dumps(snapshot))
        while True:
            await ws.receive_text()  # keepalive pings from client; content ignored
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


dist = ROOT / "frontend/dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="static")
