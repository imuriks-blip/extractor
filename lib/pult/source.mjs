// Отметка процесса-источника (EXT-89, ПТ1б, SPEC-extractor-pult §4.3): кто нажал — по паре портов сокета POST.
// Способ: постоянный скрытый PowerShell (windowsHide = CREATE_NO_WINDOW), один раз компилирует P/Invoke —
// GetExtendedTcpTable (владелец клиентского конца loopback-соединения) и CreateToolhelp32Snapshot (pid, родитель, образ) —
// и отвечает строкой JSON на строку «порт-клиента порт-сервера». Без прав администратора. Тёплый запрос — миллисекунды
// (разовый PowerShell на запрос — 0,7–0,8 с, не укладывается в 300 мс). Первый запрос ждёт запуска помощника.
// Действие отметка не блокирует никогда: любой сбой — { ok:false, reason }.
import { spawn as nodeSpawn } from 'node:child_process';

const CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class Pm {
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr p, ref int size, bool sort, int af, int cls, uint reserved);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct PE { public uint dwSize, cntUsage, pid; public UIntPtr heap; public uint module, threads, ppid; public int pri; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  static int Port(int v) { return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF); }
  static string Ip(int v) { return (v & 0xFF) + "." + ((v >> 8) & 0xFF) + "." + ((v >> 16) & 0xFF) + "." + ((v >> 24) & 0xFF); }
  // строки таблицы TCP с локальным портом cport: [состояние, локальный адрес, локальный порт, удалённый адрес, удалённый порт, pid]; null — сбой таблицы
  public static string Socks(int cport) {
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
    for (int i = 0; i < 5; i++) {
      size += 4096;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        uint r = GetExtendedTcpTable(buf, ref size, false, 2, 5, 0);
        if (r == 122) continue;
        if (r != 0) return null;
        int n = Marshal.ReadInt32(buf);
        StringBuilder sb = new StringBuilder("["); bool first = true;
        for (int k = 0; k < n; k++) {
          IntPtr row = IntPtr.Add(buf, 4 + k * 24);
          if (Port(Marshal.ReadInt32(row, 8)) != cport) continue;
          if (!first) sb.Append(','); first = false;
          sb.Append('[').Append(Marshal.ReadInt32(row, 0)).Append(",\\"").Append(Ip(Marshal.ReadInt32(row, 4))).Append("\\",").Append(Port(Marshal.ReadInt32(row, 8)))
            .Append(",\\"").Append(Ip(Marshal.ReadInt32(row, 12))).Append("\\",").Append(Port(Marshal.ReadInt32(row, 16))).Append(',').Append(Marshal.ReadInt32(row, 20)).Append(']');
        }
        return sb.Append(']').ToString();
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return null;
  }
  public static string Table() {
    IntPtr h = CreateToolhelp32Snapshot(2, 0);
    if (h == IntPtr.Zero || h == new IntPtr(-1)) return "[]";
    StringBuilder sb = new StringBuilder("[");
    try {
      PE e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
      bool ok = Process32FirstW(h, ref e); bool first = true;
      while (ok) {
        if (!first) sb.Append(','); first = false;
        sb.Append('[').Append(e.pid).Append(',').Append(e.ppid).Append(",\\"").Append(e.exe.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\"]");
        ok = Process32NextW(h, ref e);
      }
    } finally { CloseHandle(h); }
    return sb.Append(']').ToString();
  }
}`;

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@
[Console]::Out.WriteLine('ready')
while (($l = [Console]::In.ReadLine()) -ne $null) {
  try {
    $p = $l.Trim().Split(' ')
    $o = [Pm]::Socks([int]$p[0])
    if ($o -eq $null) { [Console]::Out.WriteLine('{"error":"tcp-table"}'); continue }
    $t = [Pm]::Table()
    [Console]::Out.WriteLine('{"socks":' + $o + ',"procs":' + $t + '}')
  } catch { [Console]::Out.WriteLine('{"error":"helper"}') }
}
`;

const IMAGE_OK = 'msedge.exe';
const IMAGE_BAD_PARENT = 'claude.exe';

// Классификация по таблице процессов: pid владельца, procs — [[pid, ppid, образ], …]. Чистая функция.
export function classify({ pid, procs }) {
  const by = new Map();
  for (const r of Array.isArray(procs) ? procs : []) if (Array.isArray(r)) by.set(r[0], { ppid: r[1], image: String(r[2] ?? '') });
  const self = by.get(pid);
  if (!self) return { ok: false, image: null, chain: [], pid, reason: 'process-gone' };
  const chain = [];
  const seen = new Set([pid]);
  let at = self.ppid;
  while (chain.length < 32 && at && !seen.has(at) && by.has(at)) {
    seen.add(at);
    chain.push(by.get(at).image);
    at = by.get(at).ppid;
  }
  const lower = (s) => s.toLowerCase();
  const ok = lower(self.image) === IMAGE_OK && !chain.some((c) => lower(c) === IMAGE_BAD_PARENT);
  // цепочка оборвалась на Edge (родителя нет в таблице, выше Edge никого не видно) — кто запустил Edge, неизвестно:
  // признак для разбора на Г-П5, не красный (у Edge с ярлыка родитель — живой explorer); решение дирижёра на приёмке EXT-89
  const launcherGone = !!at && !seen.has(at) && !by.has(at) && lower(chain.length ? chain[chain.length - 1] : self.image) === IMAGE_OK;
  return { ok, image: self.image, chain, pid, ...(launcherGone ? { launcherGone: true } : {}), ...(ok ? {} : { reason: lower(self.image) !== IMAGE_OK ? 'image' : 'claude-in-chain' }) };
}

