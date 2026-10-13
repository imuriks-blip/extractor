// Тихая отправка доски и её состояние (EXT-99, спека витрины §2.12; такт ПТ15 спеки пульта).
// Витрина сама зовёт `node <доска>/tools/sync.mjs --by extractor --root <доска>`: через quietS тишины после смены HEAD
// (при ahead > 0), не реже periodMin бодрствования от последней удачной отправки любым запускающим и своей попытки,
// один раз через wakeDelayS после пробуждения. Не зовёт: флаг выключен, mode не live, push не true, конфиг не читается,
// HEAD отсоединён или доска посреди перебазирования/слияния (повод откладывается, не теряется), свой вызов идёт (после
// конца — один повтор при ahead > 0). Код 3 — один повтор через quietS. Процесс — detached, без окна, stdio ignore, без
// unref, cleanEnv, таймаут timeoutS — снятие деревом по своему pid. Журнал — только server.log (board-sync,
// board-sync-skip при смене причины, board-sync-left). Состояние: .board-sync.json по mtime, ahead — по git
// (`log --format=%at origin/main..HEAD`), уровень и причина — здесь, страница пишет только текст.
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { cleanEnv, killTree } from './pult/board-run.mjs';
import { createWake } from './notify.mjs';
import { maskText } from './mask.mjs';
import { cutChars } from './text.mjs';

export const BOARD_SYNC_DEFAULTS = Object.freeze({ enabled: false, quietS: 60, periodMin: 15, wakeDelayS: 60, timeoutS: 300, yellowMin: 20, redMin: 60 });
const MIN = 60000;
const STALE_LOCK_MS = 60000; // брошенный замок — тот же порог, что у блокировки доски (§2.1 спеки доски)
const REBASE_RED_MS = 60000; // перебазирование видно непрерывно 60 с — красное (п.4)
const UNREAD_MS = 60000; // состояние не читается дольше 60 с — жёлтое unread
const STRICT = 'IPTV'; // строгая сеть маски (как lastError зеркала, §6 п.2)
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const iso = (ms) => new Date(ms).toISOString();
const list = (v) => (Array.isArray(v) ? v : []);

// config.json → boardSync: объект живого конфига поверх умолчаний по ключам; enabled — только явное true (от pult не зависит)
export function boardSyncConfig(config) {
  const own = config?.boardSync && typeof config.boardSync === 'object' ? config.boardSync : {};
  const out = { ...BOARD_SYNC_DEFAULTS };
  for (const k of Object.keys(BOARD_SYNC_DEFAULTS)) {
    if (k === 'enabled') out.enabled = own.enabled === true;
    else if (Number.isFinite(own[k]) && own[k] > 0) out[k] = own[k];
  }
  return out;
}

// Уровень и причина строки отправки (таблица §2.12): самая тяжёлая причина, при равных — первая по таблице. Возраст —
// по бодрствованию (slept — проспанное на отрезке). Не live — строки нет (level null).
export function syncLevel({ mode, push, state = {}, ahead, oldestAheadAt, now, slept = () => 0, cfg = BOARD_SYNC_DEFAULTS, rebase = false, unreadSince = null }) {
  if (mode !== 'live') return { level: null, why: mode === 'mirror' ? 'mode' : 'config' };
  const age = (s) => { const a = Date.parse(s); return Number.isFinite(a) ? (now - a) - slept(a, now) : null; };
  const Y = cfg.yellowMin * MIN;
  const R = cfg.redMin * MIN;
  const reds = [];
  const yellows = [];
  const old = ahead > 0 ? age(oldestAheadAt) : null;
  if (old !== null && old >= R) reds.push('behind'); else if (old !== null && old >= Y) yellows.push('behind');
  if (state.lastError) { const e = age(state.since); if (e !== null && e >= R) reds.push('net'); else yellows.push('net'); }
  if (push !== true) yellows.push('push-off');
  if (list(state.inbox_blocked).length) yellows.push('inbox');
  if (unreadSince !== null && now - unreadSince > UNREAD_MS) yellows.push('unread');
  if (list(state.conflict).length) reds.push('conflict');
  if (list(state.dirty).length) reds.push('dirty');
  if (list(state.hold).length) reds.push('hold');
  if (rebase) reds.push('rebase');
  if (reds.length) return { level: 'red', why: reds[0] };
  if (yellows.length) return { level: 'yellow', why: yellows[0] };
  if (ahead === null || ahead === undefined) return { level: 'grey', why: 'unknown' };
  return { level: 'grey', why: ahead > 0 ? 'pending' : 'ok' };
}

