#!/usr/bin/env bash
# Configure local coding agents to use the same ASM runtime. Native lifecycle hooks are merged
# where the client exposes them; every client receives the same stdio MCP contract.
# The installer itself is TypeScript (jobs/src/install), one implementation for every platform;
# this wrapper builds jobs/ and runs it. Windows: `npm --prefix jobs run asm:install`.
set -euo pipefail

ASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# node may live outside a scheduler's PATH; the installer adds the folders uv and graphify use.
export PATH="$HOME/.local/bin:$PATH"

cd "$ASM/jobs"
# Modules follow the lock: after a pull that adds a dependency the build needs them first.
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.asm-installed-lock; then
  npm ci --no-audit --no-fund --silent
  cp package-lock.json node_modules/.asm-installed-lock
fi
npm run build --silent
exec node dist/install/cli.js "$@"
