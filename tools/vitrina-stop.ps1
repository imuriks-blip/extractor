# vitrina-stop.ps1 - graceful stop of the Extractor vitrina for update.ps1 (EXT-53, Golem's verdict on V10, minor 5).
# ASCII only. Dot-sourced by update.ps1 and by test/ext53-stop.test.mjs.
#
# Stop-Process without -Force sends node no signal on Windows, and -Force kills it before stop() writes the last
# "stats" line and the journal index. So the stop is asked through a file: <DataDir>\stop.request holds the pid of
# the vitrina to stop; the vitrina checks the file once a second (lib\stop-request.mjs), runs stop() and exits 0.
# A file with another pid is removed by the vitrina without stopping.
#
# Stop-VitrinaGracefully -DataDir <data\vitrina> -ProcessId <pid> [-TimeoutSec 10]  ->  one word:
#   'graceful' - the process exited by itself within TimeoutSec;
#   'forced'   - it did not: Stop-Process -Force, then the request file is removed;
#   'gone'     - there was no such process (nothing written).
function Stop-VitrinaGracefully([string]$DataDir, [int]$ProcessId, [int]$TimeoutSec = 10) {
  $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $p) { return 'gone' }
  $file = Join-Path $DataDir 'stop.request'
  $tmp = "$file.tmp"
  # temp file + rename: the vitrina never reads half a pid
  [System.IO.File]::WriteAllText($tmp, [string]$ProcessId)
  Move-Item -LiteralPath $tmp -Destination $file -Force
  if ($p.WaitForExit($TimeoutSec * 1000)) { return 'graceful' }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  $null = $p.WaitForExit(5000)
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  return 'forced'
}
