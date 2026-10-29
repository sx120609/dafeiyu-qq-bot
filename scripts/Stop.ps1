$ErrorActionPreference='Stop'
& wsl -d Ubuntu -- systemctl --user stop dafeiyu-bot.service dafeiyu-codex.service
& wsl -d Ubuntu -u root -- docker stop qq-ai | Out-Null
$workspace=Split-Path -Parent $PSScriptRoot
$keepaliveFile=Join-Path $workspace '.runtime/wsl-keepalive.json'
if(Test-Path $keepaliveFile){
    $record=Get-Content -Raw $keepaliveFile | ConvertFrom-Json
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if($process.Name -eq 'wsl.exe' -and $process.CommandLine -like '*bot-gpt-ds-codex-qq/scripts/keepalive.sh*'){Stop-Process -Id $process.ProcessId}
}
Write-Output 'Dafeiyu engine, Codex adapter and QQ runtime stopped.'
