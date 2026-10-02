# update.ps1 - update and restart the Extractor vitrina without windows (EXT-38, spec SPEC-extractor-vitrina, row V9).
# ASCII only: Windows PowerShell 5.1 reads a .ps1 without BOM in the system code page.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\update.ps1 [-Root <repo>] [-Node <node.exe>] [-NoRestart]
#
# Steps (git pull is not here - the conductor does it first):
#   1. npm ci in the root; npm ci and npm run build in web\ (web\dist is outside git: without the build the
#      server answers 503, after a pull without the build it shows the old interface). Any failure - stop here,
#      exit 1, the running vitrina is not touched.
#   2. GET http://127.0.0.1:<port>/api/health (port from data\vitrina\config.json, else config.default.json):
#      - answers the vitrina (app = extractor-vitrina): its pid must be a node.exe running server.mjs,
#        that process (and only it) is stopped; other node processes are never touched;
#      - answers something else: exit 3 "port is taken by a foreign process", nothing is stopped or started;
#      - nothing answers: nothing to stop.
#   3. Starts tools\vitrina-hidden.js through wscript.exe (no window) and waits up to 60 s for /api/health
#      with a new pid. Exit 0 - restarted, 2 - did not answer in time (see data\vitrina\console.log, server.log).
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Node = '',
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.mjs'))) { throw "not a vitrina root (no server.mjs): $Root" }
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
$npm = Join-Path (Split-Path -Parent $Node) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction Stop).Source }

function Invoke-Npm([string]$dir, [string[]]$npmArgs) {
  Write-Output "npm $($npmArgs -join ' ')  ($dir)"
  Push-Location -LiteralPath $dir
  try { & $npm @npmArgs; $rc = $LASTEXITCODE } finally { Pop-Location }
  if ($rc -ne 0) { Write-Output "update stopped: npm $($npmArgs -join ' ') in $dir exited $rc; the running vitrina is not touched"; exit 1 }
}

Invoke-Npm $Root @('ci')
Invoke-Npm (Join-Path $Root 'web') @('ci')
Invoke-Npm (Join-Path $Root 'web') @('run', 'build')
if ($NoRestart) { Write-Output 'built; restart skipped (-NoRestart)'; exit 0 }

function Get-Port {
  foreach ($f in @('data\vitrina\config.json', 'config.default.json')) {
    $p = Join-Path $Root $f
    if (Test-Path -LiteralPath $p) {
      $c = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($c.port) { return [int]$c.port }
    }
  }
  throw 'no port in data\vitrina\config.json or config.default.json'
}

# $null - nothing answers; otherwise the parsed answer, or @{ foreign = $true }
function Get-Health([int]$port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/health"
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { return @{ foreign = $true } }
    return $null
  }
  try { $j = $r.Content | ConvertFrom-Json } catch { return @{ foreign = $true } }
  if ($j.app -ne 'extractor-vitrina') { return @{ foreign = $true } }
  return $j
}

$port = Get-Port
$h = Get-Health $port
$oldPid = $null
if ($h -and $h.foreign) { Write-Output "port is taken by a foreign process: 127.0.0.1:$port does not answer as the vitrina; nothing stopped"; exit 3 }
if ($h) {
  $oldPid = [int]$h.pid
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid"
  if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server\.mjs') {
    Write-Output "pid $oldPid from /api/health is not a node.exe running server.mjs; nothing stopped"; exit 3
  }
  Stop-Process -Id $oldPid -Force
  Write-Output "stopped: vitrina pid $oldPid"
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Health $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hidden = Join-Path $Root 'tools\vitrina-hidden.js'
Start-Process -FilePath $wscript -ArgumentList ('//B //Nologo //E:JScript "' + $hidden + '" "' + $Node + '"') -WorkingDirectory $Root
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $n = Get-Health $port
  if ($n -and -not $n.foreign -and [int]$n.pid -ne $oldPid) { Write-Output "started: vitrina pid $($n.pid) on http://127.0.0.1:$port/"; exit 0 }
} while ((Get-Date) -lt $deadline)
Write-Output "the vitrina did not answer in 60 s; see data\vitrina\console.log and server.log"
exit 2
