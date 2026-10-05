// Ждущий звонка (спека пульта §2.1, §2.2, §2.4; ПТ4б, EXT-63). Команда хука Stop (async, asyncRewake):
//   node bell/waiter.mjs [--port <N>] [--bell-dir <путь>]
// По умолчанию — порт 4317 и папка звонка живой витрины. stdin хука → session_id. Один ждущий на сессию: замок
// <bellDir>/<sid>.lock {pid, procStart, bootAt, at}; чужой живой — только если pid жив И время старта совпало.
// Хозяин — ~/.claude/sessions/<pid>.json с sessionId == sid (живость — pid + procStart), раз в 1 с; не найден
// за 10 с — выход 0; умер — выход 0. STOP в папке звонка — при старте (замок не берётся) и на каждом тике.
// Звонит только свободному хозяину (status idle или нет статуса). Порядок звонка (2.2): GET /api/bell/<sid> →
// строка ring {ids} в bell.log → удалить сигналы прозвоненных → текст в stderr и код 2. Сигналы, чьих id нет
// в ответе сервера (ни в ids, ни в held), — удалить, строка forged {ids}. Содержимое сигналов не читается. В bell.log — без текста.
// Удаление файлов — fs.unlinkSync (rmSync молча не удаляет путь с кириллицей, EXT-62).
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { pidAlive, procStartsWindows } from '../lib/processes.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RING_RE = /^(W-[0-9A-Za-z-]+)\.ring$/;
export const TICK_MS = 1000;
export const OWNER_WAIT_MS = 10000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULTS = { port: 4317, bellDir: path.join(ROOT, 'data', 'vitrina', 'bell') };

const unlinkQuiet = (fs, f) => { try { fs.unlinkSync(f); return true; } catch { return false; } };
const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? undefined : null; } };

// замок жив: pid жив И время старта процесса совпало с записанным (Windows раздаёт pid заново)
async function lockAlive(lock, { isAlive, procStartOf }) {
  if (!lock || !Number.isInteger(lock.pid) || typeof lock.procStart !== 'string' || !isAlive(lock.pid)) return false;
  try { return (await procStartOf([lock.pid])).get(lock.pid) === lock.procStart; } catch { return false; }
}

// /api/health → bell.waiters: живые замки в папке звонка. Счётчик сервера держит проверенные пары pid|procStart
// (как verified в lib/processes.mjs): пара, раз проверенная, не перепроверяется, пока pid жив — время старта (PowerShell)
// спрашивается только за новые пары; умер pid — пара забыта без вызова.
export function createLockCounter({ fs = nodeFs, isAlive = pidAlive, procStartOf = procStartsWindows } = {}) {
  const verified = new Map(); // `${pid}|${procStart}` → true/false
  return {
    async count({ dir }) {
      let names;
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.lock') && UUID_RE.test(n.slice(0, -5))); } catch { return 0; }
      const locks = names.map((n) => readJson(fs, path.join(dir, n))).filter((l) => l && Number.isInteger(l.pid) && typeof l.procStart === 'string');
      const key = (l) => `${l.pid}|${l.procStart}`;
      for (const k of [...verified.keys()]) if (!isAlive(Number(k.split('|')[0]))) verified.delete(k);
      const live = locks.filter((l) => isAlive(l.pid));
      const need = live.filter((l) => !verified.has(key(l)));
      if (need.length) {
        let starts;
        try { starts = await procStartOf([...new Set(need.map((l) => l.pid))]); } catch { return null; }
        for (const l of need) verified.set(key(l), starts.get(l.pid) === l.procStart);
      }
      return live.filter((l) => verified.get(key(l)) === true).length;
    },
  };
}

// разовый счёт (без памяти между вызовами)
export function countLiveLocks({ dir, fs = nodeFs, isAlive = pidAlive, procStartOf = procStartsWindows }) {
  return createLockCounter({ fs, isAlive, procStartOf }).count({ dir });
}

