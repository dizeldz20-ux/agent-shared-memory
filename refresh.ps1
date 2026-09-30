# ASM refresh on Windows: re-extract the code graphs, rebuild the vault's okf bundle, merge
# brain.json, deploy the runtime copies, hot-reload a running server.
#   .\refresh.ps1 [--changed] [--brain-only]
# The refresh itself is TypeScript (jobs\src\refresh), one implementation for every platform;
# this wrapper builds jobs\ and hands it the arguments. Where running scripts is disabled:
#   npm --prefix jobs run asm:refresh -- --changed
$ErrorActionPreference = 'Stop'
$jobs = Join-Path $PSScriptRoot 'jobs'
$lock = Join-Path $jobs 'package-lock.json'
$installed = Join-Path $jobs 'node_modules\.asm-installed-lock'
# Modules follow the lock: after a pull that adds a dependency the build needs them first.
if (-not (Test-Path $installed) -or (Get-FileHash $lock).Hash -ne (Get-FileHash $installed).Hash) {
  npm --prefix $jobs ci --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Copy-Item $lock $installed -Force
}
$cli = Join-Path $jobs 'dist\refresh\cli.js'
npm --prefix $jobs run build --silent
if ($LASTEXITCODE -ne 0) {
  # --brain-only deploys no code, so the refresh built last can still rebuild the graph.
  if (($args -notcontains '--brain-only') -or -not (Test-Path $cli)) { exit $LASTEXITCODE }
  Write-Warning 'jobs build failed - running the refresh built last (--brain-only deploys no code)'
}
node $cli @args
exit $LASTEXITCODE
