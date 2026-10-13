// EXT-99 · ПТ15 спеки пульта: витрина сама зовёт sync.mjs доски (тихая отправка) и показывает состояние отправки —
// спека витрины §2.12. Подменные часы — шов `now` планировщика; подменный sync — скрипт во временной папке, пишущий
// argv, окружение и код выхода в файл-метку; временная доска mode: live с голым «origin» во временной папке.
// Настоящий sync.mjs — только скопированный во временную доску (как ext91-live); C:\projects\unorbis-board не пишется.
// Ожидаемые значения — из того, что положено в тест, и из таблицы §2.12; у каждого правила рядом — исправный случай.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createBoardSync, createSyncRun, syncLevel, boardSyncConfig, BOARD_SYNC_DEFAULTS } from '../lib/board-sync.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { startServer } from '../lib/start.mjs';
import { boardSyncLine } from '../web/src/boardSyncText.js';
import { BOARD_LIB, tmpDir, projectsMd, gitInitCommit, git } from './helpers.mjs';

const lockLib = await import(pathToFileURL(path.join(BOARD_LIB, 'lock.mjs')).href);
const { scan } = await import(pathToFileURL(path.join(BOARD_LIB, 'secrets.mjs')).href);
const TOOLS = path.join(BOARD_LIB, '..');
const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const S = 1000;
const MIN = 60 * S;
const iso = (ms) => new Date(ms).toISOString();
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return !!fn(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killOwn = (pid) => { if (pid && alive(pid)) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* уже нет */ } } };

// временная доска: mode/push по тесту, голый origin в своей временной папке, состояние отправки — вне git
// origin — ссылка refs/remotes/origin/main без сети (для ahead довольно; push по пути через sh.exe под нагрузкой — секунды);
// bare — настоящий голый «origin» во временной папке (тест с настоящим sync.mjs)
function syncBoard({ mode = 'live', push = true, origin = true, bare: withBare = false } = {}) {
  const dir = tmpDir('ext99-board-');
  fs.writeFileSync(path.join(dir, 'projects.md'), projectsMd(['EXT']));
  fs.mkdirSync(path.join(dir, 'EXT'));
  fs.writeFileSync(path.join(dir, 'EXT', 'n.txt'), '0');
  fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode, push, tz: 'Europe/Riga' }) + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.board-sync.json\n.board-sync.log\n.board.lock\n.board-hold.log\n');
  gitInitCommit(dir);
  if (origin && !withBare) git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (withBare) {
    const bare = tmpDir('ext99-origin-');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  return dir;
}
let seq = 0;
// коммит с датой автора (oldestAheadAt — по %at); тело — новая строка файла
function commitAt(dir, ms) {
  fs.appendFileSync(path.join(dir, 'EXT', 'n.txt'), `\n${++seq}`);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', 'commit', '-q', '-am', `c${seq}`],
    { windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: `@${Math.floor(ms / 1000)} +0000` } });
}
const pushOrigin = (dir) => git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); // «отправил хук»: origin/main = HEAD
const writeState = (dir, s) => fs.writeFileSync(path.join(dir, '.board-sync.json'), JSON.stringify(s, null, 2) + '\n');

// планировщик на подменных часах и подменном запуске: run(reason) → {pid, done, rearm}; коды — по очереди из codes,
// пустая очередь — вызов висит, пока тест не скажет end()
function harness(dir, { cfg = {}, codes = [], hang = false, lock = lockLib } = {}) {
  const h = { now: T0, calls: [], lines: [] };
  const run = (reason) => {
    const c = { reason, at: h.now, pid: 40000 + h.calls.length, rearmed: 0 };
    c.done = new Promise((res) => { c.end = (r) => res(typeof r === 'object' ? r : { code: r, ms: 10 }); });
    h.calls.push(c);
    if (!hang) { const code = codes.length ? codes.shift() : 0; c.end(code); } else if (codes.length) c.end(codes.shift());
    return { pid: c.pid, done: c.done, rearm: () => { c.rearmed++; } };
  };
  h.bs = createBoardSync({ root: dir, cfg: { ...BOARD_SYNC_DEFAULTS, enabled: true, ...cfg }, git: createGitRead(), lock, scan, now: () => h.now, run,
    log: { write: (event, f = {}) => h.lines.push({ event, ...f }) }, wakeJumpMs: 90 * S });
  h.tick = async () => { await h.bs.tick(); await settle(); };
  h.step = async (sec = 5) => { h.now += sec * S; await h.tick(); };
  h.advance = async (sec) => { for (let i = 0; i < sec; i += 5) await h.step(5); };
  h.jump = async (ms) => { h.now += ms; await h.tick(); };
  h.of = (event) => h.lines.filter((l) => l.event === event);
  return h;
}

// --- поводы ---

