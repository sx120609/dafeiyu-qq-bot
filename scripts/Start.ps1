param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$linuxRoot=(& wsl -d Ubuntu -- wslpath -u $workspace.Replace('\','/')).Trim()
$keepaliveFile=Join-Path $workspace '.runtime/wsl-keepalive.json'
$keepalive=$null
if(Test-Path $keepaliveFile){
    $record=Get-Content -Raw $keepaliveFile | ConvertFrom-Json
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if($process.Name -eq 'wsl.exe' -and $process.CommandLine -like "*$linuxRoot/scripts/keepalive.sh*"){$keepalive=$process}
}
if(-not $keepalive){
    # CreateNoWindow gives wsl.exe no console at all. -WindowStyle Hidden is not enough when
    # Windows Terminal is the default console host: it opens a visible tab, and closing that
    # tab ends the keepalive, after which WSL shuts the whole distro down.
    $info=[Diagnostics.ProcessStartInfo]::new("$env:SystemRoot\System32\wsl.exe","-d Ubuntu --exec /bin/bash $linuxRoot/scripts/keepalive.sh")
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $process=[Diagnostics.Process]::Start($info)
    [IO.File]::WriteAllText($keepaliveFile,(@{pid=$process.Id}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
& wsl -d Ubuntu -u root -- systemctl start docker
if($LASTEXITCODE -ne 0){throw 'Could not start Docker'}
& wsl -d Ubuntu -u root -- docker start qq-ai | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not start QQ runtime'}
& wsl -d Ubuntu -- systemctl --user start dafeiyu-bot.service
if($LASTEXITCODE -ne 0){throw 'Could not start Dafeiyu services'}
$ready=$false
for($i=0;$i -lt 40;$i++){
    Start-Sleep -Milliseconds 500
    if(Test-Path "$workspace/.runtime/status.json"){
        $status=Get-Content -Raw "$workspace/.runtime/status.json" | ConvertFrom-Json
        if($status.engine -and (Test-Path "$workspace/.runtime/control-url.txt")){
            try{
                $control=[Uri]([IO.File]::ReadAllText("$workspace/.runtime/control-url.txt").Trim())
                $origin=$control.GetLeftPart([UriPartial]::Authority)
                $check=Invoke-RestMethod "$origin/api/status" -Headers @{'X-QQ-Control'=$control.Fragment.Substring(1);Origin=$origin} -TimeoutSec 2
                if($check.temporaryCredentials){$ready=$true;break}
            }catch{}
        }
    }
}
if(-not $ready){throw 'Engine not ready. Run scripts/Status.ps1.'}
Write-Output 'Dafeiyu is running. The local console manages models, QQ login and runtime controls.'
if(-not $NoBrowser){ & "$PSScriptRoot/Open-Console.ps1" }
