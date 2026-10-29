$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $workspace '.runtime'
New-Item -ItemType Directory -Force $runtime, (Join-Path $runtime 'requests') | Out-Null
$codex = Get-ChildItem (Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/node_modules') -Recurse -Filter codex.exe | Select-Object -First 1 -ExpandProperty FullName
if (-not $codex) { throw 'Codex CLI not found' }
$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$configPath = Join-Path $runtime 'bridge.json'
if (-not (Test-Path $configPath)) {
    $config = @{token=[Convert]::ToBase64String($tokenBytes);port=18191;codex=(& wsl -d Ubuntu -- wslpath -u $codex.Replace('\','/')).Trim();tempRoot=(& wsl -d Ubuntu -- wslpath -u (Join-Path $runtime 'requests').Replace('\','/')).Trim()}
} else {
    $config = @{}
    (Get-Content -Raw $configPath | ConvertFrom-Json).PSObject.Properties | ForEach-Object {$config[$_.Name]=$_.Value}
}
$claude = Join-Path $env:APPDATA 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
if(Test-Path $claude){$config.claude=(& wsl -d Ubuntu -- wslpath -u $claude.Replace('\','/')).Trim()}
$config.windowsNode=(& wsl -d Ubuntu -- wslpath -u (Get-Command node).Source.Replace('\','/')).Trim()
$config.tempRoot=(& wsl -d Ubuntu -- wslpath -u (Join-Path $runtime 'requests').Replace('\','/')).Trim()
if(-not $config.imageCodex){$config.imageCodex=$config.codex}
$projectCodex=Get-ChildItem (Join-Path $workspace 'node_modules/@openai') -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if($projectCodex){$config.codex=(& wsl -d Ubuntu -- wslpath -u $projectCodex.Replace('\','/')).Trim()}
$config.generatedImagesRoot='/mnt/d/Dev/Outputs/CodexGeneratedImages'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $runtime /inheritance:r /grant:r "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
Write-Output 'Private bridge configuration ready.'