test('тишина: смена HEAD в 0 и 30 с → вызов ровно один, через 60 с после второй (не после первой)', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  commitAt(dir, T0);
  await h.step(); // T0+5: увидена первая смена
  await h.advance(30);
  commitAt(dir, h.now);
  await h.step(); // вторая смена увидена здесь
  const second = h.now;
  await h.advance(55);
  assert.equal(h.calls.length, 0, 'через 60 с после ПЕРВОЙ смены вызова быть не должно — таймер взводится заново');
  await h.advance(10);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].reason, 'quiet');
  const d = h.calls[0].at - second;
  assert.ok(d >= 60 * S && d <= 65 * S, `задержка ${d} мс`);
  await h.advance(120);
  assert.equal(h.calls.length, 1, 'второго вызова нет');
  assert.deepEqual(h.of('board-sync').map((l) => [l.reason, l.code]), [['quiet', 0]]);
});

test('тишина: ahead = 0 к сроку (отправил хук) → вызова нет; исправный случай — без отправки вызов есть', async () => {
  for (const pushed of [true, false]) {
    const dir = syncBoard();
    const h = harness(dir);
    await h.tick();
    commitAt(dir, T0);
    await h.step();
    if (pushed) pushOrigin(dir);
    await h.advance(70);
    assert.equal(h.calls.length, pushed ? 0 : 1, pushed ? 'ahead 0 — вызова нет' : 'ahead 1 — вызов');
  }
});

test('15 мин: без смен HEAD вызов через 15 мин бодрствования, не раньше', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  await h.advance(14 * 60 + 55);
  assert.equal(h.calls.length, 0);
  await h.advance(10);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].reason, 'period');
  assert.equal(h.bs.status().ahead, 0, 'зовётся и при ahead = 0');
});

test('15 мин: удачная отправка хуком (lastOk) на 10-й мин сдвигает срок; без неё — вызов на 15-й', async () => {
  for (const hook of [true, false]) {
    const dir = syncBoard();
    const h = harness(dir);
    await h.tick();
    await h.advance(10 * 60);
    if (hook) writeState(dir, { lastOk: iso(h.now), ahead: 0 });
    await h.advance(5 * 60 + 10);
    assert.equal(h.calls.length, hook ? 0 : 1, hook ? 'срок сдвинут хуком' : 'срок не сдвинут');
    if (hook) { await h.advance(10 * 60); assert.equal(h.calls.length, 1, 'через 15 мин от lastOk хука — вызов'); }
  }
});

test('пробуждение: скачок 2 ч при взведённых «тишине» и «15 мин» → ровно один вызов через 60 с, не пачка', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  await h.advance(14 * 60);
  commitAt(dir, h.now);
  await h.step(); // «тишина» взведена, «15 мин» вот-вот
  await h.jump(2 * 3600 * S);
  const woke = h.now;
  await h.advance(55);
  assert.equal(h.calls.length, 0, 'сразу после пробуждения вызова нет (сеть не поднялась)');
  await h.advance(10);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].reason, 'wake');
  assert.ok(h.calls[0].at - woke >= 60 * S);
  await h.advance(5 * 60);
  assert.equal(h.calls.length, 1, 'пачки нет: «тишина» и «15 мин» сброшены');
  await h.advance(10 * 60 + 10);
  assert.equal(h.calls.length, 2, '«15 мин» — от вызова пробуждения');
  assert.equal(h.calls[1].reason, 'period');
});

test('пробуждение: идущий в момент сна вызов не снят — его таймаут отсчитан заново (rearm)', async () => {
  const dir = syncBoard();
  const h = harness(dir, { hang: true });
  await h.tick();
  await h.advance(15 * 60 + 5);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].rearmed, 0, 'без сна таймаут не трогается');
  await h.jump(3600 * S);
  assert.equal(h.calls[0].rearmed, 1, 'на пробуждении таймаут идущего вызова — заново');
  assert.ok(h.bs.status().running, 'вызов не снят');
});

// --- одновременно, код 3, повторы ---

test('код 3: строка board-sync {code: 3}, один повтор через 60 с, уровень не красный', async () => {
  const dir = syncBoard();
  const h = harness(dir, { codes: [3, 0] });
  await h.tick();
  commitAt(dir, T0);
  await h.step();
  await h.advance(65);
  assert.equal(h.calls.length, 1);
  const end1 = h.calls[0].at; // подменный вызов кончается в том же шаге
  assert.equal(h.of('board-sync')[0].code, 3);
  assert.notEqual(h.bs.status().level, 'red');
  while (h.now < end1 + 55 * S) await h.step(5);
  assert.equal(h.calls.length, 1, 'повтор не раньше 60 с');
  await h.advance(10);
  assert.equal(h.calls.length, 2, 'один повтор');
  assert.ok(h.calls[1].at - end1 >= 60 * S);
  assert.equal(h.of('board-sync')[1].retry, true);
});

test('код 3 два раза подряд (повод и его повтор) → третьего вызова до следующего повода нет', async () => {
  const dir = syncBoard();
  const h = harness(dir, { codes: [3, 3, 0] });
  await h.tick();
  commitAt(dir, T0);
  await h.step();
  await h.advance(140);
  assert.equal(h.calls.length, 2);
  await h.advance(10 * 60);
  assert.equal(h.calls.length, 2, 'повтор с кодом 3 нового повтора не ставит');
  commitAt(dir, h.now);
  await h.step();
  await h.advance(65);
  assert.equal(h.calls.length, 3, 'следующий повод — обычный вызов');
});

