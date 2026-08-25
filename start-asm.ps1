# Start the ASM server (graph API + shared memory + UI) on http://localhost:8930
$ASM = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ASM
uv run python -m uvicorn server:app --port 8930 --host 127.0.0.1