// Владелец клиентского конца среди строк таблицы TCP [состояние, локальный адрес, локальный порт, удалённый адрес, удалённый порт, pid]:
// порты, АДРЕСА и состояние ESTABLISHED (5) — один local-порт на разных адресах (bind на 127.0.0.2:P) чужую строку не подсунет;
// TIME_WAIT и pid 0 не берутся. Адрес вида ::ffff:127.0.0.1 приводится к IPv4. Нет строки — null
const v4 = (a) => String(a).replace(/^::ffff:/i, '');
export function pickOwner(socks, { clientPort, serverPort, clientAddr, serverAddr }) {
  const row = (Array.isArray(socks) ? socks : []).find((r) => Array.isArray(r) && r[0] === 5 && r[2] === clientPort && r[4] === serverPort
    && r[1] === v4(clientAddr) && r[3] === v4(serverAddr) && r[5] > 0);
  return row ? row[5] : null;
}

// Чтение владельца сокета и таблицы процессов одним помощником. spawn — подмена для тестов
export function createHelperReader({ spawn = nodeSpawn, platform = process.platform, startMs = 8000, queryMs = 1500 } = {}) {
  let child = null;
  let ready = null; // промис готовности помощника
  let waiting = []; // очередь ответов построчно
  let chain = Promise.resolve(); // запросы по одному: протокол строчный

  function fail(err) {
    const w = waiting; waiting = [];
    child = null; ready = null;
    for (const x of w) x.reject(err);
  }
  function start() {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = c;
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const w = waiting.shift();
        if (w) w.resolve(line);
      }
    });
    c.on('error', () => { if (child === c) fail(new Error('helper-spawn')); });
    c.on('exit', () => { if (child === c) fail(new Error('helper-exit')); });
    c.stdin.on('error', () => {});
    c.unref?.(); c.stdout.unref?.(); c.stdin.unref?.();
    return ask(null, startMs).then((line) => { if (line !== 'ready') throw new Error('helper-start'); });
  }
  function ask(text, ms) {
    return new Promise((resolve, reject) => {
      const w = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        const at = waiting.indexOf(w);
        if (at >= 0) waiting.splice(at, 1);
        reject(new Error('timeout'));
        // ответ опоздает и сдвинет очередь — помощника перезапускаем
        try { child?.kill(); } catch { /* уже нет */ }
      }, ms);
      waiting.push(w); // таймер не unref: пока ждём ответа помощника, процесс не должен выйти
      if (text !== null) child.stdin.write(text + '\n');
    });
  }
  async function read({ clientPort, serverPort, clientAddr, serverAddr }) {
    if (platform !== 'win32') throw new Error('unsupported-platform');
    if (!Number.isInteger(clientPort) || !Number.isInteger(serverPort) || typeof clientAddr !== 'string' || typeof serverAddr !== 'string') throw new Error('no-ports');
    const run = async () => {
      if (!child) ready = start();
      await ready;
      const line = await ask(`${clientPort} ${serverPort}`, queryMs);
      const o = JSON.parse(line);
      if (o.error) throw new Error(o.error);
      const pid = pickOwner(o.socks, { clientPort, serverPort, clientAddr, serverAddr });
      if (pid === null) throw new Error('no-socket');
      return { pid, procs: o.procs };
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }
  return { read, close() { const c = child; child = null; ready = null; try { c?.stdin.end(); c?.kill(); } catch { /* уже нет */ } } };
}

// identify(req) → proc для client.proc: { ok, image, chain, pid, ms, reason? }. read — внедряемая зависимость:
// ({clientPort, serverPort, clientAddr, serverAddr}) → { pid, procs }. Не бросает никогда
export function createSource({ read, limitMs = 1500, clock = () => performance.now() } = {}) {
  async function identify({ clientPort, serverPort, clientAddr, serverAddr }) {
    const t0 = clock();
    const ms = () => Math.round(clock() - t0);
    let timer;
    try {
      const got = await Promise.race([
        Promise.resolve().then(() => read({ clientPort, serverPort, clientAddr, serverAddr })),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), limitMs); timer.unref?.(); }),
      ]);
      return { ...classify(got), ms: ms() };
    } catch (e) {
      const reason = typeof e?.message === 'string' && /^[a-z][a-z-]{1,30}$/.test(e.message) ? e.message : 'error';
      return { ok: false, image: null, chain: [], reason, ms: ms() };
    } finally {
      clearTimeout(timer);
    }
  }
  return { identify };
}