test('два повода, пока свой вызов идёт → после конца ровно один повторный', async () => {
  const dir = syncBoard();
  const h = harness(dir, { hang: true });
  await h.tick();
  commitAt(dir, T0);
  await h.step();
  await h.advance(65);
  assert.equal(h.calls.length, 1);
  commitAt(dir, h.now); await h.step(); await h.advance(65);
  commitAt(dir, h.now); await h.step(); await h.advance(65);
  assert.equal(h.calls.length, 1, 'пока вызов идёт — второго нет');
  h.calls[0].end(0);
  await h.step();
  assert.equal(h.calls.length, 2, 'после конца — один повторный');
  h.calls[1].end(0);
  await h.advance(120);
  assert.equal(h.calls.length, 2, 'ровно один');
});

test('свой вызов идёт, повод пришёл, но к концу ahead = 0 → повторного нет', async () => {
  const dir = syncBoard();
  const h = harness(dir, { hang: true });
  await h.tick();
  commitAt(dir, T0); await h.step(); await h.advance(65);
  commitAt(dir, h.now); await h.step(); await h.advance(65);
  pushOrigin(dir);
  h.calls[0].end(0);
  await h.advance(30);
  assert.equal(h.calls.length, 1);
});

// --- не зовётся ---

test('mode: mirror → 0 вызовов, board-sync-skip {why: mode} один раз, не каждые 5 с', async () => {
  const dir = syncBoard({ mode: 'mirror' });
  const h = harness(dir);
  await h.tick();
  commitAt(dir, T0);
  await h.step();
  await h.advance(16 * 60);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['mode']);
  // смена причины — новая строка; снятие причины — вызов по ближайшему поводу
  fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode: 'live', push: false }));
  await h.step();
  assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['mode', 'push']);
});

test('push: false → 0 вызовов, жёлтое push-off; исправный случай push: true — вызов есть', async () => {
  for (const push of [false, true]) {
    const dir = syncBoard({ push });
    const h = harness(dir);
    await h.tick();
    commitAt(dir, T0); await h.step(); await h.advance(70);
    assert.equal(h.calls.length, push ? 1 : 0);
    if (!push) assert.deepEqual([h.bs.status().level, h.bs.status().why], ['yellow', 'push-off']);
  }
});

test('board.config.json не читается или mode неясен → 0 вызовов, skip {why: config}', async () => {
  for (const text of ['{не json', JSON.stringify({ mode: 'zerkalo', push: true })]) {
    const dir = syncBoard();
    fs.writeFileSync(path.join(dir, 'board.config.json'), text);
    const h = harness(dir);
    await h.tick();
    await h.advance(16 * 60);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['config']);
  }
});

test('выключено: boardSync.enabled = false → 0 вызовов при смене HEAD и через 15 мин; состояние для шапки есть', async () => {
  const dir = syncBoard();
  const h = harness(dir, { cfg: { enabled: false } });
  await h.tick();
  commitAt(dir, T0);
  await h.step();
  await h.advance(16 * 60);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['off']);
  const f = h.bs.freshness();
  assert.equal(f.ahead, 1);
  assert.equal(f.level, 'grey');
  assert.equal(f.why, 'pending');
  assert.equal(h.bs.status().on, false);
});

test('pult.enabled = false при boardSync.enabled = true → отправка включена (от пульта не зависит); умолчание — выключена', () => {
  assert.equal(boardSyncConfig({ pult: { enabled: false }, boardSync: { enabled: true } }).enabled, true);
  assert.equal(boardSyncConfig({ pult: { enabled: true } }).enabled, false);
  assert.equal(boardSyncConfig({}).enabled, false);
  const def = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8'));
  const { _comment, ...bsDef } = def.boardSync;
  assert.deepEqual(bsDef, { enabled: false, quietS: 60, periodMin: 15, wakeDelayS: 60, timeoutS: 300, yellowMin: 20, redMin: 60 });
  assert.deepEqual(boardSyncConfig({ boardSync: { quietS: 5 } }), { ...bsDef, quietS: 5 });
});

// --- перебазирование висит ---

const ownLock = (dir, over = {}) => fs.writeFileSync(path.join(dir, '.board.lock'), JSON.stringify({ pid: process.pid, as: 'sync', cmd: 'sync', at: iso(Date.now()), boot: lockLib.bootTime(), ...over }));

test('перебазирование висит: .git/rebase-merge 61 с при свободной .board.lock → 0 вызовов, красное rebase; 59 с — не красное', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  commitAt(dir, T0);
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
  await h.step(1);
  await h.step(59);
  assert.notEqual(h.bs.status().why, 'rebase', '59 с — не красное');
  await h.step(2);
  assert.deepEqual([h.bs.status().level, h.bs.status().why], ['red', 'rebase']);
  await h.advance(16 * 60);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['rebase']);
});

