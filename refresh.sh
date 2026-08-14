#!/usr/bin/env bash
# C2B refresh (POSIX port of refresh.ps1 — macOS/Linux): re-extract code graphs, rebuild the
# vault's okf bundle, re-merge brain.json, redeploy the runtime copies, hot-reload a running
# server. Reads the same sources.json merge.py does, so the project list lives in one place.
set -euo pipefail

C2B="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$HOME/.claude/c2b"
HOOKS="$HOME/.claude/hooks"

# uv and graphify install outside the default PATH (~/.local/bin, and on macOS the per-version
# user-site bin under ~/Library/Python). Prepend rather than depend on the user's shell profile:
# this script is also fired from schedulers, and launchd/cron give a job almost no PATH at all.
for d in "$HOME/Library/Python"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH="$HOME/.local/bin:$PATH"

VAULT="$(python3 -c 'import json,os,sys; c=json.load(open(sys.argv[1])); v=c.get("vault"); print(os.path.abspath(os.path.join(os.path.dirname(sys.argv[1]), v)) if v else "")' "$C2B/sources.json")"

# Two generators write the same three files (okf/index.md, catalog.json, graph.json) and the
# last one to run wins. okf/okf-build.mjs is the canonical one — it also maintains the split
# index under okf/index/, the okf-fields.json restore snapshot and the health block that
# tools/build_okf.py does not emit. The Python one is the fallback for when node is missing:
# documenting a session must never depend on a toolchain being healthy.
if [ -n "$VAULT" ] && [ -f "$VAULT/okf/okf-build.mjs" ] && command -v node >/dev/null 2>&1; then
  echo "== rebuild okf bundle from the vault (okf-build.mjs) =="
  ( cd "$VAULT" && node okf/okf-build.mjs )
elif [ -n "$VAULT" ] && [ -f "$VAULT/tools/build_okf.py" ]; then
  echo "== rebuild okf bundle from the vault (build_okf.py fallback) =="
  ( cd "$VAULT" && python3 tools/build_okf.py )
fi

echo "== graphify extract (code-only, local AST) =="
python3 - "$C2B/sources.json" <<'PY' | while IFS=$'\t' read -r raw base; do
import json, os, sys
cfg = json.load(open(sys.argv[1]))
root = os.path.dirname(os.path.abspath(sys.argv[1]))
for s in cfg["sources"]:
    base = s["base"]
    if not os.path.isabs(base):
        base = os.path.abspath(os.path.join(root, base))
    print(f"{s['raw']}\t{base}")
PY
  echo "-- $raw"
  graphify extract "$base" --code-only --out "$C2B/data/raw/$raw"
done

echo "== merge -> brain.json =="
cd "$C2B"
uv run python merge.py

echo "== deploy runtime copies =="
mkdir -p "$RUNTIME" "$HOOKS"
# brain.json goes out atomically: a plain copy truncates in place, and a session starting
# inside that window gets an MCP server that cannot parse it and fails to boot.
for f in brain.json brain.index.json; do
  cp "$C2B/data/$f" "$RUNTIME/$f.tmp"
  mv -f "$RUNTIME/$f.tmp" "$RUNTIME/$f"
done
cp -f "$C2B/mcp_server.py" "$RUNTIME/"
cp -f "$C2B/pyproject.toml" "$RUNTIME/" 2>/dev/null || true
cp -f "$C2B/hook/c2b-hook.js" "$C2B/hook/c2b-session-start.js" \
      "$C2B/hook/c2b-prompt-hook.js" "$C2B/hook/c2b-session-doc.js" "$HOOKS/"

# The deployed hooks live in ~/.claude/hooks and cannot see sources.json, so publish the
# resolved paths next to the runtime graph. Without this the documentation gate has no vault
# to point at and stays silent — see the session-doc note in the README.
python3 - "$RUNTIME/c2b-paths.json" "$VAULT" "$C2B" <<'PY'
import json, sys
json.dump({"vault": sys.argv[2], "repo": sys.argv[3]}, open(sys.argv[1], "w"), indent=2)
PY

# Reload distinction preserved from the PowerShell original: a CONNECTION failure means the
# server is not running (fine). An HTTP error means the running server rejected the new graph
# and is still serving the old one (not fine) — those must not both read as "reload failed".
if code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://127.0.0.1:8930/api/reload 2>/dev/null)"; then
  echo "server reloaded (HTTP $code)"
else
  rc=$?
  if [ "$rc" = 7 ] || [ "$rc" = 28 ]; then
    echo "server not running - skipped reload"
  else
    echo "RELOAD FAILED - server is up but rejected the new graph (curl exit $rc); it is still serving the OLD graph"
  fi
fi
echo "done."
