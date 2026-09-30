# ASM on Windows — implementation plan

**Goal:** a person on Windows can install ASM, refresh the brain, and get the MCP tools, the hooks and the daily jobs working, from the same code that runs on macOS and Linux.

**Architecture:** the refresh and the installer move from bash (and a stale PowerShell copy) into one TypeScript implementation inside `jobs/`. `refresh.sh`, `refresh.ps1` and `install-agent-integrations.sh` shrink to wrappers that build `jobs/` and hand their arguments to Node; on Windows the entry points are `npm --prefix jobs run asm:install` and `npm --prefix jobs run asm:refresh`, which need no execution-policy change. Every process ASM starts goes through one resolver that runs `.exe` files directly and decodes npm `.cmd` shims into `node <script>`, so no shell ever parses an argument.

**Tech stack:** Node 22+ (ESM, TypeScript 5.8 strict, NodeNext), Vitest, zod; Python 3.11+ through `uv` for `merge.py`, `source_manifest.py` and the configurator, which stay Python.

## Global constraints

- New code is TypeScript; existing Python stays Python (no retroactive conversion).
- One implementation per behavior: after this plan no refresh or install logic lives in bash or PowerShell.
- No process is started through a shell; arguments are never re-quoted.
- The repo is public: tests and docs use neutral names and paths (`/Users/x`, `C:\Users\x`).
- Tests run niced with `--maxWorkers=2`, one run at a time.

## Why the old code fails on Windows

| # | Where | What happens on Windows |
|---|-------|-------------------------|
| G1 | `refresh.ps1` | Last changed with the first public release. It never deploys `brain.pages.json`, `lifecycle.py`, `asm_text.py`, two hooks, the jobs or the review skill, so the deployed MCP fails to import its own modules. |
| G2 | `install-agent-integrations.sh` | Bash only; Windows has no installer. |
| G3 | `hook/asm-session-start.js` | Spawns `nice`, which does not exist: the daily jobs never start, and the unhandled spawn error can fail the hook. `detached` without `windowsHide` flashes a console window. |
| G4 | `jobs/src/runner/refresh-job.ts` | Spawns `bash refresh.sh`; on Windows `bash` is missing or is the WSL launcher. |
| G5 | `jobs/src/model/claude-runner.ts` | Spawns `claude`; an npm install is `claude.cmd`, which Node cannot spawn without a shell. |
| G6 | `hook/asm-activity-hook.js` | The temp-tree filter knows only macOS temp paths, so Windows temp files are logged as project activity. |
| G7 | `jobs/src/apply/files.ts` | `move()` falls back from a hard link only on `EXDEV`; volumes without hard links report `EPERM` or `ENOTSUP` and the move fails. |
| G8 | tests | Several Python and Vitest tests drive `/bin/sh` fakes or `bash`. |
| G9 | repo | No `.gitattributes`: a clone with `core.autocrlf=true` checks the shell scripts out with CRLF. |
| G10 | repo | No CI, so nothing ever ran on Windows. |

## Tasks

Each task is test-first: the test is written, seen failing, then the code makes it pass.

1. **Command resolver** — `jobs/src/platform/command-resolver.ts`. `resolveCommand(name, options)` returns `{ file, args }`. POSIX: unchanged name. Win32: search `PATH` × `PATHEXT`; `.exe`/`.com` run directly; a `.cmd`/`.bat` npm shim is decoded to `node <script>` (the last `%dp0%` or `%~dp0` script path in the shim); `npm` prefers `node_modules/npm/bin/npm-cli.js` next to `node.exe`; a `.js`/`.mjs`/`.cjs` path runs with the current Node on every platform; anything else is `CommandUnavailableError`. Tests: each branch with fixture shims (the npm cmd-shim layout and the Node distribution's `npm.cmd` layout).
2. **Process runner** — `jobs/src/platform/process-runner.ts`: spawn through the resolver, `windowsHide`, no shell, line callback, exit code. Tests with real `node` children.
3. **Claude runner** (G5) uses the resolver; its tests drive a Node fake instead of `/bin/sh`.
4. **SessionStart launch** (G3): spawn the current Node directly with `windowsHide`, lower the child with `os.setPriority`, swallow spawn errors. The existing launch test also asserts the lowered priority.
5. **Activity temp tree** (G6): also drop paths under `os.tmpdir()`.
6. **Move fallback** (G7): exclusive copy on `EPERM`, `ENOTSUP`, `ENOSYS` as well as `EXDEV`.
7. **Refresh core** — `jobs/src/refresh/`: okf rebuild, graphify extraction with the `--changed` freshness rule, merge, atomic brain deploy with `brain.json` last, `asm-paths.json`, reload. Brain-only deploys nothing else.
8. **Refresh deploy** — runtime code, hooks, jobs `dist/` mirrored (extra files removed), production `npm ci` when the lock changed, skill-map seed only when missing, skill map rebuild, skills to both skill roots, the byte-identical legacy Codex skill retired, the Codex graph-mission copied.
9. **Refresh CLI and wrappers** — `jobs/src/refresh/cli.ts`; `asm:refresh` and `asm:install` npm scripts with a build pre-step; `refresh.sh` and `refresh.ps1` become wrappers.
10. **Daily refresh job** (G4) calls the refresh in process: brain-only, changed-only.
11. **Equivalence** — run the old `refresh.sh` (full and `--brain-only`) and the new refresh on identical sandboxes with fake `uv`/`graphify`; compare every deployed file by sha256. Every difference is either fixed or recorded as an intended change.
12. **Installer** — `jobs/src/install/`: legacy runtime import, refresh (unless `ASM_SKIP_REFRESH=1`), the Python configurator through `uv`, Codex and Grok registration with the upsert before the legacy removal (unless `ASM_SKIP_CLIENT_CLI=1`). `install-agent-integrations.sh` becomes a wrapper. The two bash installer tests move to Vitest.
13. **Portability of the Python tests** (G8): tests that need `bash` find it with `shutil.which` and skip without it; the refresh and installer tests that drove bash move to Vitest (tasks 9 and 12).
14. **Repo hygiene** (G9, G10): `.gitattributes`; a GitHub Actions matrix (Ubuntu, macOS, Windows) running the Python suite, typecheck, Vitest, and an install smoke test on a throwaway home; a Windows quick start in the README.

## Verification

- Full Python suite and Vitest on macOS, run alone.
- The install smoke test on a throwaway home on macOS: install, refresh, MCP `initialize` and `brain_search`, the SessionStart hook command run as configured.
- The same suite and smoke test on the Windows CI runner.

## Review focus

- A path with spaces or non-ASCII characters (a Windows user folder, a Hebrew folder name) through the resolver, the refresh and the hook commands.
- `PATHEXT` casing and a `PATH` entry that is empty or quoted.
- A brain-only refresh never deploys code, and a failed extraction never blocks the merge.
- The jobs mirror removes stale files from `dist/` but never touches the jobs state (`config.json`, `trust.json`, `proposals/`, `logs/`).
- A missing tool (`uv`, `graphify`, `claude`) fails loudly with its name.