test('отсоединённый HEAD 61 с → 0 вызовов, красное rebase, skip {why: detached}', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  git(dir, 'checkout', '-q', '--detach');
  await h.step(1);
  await h.step(61);
  assert.deepEqual([h.bs.status().level, h.bs.status().why], ['red', 'rebase']);
  assert.deepEqual(h.of('board-sync-skip').map((l) => l.why), ['detached']);
  await h.advance(16 * 60);
  assert.equal(h.calls.length, 0);
});

test('исправный случай рядом: rebase-merge при занятой .board.lock (чужой идущий sync) 2 мин → не красное, вызова нет', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
  ownLock(dir, { at: iso(h.now) });
  commitAt(dir, T0);
  await h.step(1);
  await h.advance(120);
  assert.notEqual(h.bs.status().level, 'red');
  assert.equal(h.calls.length, 0);
});

test('мёртвый замок: rebase-merge и .board.lock с мёртвым pid старше 60 с или boot другой загрузки → красное через 60 с', async () => {
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => dead.once('exit', r));
  for (const over of [{ pid: dead.pid, at: iso(T0 - 2 * MIN) }, { boot: lockLib.bootTime() - 24 * 3600 * S, at: iso(T0) }]) {
    const dir = syncBoard();
    const h = harness(dir);
    await h.tick();
    fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
    ownLock(dir, { at: iso(h.now), ...over });
    await h.step(1);
    await h.step(61);
    assert.deepEqual([h.bs.status().level, h.bs.status().why], ['red', 'rebase'], JSON.stringify(over));
  }
});

test('блокировка и rebase-merge сняты → отложенный повод исполнен на первом опросе (вызов один, повод не потерян)', async () => {
  const dir = syncBoard();
  const h = harness(dir);
  await h.tick();
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
  ownLock(dir, { at: iso(h.now) });
  commitAt(dir, T0);
  await h.step(1);
  await h.advance(90); // срок «тишины» прошёл при перебазировании
  assert.equal(h.calls.length, 0);
  fs.rmSync(path.join(dir, '.git', 'rebase-merge'), { recursive: true });
  fs.rmSync(path.join(dir, '.board.lock'));
  await h.step();
  assert.equal(h.calls.length, 1, 'на первом опросе без перебазирования');
  assert.equal(h.calls[0].reason, 'quiet');
  await h.advance(60);
  assert.equal(h.calls.length, 1);
});

// --- сбой sync и состояние ---

test('сбой sync: код 5 и lastError → board-sync {code: 5}, жёлтое net; через 60 мин бодрствования — красное', async () => {
  const dir = syncBoard();
  const h = harness(dir, { codes: [5] });
  await h.tick();
  await h.advance(15 * 60); // по сроку, ahead = 0: отставание не примешивается к «сети»
  writeState(dir, { lastError: 'fatal: unable to access', since: iso(h.now), ahead: 1 });
  await h.step();
  assert.equal(h.calls.length, 1);
  assert.equal(h.of('board-sync')[0].code, 5);
  assert.deepEqual([h.bs.status().level, h.bs.status().why], ['yellow', 'net']);
  await h.advance(59 * 60);
  assert.equal(h.bs.status().level, 'yellow');
  await h.advance(70);
  assert.deepEqual([h.bs.status().level, h.bs.status().why], ['red', 'net']);
});

test('lastError с https://u:p@h/x и ключом ghp_… → в /api/health и в шапке нет ни логина, ни пароля, ни ключа', async () => {
  const dir = syncBoard();
  const key = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
  writeState(dir, { lastError: `fatal: unable to access 'https://ivan:Pa55word@github.com/x/board.git/': ${key} 403`, since: iso(T0), ahead: 1 });
  const h = harness(dir);
  await h.tick();
  const all = JSON.stringify([h.bs.status(), h.bs.freshness(), boardSyncLine(h.bs.freshness())]);
  for (const bad of ['ivan', 'Pa55word', key, 'ghp_Ab3']) assert.ok(!all.includes(bad), `утечка: ${bad}`);
  assert.match(h.bs.status().lastError, /https:\/\/github\.com/);
  assert.ok([...h.bs.status().lastError].length <= 120);
});

test('коды 4, 6, 7 (conflict, dirty, hold) → красные по таблице §2.12; conflict — номера карточек', async () => {
  const cases = [
    [{ conflict: ['EXT/EXT-12.md', 'EXT/EXT-12.log.md', 'CAR/CAR-3.log.md', 'projects.md'] }, 'conflict'],
    [{ dirty: ['EXT/EXT-5.md'] }, 'dirty'],
    [{ hold: ['inbox/a.png'] }, 'hold'],
  ];
  for (const [st, why] of cases) {
    const dir = syncBoard();
    writeState(dir, st);
    const h = harness(dir);
    await h.tick();
    assert.deepEqual([h.bs.status().level, h.bs.status().why], ['red', why]);
    if (why === 'conflict') {
      assert.deepEqual(h.bs.status().conflict, ['EXT-12', 'CAR-3']);
      assert.equal(h.bs.status().conflictOther, 1);
      assert.deepEqual(h.bs.freshness().conflictIds, ['EXT-12', 'CAR-3']);
    }
  }
});

