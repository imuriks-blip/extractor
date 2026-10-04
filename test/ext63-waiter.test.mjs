// ПТ4б (EXT-63; спека пульта §2.1, §2.2 «Порядок звонка у ждущего», §2.4): ждущий bell/waiter.mjs на подменах —
// без живой сессии и без сервера. Подменены: часы и сон (тик 1 с), живость pid, время старта процесса, GET к витрине,
// stderr. Файлы — настоящие, во временной папке (замок, сигналы, bell.log, реестр сессий). Ожидания — из спеки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWaiter, countLiveLocks } from '../bell/waiter.mjs';
import { tmpDir } from './helpers.mjs';

const SID = '00000000-0000-4000-8000-000000000001';
const SID2 = '00000000-0000-4000-8000-000000000002';
const ME = 5001; // pid ждущего
const OWNER = 7001; // pid хозяина (claude.exe)
const START = { [ME]: '134000000000000001', [OWNER]: '134000000000000777' };

function mk({ owner = { pid: OWNER, sessionId: SID, procStart: START[OWNER], status: 'idle' }, served = () => [], getStatus = 200 } = {}) {
  const bellDir = tmpDir('waiter-bell-');
  const sessionsDir = tmpDir('waiter-sess-');
  const alive = new Set([ME, OWNER]);
  const starts = { ...START };
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const gets = [];
  const errs = [];
  const hooks = { onTick: () => {}, onStderr: () => {} };
  if (owner) fs.writeFileSync(path.join(sessionsDir, `${owner.pid}.json`), JSON.stringify(owner));
  let tick = 0;
  const env = {
    sid: SID, port: 4399, bellDir, sessionsDir, pid: ME,
    now: () => clock,
    sleep: async (ms) => { clock += ms; tick++; hooks.onTick(tick); },
    isAlive: (pid) => alive.has(pid),
    procStartOf: async (pids) => new Map(pids.map((p) => [p, alive.has(p) ? starts[p] ?? null : null])),
    get: async (sid) => { gets.push({ sid, at: clock }); const ids = served(); return { status: getStatus, json: { ids, text: ids.length ? `ТЕКСТ ${ids.join(',')}` : null } }; },
    stderr: (s) => { errs.push(s); hooks.onStderr(s); },
    maxTicks: 60,
  };
  const log = () => (fs.existsSync(path.join(bellDir, 'bell.log')) ? fs.readFileSync(path.join(bellDir, 'bell.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const signal = (id, sid = SID) => { fs.mkdirSync(path.join(bellDir, sid), { recursive: true }); fs.writeFileSync(path.join(bellDir, sid, `${id}.ring`), ''); };
  const signals = (sid = SID) => { try { return fs.readdirSync(path.join(bellDir, sid)).sort(); } catch { return []; } };
  const lockFile = path.join(bellDir, `${SID}.lock`);
  const setOwner = (patch) => fs.writeFileSync(path.join(sessionsDir, `${OWNER}.json`), JSON.stringify({ ...owner, ...patch }));
  return { env, bellDir, sessionsDir, alive, starts, gets, errs, hooks, log, signal, signals, lockFile, setOwner, clock: () => clock };
}

const A = 'W-261004-120000-a001';
const B = 'W-261004-120001-b002';
const F = 'W-261004-120002-dead';

// ---------------- 2.1: стоп-файл ----------------

test('2.1: STOP до старта — выход 0 сразу, замок не взят, к витрине не ходил', async () => {
  const s = mk({ served: () => [A] });
  fs.writeFileSync(path.join(s.bellDir, 'STOP'), '');
  s.signal(A);
  assert.equal(await runWaiter(s.env), 0);
  assert.equal(fs.existsSync(s.lockFile), false);
  assert.deepEqual(s.gets, []);
  assert.deepEqual(s.log().map((l) => l.event), ['stop']);
  assert.deepEqual(s.signals(), [`${A}.ring`], 'сигнал не тронут');
});

test('2.1: STOP появился на тике — выход 0, замок снят, строка stop', async () => {
  const s = mk();
  s.hooks.onTick = (n) => { if (n === 3) fs.writeFileSync(path.join(s.bellDir, 'STOP'), ''); };
  assert.equal(await runWaiter(s.env), 0);
  assert.equal(fs.existsSync(s.lockFile), false);
  assert.deepEqual(s.log().map((l) => l.event), ['start', 'stop']);
});

// ---------------- 2.1: замок ----------------

test('2.1: замок живого ждущего (pid жив, procStart совпал) — второй выходит 0 (skip), замок не тронут', async () => {
  const s = mk({ served: () => [A] });
  s.alive.add(6001); s.starts[6001] = '134000000000000600';
  const other = { pid: 6001, procStart: '134000000000000600', bootAt: 'x', at: 'y' };
  fs.writeFileSync(s.lockFile, JSON.stringify(other));
  s.signal(A);
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.lockFile, 'utf8')), other);
  assert.deepEqual(s.log().map((l) => l.event), ['skip']);
  assert.deepEqual(s.gets, []);
});

