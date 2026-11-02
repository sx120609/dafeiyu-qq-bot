param([switch]$NoBrowser)
# Starts the bot on Windows without the tray: the gateway (bridge/main.mjs) also runs SnowLuma and the engine.
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $workspace '.runtime'
$config=Get-Content -Raw (Join-Path $runtime 'bridge-windows.json') | ConvertFrom-Json
$node=if($config.node -and (Test-Path $config.node)){$config.node}else{(Get-Command node).Source}
$pidFile=Join-Path $runtime 'host.pid'
$running=$null
if(Test-Path $pidFile){$running=Get-Process -Id ([int](Get-Content -Raw $pidFile)) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node'}
if(-not $running){
    # CreateNoWindow: no console to close by accident; the gateway writes .runtime/logs/gateway.log itself.
    $info=[Diagnostics.ProcessStartInfo]::new($node,"`"$workspace\bridge\main.mjs`"")
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory=$workspace
    $process=[Diagnostics.Process]::Start($info)
    [IO.File]::WriteAllText($pidFile,[string]$process.Id,[Text.UTF8Encoding]::new($false))
}
$ready=$false
for($i=0;$i -lt 60;$i++){
    Start-Sleep -Milliseconds 500
    $health=& curl.exe -s --noproxy '*' --max-time 2 "http://127.0.0.1:$($config.port)/healthz"
    if($LASTEXITCODE -eq 0 -and $health){$ready=$true;break}
}
if(-not $ready){throw 'Gateway not ready. See .runtime/logs/gateway.log.'}
Write-Output 'Dafeiyu is running. The local console manages models, QQ login and runtime controls.'
if(-not $NoBrowser){ & "$PSScriptRoot/Open-Console.ps1" }