test('ahead: в файле 0, а в origin/main..HEAD 3 коммита → ahead 3 и pending; старейший 25 мин — жёлтое behind', async () => {
  const dir = syncBoard();
  writeState(dir, { lastOk: iso(T0 - 30 * MIN), ahead: 0 });
  // старейший по автору — не первый и не последний в выводе log (порядок log — по дате коммиттера)
  commitAt(dir, T0 - 10 * MIN); commitAt(dir, T0 - 25 * MIN); commitAt(dir, T0 - 2 * MIN);
  const h = harness(dir, { cfg: { enabled: false } });
  await h.tick();
  assert.equal(h.bs.status().ahead, 3);
  assert.equal(h.bs.status().oldestAheadAt, iso(T0 - 25 * MIN), 'наименьшее %at, не последняя строка');
  assert.deepEqual([h.bs.status().level, h.bs.status().why], ['yellow', 'behind']);
  const dir2 = syncBoard();
  commitAt(dir2, T0 - 5 * MIN); commitAt(dir2, T0 - 4 * MIN); commitAt(dir2, T0 - 3 * MIN);
  const h2 = harness(dir2, { cfg: { enabled: false } });
  await h2.tick();
  assert.deepEqual([h2.bs.status().ahead, h2.bs.status().level, h2.bs.status().why], [3, 'grey', 'pending']);
});

test('ahead: коммит перед сном 8 ч → не жёлтое (возраст по бодрствованию); origin/main нет → ahead null', async () => {
  const dir = syncBoard();
  const h = harness(dir, { cfg: { enabled: false } });
  await h.tick();
  commitAt(dir, h.now);
  await h.step();
  await h.jump(8 * 3600 * S);
  await h.step();
  assert.equal(h.bs.status().ahead, 1);
  assert.equal(h.bs.status().level, 'grey', 'проспанное не старит');
  await h.advance(20 * 60);
  assert.equal(h.bs.status().why, 'behind', 'исправный случай: 20 мин бодрствования — жёлтое');
  const dir2 = syncBoard({ origin: false });
  const h2 = harness(dir2, { cfg: { enabled: false } });
  await h2.tick();
  assert.equal(h2.bs.status().ahead, null);
});

test('уровень: таблица §2.12 на подменных часах (inbox, unread, самая тяжёлая причина)', () => {
  const cfg = { ...BOARD_SYNC_DEFAULTS };
  const base = { mode: 'live', push: true, state: {}, ahead: 0, oldestAheadAt: null, now: T0, slept: () => 0, cfg, rebase: false, unreadSince: null };
  assert.deepEqual(syncLevel(base), { level: 'grey', why: 'ok' });
  assert.deepEqual(syncLevel({ ...base, state: { inbox_blocked: ['inbox/x.md'] } }), { level: 'yellow', why: 'inbox' });
  assert.deepEqual(syncLevel({ ...base, unreadSince: T0 - 59 * S }), { level: 'grey', why: 'ok' });
  assert.deepEqual(syncLevel({ ...base, unreadSince: T0 - 61 * S }), { level: 'yellow', why: 'unread' });
  // несколько причин — самая тяжёлая; при равных — первая по таблице
  assert.deepEqual(syncLevel({ ...base, state: { dirty: ['a'], hold: ['b'], inbox_blocked: ['c'] } }), { level: 'red', why: 'dirty' });
  assert.deepEqual(syncLevel({ ...base, ahead: 2, oldestAheadAt: iso(T0 - 61 * MIN), state: { conflict: ['EXT/EXT-1.md'] } }), { level: 'red', why: 'behind' });
  assert.deepEqual(syncLevel({ ...base, ahead: 2, oldestAheadAt: iso(T0 - 61 * MIN), push: false }), { level: 'red', why: 'behind' });
});

// --- шапка ---

