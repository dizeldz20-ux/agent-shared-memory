#!/usr/bin/env bash
# Start the ASM server (graph API + shared memory + UI) on http://localhost:8930
# Optional: the MCP reads brain.json from disk and works with this down.
set -euo pipefail
for d in "$HOME/Library/Python"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH="$HOME/.local/bin:$PATH"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uv run python -m uvicorn server:app --port 8930 --host 127.0.0.1
