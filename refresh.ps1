# C2B refresh: re-extract code graphs, re-merge brain.json, redeploy runtime copies.
# Reads the same sources.json that merge.py uses, so the project list lives in one place.
# Schedule it (nightly task / Stop hook wrapper) or run manually after structural changes.
$ErrorActionPreference = 'Stop'
$C2B = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $env:USERPROFILE '.claude\c2b'
$hooks = Join-Path $env:USERPROFILE '.claude\hooks'

$cfg = Get-Content (Join-Path $C2B 'sources.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host "== graphify extract (code-only, local AST) =="
foreach ($s in $cfg.sources) {
  $base = if ([System.IO.Path]::IsPathRooted($s.base)) { $s.base } else { Join-Path $C2B $s.base }
  graphify extract $base --code-only --out (Join-Path $C2B "data\raw\$($s.raw)")
}

Write-Host "== merge -> brain.json =="
Set-Location $C2B
uv run python merge.py

Write-Host "== deploy runtime copies =="
New-Item -ItemType Directory -Force $runtime | Out-Null
New-Item -ItemType Directory -Force $hooks | Out-Null
# brain.json goes out atomically: Copy-Item -Force truncates in place, and a session
# starting inside that window gets an MCP server that cannot parse it and fails to boot.
Copy-Item "$C2B\data\brain.json" "$runtime\brain.json.tmp" -Force
Move-Item "$runtime\brain.json.tmp" "$runtime\brain.json" -Force
Copy-Item "$C2B\data\brain.index.json" "$runtime\brain.index.json.tmp" -Force
Move-Item "$runtime\brain.index.json.tmp" "$runtime\brain.index.json" -Force
Copy-Item "$C2B\mcp_server.py" $runtime -Force
Copy-Item "$C2B\hook\c2b-hook.js","$C2B\hook\c2b-session-start.js","$C2B\hook\c2b-prompt-hook.js" $hooks -Force

try {
  Invoke-RestMethod -Method Post http://127.0.0.1:8930/api/reload -TimeoutSec 5 | Out-Null
  Write-Host "server reloaded"
} catch [System.Net.WebException], [System.Net.Http.HttpRequestException] {
  # Only a connection failure means "not running". An HTTP error means the running server
  # rejected the new graph and is still serving the old one - that must not read as fine.
  if ($_.Exception.Response) { Write-Host "RELOAD FAILED - server is up but rejected the new graph: $($_.Exception.Message)" }
  else { Write-Host "server not running - skipped reload" }
} catch {
  Write-Host "RELOAD FAILED: $($_.Exception.Message)"
}
Write-Host "done."