// lastError: учётные данные из адресов `схема://…@` снимаются ещё раз, затем маска строгой сетью и обрезка 120 знаков
export function cleanError(text, scan) {
  if (typeof text !== 'string' || !text) return null;
  const s = text.split(/\r?\n/)[0].replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1');
  return cutChars(scan ? maskText(s, scan, { project: STRICT }) : s, 120);
}

// Запуск sync: start(reason) → {pid, done: Promise<{code, ms, timedOut?}>, rearm(), leave()}. Код — событием exit;
// не запустился — code 'SPAWN'; таймаут — killTree(pid) и child.kill(), {code: null, timedOut: true}. rearm — таймаут
// заново (пробуждение, п.3); leave — витрина уходит и оставляет sync доработать (штатная остановка, п.6).
// detached — только для отрицательного контроля теста «дожил»; в витрине всегда true.
export function createSyncRun({ root, script = null, node = process.execPath, spawn = nodeSpawn, kill = killTree, timeoutMs = BOARD_SYNC_DEFAULTS.timeoutS * 1000, env = process.env, detached = true }) {
  const syncJs = script ?? path.join(root, 'tools', 'sync.mjs');
  const start = () => {
    const t0 = Date.now();
    let finished = false;
    let timer = null;
    let child = null;
    let timedOut = false; // таймаут уже снимает: exit от taskkill (код 1) — не исход sync
    let resolveP;
    const done = new Promise((r) => { resolveP = r; });
    const end = (v) => { if (!finished) { finished = true; clearTimeout(timer); resolveP({ ms: Date.now() - t0, ...v }); } };
    const arm = () => {
      clearTimeout(timer);
      if (finished) return;
      timer = setTimeout(async () => {
        timedOut = true;
        if (child?.pid) { try { await kill(child.pid); } catch { /* не вышло — ниже child.kill */ } }
        try { child?.kill(); } catch { /* уже мёртв */ }
        end({ code: null, timedOut: true });
      }, timeoutMs);
    };
    try {
      child = spawn(node, [syncJs, '--by', 'extractor', '--root', root], { detached, windowsHide: true, stdio: 'ignore', env: cleanEnv(env) });
    } catch { end({ code: 'SPAWN' }); return { pid: null, done, rearm() {}, leave() {} }; }
    child.once('error', () => end({ code: 'SPAWN' }));
    child.once('exit', (code) => { if (!timedOut) end({ code }); });
    arm();
    return { pid: child.pid ?? null, done, rearm: arm, leave: () => { clearTimeout(timer); try { child.unref(); } catch { /* нет */ } } };
  };
  return { start };
}

