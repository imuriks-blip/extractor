// Читатель живых процессов (спека витрины 1.2, 2.1; такт В3): ~/.claude/sessions/<pid>.json, только чтение.
// Читаются только файлы вида <число>.json — файлы *.key рядом не открываются никогда. Из файла берутся только поля
// верхнего уровня, нужные витрине (ниже FIELDS); путь сокета, cwd и прочее не хранятся.
// Живой — pid жив И время старта процесса совпадает с procStart (pid Windows раздаёт заново). Время старта — один раз
// на пару pid+procStart (появился pid или файл реестра сменил процесс), дальше живость — только проверка pid.
// Ошибка чтения файла (заперт, битый) — прежняя запись остаётся с прежним временем наблюдения: через staleMin тред
// «устарело» (гейт п.5), а не пропал и не «свободен».
import nodeFs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const FIELDS = ['pid', 'sessionId', 'hostSessionId', 'name', 'nameSource', 'status', 'waitingFor', 'startedAt', 'procStart', 'updatedAt', 'statusUpdatedAt', 'kind', 'entrypoint', 'version'];
const PID_FILE = /^(\d+)\.json$/;
const RETRY_MS = 60000; // отсрочка после отказа вызова времени старта, на pid

// procStart — FILETIME Windows строкой (100 нс с 1601-01-01); в миллисекунды Unix
export function filetimeToMs(s) {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return null;
  return Number(BigInt(s) / 10000n - 11644473600000n);
}

// pid жив: сигнал 0 — только проверка; EPERM — процесс есть, но чужой
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Время старта процессов одним вызовом PowerShell без окна консоли (windowsHide, грабля Т4): pid → FILETIME строкой
// (StartTime.ToFileTimeUtc() — та же шкала, что procStart: проверено на двух живых тредах 02.10) или null.
export function procStartsWindows(pids, { timeoutMs = 15000 } = {}) {
  const ids = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (ids.length === 0) return Promise.resolve(new Map());
  const script = `foreach ($p in (Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue)) { try { "$($p.Id) $($p.StartTime.ToFileTimeUtc())" } catch { "$($p.Id) -" } }`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const out = new Map(ids.map((p) => [p, null]));
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+) (\d+|-)$/);
        if (m) out.set(Number(m[1]), m[2] === '-' ? null : m[2]);
      }
      resolve(out);
    });
  });
}

// skipCwds — папки, чьи процессы реестра витрина не показывает (EXT-87: сессия замера, спека пульта §6 п.4); cwd читается из файла только для сверки, не хранится
const normCwd = (p) => path.resolve(String(p)).toLowerCase();
export function createProcessReader({ dir, fs = nodeFs, now = () => Date.now(), isAlive = pidAlive, procStartOf = procStartsWindows, skipCwds = [] }) {
  const skipSet = new Set(skipCwds.map(normCwd));
  const entries = new Map(); // имя файла → запись
  const verified = new Map(); // `${pid}|${procStart}` → true/false
  const st = { lastOkAt: null, errors: 0, lastError: null, files: 0 };
  const retryAt = new Map(); // pid → время, раньше которого вызов времени старта не повторять
  let checking = null; // идущий вызов времени старта

  async function refresh() {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => PID_FILE.test(n)); } catch (e) { st.errors++; st.lastError = e.code ?? 'ERR'; return; }
    st.files = names.length;
    let failed = false;
    const fresh = [];
    for (const n of names) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) {
        failed = true; st.errors++; st.lastError = e.code ?? e.name;
        continue; // прежняя запись (если была) остаётся со старым временем наблюдения
      }
      if (!j || typeof j !== 'object') { failed = true; st.errors++; st.lastError = 'FORM'; continue; }
      if (typeof j.cwd === 'string' && j.cwd && skipSet.has(normCwd(j.cwd))) continue; // процесс замера: не тред
      const e = {};
      for (const k of FIELDS) e[k] = j[k] ?? null;
      e.pid = Number(n.match(PID_FILE)[1]);
      fresh.push([n, e]);
    }
    // файл процесса исчез — запись и сверка по его pid забыты (вернётся тот же pid — сверка заново)
    for (const k of [...entries.keys()]) if (!names.includes(k)) {
      const pid = entries.get(k).pid;
      for (const key of [...verified.keys()]) if (key.startsWith(`${pid}|`)) verified.delete(key);
      entries.delete(k);
    }

    // Вердикт Голема, Важно 2: один вызов времени старта за раз (зависший PowerShell не плодит новых, файлы читаются
    // дальше); отказ — повтор по этим pid не раньше чем через RETRY_MS.
    const t0 = now();
    const need = fresh.map(([, e]) => e).filter((e) => !verified.has(`${e.pid}|${e.procStart}`) && !((retryAt.get(e.pid) ?? -Infinity) > t0) && isAlive(e.pid));
    if (need.length && !checking) {
      let procFailed = false;
      checking = (async () => {
        try {
          const starts = await procStartOf(need.map((e) => e.pid));
          for (const e of need) { verified.set(`${e.pid}|${e.procStart}`, starts.get(e.pid) != null && starts.get(e.pid) === e.procStart); retryAt.delete(e.pid); }
        } catch (err) {
          procFailed = true; st.errors++; st.lastError = err.code ?? 'PROCSTART';
          for (const e of need) retryAt.set(e.pid, now() + RETRY_MS);
        }
      })();
      try { await checking; } finally { checking = null; }
      if (procFailed) failed = true;
    }
    const t = now();
    for (const [n, e] of fresh) {
      const key = `${e.pid}|${e.procStart}`;
      const alive = isAlive(e.pid);
      if (!alive) verified.delete(key);
      // время старта не удалось узнать (сбой PowerShell) — прежнее решение по этому файлу, иначе пока не живой
      e.live = alive && (verified.has(key) ? verified.get(key) : (entries.get(n)?.live ?? false));
      e.observedAt = t;
      entries.set(n, e);
    }
    if (!failed) st.lastOkAt = new Date(t).toISOString();
  }

  return {
    refresh,
    entries: () => [...entries.values()].map((e) => ({ ...e })),
    state: () => ({ ...st, live: [...entries.values()].filter((e) => e.live).length }),
  };
}
