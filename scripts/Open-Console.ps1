$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$url=[IO.File]::ReadAllText("$workspace/.runtime/console-url.txt").Trim()
# The private token is only needed for first-time password setup; afterwards the console asks for the password.
try{
    $auth=Invoke-RestMethod ([Uri]$url).GetLeftPart([UriPartial]::Path).Replace('/console/','/console/api/auth') -TimeoutSec 5
    if($auth.passwordSet){$url=([Uri]$url).GetLeftPart([UriPartial]::Path)}
}catch{}
Start-Process $url