// Планировщик и состояние. tick() — шаг опроса доски (5 с); now — шов часов; run(reason) — запуск (createSyncRun().start);
// head() — HEAD доски, которым уже следит читатель (по умолчанию — файлами .git); lock — {pidAlive, otherBoot} из tools/lib доски.
export function createBoardSync({ root, cfg = BOARD_SYNC_DEFAULTS, git, lock, scan = null, now = Date.now, run, log = { write() {} }, head = null, wakeJumpMs = 90000, stopWaitMs = 5000, fs = nodeFs }) {
  const quietMs = cfg.quietS * 1000;
  const periodMs = cfg.periodMin * MIN;
  const wakeDelayMs = cfg.wakeDelayS * 1000;
  const wake = createWake({ now, jumpMs: wakeJumpMs });
  const gd = path.join(root, '.git');
  const st = {
    head: undefined, quietAt: null, wakeAt: null, retry: null, deferred: null, queued: null,
    periodBase: now(), lastAttemptAt: null, running: null, runP: null, last: null,
    mode: null, push: null, cfgError: false,
    file: {}, fileMtime: undefined, fileErrSince: null, fileError: null,
    logMtime: undefined, by: null,
    ahead: undefined, oldestAheadAt: null, gitErrSince: null, needAhead: true,
    rebaseSince: null, rebaseRed: false, skipWhy: undefined, busy: false, stopped: false,
  };

  function readBoardConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(root, 'board.config.json'), 'utf8'));
      const m = c?.mode;
      st.mode = m === 'live' || m === 'mirror' ? m : null;
      st.push = c?.push === true;
      st.cfgError = st.mode === null;
    } catch { st.mode = null; st.push = null; st.cfgError = true; }
  }

  // .board-sync.json — по mtime; ошибка — прежнее с возрастом; нет файла — пусто (sync ещё не ходил)
  function readStateFile(t) {
    const f = path.join(root, '.board-sync.json');
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m !== st.fileMtime) { st.file = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; st.fileMtime = m; st.needAhead = true; }
      st.fileErrSince = null; st.fileError = null;
    } catch (e) {
      if (e.code === 'ENOENT') {
        if (st.fileMtime !== null) { st.file = {}; st.fileMtime = null; }
        st.fileErrSince = null; st.fileError = null;
      } else { st.fileErrSince ??= t; st.fileError = typeof e.code === 'string' ? e.code : 'PARSE'; }
    }
  }

  // кто отправил последним: by последней строки «удача» .board-sync.log (по mtime, файл — до 500 строк)
  function readSyncLog() {
    const f = path.join(root, '.board-sync.log');
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m === st.logMtime) return;
      st.logMtime = m;
      const ok = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.split('\t')[2]?.startsWith('удача')).at(-1);
      st.by = ok ? ok.split('\t')[1] : null;
    } catch { /* нет файла или не читается — прежнее */ }
  }

  const currentHead = () => {
    if (head) return head() ?? null;
    try {
      const h = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
      if (OID.test(h)) return h;
      const ref = h.match(/^ref: (refs\/[^\s]+)$/)?.[1];
      if (!ref || ref.split('/').includes('..')) return null;
      try { return fs.readFileSync(path.join(gd, ...ref.split('/')), 'utf8').trim(); } catch { /* в packed-refs */ }
      for (const line of fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8').split(/\r?\n/)) { const [oid, name] = line.split(' '); if (name === ref) return oid; }
      return null;
    } catch { return null; }
  };

  // HEAD отсоединён — 'detached'; перебазирование или слияние висит — 'rebase'; иначе null
  function rebaseState() {
    try { if (OID.test(fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim())) return 'detached'; } catch { /* .git не каталог или нет — не видно */ }
    for (const n of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) if (fs.existsSync(path.join(gd, n))) return 'rebase';
    return null;
  }

  // .board.lock занят — по правилам живости lock.mjs доски: другой загрузки — свободен; мёртвый pid и старше 60 с — свободен;
  // неразобранный — занят, пока не состарится
  function lockBusy(t) {
    const f = path.join(root, '.board.lock');
    let raw;
    let mtime;
    try { raw = fs.readFileSync(f, 'utf8'); mtime = fs.statSync(f).mtimeMs; } catch { return false; }
    let j;
    try { j = JSON.parse(raw); } catch { return t - mtime <= STALE_LOCK_MS; }
    if (lock?.otherBoot?.(j.boot)) return false;
    const at = Date.parse(j.at);
    const atMs = Number.isFinite(at) ? at : mtime;
    if (t - atMs > STALE_LOCK_MS && !lock?.pidAlive?.(j.pid)) return false;
    return true;
  }

  async function recomputeAhead() {
    st.needAhead = false;
    try {
      let origin = true;
      try { await git(root, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']); } catch { origin = false; }
      if (!origin) {
        await git(root, ['rev-parse', 'HEAD']); // git читается — значит, нет origin/main: ahead неизвестен, не 0
        st.ahead = null; st.oldestAheadAt = null;
      } else {
        const ts = (await git(root, ['log', '--format=%at', 'origin/main..HEAD'])).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => n > 0);
        st.ahead = ts.length;
        // порядок log — не хронология: наименьшее %at (дата автора — перебазирование её не трогает)
        st.oldestAheadAt = ts.length ? iso(ts.reduce((a, b) => Math.min(a, b)) * 1000) : null;
      }
      st.gitErrSince = null;
    } catch { st.gitErrSince ??= now(); }
  }

  function gate(rb) {
    if (cfg.enabled !== true) return 'off';
    if (st.cfgError) return 'config';
    if (st.mode !== 'live') return 'mode';
    if (st.push !== true) return 'push';
    return rb;
  }

  const lastOkMs = () => { const v = Date.parse(st.file?.lastOk); return Number.isFinite(v) ? v : -Infinity; };
  const periodFrom = () => Math.max(st.periodBase, st.lastAttemptAt ?? -Infinity, lastOkMs());
  const periodDue = (t) => { const b = periodFrom(); return (t - b) - wake.slept(b, t) >= periodMs; };

  function call(trig) {
    const t = now();
    st.lastAttemptAt = t;
    st.deferred = null;
    st.queued = null;
    let h;
    try { h = run(trig.reason); } catch { h = { pid: null, done: Promise.resolve({ code: 'SPAWN', ms: 0 }) }; }
    st.running = { pid: h.pid ?? null, since: iso(t), reason: trig.reason, handle: h };
    st.runP = Promise.resolve(h.done).then((r = {}) => {
      const fields = { reason: trig.reason, code: r.code ?? null, ms: r.ms ?? null, pid: h.pid ?? null };
      if (r.timedOut) fields.timedOut = true;
      if (trig.retry) fields.retry = true;
      log.write('board-sync', fields);
      st.last = { at: iso(now()), reason: trig.reason, code: r.code ?? null, ms: r.ms ?? null };
      st.running = null;
      // код 3 (доска занята) — не ошибка: один повтор через quietS; повтор с кодом 3 нового не ставит
      if (r.code === 3 && !trig.retry && !st.stopped) st.retry = { at: now() + quietMs, reason: trig.reason, retry: true };
      st.needAhead = true;
    });
  }

  function onWake(t) {
    // взведённые таймеры сбрасываются — пачки нет; один вызов через wakeDelayS; «15 мин» — от него
    st.quietAt = null; st.retry = null; st.deferred = null; st.queued = null;
    st.wakeAt = t + wakeDelayMs;
    st.periodBase = t;
    st.needAhead = true;
    st.running?.handle?.rearm?.(); // идущий вызов не снимается: таймаут — заново от пробуждения
  }

  async function tick() {
    if (st.busy || st.stopped) return;
    st.busy = true;
    try {
      await null; // конец своего вызова (exit) — раньше выбора
      const t = now();
      if (wake.tick()) onWake(t);
      readBoardConfig();
      readStateFile(t);
      readSyncLog();
      const h = currentHead();
      if (h) {
        if (st.head !== undefined && h !== st.head) st.quietAt = t + quietMs; // смена HEAD — «коммит», таймер заново
        st.head = h;
      }
      const rb = rebaseState();
      if (rb) st.rebaseSince ??= t; else st.rebaseSince = null;
      st.rebaseRed = !!rb && t - st.rebaseSince >= REBASE_RED_MS && !lockBusy(t) && !st.running;

      const due = [];
      if (st.quietAt !== null && t >= st.quietAt) { st.quietAt = null; await recomputeAhead(); if (st.ahead > 0) due.push({ reason: 'quiet' }); }
      if (st.wakeAt !== null && t >= st.wakeAt) { st.wakeAt = null; due.push({ reason: 'wake' }); }
      if (st.retry && t >= st.retry.at) { due.push(st.retry); st.retry = null; }
      if (st.wakeAt === null && periodDue(t)) due.push({ reason: 'period' });
      if (st.needAhead) await recomputeAhead();

      const why = gate(rb);
      if (why !== st.skipWhy) { if (why) log.write('board-sync-skip', { why }); st.skipWhy = why; }
      if (why === 'detached' || why === 'rebase') { if (due.length) st.deferred ??= due[0]; return; } // откладывается, не теряется
      if (why) return;
      if (st.running) { if (due.length) st.queued ??= due[0]; return; } // после конца — один повтор
      let pick = due[0] ?? st.deferred ?? null;
      if (!pick && st.queued) { const q = st.queued; st.queued = null; if (st.ahead > 0) pick = { reason: q.reason }; }
      if (pick) call(pick);
    } finally { st.busy = false; }
  }

  function nextOf() {
    const c = [];
    if (st.quietAt !== null) c.push({ at: st.quietAt, reason: 'quiet' });
    if (st.wakeAt !== null) c.push({ at: st.wakeAt, reason: 'wake' });
    if (st.retry) c.push({ at: st.retry.at, reason: st.retry.reason });
    if (st.wakeAt === null) c.push({ at: periodFrom() + periodMs, reason: 'period' });
    const n = c.sort((a, b) => a.at - b.at)[0];
    return n ? { at: iso(n.at), reason: n.reason } : null;
  }

  function levelNow() {
    const errs = [st.fileErrSince, st.gitErrSince].filter((x) => x !== null);
    return syncLevel({ mode: st.mode, push: st.push, state: st.file, ahead: st.ahead ?? null, oldestAheadAt: st.oldestAheadAt, now: now(), slept: wake.slept, cfg,
      rebase: st.rebaseRed, unreadSince: errs.length ? Math.min(...errs) : null });
  }

  function conflictIds() {
    const ids = [];
    let other = 0;
    for (const p of list(st.file.conflict)) {
      const m = String(p).replace(/\\/g, '/').match(/^([A-Z]{2,6})\/(\1-\d+)(?:\.log)?\.md$/);
      if (m) { if (!ids.includes(m[2])) ids.push(m[2]); } else other++;
    }
    return { ids, other };
  }

  const str = (v) => (typeof v === 'string' && v ? v : null);

  return {
    tick,
    status() {
      const { level, why } = levelNow();
      const c = conflictIds();
      return {
        on: cfg.enabled === true, mode: st.mode, push: st.push,
        lastOkAt: str(st.file.lastOk), by: st.by, ahead: st.ahead ?? null, oldestAheadAt: st.oldestAheadAt,
        lastError: cleanError(st.file.lastError, scan), errorSince: st.file.lastError ? str(st.file.since) : null,
        conflict: c.ids, conflictOther: c.other, dirty: list(st.file.dirty).length, hold: list(st.file.hold).length, inboxBlocked: list(st.file.inbox_blocked).length,
        level, why,
        running: st.running ? { pid: st.running.pid, since: st.running.since, reason: st.running.reason } : null,
        last: st.last, next: cfg.enabled === true ? nextOf() : null,
        readError: st.fileError ?? (st.gitErrSince !== null ? 'GIT' : null),
      };
    },
    freshness() {
      const { level, why } = levelNow();
      return { level, why, lastOkAt: str(st.file.lastOk), ahead: st.ahead ?? null, oldestAheadAt: st.oldestAheadAt,
        errorSince: st.file.lastError ? str(st.file.since) : null, conflictIds: conflictIds().ids, inboxBlocked: list(st.file.inbox_blocked).length, by: st.by };
    },
    // штатная остановка (§5): идущий sync не снимается — ждём до stopWaitMs, дальше оставляем (строка board-sync-left)
    async stop() {
      st.stopped = true;
      const r = st.running;
      if (!r) return;
      let tm = null;
      const finished = await Promise.race([st.runP.then(() => true), new Promise((res) => { tm = setTimeout(() => res(false), stopWaitMs); })]);
      clearTimeout(tm);
      if (!finished) { r.handle?.leave?.(); log.write('board-sync-left', { pid: r.pid }); }
    },
  };
}