test('шапка: тексты дословно по таблице §2.12, уровень — класс строки', () => {
  const at = iso(T0);
  const d = new Date(T0);
  const p2 = (n) => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const f = (o) => boardSyncLine({ lastOkAt: at, ahead: 0, oldestAheadAt: at, errorSince: at, conflictIds: [], inboxBlocked: 0, by: 'hook', ...o });
  assert.equal(f({ level: 'grey', why: 'ok' }).text, `на GitHub · ${hm}`);
  assert.equal(f({ level: 'grey', why: 'pending', ahead: 4 }).text, `на GitHub · ${hm} · ждут отправки: 4`);
  assert.equal(f({ level: 'yellow', why: 'behind', ahead: 4 }).text, `не отправлено 4 · с ${hm}`);
  assert.equal(f({ level: 'yellow', why: 'net', ahead: 2 }).text, `отправка не удаётся с ${hm} · не отправлено 2`);
  assert.equal(f({ level: 'yellow', why: 'push-off' }).text, 'отправка выключена (push: false)');
  assert.equal(f({ level: 'yellow', why: 'inbox', inboxBlocked: 2 }).text, 'входящие не приняты: 2 — похоже на секрет');
  assert.equal(f({ level: 'yellow', why: 'unread' }).text, 'состояние отправки не читается');
  assert.equal(f({ level: 'red', why: 'behind', ahead: 4 }).text, `не отправлено 4 · с ${hm} — проверь`);
  assert.equal(f({ level: 'red', why: 'net', ahead: 2 }).text, `отправка не удаётся с ${hm} · не отправлено 2 — проверь`);
  assert.equal(f({ level: 'red', why: 'conflict', conflictIds: ['EXT-12'] }).text, 'не отправляется: конфликт EXT-12 — решает владелец');
  assert.equal(f({ level: 'red', why: 'dirty' }).text, 'не отправляется: правка мимо board — зови дирижёра');
  assert.equal(f({ level: 'red', why: 'hold' }).text, 'не отправляется: картинки ждут твоего взгляда');
  assert.equal(f({ level: 'red', why: 'rebase' }).text, 'доска посреди перебазирования — зови дирижёра');
  assert.equal(f({ level: 'red', why: 'dirty' }).cls, 'fresh-bad');
  assert.equal(f({ level: 'yellow', why: 'unread' }).cls, 'fresh-warn');
  assert.equal(f({ level: 'grey', why: 'ok' }).cls, '');
  assert.match(f({ level: 'grey', why: 'ok' }).title, /конец сессии/);
  assert.match(f({ level: 'grey', why: 'ok', by: 'extractor' }).title, /витрина/);
  assert.equal(boardSyncLine(null), null);
});

// --- процесс (настоящие процессы node; подменный sync во временной папке) ---

const FAKE_SYNC = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'cfg.json'), 'utf8'));
const mark = (o) => fs.appendFileSync(path.join(dir, 'marks.log'), JSON.stringify({ pid: process.pid, ...o }) + '\\n');
mark({ ev: 'start', argv: process.argv.slice(2), env: Object.keys(process.env) });
if (cfg.child) {
  // ребёнок отсоединён (как git-remote-http у git): со смертью родителя сам не уходит — снимает только дерево по pid
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'ext99-child-' + cfg.tag], { stdio: 'ignore', windowsHide: true, detached: true });
  fs.writeFileSync(path.join(dir, 'child.pid'), String(c.pid));
}
setTimeout(() => { mark({ ev: 'end', code: cfg.code ?? 0 }); process.exit(cfg.code ?? 0); }, cfg.ms ?? 0);
`;
function fakeSync(cfg) {
  const dir = tmpDir('ext99-fake-');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'sync.mjs'), FAKE_SYNC);
  fs.writeFileSync(path.join(dir, 'tools', 'cfg.json'), JSON.stringify(cfg));
  const marks = () => { try { return fs.readFileSync(path.join(dir, 'tools', 'marks.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, script: path.join(dir, 'tools', 'sync.mjs'), marks, childPid: () => Number(fs.readFileSync(path.join(dir, 'tools', 'child.pid'), 'utf8')) };
}

test('процесс: аргументы массивом (--by extractor, --root), detached, windowsHide, stdio ignore, без --detach; окружение без ключей сессии и Plane', async () => {
  const f = fakeSync({ code: 0 });
  const seen = [];
  const spy = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return spawn(cmd, args, opts); };
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDECODE: '1', PLANE_API_KEY: 'k', PLANE_URL: 'u' };
  const r = createSyncRun({ root: f.dir, spawn: spy, env, timeoutMs: 20000 });
  const h = r.start('quiet');
  const res = await h.done;
  assert.equal(res.code, 0, 'код выхода — событием exit при живом родителе');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, process.execPath);
  assert.deepEqual(seen[0].args, [path.join(f.dir, 'tools', 'sync.mjs'), '--by', 'extractor', '--root', f.dir]);
  assert.equal(seen[0].opts.detached, true);
  assert.equal(seen[0].opts.windowsHide, true);
  assert.equal(seen[0].opts.stdio, 'ignore');
  const m = f.marks().find((x) => x.ev === 'start');
  assert.deepEqual(m.argv, ['--by', 'extractor', '--root', f.dir]);
  assert.ok(!m.argv.includes('--detach'));
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'PLANE_API_KEY', 'PLANE_URL']) assert.ok(!m.env.includes(k), `в окружении sync есть ${k}`);
  assert.ok(m.env.some((k) => /^path$/i.test(k)), 'исправный случай: прочее окружение на месте');
});

test('процесс: код выхода 7 приходит событием exit', async () => {
  const f = fakeSync({ code: 7, ms: 200 });
  const res = await createSyncRun({ root: f.dir, timeoutMs: 20000 }).start('period').done;
  assert.equal(res.code, 7);
  assert.equal(typeof res.ms, 'number');
});

test('процесс: висит дольше таймаута (2 с) со своим ребёнком → оба сняты деревом по pid, {code: null, timedOut: true}', async () => {
  const f = fakeSync({ child: true, tag: `t${process.pid}`, ms: 600000 });
  const h = createSyncRun({ root: f.dir, timeoutMs: 2000 }).start('quiet');
  let child = null;
  try {
    assert.ok(await until(() => fs.existsSync(path.join(f.dir, 'tools', 'child.pid'))));
    child = f.childPid();
    assert.ok(alive(h.pid) && alive(child), 'до таймаута оба живы');
    const res = await h.done;
    assert.equal(res.code, null);
    assert.equal(res.timedOut, true);
    assert.ok(await until(() => !alive(h.pid) && !alive(child), 5000), 'sync и его ребёнок сняты');
  } finally { killOwn(child); killOwn(h.pid); }
});

test('процесс: таймаут, отсчитанный заново (rearm), не снимает живой вызов; без rearm — снял бы', async () => {
  const f = fakeSync({ ms: 2500, code: 0 });
  const h = createSyncRun({ root: f.dir, timeoutMs: 1500 }).start('quiet');
  await sleep(1000);
  h.rearm();
  const res = await h.done;
  assert.equal(res.code, 0, 'дожил до своего конца');
  const f2 = fakeSync({ ms: 2500, code: 0 });
  const res2 = await createSyncRun({ root: f2.dir, timeoutMs: 1500 }).start('quiet').done;
  assert.equal(res2.timedOut, true, 'исправный случай: без rearm — таймаут');
});

test('процесс: не запустился → code SPAWN', async () => {
  const res = await createSyncRun({ root: tmpDir('ext99-none-'), node: path.join(tmpDir('ext99-nonode-'), 'нет-node.exe'), timeoutMs: 5000 }).start('quiet').done;
  assert.equal(res.code, 'SPAWN');
});

test('процесс: дожил после выхода родителя — настоящим процессом; без detached метки нет', async () => {
  const PARENT = `import fs from 'node:fs';
