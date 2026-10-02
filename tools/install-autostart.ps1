# install-autostart.ps1 - autostart of the Extractor vitrina at Windows logon and the toast sender name (EXT-38,
# spec SPEC-extractor-vitrina section 5, Ivan's decision V-9: Startup-folder shortcut through a hidden launcher,
# no Task Scheduler). ASCII only: Windows PowerShell 5.1 reads a .ps1 without BOM in the system code page.
# Needs no administrator rights: everything goes to the current user (Startup folder, HKCU).
#
#   install:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 [-Root <repo>] [-Name <n>] [-AppId <id>] [-Node <node.exe>] [-IconPath <png|ico>] [-Start]
#   remove:   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove [-Root <repo>] [-Name <n>] [-AppId <id>]
#
# Install needs a built interface (web\dist\index.html): run tools\update.ps1 first (or update.ps1 -NoRestart).
# What install puts (and -Remove takes away, nothing else):
#   1. <Startup>\<Name>.lnk  ->  wscript.exe //B //Nologo //E:JScript "<Root>\tools\vitrina-hidden.js" "<node.exe>"
#      (node.exe as an absolute path resolved now, so PATH at logon does not matter; no window at all).
#   2. HKCU\Software\Classes\AppUserModelId\<AppId>  DisplayName = "Extractor" in Russian (+ IconUri if -IconPath):
#      the vitrina shows its toasts from this id when the key exists (config toastAppId, lib/toast.mjs),
#      otherwise from Windows PowerShell as before.
#   (-Remove also drops HKCU\...\Notifications\Settings\<AppId>, which Windows itself creates at the first toast,
#    but only together with our own AppUserModelId key.)
# Ours means: the shortcut names the launcher of exactly this -Root; the registry key has our DisplayName and no
# subkeys. Anything else with the same name is kept ("kept (not ours)") and install refuses to overwrite it.
# Registry keys are created only when missing and removed without -Recurse.
# -Start: also runs the shortcut once now (the vitrina exits 0 by itself if it already answers on its port).
# -Remove does not stop a running vitrina: stop it first (pid from /api/health) if it has to go now.
# Probe: a trial -Name and -AppId and a trial clone as -Root with its own port and "toasts": false in
# data\vitrina\config.json. The real autostart (default names, C:\projects\extractor) is put by the conductor
# with Ivan's yes only.
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Name = 'Extractor',
  [string]$AppId = 'Unorbis.Extractor',
  [string]$DisplayName = '',
  [string]$Node = '',
  [string]$IconPath = '',
  [switch]$Start,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vitrina-checks.ps1')

if ($Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$' -or $Name.Contains('..')) { throw "bad -Name (starts with a letter or digit; letters, digits, space . _ -; no '..'): $Name" }
if (-not (Test-AppIdArg $AppId)) { throw "bad -AppId (starts with a letter or digit; letters, digits . _ -; no '..' and no '\'): $AppId" }
if (-not $DisplayName) { $DisplayName = [regex]::Unescape('\u042d\u043a\u0441\u0442\u0440\u0430\u043a\u0442\u043e\u0440') }

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (Test-Path -LiteralPath $Root) { $Root = (Resolve-Path -LiteralPath $Root).Path }
$Root = $Root.TrimEnd('\')

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup ($Name + '.lnk')
$appParent = 'HKCU:\Software\Classes\AppUserModelId'
$appKey = $appParent + '\' + $AppId
$winKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\' + $AppId
$wsh = New-Object -ComObject WScript.Shell

function Test-OursLnk([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  return (Test-OursShortcutArgs -Root $Root -Arguments $wsh.CreateShortcut($path).Arguments)
}
function Test-NoSubkeys([string]$key) { return (@(Get-ChildItem -LiteralPath $key).Count -eq 0) }
function Test-OursKey([string]$key) {
  if (-not (Test-Path -LiteralPath $key)) { return $false }
  $dn = (Get-ItemProperty -LiteralPath $key -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
  return (($dn -ceq $DisplayName) -and (Test-NoSubkeys $key))
}

if ($Remove) {
  if (Test-OursLnk $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Output "removed: $lnk" }
  elseif (Test-Path -LiteralPath $lnk) { Write-Output "kept (not ours): $lnk" }
  else { Write-Output "not found: $lnk" }
  if (Test-OursKey $appKey) {
    Remove-Item -LiteralPath $appKey
    Write-Output "removed: $appKey"
    if ((Test-Path -LiteralPath $winKey) -and (Test-NoSubkeys $winKey)) { Remove-Item -LiteralPath $winKey; Write-Output "removed: $winKey" }
  }
  elseif (Test-Path -LiteralPath $appKey) { Write-Output "kept (not ours): $appKey" }
  else { Write-Output "not found: $appKey" }
  exit 0
}

if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
$hidden = Join-Path $Root 'tools\vitrina-hidden.js'
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.mjs'))) { throw "not a vitrina root (no server.mjs): $Root" }
if (-not (Test-Path -LiteralPath $hidden)) { throw "no tools\vitrina-hidden.js in $Root" }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'web\dist\index.html'))) { throw "the interface is not built (no web\dist\index.html): run tools\update.ps1 first (or update.ps1 -NoRestart), then install" }
if (-not (Test-Path -LiteralPath $Node)) { throw "node.exe not found: $Node" }
if ((Test-Path -LiteralPath $lnk) -and -not (Test-OursLnk $lnk)) { throw "a foreign shortcut has this name, choose another -Name: $lnk" }
if ((Test-Path -LiteralPath $appKey) -and -not (Test-OursKey $appKey)) { throw "a foreign AppUserModelId key has this id, choose another -AppId: $appKey" }
if ($IconPath -and -not (Test-Path -LiteralPath $IconPath)) { throw "icon not found: $IconPath" }

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$s = $wsh.CreateShortcut($lnk)
$s.TargetPath = $wscript
$s.Arguments = '//B //Nologo //E:JScript "' + $hidden + '" "' + $Node + '"'
$s.WorkingDirectory = $Root
$s.Description = 'Extractor vitrina (hidden, 127.0.0.1) - EXT-38'
$s.Save()
Write-Output "shortcut: $lnk"

if (-not (Test-Path -LiteralPath $appParent)) { New-Item -Path $appParent | Out-Null }
if (-not (Test-Path -LiteralPath $appKey)) { New-Item -Path $appKey | Out-Null }
New-ItemProperty -LiteralPath $appKey -Name DisplayName -Value $DisplayName -PropertyType String -Force | Out-Null
if ($IconPath) { New-ItemProperty -LiteralPath $appKey -Name IconUri -Value (Resolve-Path -LiteralPath $IconPath).Path -PropertyType String -Force | Out-Null }
Write-Output "toast sender: $appKey"

if ($Start) {
  Start-Process -FilePath $wscript -ArgumentList $s.Arguments -WorkingDirectory $Root
  Write-Output "started: $lnk"
}
