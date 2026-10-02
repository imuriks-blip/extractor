# install-autostart.ps1 - autostart of the Extractor vitrina at Windows logon and the toast sender name (EXT-38,
# spec SPEC-extractor-vitrina section 5, Ivan's decision V-9: Startup-folder shortcut through a hidden launcher,
# no Task Scheduler). ASCII only: Windows PowerShell 5.1 reads a .ps1 without BOM in the system code page.
# Needs no administrator rights: everything goes to the current user (Startup folder, HKCU).
#
#   install:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 [-Root <repo>] [-Name <n>] [-AppId <id>] [-Node <node.exe>] [-IconPath <png|ico>] [-Start]
#   remove:   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove [-Name <n>] [-AppId <id>]
#
# What install puts (and -Remove takes away, nothing else):
#   1. <Startup>\<Name>.lnk  ->  wscript.exe //B //Nologo //E:JScript "<Root>\tools\vitrina-hidden.js" "<node.exe>"
#      (node.exe as an absolute path resolved now, so PATH at logon does not matter; no window at all).
#   2. HKCU\Software\Classes\AppUserModelId\<AppId>  DisplayName = "Extractor" in Russian (+ IconUri if -IconPath):
#      the vitrina shows its toasts from this id when the key exists (config toastAppId, lib/toast.mjs),
#      otherwise from Windows PowerShell as before.
# -Start: also runs the shortcut once now (the vitrina exits 0 by itself if it already answers on its port).
# Probe: a trial -Name and -AppId and a trial clone as -Root with its own port in data\vitrina\config.json.
# The real autostart (default names, C:\projects\extractor) is put by the conductor with Ivan's yes only.
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

if ($Name -notmatch '^[A-Za-z0-9 ._-]{1,64}$') { throw "bad -Name (letters, digits, space . _ -): $Name" }
if ($AppId -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw "bad -AppId (letters, digits . _ -): $AppId" }
if (-not $DisplayName) { $DisplayName = [regex]::Unescape('\u042d\u043a\u0441\u0442\u0440\u0430\u043a\u0442\u043e\u0440') }

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup ($Name + '.lnk')
$appKey = 'HKCU:\Software\Classes\AppUserModelId\' + $AppId
$wsh = New-Object -ComObject WScript.Shell

# only a shortcut that points to our launcher counts as ours: a foreign shortcut with the same name stays
function Test-Ours([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $s = $wsh.CreateShortcut($path)
  return ($s.Arguments -match 'vitrina-hidden\.js')
}

if ($Remove) {
  if (Test-Ours $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Output "removed: $lnk" }
  elseif (Test-Path -LiteralPath $lnk) { Write-Output "kept (not ours): $lnk" }
  else { Write-Output "not found: $lnk" }
  if (Test-Path -LiteralPath $appKey) { Remove-Item -LiteralPath $appKey -Recurse -Force; Write-Output "removed: $appKey" }
  else { Write-Output "not found: $appKey" }
  exit 0
}

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
$hidden = Join-Path $Root 'tools\vitrina-hidden.js'
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.mjs'))) { throw "not a vitrina root (no server.mjs): $Root" }
if (-not (Test-Path -LiteralPath $hidden)) { throw "no tools\vitrina-hidden.js in $Root" }
if (-not (Test-Path -LiteralPath $Node)) { throw "node.exe not found: $Node" }
if ((Test-Path -LiteralPath $lnk) -and -not (Test-Ours $lnk)) { throw "a foreign shortcut has this name, choose another -Name: $lnk" }
if ($IconPath -and -not (Test-Path -LiteralPath $IconPath)) { throw "icon not found: $IconPath" }

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$s = $wsh.CreateShortcut($lnk)
$s.TargetPath = $wscript
$s.Arguments = '//B //Nologo //E:JScript "' + $hidden + '" "' + $Node + '"'
$s.WorkingDirectory = $Root
$s.Description = 'Extractor vitrina (hidden, 127.0.0.1) - EXT-38'
$s.Save()
Write-Output "shortcut: $lnk"

New-Item -Path $appKey -Force | Out-Null
New-ItemProperty -LiteralPath $appKey -Name DisplayName -Value $DisplayName -PropertyType String -Force | Out-Null
if ($IconPath) { New-ItemProperty -LiteralPath $appKey -Name IconUri -Value (Resolve-Path -LiteralPath $IconPath).Path -PropertyType String -Force | Out-Null }
Write-Output "toast sender: $appKey"

if ($Start) {
  Start-Process -FilePath $wscript -ArgumentList $s.Arguments -WorkingDirectory $Root
  Write-Output "started: $lnk"
}
