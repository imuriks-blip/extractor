# update.ps1 - update and restart the Extractor vitrina without windows (EXT-38, spec SPEC-extractor-vitrina, row V9).
# ASCII only: Windows PowerShell 5.1 reads a .ps1 without BOM in the system code page.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\update.ps1 [-Root <repo>] [-Node <node.exe>] [-NoRestart]
#
# Steps (git pull is not here - the conductor does it first):
#   1. Who is on 127.0.0.1:<port> (port from data\vitrina\config.json, else config.default.json) - BEFORE npm:
#      - nobody listens: nothing to stop;
#      - our vitrina: /api/health answers app = extractor-vitrina, its pid is the process listening on the port,
#        that process is node.exe and its command line names "<Root>\server.mjs" literally (tools\vitrina-checks.ps1);
#      - anything else (another program, a vitrina of another copy, a vitrina started as "node server.mjs" by hand,
#        an old build without app/pid in /api/health, a listener that does not answer in 3 s):
#        exit 3, nothing is built, stopped or started.
#   2. npm ci in the root; npm ci and npm run build in web\ (web\dist is outside git: without the build the
#      server answers 503, after a pull without the build it shows the old interface).
#      Exit 1 on any npm failure. NOTE: npm ci deletes node_modules first - the running vitrina keeps working from
#      memory, but a new start (logon, reboot) fails until the update succeeds: repeat update.ps1 before rebooting.
#   3. Re-checks step 1 (same pid, still ours), stops that one process gracefully (tools\vitrina-stop.ps1: its pid
#      goes to data\vitrina\stop.request, the vitrina runs stop() - last "stats" line, index, "stop" line - and
#      exits; Stop-Process -Force only if it is still alive after 10 s), starts tools\vitrina-hidden.js through
#      wscript.exe (no window) and waits up to 60 s for /api/health with a new pid.
#      Exit 0 - restarted, 2 - did not answer in time (see data\vitrina\console.log and server.log).
# -NoRestart: steps 1-2 only (for a first install: build, then install-autostart.ps1).
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Node = '',
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vitrina-checks.ps1')
. (Join-Path $PSScriptRoot 'vitrina-stop.ps1')

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.mjs'))) { throw "not a vitrina root (no server.mjs): $Root" }
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
$npm = Join-Path (Split-Path -Parent $Node) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction Stop).Source }

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

function Get-ListenerPids([int]$port) {
  return @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess })
}

# 'none' - nobody listens; 'own' (+ Pid) - our vitrina; 'foreign' (+ Why) - anything else
function Get-PortState([int]$port) {
  $listeners = Get-ListenerPids $port
  $j = $null
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/health"
    try { $j = $r.Content | ConvertFrom-Json } catch { return @{ State = 'foreign'; Why = '/api/health is not JSON' } }
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { return @{ State = 'foreign'; Why = 'HTTP ' + [int]$_.Exception.Response.StatusCode } }
    if ($listeners.Count -gt 0) { return @{ State = 'foreign'; Why = 'a listener does not answer (' + $_.Exception.Status + ')' } }
    return @{ State = 'none' }
  }
  if ($j.app -ne 'extractor-vitrina' -or -not $j.pid) { return @{ State = 'foreign'; Why = '/api/health has no app=extractor-vitrina and pid (another program or an old build)' } }
  $hp = [int]$j.pid
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $hp"
  $name = ''; $cmd = ''
  if ($p) { $name = [string]$p.Name; $cmd = [string]$p.CommandLine }
  if (-not (Test-OwnVitrina -Root $Root -HealthPid $hp -ListenerPids $listeners -Name $name -CommandLine $cmd)) {
    return @{ State = 'foreign'; Why = "pid $hp is not node.exe running `"$Root\server.mjs`" and listening on the port" }
  }
  return @{ State = 'own'; Pid = $hp }
}

function Invoke-Npm([string]$dir, [string[]]$npmArgs) {
  Write-Output "npm $($npmArgs -join ' ')  ($dir)"
  Push-Location -LiteralPath $dir
  try { & $npm @npmArgs; $rc = $LASTEXITCODE } finally { Pop-Location }
  if ($rc -ne 0) { Write-Output "update stopped: npm $($npmArgs -join ' ') in $dir exited $rc; nothing stopped. node_modules may be gone: repeat update.ps1 before a reboot"; exit 1 }
}

$port = Get-Port
$st = Get-PortState $port
if ($st.State -eq 'foreign') { Write-Output "port is taken by a foreign process: 127.0.0.1:$port - $($st.Why); nothing built, stopped or started"; exit 3 }

Invoke-Npm $Root @('ci')
Invoke-Npm (Join-Path $Root 'web') @('ci')
Invoke-Npm (Join-Path $Root 'web') @('run', 'build')
if ($NoRestart) { Write-Output 'built; restart skipped (-NoRestart)'; exit 0 }

$st2 = Get-PortState $port
if ($st2.State -eq 'foreign' -or ($st.State -eq 'own' -and $st2.State -eq 'own' -and $st2.Pid -ne $st.Pid)) {
  Write-Output "port 127.0.0.1:$port changed hands during the build ($($st2.State) $($st2.Why)); nothing stopped or started"; exit 3
}
$oldPid = $null
if ($st2.State -eq 'own') {
  $oldPid = $st2.Pid
  $how = Stop-VitrinaGracefully -DataDir (Join-Path $Root 'data\vitrina') -ProcessId $oldPid -TimeoutSec 10
  Write-Output "stopped: vitrina pid $oldPid ($how)"
  $deadline = (Get-Date).AddSeconds(15)
  while (((Get-ListenerPids $port).Count -gt 0) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hidden = Join-Path $Root 'tools\vitrina-hidden.js'
Start-Process -FilePath $wscript -ArgumentList ('//B //Nologo //E:JScript "' + $hidden + '" "' + $Node + '"') -WorkingDirectory $Root
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $n = Get-PortState $port
  if ($n.State -eq 'own' -and $n.Pid -ne $oldPid) { Write-Output "started: vitrina pid $($n.Pid) on http://127.0.0.1:$port/"; exit 0 }
} while ((Get-Date) -lt $deadline)
Write-Output "the vitrina did not answer in 60 s; see data\vitrina\console.log and server.log"
exit 2
