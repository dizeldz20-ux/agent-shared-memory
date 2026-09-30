#!/usr/bin/env bash
# ASM refresh on macOS and Linux: re-extract the code graphs, rebuild the vault's okf bundle,
# merge brain.json, deploy the runtime copies, hot-reload a running server.
#   ./refresh.sh            every source
#   ./refresh.sh --changed  only sources with a file newer than their last extract
#   ./refresh.sh --brain-only   the graph files, no code
# The refresh itself is TypeScript (jobs/src/refresh), one implementation for every platform;
# this wrapper builds jobs/ and hands it the arguments. Windows: refresh.ps1, or
# `npm --prefix jobs run asm:refresh -- --changed`.
set -euo pipefail

ASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# node may live outside a scheduler's PATH; the refresh adds the folders uv and graphify use.
export PATH="$HOME/.local/bin:$PATH"

cd "$ASM/jobs"
# Modules follow the lock: after a pull that adds a dependency the build needs them first.
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.asm-installed-lock; then
  npm ci --no-audit --no-fund --silent
  cp package-lock.json node_modules/.asm-installed-lock
fi
if ! npm run build --silent; then
  # A half-edited checkout must not stop the graph: --brain-only deploys no code, so the refresh
  # built last can still rebuild the graph. Anything else stops here, before deploying a thing.
  case " $* " in
    *" --brain-only "*) [ -f dist/refresh/cli.js ] || exit 1
                        echo "   !! jobs build failed — running the refresh built last (--brain-only deploys no code)" >&2 ;;
    *) exit 1 ;;
  esac
fi
exec node dist/refresh/cli.js "$@"
