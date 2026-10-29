$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$url=([Uri][IO.File]::ReadAllText("$workspace/.runtime/console-url.txt").Trim()).GetLeftPart([UriPartial]::Path)
Start-Process ($url+'#panel')
