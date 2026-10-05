# Проба ПТ8 (EXT-75): видимые окна верхнего уровня, которыми владеют процессы с данными pid. Только чтение, без снимков экрана.
# Вывод — JSON-массив [{pid, title, cls}]; пусто — у процессов нет видимых окон (скрытое окно консоли IsWindowVisible даёт false).
#   powershell -NoProfile -File pt8-windows.ps1 <pid> [<pid> ...]
param([Parameter(ValueFromRemainingArguments = $true)] [int[]] $Pids)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Pt8Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string[]> Visible(HashSet<uint> pids) {
    var res = new List<string[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) {
        var t = new StringBuilder(200); var c = new StringBuilder(100);
        GetWindowText(h, t, 200); GetClassName(h, c, 100);
        res.Add(new string[] { pid.ToString(), t.ToString(), c.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
$set = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($p in $Pids) { [void]$set.Add([uint32]$p) }
$out = @()
foreach ($r in [Pt8Win]::Visible($set)) { $out += [pscustomobject]@{ pid = [int]$r[0]; title = $r[1]; cls = $r[2] } }
ConvertTo-Json -InputObject @($out) -Compress