for (const [name, setup] of [
  ['мёртвым pid', (s) => fs.writeFileSync(s.lockFile, JSON.stringify({ pid: 6002, procStart: '134000000000000600' }))],
  ['чужим procStart (pid роздан заново)', (s) => { s.alive.add(6003); s.starts[6003] = '134000000000000999'; fs.writeFileSync(s.lockFile, JSON.stringify({ pid: 6003, procStart: '134000000000000600' })); }],
  ['битым содержимым', (s) => fs.writeFileSync(s.lockFile, 'не json')],
]) {
  test(`2.1: замок с ${name} — перехвачен: в замке свой pid и procStart`, async () => {
    const s = mk();
    setup(s);
    let seen = null;
    s.hooks.onTick = (n) => { if (n === 1) seen = JSON.parse(fs.readFileSync(s.lockFile, 'utf8')); if (n === 2) s.alive.delete(OWNER); };
    assert.equal(await runWaiter(s.env), 0);
    assert.equal(seen.pid, ME);
    assert.equal(seen.procStart, START[ME]);
    assert.ok(typeof seen.bootAt === 'string' && typeof seen.at === 'string', JSON.stringify(seen));
    assert.equal(s.log()[0].event, 'start');
  });
}

// ---------------- 2.1: хозяин ----------------

test('2.1: хозяин не найден за 10 с от старта — выход 0, owner-gone, замок снят', async () => {
  const s = mk({ owner: null });
  const t0 = s.clock();
  assert.equal(await runWaiter(s.env), 0);
  const waited = s.clock() - t0;
  assert.ok(waited >= 10000 && waited <= 11000, `ждал ${waited} мс`);
  assert.deepEqual(s.log().map((l) => l.event), ['start', 'owner-gone']);
  assert.equal(fs.existsSync(s.lockFile), false);
});

test('2.1: запись хозяина с чужим procStart — не хозяин (pid роздан заново): через 10 с выход', async () => {
  const s = mk({ owner: { pid: OWNER, sessionId: SID, procStart: '134000000000000111', status: 'idle' } });
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.log().map((l) => l.event), ['start', 'owner-gone']);
});

test('2.1: хозяин умер — ждущий уходит на ближайшем тике (≤ 1 с), owner-gone, замок снят', async () => {
  const s = mk();
  let diedAt = null;
  s.hooks.onTick = (n) => { if (n === 4) { s.alive.delete(OWNER); diedAt = s.clock(); } };
  assert.equal(await runWaiter(s.env), 0);
  assert.ok(s.clock() - diedAt <= 1000, `ушёл через ${s.clock() - diedAt} мс`);
  assert.deepEqual(s.log().map((l) => l.event), ['start', 'owner-gone']);
  assert.equal(fs.existsSync(s.lockFile), false);
});

// ---------------- 2.2: порядок звонка ----------------

test('2.2: порядок звонка — GET → ring {ids} в bell.log → сигналы прозвоненных удалены → stderr и код 2; замок снят', async () => {
  const s = mk({ served: () => [A, B] });
  s.signal(A); s.signal(B);
  let atStderr = null;
  s.hooks.onStderr = () => { atStderr = { log: s.log().map((l) => [l.event, l.ids]), signals: s.signals(), gets: s.gets.length }; };
  assert.equal(await runWaiter(s.env), 2);
  assert.deepEqual(s.errs, [`ТЕКСТ ${A},${B}`]);
  assert.deepEqual(atStderr, { log: [['start', undefined], ['ring', [A, B]]], signals: [], gets: 1 });
  assert.deepEqual(s.gets.map((g) => g.sid), [SID]);
  assert.equal(fs.existsSync(s.lockFile), false);
  const ring = s.log()[1];
  assert.equal(ring.sid, SID);
  assert.ok(Number.isFinite(Date.parse(ring.at)));
  assert.equal(ring.text, undefined, 'текста в bell.log нет');
});

test('2.2: сигнал мимо сервера — forged {ids}, сигнал удалён, звонка нет; исправный рядом — звонок только им', async () => {
  const s = mk({ served: () => [A] });
  s.signal(F); s.signal(A);
  assert.equal(await runWaiter(s.env), 2);
  assert.deepEqual(s.log().map((l) => [l.event, l.ids]), [['start', undefined], ['forged', [F]], ['ring', [A]]]);
  assert.deepEqual(s.errs, [`ТЕКСТ ${A}`]);
  assert.deepEqual(s.signals(), []);
});

