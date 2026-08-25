# ASM refresh: re-extract code graphs, re-merge brain.json, redeploy runtime copies.
# Reads the same sources.json that merge.py uses, so the project list lives in one place.
# Schedule it (nightly task / Stop hook wrapper) or run manually after structural changes.
$ErrorActionPreference = 'Stop'
$ASM = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = if ($env:ASM_HOME) { $env:ASM_HOME } else { Join-Path $env:USERPROFILE '.asm' }
$hooks = Join-Path $runtime 'hooks'

$cfg = Get-Content (Join-Path $ASM 'sources.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$vault = if ($cfg.vault) {
  if ([System.IO.Path]::IsPathRooted($cfg.vault)) { $cfg.vault }
  else { [System.IO.Path]::GetFullPath((Join-Path $ASM $cfg.vault)) }
} else { '' }

Write-Host "== graphify extract (code-only, local AST) =="
$expandedSources = python (Join-Path $ASM 'source_manifest.py') (Join-Path $ASM 'sources.json') | ConvertFrom-Json
foreach ($s in $expandedSources) {
  $base = if ([System.IO.Path]::IsPathRooted($s.base)) { $s.base } else { Join-Path $ASM $s.base }
  if (-not (Test-Path $base -PathType Container)) {
    Write-Warning "base not found: $base - skipping; the previous extract remains stale"
    continue
  }
  graphify extract $base --code-only --out (Join-Path $ASM "data\raw\$($s.raw)")
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "extraction failed: $base - merge will retain a previous extract or mark this source empty"
  }
}

Write-Host "== merge -> brain.json =="
Set-Location $ASM
uv run python merge.py

Write-Host "== deploy runtime copies =="
New-Item -ItemType Directory -Force $runtime | Out-Null
New-Item -ItemType Directory -Force $hooks | Out-Null
# brain.json goes out atomically: Copy-Item -Force truncates in place, and a session
# starting inside that window gets an MCP server that cannot parse it and fails to boot.
Copy-Item "$ASM\data\brain.json" "$runtime\brain.json.tmp" -Force
Move-Item "$runtime\brain.json.tmp" "$runtime\brain.json" -Force
Copy-Item "$ASM\data\brain.index.json" "$runtime\brain.index.json.tmp" -Force
Move-Item "$runtime\brain.index.json.tmp" "$runtime\brain.index.json" -Force
Copy-Item "$ASM\mcp_server.py","$ASM\pyproject.toml" $runtime -Force
Copy-Item "$ASM\hook\asm-activity-hook.js","$ASM\hook\asm-session-start.js","$ASM\hook\asm-prompt-recall.js","$ASM\hook\asm-memory-gate.js" $hooks -Force

foreach ($skillRoot in @(
  (Join-Path $env:USERPROFILE '.agents\skills'),
  (Join-Path $env:USERPROFILE '.claude\skills')
)) {
  $skillTarget = Join-Path $skillRoot 'agent-shared-memory'
  New-Item -ItemType Directory -Force $skillTarget | Out-Null
  Copy-Item "$ASM\skills\agent-shared-memory\SKILL.md" $skillTarget -Force
}

# Retire only the byte-identical duplicate written by older ASM refreshes. A user-modified
# Codex-specific copy is left untouched instead of being deleted implicitly.
$legacyCodexSkill = Join-Path $env:USERPROFILE '.codex\skills\agent-shared-memory'
$legacyCodexSkillFile = Join-Path $legacyCodexSkill 'SKILL.md'
$sharedSkillFile = Join-Path $ASM 'skills\agent-shared-memory\SKILL.md'
if ((Test-Path $legacyCodexSkillFile -PathType Leaf) -and
    ((Get-FileHash $legacyCodexSkillFile).Hash -eq (Get-FileHash $sharedSkillFile).Hash)) {
  Remove-Item $legacyCodexSkillFile -Force
  if ((Get-ChildItem $legacyCodexSkill -Force | Measure-Object).Count -eq 0) {
    Remove-Item $legacyCodexSkill -Force
  }
}

$codexGraphMission = Join-Path $env:USERPROFILE '.agents\skills\graph-mission'
New-Item -ItemType Directory -Force $codexGraphMission | Out-Null
Copy-Item "$ASM\skills\codex\graph-mission\*" $codexGraphMission -Recurse -Force

@{ vault = $vault; repo = $ASM } | ConvertTo-Json | Set-Content (Join-Path $runtime 'asm-paths.json') -Encoding UTF8

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
