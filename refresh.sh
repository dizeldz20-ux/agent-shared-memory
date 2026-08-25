#!/usr/bin/env bash
# ASM refresh (POSIX port of refresh.ps1 — macOS/Linux): re-extract code graphs, rebuild the
# vault's okf bundle, re-merge brain.json, redeploy the runtime copies, hot-reload a running
# server. Reads the same sources.json merge.py does, so the project list lives in one place.
set -euo pipefail

ASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${ASM_HOME:-$HOME/.asm}"
HOOKS="$RUNTIME/hooks"

# uv and graphify install outside the default PATH (~/.local/bin, and on macOS the per-version
# user-site bin under ~/Library/Python). Prepend rather than depend on the user's shell profile:
# this script is also fired from schedulers, and launchd/cron give a job almost no PATH at all.
for d in "$HOME/Library/Python"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH="$HOME/.local/bin:$PATH"

VAULT="$(python3 -c 'import json,os,sys; c=json.load(open(sys.argv[1])); v=c.get("vault"); print(os.path.abspath(os.path.join(os.path.dirname(sys.argv[1]), v)) if v else "")' "$ASM/sources.json")"

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
while IFS=$'\t' read -r raw base; do
  echo "-- $raw"
  # A source whose tree is gone (a deleted worktree, a repo moved) must not abort the run:
  # under `set -e` that kills the pipeline BEFORE the merge, so brain.json silently stops
  # tracking every OTHER source too. Skip it loudly and keep its last extract in data/raw.
  if [ ! -d "$base" ]; then
    echo "   !! base not found: $base — skipping (data/raw/$raw keeps its last extract, now STALE)" >&2
    continue
  fi
  if ! graphify extract "$base" --code-only --out "$ASM/data/raw/$raw"; then
    echo "   !! extraction failed: $base — merge will retain a previous extract or mark this source empty" >&2
  fi
done < <(python3 "$ASM/source_manifest.py" "$ASM/sources.json" --tsv)

echo "== merge -> brain.json =="
cd "$ASM"
uv run python merge.py

echo "== deploy runtime copies =="
mkdir -p "$RUNTIME" "$HOOKS"
# brain.json goes out atomically: a plain copy truncates in place, and a session starting
# inside that window gets an MCP server that cannot parse it and fails to boot.
for f in brain.json brain.index.json; do
  cp "$ASM/data/$f" "$RUNTIME/$f.tmp"
  mv -f "$RUNTIME/$f.tmp" "$RUNTIME/$f"
done
cp -f "$ASM/mcp_server.py" "$RUNTIME/"
cp -f "$ASM/pyproject.toml" "$RUNTIME/" 2>/dev/null || true
cp -f "$ASM/hook/asm-activity-hook.js" "$ASM/hook/asm-session-start.js" \
      "$ASM/hook/asm-prompt-recall.js" "$ASM/hook/asm-memory-gate.js" "$HOOKS/"

# Publish one cross-agent copy for Codex, Cursor, Kimi Code, and Grok Build, plus
# Claude Code's client-specific compatibility copy. Avoid a duplicate under
# ~/.codex/skills because Codex also scans ~/.agents/skills.
for skill_root in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  mkdir -p "$skill_root/agent-shared-memory"
  cp -f "$ASM/skills/agent-shared-memory/SKILL.md" "$skill_root/agent-shared-memory/SKILL.md"
done

# Older ASM refreshes also wrote the same managed file under ~/.codex/skills, which
# makes clients that scan both roots expose the protocol twice. Remove only a
# byte-identical managed copy; preserve the directory if the user changed or extended it.
legacy_codex_skill="$HOME/.codex/skills/agent-shared-memory"
if [ -f "$legacy_codex_skill/SKILL.md" ] && \
   cmp -s "$ASM/skills/agent-shared-memory/SKILL.md" "$legacy_codex_skill/SKILL.md"; then
  rm -f "$legacy_codex_skill/SKILL.md"
  rmdir "$legacy_codex_skill" 2>/dev/null || true
fi

# graph-mission has a Codex-native variant because Codex uses different planning,
# collaboration, skill-routing and lineage surfaces than Claude Code. Current Codex
# discovers user-authored skills from ~/.agents/skills. Do not duplicate it under
# ~/.codex/skills: clients that scan both roots expose two selectors with the same name.
mkdir -p "$HOME/.agents/skills/graph-mission"
cp -R "$ASM/skills/codex/graph-mission/." "$HOME/.agents/skills/graph-mission/"

# The deployed hooks live in ~/.asm/hooks and cannot see sources.json, so publish the
# resolved paths next to the runtime graph. Without this the documentation gate has no vault
# to point at and stays silent — see the memory-gate note in the README.
python3 - "$RUNTIME/asm-paths.json" "$VAULT" "$ASM" <<'PY'
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