test('2.2: только поддельный сигнал — forged, stderr пуст, ждущий ждёт дальше (выход по смерти хозяина, код 0)', async () => {
  const s = mk({ served: () => [] });
  s.signal(F);
  s.hooks.onTick = (n) => { if (n === 5) s.alive.delete(OWNER); };
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.log().map((l) => [l.event, l.ids]), [['start', undefined], ['forged', [F]], ['owner-gone', undefined]]);
  assert.deepEqual(s.errs, []);
  assert.equal(s.gets.length, 1, 'сигналов больше нет — к витрине не ходит');
});

test('2.2: сигналов нет — к витрине не ходит', async () => {
  const s = mk({ served: () => [A] });
  s.hooks.onTick = (n) => { if (n === 5) s.alive.delete(OWNER); };
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.gets, []);
});

test('2.2, §4.3: витрина ответила 503 (pult.bell выключен) — не звонит, сигналы не тронуты, stop с причиной, выход 0, замок снят', async () => {
  const s = mk({ served: () => [A], getStatus: 503 });
  s.signal(A);
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.signals(), [`${A}.ring`]);
  assert.deepEqual(s.log().map((l) => [l.event, l.reason]), [['start', undefined], ['stop', 'bell-off']]);
  assert.deepEqual(s.errs, []);
  assert.equal(fs.existsSync(s.lockFile), false);
});

test('2.2: витрина не отвечает (не запущена) — сигналы не тронуты, ждёт дальше', async () => {
  const s = mk({ served: () => [A], getStatus: 0 });
  s.signal(A);
  s.hooks.onTick = (n) => { if (n === 3) s.alive.delete(OWNER); };
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.signals(), [`${A}.ring`]);
  assert.deepEqual(s.log().map((l) => l.event), ['start', 'owner-gone']);
  assert.equal(s.gets.length, 3);
});

test('2.2: сигналы чужого треда ждущий не видит', async () => {
  const s = mk({ served: () => [A] });
  s.signal(A, SID2);
  s.hooks.onTick = (n) => { if (n === 3) s.alive.delete(OWNER); };
  assert.equal(await runWaiter(s.env), 0);
  assert.deepEqual(s.gets, []);
  assert.deepEqual(s.signals(SID2), [`${A}.ring`]);
});

// ---------------- 2.4: звонит только свободному ----------------

for (const status of ['busy', 'waiting']) {
  test(`2.4: хозяин ${status} — не звонит и к витрине не ходит; стал idle — звонок`, async () => {
    const s = mk({ owner: { pid: OWNER, sessionId: SID, procStart: START[OWNER], status }, served: () => [A] });
    s.signal(A);
    let freedAt = null;
    s.hooks.onTick = (n) => { if (n === 5) { s.setOwner({ status: 'idle' }); freedAt = s.clock(); } };
    assert.equal(await runWaiter(s.env), 2);
    assert.equal(s.gets.length, 1);
    assert.ok(s.gets[0].at >= freedAt, 'GET только после idle');
  });
}

test('2.4: статуса в записи хозяина нет — считается свободным', async () => {
  const s = mk({ owner: { pid: OWNER, sessionId: SID, procStart: START[OWNER] }, served: () => [A] });
  s.signal(A);
  assert.equal(await runWaiter(s.env), 2);
});

// ---------------- /api/health → bell.waiters ----------------

test('§1.7: живые ждущие — по замкам: pid жив и procStart совпал; мёртвый, чужой procStart и битый — не в счёт', async () => {
  const dir = tmpDir('waiter-count-');
  const alive = new Set([1, 2, 3]);
  const starts = { 1: '11', 2: '22', 3: '33' };
  fs.writeFileSync(path.join(dir, `${SID}.lock`), JSON.stringify({ pid: 1, procStart: '11' }));
  fs.writeFileSync(path.join(dir, `${SID2}.lock`), JSON.stringify({ pid: 2, procStart: '99' }));
  fs.writeFileSync(path.join(dir, '00000000-0000-4000-8000-000000000003.lock'), JSON.stringify({ pid: 4, procStart: '44' }));
  fs.writeFileSync(path.join(dir, '00000000-0000-4000-8000-000000000004.lock'), '{');
  fs.writeFileSync(path.join(dir, 'bell.log'), '');
  const n = await countLiveLocks({ dir, isAlive: (p) => alive.has(p), procStartOf: async (pids) => new Map(pids.map((p) => [p, starts[p] ?? null])) });
  assert.equal(n, 1);
  assert.equal(await countLiveLocks({ dir: path.join(dir, 'нет'), isAlive: () => true, procStartOf: async () => new Map() }), 0);
});
