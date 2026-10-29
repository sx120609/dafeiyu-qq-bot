# Builds Dafeiyu.exe (tray launcher) with the C# compiler included in Windows' .NET Framework 4.8.
$ErrorActionPreference='Stop'
$here=$PSScriptRoot;$workspace=Split-Path -Parent $here
if(-not (Test-Path "$here\dafeiyu.ico")){ & "$workspace\scripts\make-images.ps1" | Out-Null }
$csc="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$workspace\Dafeiyu.exe" "/win32icon:$here\dafeiyu.ico" "/win32manifest:$here\app.manifest" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "$here\Launcher.cs"
if($LASTEXITCODE -ne 0){throw 'Launcher build failed'}
Write-Output "Built $workspace\Dafeiyu.exe"
