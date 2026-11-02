$ErrorActionPreference='Stop'
# Ends the gateway, the engine and SnowLuma (each only if its recorded pid is still a node.exe). QQ keeps running.
$runtime=Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'
foreach($name in 'host.pid','engine.pid','snowluma.pid'){
    $file=Join-Path $runtime $name
    if(-not (Test-Path $file)){continue}
    $process=Get-Process -Id ([int](Get-Content -Raw $file)) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node'
    if($process){Stop-Process -Id $process.Id -Confirm:$false;$process.WaitForExit(10000) | Out-Null}
    Remove-Item $file -ErrorAction SilentlyContinue
}
Write-Output 'Dafeiyu gateway, engine and SnowLuma stopped.'
