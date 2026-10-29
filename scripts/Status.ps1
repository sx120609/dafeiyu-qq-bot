$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
& wsl -d Ubuntu -- systemctl --user is-active dafeiyu-bot.service dafeiyu-codex.service
& wsl -d Ubuntu -u root -- docker inspect --format '{{.State.Status}}' qq-ai
if(Test-Path "$workspace/.runtime/status.json"){ Get-Content -Raw "$workspace/.runtime/status.json" }
# curl with --noproxy: Windows PowerShell 5.1 would send loopback requests through the system proxy.
$health=& curl.exe -s --noproxy '*' --max-time 5 'http://127.0.0.1:18191/healthz'
if($LASTEXITCODE -eq 0 -and $health){$health}else{Write-Output 'Model gateway unreachable'}