// GET http://127.0.0.1:<port>/api/bell/<sid> — с Host, без Origin и Sec-Fetch-Site (иначе 403, §4.1)
export function httpGet(port, sid, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/bell/${sid}`, headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* не JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

// Один ждущий от начала до выхода; возвращает код выхода (0 или 2). Все внешние вещи — параметрами (тесты).
export async function runWaiter({ sid, port = DEFAULTS.port, bellDir = DEFAULTS.bellDir, sessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
  pid = process.pid, fs = nodeFs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isAlive = pidAlive,
  procStartOf = procStartsWindows, get = (s) => httpGet(port, s), stderr = (s) => process.stderr.write(s),
  tickMs = TICK_MS, ownerWaitMs = OWNER_WAIT_MS, maxTicks = Infinity }) {
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return 0;
  sid = sid.toLowerCase();
  const logFile = path.join(bellDir, 'bell.log');
  const lockFile = path.join(bellDir, `${sid}.lock`);
  const sigDir = path.join(bellDir, sid);
  const stopFile = path.join(bellDir, 'STOP');
  const log = (event, extra = {}) => {
    try { fs.mkdirSync(bellDir, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now()).toISOString(), sid, event, ...extra }) + '\n'); } catch { /* журнал не пишется — звонок не держим */ }
  };

  if (fs.existsSync(stopFile)) { log('stop'); return 0; }

  // замок: сначала чужой (дешёвая проверка pid, время старта — только у живого pid); живой → skip без своего времени
  // старта. Решено брать — своё время старта; не узналось → замок не берётся (чужой ждущий счёл бы его мёртвым и
  // поднял бы второго), skip с причиной. Затем эксклюзивное создание; гонка — ещё одна сверка (один повтор).
  fs.mkdirSync(bellDir, { recursive: true });
  if (fs.existsSync(lockFile) && await lockAlive(readJson(fs, lockFile), { isAlive, procStartOf })) { log('skip'); return 0; }
  let myStart = null;
  try { myStart = (await procStartOf([pid])).get(pid) ?? null; } catch { /* не узнано */ }
  if (typeof myStart !== 'string') { log('skip', { reason: 'no-proc-start' }); return 0; }
  const mine = { pid, procStart: myStart, bootAt: new Date(now() - os.uptime() * 1000).toISOString(), at: new Date(now()).toISOString() };
  let took = false;
  for (let i = 0; i < 2 && !took; i++) {
    try { fs.writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx' }); took = true; } catch (e) {
      if (e.code !== 'EEXIST') return 0;
      if (await lockAlive(readJson(fs, lockFile), { isAlive, procStartOf })) { log('skip'); return 0; }
      unlinkQuiet(fs, lockFile);
    }
  }
  if (!took) { log('skip'); return 0; }
  const release = () => { const l = readJson(fs, lockFile); if (l && l.pid === pid) unlinkQuiet(fs, lockFile); };
  log('start');

  // хозяин: запись реестра с sessionId == sid и совпавшим временем старта
  const t0 = now();
  let owner = null; // {pid, file}
  const findOwner = async () => {
    let names = [];
    try { names = fs.readdirSync(sessionsDir).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
    for (const n of names) {
      const s = readJson(fs, path.join(sessionsDir, n));
      if (!s || s.sessionId !== sid || !Number.isInteger(s.pid) || !isAlive(s.pid)) continue;
      if (typeof s.procStart === 'string') {
        let st = null;
        try { st = (await procStartOf([s.pid])).get(s.pid); } catch { continue; }
        if (st !== s.procStart) continue;
      }
      return { pid: s.pid, file: path.join(sessionsDir, n), status: s.status };
    }
    return null;
  };
  const signals = () => { try { return fs.readdirSync(sigDir).map((n) => n.match(RING_RE)?.[1]).filter(Boolean); } catch { return []; } };

  for (let tick = 0; tick < maxTicks; tick++) {
    if (tick > 0) await sleep(tickMs);
    if (fs.existsSync(stopFile)) { release(); log('stop'); return 0; }
    let status;
    if (!owner) {
      owner = await findOwner();
      if (!owner) {
        if (now() - t0 >= ownerWaitMs) { release(); log('owner-gone'); return 0; }
        continue;
      }
      status = owner.status;
    } else {
      if (!isAlive(owner.pid)) { release(); log('owner-gone'); return 0; }
      const s = readJson(fs, owner.file);
      if (s === undefined) { release(); log('owner-gone'); return 0; } // запись реестра исчезла — сессия закрылась
      status = s ? s.status : 'busy'; // запись не читается (заперта, битая) — не знаем, ждём
    }
    const ids = signals();
    if (!ids.length) continue;
    if (status !== undefined && status !== null && status !== 'idle') continue;
    const r = await get(sid);
    // 503 — звонок выключен флагом pult.bell (§4.3): не звонить, сигналы не трогать, уйти
    if (r?.status === 503) { release(); log('stop', { reason: 'bell-off' }); return 0; }
    if (r?.status !== 200 || !r.json || !Array.isArray(r.json.ids)) continue;
    const served = r.json.ids.filter((x) => typeof x === 'string');
    // held — слова, которые сервер знает, но держит до следующего звонка («перечитай» не в одном звонке со словами, 2.6):
    // их сигналы не поддельные — лежат, следующий ждущий того же треда позвонит ими
    const held = Array.isArray(r.json.held) ? r.json.held.filter((x) => typeof x === 'string') : [];
    const forged = ids.filter((x) => !served.includes(x) && !held.includes(x));
    if (forged.length) { for (const id of forged) unlinkQuiet(fs, path.join(sigDir, `${id}.ring`)); log('forged', { ids: forged }); }
    if (!served.length || typeof r.json.text !== 'string') continue;
    log('ring', { ids: served });
    for (const id of served) unlinkQuiet(fs, path.join(sigDir, `${id}.ring`));
    release();
    stderr(r.json.text);
    return 2;
  }
  release();
  return 0;
}

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(argOf(process.argv, '--port') ?? DEFAULTS.port);
  const bellDir = path.resolve(argOf(process.argv, '--bell-dir') ?? DEFAULTS.bellDir);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', async () => {
    let j = {};
    try { j = JSON.parse(raw); } catch { /* не JSON — sid нет */ }
    let code = 0;
    try { code = await runWaiter({ sid: j.session_id, port: Number.isInteger(port) && port > 0 ? port : DEFAULTS.port, bellDir }); } catch { code = 0; }
    // stderr дописан до выхода (код 2 будит тред текстом из stderr)
    if (code === 2) process.stderr.write('', () => process.exit(2)); else process.exit(code);
  });
}
