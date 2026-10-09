// Строка prev-end (EXT-85; спека витрины 5, «Выключение ноутбука», абзац «Строка о нечистом прошлом конце»; правка по
// вердикту Голема на 9ff8902). При старте: закончился ли прошлый процесс строкой stop — по своим журналам data/vitrina
// (server.log, stats.log, console.log), прочитанным ДО первой строки нового процесса. Не закончился — одна строка
// prev-end в server.log и то же полем prevEnd в /api/health.
// Время конца (at) — последняя запись именно прошлого процесса: его start, строки server.log с его pid, строки stats с его
// pid; строки без pid после start не считаются (их может оставить неудачная попытка старта); start срезан ротацией —
// последняя строка stats.log и её pid.
// Причина: crash — в console.log после at строка uncaught (lib/console-log.mjs; падение доказано строкой, выключение
// после него не причина); shutdown — событие выключения в системном журнале Windows не позже 15 мин после at (живой
// процесс пишет stats раз в 10 мин: молчание дольше значит, что процесса уже не было); иначе — unknown, в том числе сбой
// или таймаут чтения журнала. Сон причиной не бывает — витрина его переживает. Старт чтения не ждёт.
import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

// строки второго запуска, который вышел сам (уже запущена / порт чужой), — не записи прошлого процесса (у already pid —
// номер работающей витрины, а пишет строку другой процесс)
const FOREIGN = new Set(['already', 'port-foreign']);
export const PREV_END_TIMEOUT_MS = 15000;
// выключение позже at + 15 мин — не причина смерти (stats раз в 10 мин + запас)
export const SHUTDOWN_WINDOW_MS = 15 * 60000;
// события выключения (спека 5 и Г4): поставщик → номера; Kernel-Power 42 — только с TargetState=6 (PowerSystemShutdown)
const SHUTDOWN = {
  'Microsoft-Windows-Winlogon': [7002],
  'Microsoft-Windows-Kernel-Power': [42],
  'Microsoft-Windows-Kernel-General': [13],
  EventLog: [6006, 6008],
  User32: [1074],
};
const SHUTDOWN_STATE = 6;

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
const latest = (lines) => lines.reduce((a, b) => (b.at > a.at ? b : a));

// null — прошлый процесс кончился строкой stop или его записей нет (первый запуск); иначе { at, pid }
export function findPrevEnd({ serverLog, statsLog }) {
  const server = linesOf(serverLog);
  const stats = linesOf(statsLog);
  let i = server.length - 1;
  while (i >= 0 && server[i].event !== 'start' && server[i].event !== 'stop') i--;
  if (i >= 0 && server[i].event === 'stop') return null;
  if (i < 0) {
    if (!stats.length) return null;
    const last = stats[stats.length - 1];
    return { at: last.iso, pid: last.pid };
  }
  const pid = server[i].pid;
  const own = [server[i], ...server.slice(i + 1).filter((l) => pid !== null && l.pid === pid && !FOREIGN.has(l.event)),
    ...stats.filter((l) => pid !== null && l.pid === pid)];
  return { at: latest(own).iso, pid };
}

// console.log (lib/console-log.mjs): «<ISO> uncaught: <имя>», кадры стека — следующими строками
export function findCrash(consoleLog, at) {
  return String(consoleLog ?? '').split('\n').some((l) => {
    const m = l.match(/^(\S+) uncaught:/);
    return m !== null && Date.parse(m[1]) >= at;
  });
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

const isShutdown = (e) => (SHUTDOWN[e.provider] ?? []).includes(e.id) && (e.id !== 42 || e.targetState === SHUTDOWN_STATE);
// at — время конца (мс): shutdown — событие выключения в [at, at + 15 мин]; иначе unknown
export function classifyEnd(events, at) {
  return events.some((e) => e.at >= at && e.at <= at + SHUTDOWN_WINDOW_MS && isShutdown(e)) ? 'shutdown' : 'unknown';
}

// Системный журнал Windows: wevtutil.exe (консольная программа, не PowerShell) с windowsHide — окна консоли нет
// (грабля Т4; как git и тосты витрины), таймаут — execFile убивает процесс. Только чтение.
const WEVTUTIL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');
export function readSystemEvents({ from, to, timeoutMs = PREV_END_TIMEOUT_MS, execFile = nodeExecFile }) {
  const iso = (t) => new Date(t).toISOString();
  const who = Object.entries(SHUTDOWN).map(([p, ids]) => `(Provider[@Name='${p}'] and (${ids.map((n) => `EventID=${n}`).join(' or ')}))`).join(' or ');
  const q = `*[System[(${who}) and TimeCreated[@SystemTime>='${iso(from)}' and @SystemTime<='${iso(to)}']]]`;
  return new Promise((resolve, reject) => {
    execFile(WEVTUTIL, ['qe', 'System', `/q:${q}`, '/f:xml', '/e:Events'], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseEvents(stdout));
    });
  });
}

// state(): null — прошлый конец штатный или первый запуск; иначе { at, pid, reason } (reason null, пока журнал читается)
export function createPrevEnd({ serverLog, statsLog, consoleLog = '', readEvents = readSystemEvents, timeoutMs = PREV_END_TIMEOUT_MS, log }) {
  const prev = findPrevEnd({ serverLog, statsLog });
  if (!prev) return { state: () => null, done: Promise.resolve() };
  const at = Date.parse(prev.at);
  let reason = null;
  let timer;
  let decided;
  if (findCrash(consoleLog, at)) decided = Promise.resolve('crash');
  else {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('unknown'), timeoutMs); timer.unref?.(); });
    // Promise.resolve().then — и синхронный бросок читателя становится отказом (unknown), а не ошибкой старта
    const read = Promise.resolve().then(() => readEvents({ from: at, to: at + SHUTDOWN_WINDOW_MS, timeoutMs })).then((evs) => classifyEnd(evs, at), () => 'unknown');
    decided = Promise.race([read, timeout]);
  }
  const done = decided.then((r) => {
    clearTimeout(timer);
    reason = r;
    try { log.write('prev-end', { at: prev.at, pid: prev.pid, reason }); } catch { /* журнал не роняет сервер */ }
  });
  return { state: () => ({ at: prev.at, pid: prev.pid, reason }), done };
}
