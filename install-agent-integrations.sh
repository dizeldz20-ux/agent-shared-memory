#!/usr/bin/env bash
# Configure local coding agents to use the same ASM runtime. Native lifecycle hooks are
# merged where the client exposes them; every client receives the same stdio MCP contract.
set -euo pipefail

ASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${ASM_HOME:-$HOME/.asm}"
CONFIG_HOME="${ASM_CONFIG_HOME:-$HOME}"
UV_BIN="$(command -v uv || true)"

if [ -z "$UV_BIN" ]; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ and run this installer again." >&2
  exit 1
fi

# Preserve the recoverable parts of the legacy runtime on the first migration. The old
# directory is intentionally left in place as a rollback/audit source.
mkdir -p "$RUNTIME"
LEGACY="${ASM_LEGACY_HOME:-$HOME/.claude/c2b}"
if [ -d "$LEGACY" ]; then
  for file in events.jsonl pending.jsonl memory.jsonl; do
    if [ -f "$LEGACY/$file" ] && [ ! -e "$RUNTIME/$file" ]; then
      cp "$LEGACY/$file" "$RUNTIME/$file"
    fi
  done
fi

if [ "${ASM_SKIP_REFRESH:-0}" != "1" ]; then
  "$ASM/refresh.sh"
fi

if [ -d "$CONFIG_HOME/.kimi" ]; then
  python3 "$ASM/tools/configure_agent_integrations.py" \
    --home "$CONFIG_HOME" \
    --runtime "$RUNTIME" \
    --uv "$UV_BIN" \
    --include-legacy-kimi
else
  python3 "$ASM/tools/configure_agent_integrations.py" \
    --home "$CONFIG_HOME" \
    --runtime "$RUNTIME" \
    --uv "$UV_BIN"
fi

if [ "${ASM_SKIP_CLIENT_CLI:-0}" != "1" ]; then
  if command -v codex >/dev/null 2>&1; then
    # `codex mcp add` is an upsert. Install the replacement first so a failed
    # command cannot remove the last working ASM registration; retire the known
    # legacy name only after the upsert succeeds.
    codex mcp add asm -- "$UV_BIN" run --directory "$RUNTIME" python mcp_server.py
    codex mcp remove c2b >/dev/null 2>&1 || true
  fi

  # Claude's user MCP registry is merged atomically by the Python configurator.
  # Avoid the CLI's remove-then-add window entirely.

  if command -v grok >/dev/null 2>&1; then
    # `grok mcp add` is an upsert, so the current working registration stays intact
    # until Grok has parsed the replacement successfully.
    grok mcp add --scope user asm -- "$UV_BIN" run --directory "$RUNTIME" python mcp_server.py
  fi
fi

echo "ASM is configured for Claude Code, Codex, Gemini CLI, Cursor, Kimi Code, Grok Build (when installed), and generic stdio MCP clients."
echo "Restart open agent sessions. In clients with hook trust controls, review and trust the local ASM hooks once."
