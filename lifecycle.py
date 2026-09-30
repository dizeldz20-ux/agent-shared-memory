"""The ASM lifecycle ledger: an append-only log of what happened to memory after it was written.

memory.jsonl is the raw tier and is never edited. That a record's open thread was answered, a
plan page shipped, a stale status record was overtaken, or a memory file was corrected is an
*operation* appended here — with its reason, its evidence and who did it — so every curation
step can be read back and undone. The MCP server, the hooks (hook/asm-lifecycle.js) and the
background jobs (jobs/src/ledger/fold.ts) fold this same file the same way;
tests/fixtures/lifecycle.json runs against all three.

Stdlib only: the runtime is deployed as loose files next to mcp_server.py.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

OPS = {"close_thread", "mark_done", "retire", "restore", "correct", "compact"}
KINDS = {"thread", "record", "page", "memory_file", "index_line"}
# The three operations that change what recall shows, and the state each one sets.
VISIBILITY = {"close_thread": "closed", "mark_done": "done", "retire": "retired"}
HIDDEN = {"closed", "retired"}  # `done` stays visible, marked as finished


def canonical(op: dict) -> str:
    """The one serialization an operation id is hashed from: sorted keys at every level,
    no spaces, non-ASCII kept. The TypeScript store produces the same bytes."""
    return json.dumps(op, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def op_id(op: dict) -> str:
    body = {key: value for key, value in op.items() if key != "id"}
    return "lc_" + hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()[:16]


def target_key(target: dict) -> str:
    return f"{target.get('kind')}:{target.get('id')}"


def _text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate(op: dict) -> list[str]:
    """Names of the fields that make `op` invalid; an empty list means valid. A field of the
    wrong type is invalid here exactly as in the JavaScript and TypeScript readers."""
    errors: list[str] = []
    if not isinstance(op.get("op"), str) or op["op"] not in OPS:
        errors.append("op")
    target = op.get("target")
    if not isinstance(target, dict) or not isinstance(target.get("kind"), str) or target["kind"] not in KINDS \
            or not _text(target.get("id")):
        errors.append("target")
    if not _text(op.get("reason")):
        errors.append("reason")
    errors.extend(name for name in ("ts", "undoes", "applies") if name in op and not isinstance(op[name], str))
    if op.get("op") == "restore" and not str(op.get("undoes") or "").startswith("lc_") and "undoes" not in errors:
        errors.append("undoes")
    return errors


def append_op(path: Path, op: dict) -> dict:
    """Validate, stamp and append one operation (O_APPEND + fsync, like memory.jsonl)."""
    op = {key: value for key, value in op.items() if value is not None and key != "id"}
    op.setdefault("ts", datetime.now().astimezone().isoformat(timespec="seconds"))
    errors = validate(op)
    if errors:
        raise ValueError("invalid ledger operation: " + ", ".join(errors))
    op["id"] = op_id(op)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, (json.dumps(op, ensure_ascii=False) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return op


def load_ops(path: Path) -> list[dict]:
    """Every valid operation in file order. A bad line is skipped, never fatal."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    ops: list[dict] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            op = json.loads(line)
        except ValueError:
            continue
        if isinstance(op, dict) and str(op.get("id") or "").startswith("lc_") and not validate(op):
            ops.append(op)
    return ops


@dataclass
class Lifecycle:
    """The folded ledger: the current state of every target an operation touched."""

    states: dict[str, dict] = field(default_factory=dict)
    requested: dict[str, dict] = field(default_factory=dict)

    def state(self, kind: str, ident: str) -> dict | None:
        return self.states.get(f"{kind}:{ident}")

    def hidden(self, kind: str, ident: str) -> bool:
        entry = self.state(kind, ident)
        return bool(entry and entry["state"] in HIDDEN)

    def thread_open(self, record_id: str, index: int) -> bool:
        return not self.hidden("record", record_id) and not self.hidden("thread", f"{record_id}#{index}")

    def open_threads(self, records: list[dict]) -> list[str]:
        return [f"{record['id']}#{index}"
                for record in records if record.get("id")
                for index, _ in enumerate(record.get("open_threads") or [])
                if self.thread_open(record["id"], index)]


def fold(ops: list[dict], records: list[dict] | None = None) -> Lifecycle:
    """Replay the operations in file order.

    A `supersedes` list in memory.jsonl is read first, as an implicit retire, so the older
    mechanism and the ledger agree. `restore` reinstates the state its undone operation
    replaced, and only while that operation is still the one in force — which makes a
    second restore of the same operation a no-op.
    """
    life = Lifecycle()
    for record in records or []:
        for old in record.get("supersedes") or []:
            life.states[f"record:{old}"] = {
                "state": "retired", "op_id": f"supersedes:{record.get('id')}",
                "at": record.get("created_at", ""), "reason": "superseded by a later record",
                "superseded_by": f"memory:{record.get('id')}"}
    before: dict[str, dict | None] = {}
    seen: dict[str, dict] = {}
    for op in ops:
        if op["id"] in seen:
            continue  # a line written twice is one operation
        seen[op["id"]] = op
        kind = op["op"]
        if kind in VISIBILITY:
            key = target_key(op["target"])
            before[op["id"]] = life.states.get(key)
            life.states[key] = {"state": VISIBILITY[kind], "op_id": op["id"], "at": op.get("ts", ""),
                                "reason": op.get("reason", ""), "superseded_by": op.get("superseded_by")}
        elif kind == "restore":
            undone = seen.get(op.get("undoes", ""))
            if not undone or undone["op"] not in VISIBILITY:
                continue
            key = target_key(undone["target"])
            if (life.states.get(key) or {}).get("op_id") != undone["id"]:
                continue  # already restored, or overtaken by a later operation
            previous = before.get(undone["id"])
            if previous is None:
                life.states.pop(key, None)
            else:
                life.states[key] = previous
        elif kind == "correct":
            if op.get("mode") == "requested":
                life.requested[op["id"]] = op
            elif op.get("applies"):
                life.requested.pop(op["applies"], None)
    return life
