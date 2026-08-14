"""C2B server: merged graph API + live Claude activity fanout. Port 8930.

Activity is persisted to events.jsonl and events buffered by the hook while the server was
down are drained on start, so the brain's memory of what Claude touched survives restarts
and does not depend on anyone watching.

Run: uv run uvicorn server:app --port 8930
"""
import json
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
BRAIN_PATH = ROOT / "data/brain.json"
RUNTIME = Path.home() / ".claude" / "c2b"   # runtime dir, shared with hook + MCP
PENDING_PATH = RUNTIME / "pending.jsonl"
EVENTS_PATH = RUNTIME / "events.jsonl"

app = FastAPI(title="C2B")

brain: dict = {}
nodes_by_id: dict[str, dict] = {}
abs_index: dict[str, str] = {}      # normalized abs path -> node id
suffix_index: dict[str, str] = {}   # last-2-segments -> node id
recent: deque = deque(maxlen=2000)  # must match the MCP's disk-fallback window
clients: set[WebSocket] = set()


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
        print(f"[c2b] BRAIN NOT LOADED ({exc}) — serving an empty graph; "
              f"run the refresh script then POST /api/reload")
        brain = {"nodes": [], "links": [], "generatedAt": None}
    nodes_by_id.clear()
    abs_index.clear()
    suffix_index.clear()
    for n in brain["nodes"]:
        nodes_by_id[n["id"]] = n
        a = n.get("abs")
        if a:
            abs_index[a] = n["id"]
            parts = a.split("/")
            suffix_index.setdefault("/".join(parts[-2:]), n["id"])


def match_path(path: str) -> tuple[str, bool]:
    """Return (node_id, matched). Unmatched paths become ephemeral ids."""
    p = norm(path)
    nid = abs_index.get(p)
    if not nid:
        parts = p.split("/")
        nid = suffix_index.get("/".join(parts[-2:]))
    if nid:
        return nid, True
    # ephemeral: group by containing directory name
    parts = [x for x in p.split("/") if x]
    project = parts[-2] if len(parts) >= 2 else "misc"
    return f"ephemeral:{project}:{parts[-1]}", False


def build_events(body: dict) -> list[dict]:
    ts = body.get("ts") or time.time()
    out = []
    for path in body.get("paths") or []:
        nid, matched = match_path(str(path))
        node = nodes_by_id.get(nid) if matched else None
        out.append({
            "ts": ts,
            "tool": body.get("tool", ""),
            "cwd": norm(str(body.get("cwd", ""))),
            "session": body.get("session", ""),
            "path": norm(str(path)),
            "node_id": nid,
            "matched": matched,
            "layer": node["layer"] if node else "ephemeral",
            "label": node["label"] if node else norm(str(path)).split("/")[-1],
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
        print(f"[c2b] could not persist events: {exc}")
        return False


def event_key(ev: dict) -> tuple:
    return (round(float(ev.get("ts", 0)), 3), ev.get("session", ""), ev.get("path", ""))


def drain_pending() -> int:
    """Ingest whatever the hook buffered while the server was down.

    Renames the buffer first: appends racing the drain would otherwise land in a file the
    unlink already destroyed (confirmed on Windows — both sides report success).
    """
    if not PENDING_PATH.exists():
        return 0
    staged = PENDING_PATH.with_suffix(".draining")
    try:
        if staged.exists():  # a previous drain died mid-flight; fold it back in
            with staged.open("a", encoding="utf-8") as dst:
                dst.write(PENDING_PATH.read_text(encoding="utf-8"))
            PENDING_PATH.unlink(missing_ok=True)
        else:
            PENDING_PATH.replace(staged)  # atomic; hooks immediately get a fresh pending
    except OSError as exc:
        print(f"[c2b] could not stage pending buffer: {exc}")
        return 0

    drained, bad = [], 0
    try:
        lines = staged.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        print(f"[c2b] could not read staged buffer: {exc}")
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
    fresh = [e for e in drained if event_key(e) not in known]
    dupes = len(drained) - len(fresh)
    if fresh:
        fresh.sort(key=lambda e: e["ts"])
        recent.extend(fresh)
        if not persist(fresh):
            return 0  # keep `staged` on disk — next start retries instead of losing it
    staged.unlink(missing_ok=True)
    print(f"[c2b] drained {len(fresh)} buffered events"
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
        print(f"[c2b] trimmed events.jsonl to the last {keep} events")
    except (OSError, ValueError) as exc:
        print(f"[c2b] could not trim events.jsonl: {exc}")


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
        print(f"[c2b] could not read events.jsonl: {exc}")
        return
    for line in lines:
        try:
            recent.append(json.loads(line))
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
def recent_events():
    return list(recent)


@app.post("/api/events")
async def post_event(body: dict, response: Response):
    events = build_events(body)
    if not events:
        return {"ok": True, "events": 0}
    recent.extend(events)
    if not persist(events):
        # 200 here would tell the hook "stored" and the event would die with the process.
        # A non-2xx makes the hook buffer it instead.
        response.status_code = 500
        return {"ok": False, "error": "persist failed", "events": len(events)}
    if clients:
        msg = json.dumps(events)
        dead = []
        for ws in clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)
    return {"ok": True, "events": len(events)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive pings from client; content ignored
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


dist = ROOT / "frontend/dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="static")
