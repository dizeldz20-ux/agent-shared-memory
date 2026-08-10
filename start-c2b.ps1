# Start the C2B server (graph API + live WS + UI) on http://localhost:8930
$C2B = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $C2B
uv run uvicorn server:app --port 8930 --host 127.0.0.1