const [lib, root, det, pidFile, marks] = process.argv.slice(2);
const { createSyncRun } = await import(lib);
const h = createSyncRun({ root, detached: det === '1', timeoutMs: 60000 }).start('quiet');
fs.writeFileSync(pidFile, String(h.pid));
// выход — как только ребёнок записал «start» (иначе отрицательный контроль пуст: ребёнок не успел бы и родиться)
const t = Date.now();
const iv = setInterval(() => { if (fs.existsSync(marks) || Date.now() - t > 20000) process.exit(0); }, 20);
`;
  const pdir = tmpDir('ext99-parent-');
  fs.writeFileSync(path.join(pdir, 'parent.mjs'), PARENT);
  const libUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'board-sync.mjs')).href;
  const out = {};
  for (const det of ['1', '0']) {
    const f = fakeSync({ ms: 4000, code: 0 });
    const pidFile = path.join(pdir, `pid-${det}.txt`);
    const p = spawn(process.execPath, [path.join(pdir, 'parent.mjs'), libUrl, f.dir, det, pidFile, path.join(f.dir, 'tools', 'marks.log')], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => p.once('exit', r));
    assert.ok(f.marks().some((m) => m.ev === 'start'), 'подменный sync запустился');
    await sleep(5500);
    out[det] = f.marks().some((m) => m.ev === 'end');
    try { killOwn(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* нет файла */ }
  }
  assert.equal(out['1'], true, 'с detached метка дописана после выхода родителя');
  assert.equal(out['0'], false, 'отрицательный контроль: без detached метки нет');
});

test('штатная остановка посреди подменного sync → board-sync-left {pid} в журнале, sync не снят, метка дописана', async () => {
  const f = fakeSync({ ms: 2500, code: 0 });
  const lines = [];
  let now = Date.now();
  const bs = createBoardSync({ root: f.dir, cfg: { ...BOARD_SYNC_DEFAULTS, enabled: true }, git: createGitRead(), lock: lockLib, scan, now: () => now,
    run: createSyncRun({ root: f.dir, timeoutMs: 20000 }).start, log: { write: (e, x = {}) => lines.push({ event: e, ...x }) }, stopWaitMs: 500, wakeJumpMs: 3600 * S });
  fs.writeFileSync(path.join(f.dir, 'board.config.json'), JSON.stringify({ mode: 'live', push: true }));
  await bs.tick(); now += 16 * MIN; await bs.tick();
  const pid = bs.status().running.pid;
  await bs.stop();
  assert.deepEqual(lines.filter((l) => l.event === 'board-sync-left').map((l) => l.pid), [pid]);
  assert.ok(await until(() => f.marks().some((m) => m.ev === 'end'), 6000), 'sync доработал');
  // исправный случай: короткий sync за время ожидания кончается — строки left нет, есть board-sync
  const f2 = fakeSync({ ms: 100, code: 0 });
  const lines2 = [];
  const bs2 = createBoardSync({ root: f2.dir, cfg: { ...BOARD_SYNC_DEFAULTS, enabled: true }, git: createGitRead(), lock: lockLib, scan, now: () => now,
    run: createSyncRun({ root: f2.dir, timeoutMs: 20000 }).start, log: { write: (e, x = {}) => lines2.push({ event: e, ...x }) }, stopWaitMs: 3000, wakeJumpMs: 3600 * S });
  fs.writeFileSync(path.join(f2.dir, 'board.config.json'), JSON.stringify({ mode: 'live', push: true }));
  await bs2.tick(); now += 16 * MIN; await bs2.tick();
  await bs2.stop();
  assert.equal(lines2.filter((l) => l.event === 'board-sync-left').length, 0);
  assert.equal(lines2.filter((l) => l.event === 'board-sync').length, 1);
});

// --- настоящий sync.mjs на временной доске ---

test('хук и витрина сразу, настоящий sync.mjs на временной доске → обе строки в .board-sync.log, коммиты на origin один раз', async () => {
  const dir = syncBoard({ bare: true });
  fs.cpSync(TOOLS, path.join(dir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) });
  fs.appendFileSync(path.join(dir, '.gitignore'), 'tools/\n');
  commitAt(dir, Date.now()); commitAt(dir, Date.now());
  const hook = spawn(process.execPath, [path.join(dir, 'tools', 'sync.mjs'), '--by', 'hook', '--root', dir], { windowsHide: true, stdio: 'ignore' });
  const mine = createSyncRun({ root: dir, timeoutMs: 120000 }).start('quiet');
  const [hc, res] = await Promise.all([new Promise((r) => hook.once('exit', r)), mine.done]);
  const log = fs.readFileSync(path.join(dir, '.board-sync.log'), 'utf8');
  assert.match(log, /\thook\t/);
  assert.match(log, /\textractor\t/);
  assert.ok([0, 3].includes(hc) && [0, 3].includes(res.code), `коды ${hc}, ${res.code}`);
  const remote = git(dir, 'config', '--get', 'remote.origin.url').trim();
  const subjects = execFileSync('git', ['-C', remote, 'log', '--format=%s', 'main'], { encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean);
  const theirs = subjects.filter((s) => /^c\d+$/.test(s));
  assert.equal(theirs.length, 2, 'два коммита доски на origin');
  assert.equal(new Set(theirs).size, 2, 'каждый — один раз');
  assert.equal(git(dir, 'rev-list', '--count', 'origin/main..HEAD').trim(), '0');
});

// --- витрина целиком: /api/health → boardSync, freshness.boardSync, server.log, actions.log ---

function request(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

test('витрина: pult выключен, boardSync включён → вызов идёт; /api/health → boardSync, /api/ceh → freshness.boardSync; server.log — board-sync; actions.log не появляется', async () => {
  const board = syncBoard();
  const f = fakeSync({ code: 0, ms: 100 });
  fs.cpSync(path.join(f.dir, 'tools'), path.join(board, 'tools'), { recursive: true });
  fs.appendFileSync(path.join(board, '.gitignore'), 'tools/\n');
  const reg = path.join(tmpDir('ext99-reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const dataDir = tmpDir('ext99-data-');
  const port = 49000 + Math.floor(Math.random() * 900);
  const config = { port, toasts: false, paths: { board, boardLib: BOARD_LIB, registry: reg }, pollMs: { board: 200, journals: 500 }, statsEveryMin: 10,
    pult: { enabled: false }, boardSync: { enabled: true, quietS: 1 } };
  const s = await startServer({ config, dataDir, readEvents: async () => [] });
  const marks = () => { try { return fs.readFileSync(path.join(board, 'tools', 'marks.log'), 'utf8'); } catch { return ''; } };
  try {
    await sleep(500);
    commitAt(board, Date.now());
    assert.ok(await until(() => /"end"/.test(marks()), 10000), 'подменный sync позван');
    assert.match(marks(), /"--by","extractor","--root"/);
    const slog = () => fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8');
    assert.ok(await until(() => / board-sync reason=quiet code=0 /.test(slog()), 5000), slog());
    const h = await request(port, '/api/health');
    for (const k of ['on', 'mode', 'push', 'lastOkAt', 'by', 'ahead', 'oldestAheadAt', 'lastError', 'errorSince', 'conflict', 'dirty', 'hold', 'inboxBlocked', 'level', 'why', 'running', 'last', 'next', 'readError']) assert.ok(k in h.boardSync, `нет boardSync.${k}`);
    assert.equal(h.boardSync.on, true);
    assert.equal(h.boardSync.last.code, 0);
    assert.equal(h.boardSync.last.reason, 'quiet');
    const c = await request(port, '/api/ceh');
    for (const k of ['level', 'why', 'lastOkAt', 'ahead', 'oldestAheadAt', 'errorSince', 'conflictIds']) assert.ok(k in c.freshness.boardSync, `нет freshness.boardSync.${k}`);
    assert.equal(fs.existsSync(path.join(dataDir, 'actions.log')), false, 'отправка в actions.log не пишет');
  } finally { await s.stop(); }
});
