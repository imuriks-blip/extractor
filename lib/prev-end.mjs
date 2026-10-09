// Строка prev-end (EXT-85; спека витрины 5, «Выключение ноутбука», абзац «Строка о нечистом прошлом конце»).
// При старте: закончился ли прошлый процесс строкой stop — по своим журналам data/vitrina (server.log, stats.log),
// прочитанным ДО первой строки нового процесса. Не закончился — одна строка prev-end в server.log (время последней
// записи прошлого процесса, его pid, причина) и то же полем prevEnd в /api/health. Причина — по системному журналу
// Windows в окне [последняя запись, старт нового процесса]: выход из сеанса (Winlogon 7002) или Kernel-Power 42 с
// TargetState=6 (выключение; у Ивана — «завершение работы» с быстрым запуском) — shutdown; только сон (506/507 или 42
// без выключения) — sleep; ничего, сбой или таймаут чтения — unknown. Старт чтения не ждёт.
import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

// строки второго запуска, который вышел сам (уже запущена / порт чужой), — не записи прошлого процесса
const FOREIGN = new Set(['already', 'port-foreign']);
const WINLOGON = 'Microsoft-Windows-Winlogon';
const KPOWER = 'Microsoft-Windows-Kernel-Power';
const SHUTDOWN_STATE = 6; // SYSTEM_POWER_STATE: PowerSystemShutdown
export const PREV_END_TIMEOUT_MS = 15000;

// строка lib/server-log.mjs: «<ISO> <событие> k=v k=v …»
function parseLine(l) {
  const parts = l.trim().split(' ');
  const at = Date.parse(parts[0]);
  if (!parts[1] || !Number.isFinite(at)) return null;
  const pidField = parts.find((p) => p.startsWith('pid='));
  const pid = pidField ? Number(pidField.slice(4)) : NaN;
  return { iso: parts[0], at, event: parts[1], pid: Number.isInteger(pid) ? pid : null };
}
const linesOf = (text) => String(text ?? '').split('\n').map(parseLine).filter(Boolean);

// null — прошлый процесс кончился строкой stop или журналов нет (первый запуск); иначе { at, pid } его последней записи
export function findPrevEnd({ serverLog, statsLog }) {
  const server = linesOf(serverLog);
  const stats = linesOf(statsLog);
  let i = server.length - 1;
  while (i >= 0 && server[i].event !== 'start' && server[i].event !== 'stop') i--;
  if (i >= 0 && server[i].event === 'stop') return null;
  // start есть — его pid; ротация срезала start — pid из последней строки stats.log (старый формат — без pid)
  const own = (i >= 0 ? server.slice(i) : server).filter((l) => !FOREIGN.has(l.event));
  let pid = i >= 0 ? server[i].pid : null;
  let ownStats = stats;
  if (i >= 0) ownStats = pid === null ? [] : stats.filter((l) => l.pid === pid);
  else if (stats.length) pid = stats[stats.length - 1].pid;
  const candidates = [...own, ...ownStats];
  if (!candidates.length) return null;
  const last = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return { at: last.iso, pid };
}

// XML `wevtutil qe … /f:xml /e:Events` → [{ provider, id, at (мс UTC), targetState }]
export function parseEvents(xml) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<Event[\s>][\s\S]*?<\/Event>/g)) {
    const e = m[0];
    const provider = e.match(/<Provider\s+Name=['"]([^'"]+)['"]/)?.[1] ?? '';
    const id = Number(e.match(/<EventID[^>]*>(\d+)<\/EventID>/)?.[1]);
    const at = Date.parse(e.match(/<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/)?.[1] ?? '');
    const ts = e.match(/<Data\s+Name=['"]TargetState['"]>(\d+)<\/Data>/)?.[1];
    if (!Number.isInteger(id) || !Number.isFinite(at)) continue;
    out.push({ provider, id, at, targetState: ts === undefined ? null : Number(ts) });
  }
  return out;
}

export function classifyEnd(events, { from, to }) {
  const inside = events.filter((e) => e.at >= from && e.at <= to);
  const shutdown = inside.some((e) => (e.provider === WINLOGON && e.id === 7002) || (e.provider === KPOWER && e.id === 42 && e.targetState === SHUTDOWN_STATE));
  if (shutdown) return 'shutdown';
  const sleep = inside.some((e) => e.provider === KPOWER && (e.id === 506 || e.id === 507 || e.id === 42));
  return sleep ? 'sleep' : 'unknown';
}

// Системный журнал Windows: wevtutil.exe (консольная программа, не PowerShell) с windowsHide — окна консоли нет
// (грабля Т4; как git и тосты витрины), таймаут — execFile убивает процесс. Только чтение.
const WEVTUTIL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');
export function readSystemEvents({ from, to, timeoutMs = PREV_END_TIMEOUT_MS, execFile = nodeExecFile }) {
  const iso = (t) => new Date(t).toISOString();
  const q = `*[System[((Provider[@Name='${WINLOGON}'] and (EventID=7002)) or (Provider[@Name='${KPOWER}'] and (EventID=42 or EventID=506 or EventID=507))) and TimeCreated[@SystemTime>='${iso(from)}' and @SystemTime<='${iso(to)}']]]`;
  return new Promise((resolve, reject) => {
    execFile(WEVTUTIL, ['qe', 'System', `/q:${q}`, '/f:xml', '/e:Events'], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseEvents(stdout));
    });
  });
}

// state(): null — прошлый конец штатный или первый запуск; иначе { at, pid, reason } (reason null, пока журнал читается)
export function createPrevEnd({ serverLog, statsLog, startedAt, readEvents = readSystemEvents, timeoutMs = PREV_END_TIMEOUT_MS, log }) {
  const prev = findPrevEnd({ serverLog, statsLog });
  if (!prev) return { state: () => null, done: Promise.resolve() };
  let reason = null;
  let timer;
  const win = { from: Date.parse(prev.at), to: startedAt };
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('unknown'), timeoutMs); timer.unref?.(); });
  const read = Promise.resolve().then(() => readEvents({ ...win, timeoutMs })).then((evs) => classifyEnd(evs, win), () => 'unknown');
  const done = Promise.race([read, timeout]).then((r) => {
    clearTimeout(timer);
    reason = r;
    try { log.write('prev-end', { at: prev.at, pid: prev.pid, reason }); } catch { /* журнал не роняет сервер */ }
  });
  return { state: () => ({ at: prev.at, pid: prev.pid, reason }), done };
}
