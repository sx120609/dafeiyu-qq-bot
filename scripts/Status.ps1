$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $workspace '.runtime'
foreach($name in 'host.pid','engine.pid','snowluma.pid'){
    $file=Join-Path $runtime $name
    $state='not running'
    if(Test-Path $file){$process=Get-Process -Id ([int](Get-Content -Raw $file)) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node';if($process){$state="running (pid $($process.Id), $([int]($process.WorkingSet64/1MB)) MB)"}}
    Write-Output "$($name.Replace('.pid','')): $state"
}
if(Test-Path "$runtime/status.json"){ Get-Content -Raw "$runtime/status.json" }
# curl with --noproxy: Windows PowerShell 5.1 would send loopback requests through the system proxy.
$health=& curl.exe -s --noproxy '*' --max-time 5 'http://127.0.0.1:18191/healthz'
if($LASTEXITCODE -eq 0 -and $health){$health}else{Write-Output 'Model gateway unreachable'}
