# vitrina-checks.ps1 - pure checks shared by install-autostart.ps1 and update.ps1 (EXT-38, Golem's verdict on V9).
# ASCII only. Dot-sourced; no registry, no processes, no files here - so test/v9.test.mjs can call every function
# with any argument (".." included) without touching the machine.

# AppUserModelID for the toast sender: starts with a letter or digit; letters, digits, . _ - only; no "..";
# never "." or ".." - those would turn HKCU:\Software\Classes\AppUserModelId\<id> into a parent key.
function Test-AppIdArg([string]$Id) {
  if ($Id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { return $false }
  if ($Id.Contains('..') -or $Id.Contains('\')) { return $false }
  return $true
}

# The Startup shortcut is ours only when its arguments name the launcher of exactly this root.
function Test-OursShortcutArgs([string]$Root, [string]$Arguments) {
  $want = '"' + $Root.TrimEnd('\') + '\tools\vitrina-hidden.js"'
  return ($Arguments.IndexOf($want, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# The vitrina on the port is ours (update.ps1 may stop it) only when:
#   the process is node.exe; its command line names "<Root>\server.mjs" literally (case-insensitive, as a whole
#   argument); and the pid from /api/health is the process that listens on 127.0.0.1:<port>.
function Test-OwnVitrina([string]$Root, [int]$HealthPid, [int[]]$ListenerPids, [string]$Name, [string]$CommandLine) {
  if ($Name -ne 'node.exe') { return $false }
  if (-not ($ListenerPids -contains $HealthPid)) { return $false }
  $server = [regex]::Escape($Root.TrimEnd('\') + '\server.mjs')
  return ($CommandLine -imatch ('(^|[\s"])' + $server + '("|\s|$)'))
}
