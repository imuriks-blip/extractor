// EXT-87: «Замерить остаток» (спека пульта §6 п.2–п.4) — устройство замера, поле remaining новой формы, свежесть, тревога по ценовым
// весам, пропуск папки сессии замера читателем журналов. Настоящий claude.exe не вызывается: подменный бинарник test/fake-claude.mjs
// (через node), у каждого случая поломки — исправный рядом. Ожидания — числа, положенные в фикстуру, не значения из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createMeasure, findClaudeBin, sessionDirName, measureEnv, AUTH_MESSAGE } from '../lib/pult/measure.mjs';
import { createUsage, buildUsage, buildRemaining } from '../lib/usage.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { createProcessReader } from '../lib/processes.mjs';
import { createRateLimitReader } from '../lib/rate-limit.mjs';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { CHECKS } from '../lib/pult/guard.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const MIN = 60000;
const H = 3600000;
const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// замер с подменным бинарником; mode — поведение; clock — часы теста
function rig({ mode = 'ok', ceilingMs = 60000, clock = { t: T0 }, env = {}, findBin, log } = {}) {
  const dir = path.join(tmpDir('measure-'), 'measure');
  const out = path.join(tmpDir('fake-out-'), 'run.json');
  const pids = path.join(path.dirname(out), 'pids.json');
  const launches = [];
  const logLines = [];
  const m = createMeasure({
    dir, ceilingMs, now: () => clock.t,
    env: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_OUT: out, FAKE_PIDS: pids, ...env },
    findBin: findBin ?? (() => FAKE),
    launch: (bin, args, opts) => { launches.push({ bin, args, opts }); return spawn(process.execPath, [bin, ...args], opts); },
    log: log ?? { write: (ev, f) => logLines.push({ ev, ...f }) },
  });
  const killLeft = () => { // свои хвосты: pid, записанные самим подменным бинарником этого теста
    try { const p = readJson(pids); for (const pid of [p.grandchild, p.child]) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ушёл */ } } } catch { /* не зависал */ }
  };
  return { m, dir, out, pids, launches, logLines, clock, killLeft, run: () => readJson(out) };
}

test('удача: запуск — константа, окружение без переменных десктопа, настройки гасят хуки; показанное число = событию в потоке; last.json и log.jsonl', async () => {
  const r = rig({ env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_CODE_SSE_PORT: '5', CLAUDE_KEEP: 'да', FAKE_RESET: String(Math.floor(T0 / 1000) + 3 * 3600) } });
  const res = await r.m.act({});
  const reset = Math.floor(T0 / 1000) + 3 * 3600;
  assert.equal(res.outcome, 'ok');
  assert.equal(res.message, `5 ч: 69 % · сброс ${hhmm(reset * 1000)} · 7 дн: 34 % · замер ${hhmm(T0)}`);
  const run = r.run();
  // запуск — ровно константа спеки (§6 п.2); путь настроек подставляет витрина
  const settingsFile = path.join(r.dir, 'settings.json');
  assert.deepEqual(run.args, ['-p', 'Ответь одним словом: ок', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--settings', settingsFile, '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', '0.2', '--include-hook-events']);
  assert.deepEqual(run.settings, { disableAllHooks: true });
  assert.equal(path.resolve(run.cwd).toLowerCase(), path.resolve(r.dir).toLowerCase(), 'cwd — data/vitrina/measure');
  // окружение: переменных сессии десктопа нет, прочие CLAUDE* остаются
  assert.deepEqual(run.claudeEnv, ['CLAUDE_KEEP']);
  // не отсоединённый процесс, без окна
  assert.equal(r.launches[0].opts.detached, undefined);
  assert.equal(r.launches[0].opts.windowsHide, true);
  // исправный случай приёмки: число, показанное из last.json, совпало с событием в КОПИИ потока замера
  const streamEv = fs.readFileSync(path.join(r.dir, 'last-stream.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((j) => j.type === 'rate_limit_event');
  const last = readJson(path.join(r.dir, 'last.json'));
  assert.equal(last.fiveHour.utilization, streamEv.rate_limit_info.unifiedWindows.five_hour.utilization);
  assert.equal(last.sevenDay.utilization, streamEv.rate_limit_info.unifiedWindows.seven_day.utilization);
  assert.equal(last.fiveHour.resetsAt, reset);
  assert.equal(last.at, new Date(T0).toISOString(), 'время — получение строки (часы теста)');
  assert.equal(last.costUsd, 0.0123);
  assert.equal(last.status, 'allowed');
  const rows = fs.readFileSync(path.join(r.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows, [{ at: new Date(T0).toISOString(), ok: true, costUsd: 0.0123, tokens: 10 + 20 + 300 + 4 }]);
  assert.equal(fs.readdirSync(r.dir).some((n) => n.endsWith('.tmp')), false, 'запись атомарная: временных файлов не осталось');
});

test('окружение: measureEnv снимает CLAUDECODE и CLAUDE_CODE_* (любой регистр), остальное не трогает', () => {
  const e = measureEnv({ CLAUDECODE: '1', claudecode: '1', CLAUDE_CODE_X: '1', Claude_Code_Y: '1', CLAUDE_OTHER: '1', PATH: 'p', ANTHROPIC_FOO: 'f' });
  assert.deepEqual(Object.keys(e).sort(), ['ANTHROPIC_FOO', 'CLAUDE_OTHER', 'PATH']);
});

test('неудача не затирает last.json: нет события лимита — error словами, строка ok:false; исправный повтор после — заменяет', async () => {
  const clock = { t: T0 };
  const good = rig({ clock });
  await good.m.act({});
  const before = fs.readFileSync(path.join(good.dir, 'last.json'), 'utf8');
  // тот же каталог, другой режим: новый замер без события лимита, спустя 6 мин (окно повтора прошло)
  clock.t += 6 * MIN;
  const bad = createMeasure({ dir: good.dir, now: () => clock.t, env: { PATH: process.env.PATH, FAKE_MODE: 'noevent' }, findBin: () => FAKE, launch: (b, a, o) => spawn(process.execPath, [b, ...a], o) });
  const res = await bad.act({});
  assert.equal(res.outcome, 'error');
  assert.match(res.message, /замер не удался: в ответе Claude нет события лимита/);
  assert.equal(fs.readFileSync(path.join(good.dir, 'last.json'), 'utf8'), before, 'last.json цел');
  const rows = fs.readFileSync(path.join(good.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].reason, /нет события лимита/);
  // исправный: удачный замер после неудачи last.json обновляет
  clock.t += 6 * MIN;
  const again = createMeasure({ dir: good.dir, now: () => clock.t, env: { PATH: process.env.PATH, FAKE_MODE: 'ok' }, findBin: () => FAKE, launch: (b, a, o) => spawn(process.execPath, [b, ...a], o) });
  assert.equal((await again.act({})).outcome, 'ok');
  assert.equal(readJson(path.join(good.dir, 'last.json')).at, new Date(clock.t).toISOString());
});

test('событие лимита без окон — неудача: last.json цел, строка ok:false; исправный рядом — с окнами заменяет', async () => {
  const clock = { t: T0 };
  const good = rig({ clock });
  await good.m.act({});
  const before = fs.readFileSync(path.join(good.dir, 'last.json'), 'utf8');
  clock.t += 6 * MIN;
  const bad = createMeasure({ dir: good.dir, now: () => clock.t, env: { PATH: process.env.PATH, FAKE_MODE: 'nowindows' }, findBin: () => FAKE, launch: (b, a, o) => spawn(process.execPath, [b, ...a], o) });
  const res = await bad.act({});
  assert.equal(res.outcome, 'error');
  assert.match(res.message, /в событии лимита нет окон/);
  assert.equal(fs.readFileSync(path.join(good.dir, 'last.json'), 'utf8'), before, 'last.json цел');
  const rows = fs.readFileSync(path.join(good.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).ok, false);
  clock.t += 6 * MIN;
  const again = createMeasure({ dir: good.dir, now: () => clock.t, env: { PATH: process.env.PATH, FAKE_MODE: 'ok' }, findBin: () => FAKE, launch: (b, a, o) => spawn(process.execPath, [b, ...a], o) });
  assert.equal((await again.act({})).outcome, 'ok');
  assert.equal(readJson(path.join(good.dir, 'last.json')).fiveHour.utilization, 0.69);
});

test('повтор раньше 5 мин не запускает (reused: true, прежний результат); позже — запускает', async () => {
  const r = rig();
  const first = await r.m.act({});
  assert.equal(r.launches.length, 1);
  r.clock.t += 4 * MIN + 59000;
  const again = await r.m.act({});
  assert.equal(again.outcome, 'ok');
  assert.deepEqual(again.extra, { reused: true });
  assert.match(again.message, new RegExp(`замер был в ${hhmm(T0)}`));
  assert.match(again.message, /5 ч: 69 %/);
  assert.equal(r.launches.length, 1, 'запуска не было');
  assert.equal(first.outcome, 'ok');
  r.clock.t += 2000; // 5 мин 1 с от замера
  const third = await r.m.act({});
  assert.equal(r.launches.length, 2, 'после 5 мин — новый запуск');
  assert.equal(third.extra, undefined);
});

test('ответ «Failed to authenticate» — понятная ошибка про вход; прежний замер цел; исправный случай рядом', async () => {
  const r = rig({ mode: 'auth' });
  const res = await r.m.act({});
  assert.equal(res.outcome, 'error');
  assert.equal(res.message, `замер не удался: ${AUTH_MESSAGE}`);
  assert.match(res.message, /вход Claude истёк/);
  assert.equal(fs.existsSync(path.join(r.dir, 'last.json')), false);
  const ok = rig({ mode: 'ok' });
  assert.equal((await ok.m.act({})).outcome, 'ok');
});

test('Claude не найден: error без запуска; исправный — найден', async () => {
  const none = rig({ findBin: () => null });
  const res = await none.m.act({});
  assert.deepEqual([res.outcome, res.message], ['error', 'замер не удался: Claude не найден']);
  assert.equal(none.launches.length, 0);
  assert.equal((await rig().m.act({})).outcome, 'ok');
});

test('хуки: в потоке есть hook_started — строка error в server.log, замер всё равно засчитан; без них строки нет', async () => {
  const bad = rig({ mode: 'hooks' });
  const res = await bad.m.act({});
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(bad.logLines.filter((l) => l.ev === 'error'), [{ ev: 'error', route: 'measure', code: 'HOOKS', events: 1 }]);
  assert.equal(bad.m.today(T0).count, 1);
  const clean = rig({ mode: 'ok' });
  await clean.m.act({});
  assert.deepEqual(clean.logLines, []);
});

test('потолок: зависший замер снят деревом по своему pid — ни процесса, ни внука; прежний результат цел; быстрый замер потолка не касается', async () => {
  const r = rig({ mode: 'hang', ceilingMs: 6000 });
  try {
    const t0 = Date.now();
    const res = await r.m.act({});
    assert.ok(Date.now() - t0 < 30000);
    assert.equal(res.outcome, 'error');
    assert.match(res.message, /превышен потолок/);
    for (let i = 0; i < 200 && !fs.existsSync(r.pids); i++) await sleep(50); // подменный бинарник мог записать pids уже после снятия
    const p = readJson(r.pids);
    assert.ok(Number.isInteger(p.child) && Number.isInteger(p.grandchild));
    await sleep(300);
    assert.equal(alive(p.child), false, 'процесс замера снят');
    assert.equal(alive(p.grandchild), false, 'потомок снят вместе с деревом — сирот нет');
    assert.equal(fs.existsSync(path.join(r.dir, 'last.json')), false);
    const row = fs.readFileSync(path.join(r.dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(row.ok, false);
    // после снятия замер свободен: идущего нет
    assert.equal(r.m.running(), false);
  } finally { r.killLeft(); }
  const quick = rig({ mode: 'ok', ceilingMs: 6000 });
  assert.equal((await quick.m.act({})).outcome, 'ok');
});

test('остановка витрины (stop) снимает идущий замер деревом; сирот нет', async () => {
  const r = rig({ mode: 'hang', ceilingMs: 60000 });
  try {
    const pending = r.m.act({});
    for (let i = 0; i < 100 && !fs.existsSync(r.pids); i++) await sleep(50);
    const p = readJson(r.pids);
    assert.equal(r.m.running(), true);
    assert.ok(alive(p.child) && alive(p.grandchild), 'до остановки оба живы');
    await r.m.stop();
    const res = await pending;
    assert.equal(res.outcome, 'error');
    await sleep(300);
    assert.equal(alive(p.child), false);
    assert.equal(alive(p.grandchild), false);
    assert.equal(r.m.running(), false);
  } finally { r.killLeft(); }
});

test('поиск программы в двух местах: наибольшая версия (числом, не строкой) из пакета десктопа и профиля; нигде нет — null', () => {
  const mk = (root, rel) => { const f = path.join(root, rel, 'claude.exe'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
  const env = (local, app) => ({ LOCALAPPDATA: local, APPDATA: app });
  const pkg = (local, v) => mk(local, path.join('Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code', v, 'abc'));
  const prof = (app, v) => mk(app, path.join('Claude', 'claude-code', v, 'def'));
  // профиль новее
  let L = tmpDir('local-'); let A = tmpDir('app-');
  pkg(L, '2.1.99'); const newer = prof(A, '2.1.100');
  assert.equal(findClaudeBin({ env: env(L, A) }), newer, '2.1.100 > 2.1.99 (числом)');
  // пакет новее
  L = tmpDir('local-'); A = tmpDir('app-');
  const pk = pkg(L, '2.1.293'); prof(A, '2.1.100');
  assert.equal(findClaudeBin({ env: env(L, A) }), pk);
  // только одно место — берётся оно (исправные случаи по одному)
  L = tmpDir('local-'); A = tmpDir('app-');
  const only = pkg(L, '2.0.1');
  assert.equal(findClaudeBin({ env: env(L, A) }), only);
  L = tmpDir('local-'); A = tmpDir('app-');
  const onlyP = prof(A, '2.0.2');
  assert.equal(findClaudeBin({ env: env(L, A) }), onlyP);
  // нигде нет; папка версии без программы не годится
  L = tmpDir('local-'); A = tmpDir('app-');
  fs.mkdirSync(path.join(A, 'Claude', 'claude-code', '9.9.9', 'zzz'), { recursive: true });
  assert.equal(findClaudeBin({ env: env(L, A) }), null);
  assert.equal(findClaudeBin({ env: {} }), null);
});

test('имя папки сессии замера — правило Claude (не буквенно-цифровой знак → «-»), выводится из cwd; у другого каталога данных — другое', () => {
  assert.equal(sessionDirName('C:\\projects\\extractor\\data\\vitrina\\measure'), 'C--projects-extractor-data-vitrina-measure');
  assert.notEqual(sessionDirName('C:\\tmp\\other-data\\measure'), sessionDirName('C:\\projects\\extractor\\data\\vitrina\\measure'));
});

// ---- читатели журналов пропускают папку сессии замера ----
const us = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
let seq = 0;
const asst = (sid, ms, usage) => ({ type: 'assistant', uuid: `00000000-0000-4000-8000-${String(++seq + 87000).padStart(12, '0')}`, timestamp: new Date(ms).toISOString(), sessionId: sid, isSidechain: false, version: '2.1.0',
  message: { id: `m${seq}`, role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage } });

test('папку сессии замера журналы пропускают (тред, расход, «Ждёт меня» её не видят); такая же в другой папке читается', async () => {
  const root = tmpDir('jr-');
  const measureDir = path.resolve(tmpDir('data-'), 'measure');
  const skipName = sessionDirName(measureDir);
  const put = (proj, sid, rows) => { fs.mkdirSync(path.join(root, proj), { recursive: true }); fs.writeFileSync(path.join(root, proj, `${sid}.jsonl`), rows.map((x) => `${JSON.stringify(x)}\n`).join('')); };
  put(skipName.toUpperCase(), 'measure-sid', [asst('measure-sid', T0 - H, us(999, 0, 0, 0))]); // регистр имени на Windows не важен
  put('C--proj', 'real-sid', [asst('real-sid', T0 - H, us(7, 0, 0, 0))]);
  const mk = (skipDirs) => createJournalReader({ root, indexDir: tmpDir('ji-'), now: () => new Date(T0), skipDirs });
  const skipping = mk([skipName]);
  await skipping.refresh();
  assert.deepEqual(skipping.sessions().map((s) => s.sessionId).sort(), ['real-sid'], 'потока замера среди сессий нет — нового треда и строки «Ждёт меня» не будет');
  const usage = createUsage({ journals: skipping, rateLimit: null, board: { hasCode: () => false, hasCard: () => false, mirrorIndex: () => null }, now: () => T0, cacheMs: 0 });
  assert.equal(usage.payload().week.total, 7, 'расход не считает сессию замера');
  // исправный: без пропуска та же папка читается — тест видит разницу
  const plain = mk([]);
  await plain.refresh();
  assert.deepEqual(plain.sessions().map((s) => s.sessionId).sort(), ['measure-sid', 'real-sid']);
  // горячий проход (новые файлы после первого прохода) папку тоже пропускает
  put(skipName, 'measure-sid-2', [asst('measure-sid-2', T0 - 1000, us(5, 0, 0, 0))]);
  await skipping.refresh();
  assert.deepEqual(skipping.sessions().map((s) => s.sessionId).sort(), ['real-sid']);
});

test('реестр процессов пропускает процесс сессии замера по cwd (регистр и слэши не важны); чужой cwd и такой же без пропуска — читаются', async () => {
  const measureDir = path.resolve(tmpDir('data-'), 'measure');
  const sf = (pid, sid, cwd) => JSON.stringify({ pid, sessionId: sid, cwd, startedAt: T0, procStart: '1', version: '2.1.0', kind: 'interactive', entrypoint: 'cli', status: 'busy' });
  const files = { '101.json': sf(101, 'measure-sid', measureDir.toUpperCase().replace(/\\/g, '/')), '102.json': sf(102, 'real-sid', 'C:\\proj') };
  const fakeFs = { readdirSync: () => Object.keys(files), readFileSync: (p) => files[path.basename(p)] };
  const mk = (skipCwds) => createProcessReader({ dir: 'C:/s', fs: fakeFs, now: () => T0, isAlive: () => true, procStartOf: async (pids) => new Map(pids.map((p) => [p, '1'])), skipCwds });
  const skipping = mk([measureDir]);
  await skipping.refresh();
  assert.deepEqual(skipping.entries().map((e) => e.sessionId), ['real-sid'], 'процесса замера среди живых нет — треда и строки «Кто работает» не будет');
  assert.equal(skipping.state().live, 1);
  const plain = mk([]);
  await plain.refresh();
  assert.deepEqual(plain.entries().map((e) => e.sessionId).sort(), ['measure-sid', 'real-sid'], 'без пропуска тот же файл читается');
});

// ---- остаток новой формы и свежесть ----
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const nowS = NOW / 1000;
const mlast = (agoMin, { five = 0.69, seven = 0.34, fiveResetIn = 2 * 3600, sevenResetIn = 3 * 86400 } = {}) => ({ at: new Date(NOW - agoMin * MIN).toISOString(),
  fiveHour: { utilization: five, resetsAt: nowS + fiveResetIn }, sevenDay: { utilization: seven, resetsAt: nowS + sevenResetIn }, status: 'allowed', costUsd: 0.01, usage: null });
const rem = (measure, extra = {}) => buildRemaining({ measure, nowMs: NOW, ...extra }).remaining;

test('форма remaining: ровно ключи спеки §1.7; замер — ageKind exact, resetsAt строкой', () => {
  const r = rem(mlast(5));
  assert.deepEqual(Object.keys(r), ['source', 'at', 'ageSec', 'ageKind', 'fiveHour', 'sevenDay']);
  assert.deepEqual(Object.keys(r.fiveHour), ['utilization', 'resetsAt', 'fresh']);
  assert.equal(r.source, 'measure');
  assert.equal(r.ageKind, 'exact');
  assert.equal(r.ageSec, 300);
  assert.deepEqual(r.fiveHour, { utilization: 0.69, resetsAt: new Date((nowS + 7200) * 1000).toISOString(), fresh: true });
  assert.equal(r.sevenDay.utilization, 0.34);
  assert.equal(buildRemaining({ measure: null, nowMs: NOW }).remaining, null);
});

test('свежесть 5 ч: число есть при 29 мин и на границе 30, нет при 31 мин; при смене окна (resetsAt в прошлом) нет даже у свежего события', () => {
  assert.equal(rem(mlast(29)).fiveHour.utilization, 0.69);
  assert.equal(rem(mlast(30)).fiveHour.fresh, true, 'ровно 30 мин — ещё свежее («не больше 30»)');
  const old = rem(mlast(31));
  assert.deepEqual([old.fiveHour.fresh, old.fiveHour.utilization], [false, null]);
  const changed = rem(mlast(1, { fiveResetIn: -1 }));
  assert.deepEqual([changed.fiveHour.fresh, changed.fiveHour.utilization], [false, null], 'окно сменилось');
  assert.equal(changed.sevenDay.utilization, 0.34, 'недельное при этом свежее и остаётся');
  // число не уходит на страницу вовсе: в JSON ответа несвежего окна нет цифр
  assert.equal(JSON.stringify(old.fiveHour).includes('0.69'), false);
});

test('свежесть 7 дн: число есть при 5 ч 59 мин, нет при 6 ч 1 мин; настройки порогов работают', () => {
  assert.equal(rem(mlast(359)).sevenDay.utilization, 0.34);
  const old = rem(mlast(361));
  assert.deepEqual([old.sevenDay.fresh, old.sevenDay.utilization], [false, null]);
  assert.equal(old.fiveHour.utilization, null);
  assert.equal(rem(mlast(361), { cfg: { freshSevenDayH: 7 } }).sevenDay.utilization, 0.34);
  assert.equal(rem(mlast(40), { cfg: { freshFiveHourMin: 45 } }).fiveHour.utilization, 0.69);
});

test('свежесть 7 дн: недельное окно сменилось (resetsAt в прошлом) при возрасте события < 6 ч — utilization: null; resetsAt в будущем — число показано', () => {
  const changed = rem(mlast(10, { sevenResetIn: -60 }));
  assert.deepEqual([changed.sevenDay.fresh, changed.sevenDay.utilization], [false, null], 'окно сменилось — число старого окна не показывается');
  assert.equal(JSON.stringify(changed.sevenDay).includes('0.34'), false);
  assert.equal(changed.fiveHour.utilization, 0.69, 'пятичасовое при этом свежее и остаётся');
  const ok = rem(mlast(10, { sevenResetIn: 60 }));
  assert.deepEqual([ok.sevenDay.fresh, ok.sevenDay.utilization], [true, 0.34]);
});

test('источники: прораб — нижняя граница возраста (lowerBound); побеждает самый свежий, при равенстве — замер', () => {
  const runs = tmpDir('rl-runs-');
  const d = path.join(runs, 'r1'); fs.mkdirSync(d);
  const ev = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: nowS + 3600 }, seven_day: { utilization: 0.1, resetsAt: nowS + 86400 } } } });
  fs.writeFileSync(path.join(d, 'stream.jsonl'), `${ev}\n`);
  const mt = nowS - 20 * 60; fs.utimesSync(path.join(d, 'stream.jsonl'), mt, mt);
  const rl = createRateLimitReader({ dir: runs, now: () => NOW }).get();
  const f = rl.remaining;
  const onlyF = buildRemaining({ measure: null, foreman: f, nowMs: NOW }).remaining;
  assert.equal(onlyF.source, 'foreman');
  assert.equal(onlyF.ageKind, 'lowerBound');
  assert.equal(onlyF.ageSec, 1200);
  assert.equal(onlyF.fiveHour.utilization, 0.2);
  // замер старше прораба — показан прораб; новее — замер
  assert.equal(buildRemaining({ measure: mlast(25), foreman: f, nowMs: NOW }).remaining.source, 'foreman');
  assert.equal(buildRemaining({ measure: mlast(5), foreman: f, nowMs: NOW }).remaining.source, 'measure');
  assert.equal(buildRemaining({ measure: mlast(20), foreman: f, nowMs: NOW }).remaining.source, 'measure', 'равны — замер (время точное)');
  // прораб, не моложе 40 мин: 5 ч уже не показывается, и это та же проверка, что у замера
  utimes40(d);
  const stale = buildRemaining({ measure: null, foreman: createRateLimitReader({ dir: runs, now: () => NOW }).get().remaining, nowMs: NOW }).remaining;
  assert.equal(stale.fiveHour.utilization, null);
  assert.equal(stale.sevenDay.utilization, 0.1);
});
function utimes40(d) { const mt = nowS - 40 * 60; fs.utimesSync(path.join(d, 'stream.jsonl'), mt, mt); }

test('createUsage: remaining новой формы, measuring и measures из счётчиков замера; свежесть считается на момент ответа, мимо кэша объёма', async () => {
  const journals = { usageRecords: () => [], usageGen: () => 1, sessions: () => [] };
  let clock = NOW;
  let running = false;
  const m = { last: () => mlast(10), running: () => running, today: () => ({ count: 2, costUsd: 0.05, tokens: 900 }) };
  const u = createUsage({ journals, rateLimit: null, measure: m, board: null, now: () => clock, cacheMs: 60000 });
  const a = u.payload();
  assert.equal(a.remaining.fiveHour.utilization, 0.69);
  assert.equal(a.measuring, false);
  assert.deepEqual(a.measures, { today: { count: 2, costUsd: 0.05, tokens: 900 } });
  running = true;
  assert.equal(u.payload().measuring, true);
  clock += 25 * MIN; // кэш объёма ещё жив, а событию уже 35 мин
  const b = u.payload();
  assert.equal(b.remaining.fiveHour.utilization, null);
  assert.equal(b.remaining.sevenDay.utilization, 0.34);
});

test('счёт замеров за сегодня — из log.jsonl: удачные в count, вчерашние не считаются', async () => {
  const r = rig();
  await r.m.act({});
  fs.appendFileSync(path.join(r.dir, 'log.jsonl'), `${JSON.stringify({ at: new Date(T0 - 2 * 86400000).toISOString(), ok: true, costUsd: 5, tokens: 1000 })}\n`);
  fs.appendFileSync(path.join(r.dir, 'log.jsonl'), `${JSON.stringify({ at: new Date(T0).toISOString(), ok: false, reason: 'x' })}\n`);
  assert.deepEqual(r.m.today(T0), { count: 1, costUsd: 0.0123, tokens: 334 });
});

// ---- тревога по ценовым весам: фикстура — числа из спеки §6 п.4, посчитанные вручную ----
const rec = (k, over) => ({ t: NOW - (k * 5 + 2.5) * H, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main', ...over });
const past3 = [1, 2, 3].map((k) => rec(k, { out: 1200000 })); // вывод ×5 = 6 000 000 в каждом из трёх окон, медиана 6 000 000, порог 9 000 000
const cur = (over) => ({ t: NOW - H, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main', ...over });

test('тревога по весам: чтение кэша 50 000 000 (взвешенно 5 000 000) при пороге 9 000 000 — тревоги нет; вывод 2 000 000 (10 000 000) — тревога', () => {
  const quiet = buildUsage({ records: [...past3, cur({ cacheRead: 50000000 })], nowMs: NOW }).window5h;
  assert.equal(quiet.median, 6000000);
  assert.equal(quiet.total, 5000000);
  assert.equal(quiet.warn, false, 'невзвешенно 50 млн против 1,2 млн — тревога была бы ложной');
  const loud = buildUsage({ records: [...past3, cur({ out: 2000000 })], nowMs: NOW }).window5h;
  assert.equal(loud.total, 10000000);
  assert.equal(loud.warn, true);
  assert.match(loud.message, /выше обычного/);
  assert.match(loud.message, /≈ 10000000 условных токенов против медианы 6000000/);
  assert.match(loud.message, /вес: вывод ×5, чтение кэша ×0,1/);
  // плитки и разрезы — все четыре числа как есть
  const tiles = buildUsage({ records: [...past3, cur({ cacheRead: 50000000 })], nowMs: NOW });
  assert.equal(tiles.today.cacheRead + tiles.week.cacheRead >= 50000000, true);
  assert.equal(tiles.week.total, 3 * 1200000 + 50000000);
});

test('веса: ввод ×1, вывод ×5, запись кэша ×1,25, чтение кэша ×0,1 — по одному каждый; окно из одного чтения кэша непустое, из нулей — пустое', () => {
  const w = (over) => buildUsage({ records: [...past3, cur(over)], nowMs: NOW }).window5h.total;
  assert.equal(w({ in: 1000 }), 1000);
  assert.equal(w({ out: 1000 }), 5000);
  assert.equal(w({ cacheWrite: 1000 }), 1250);
  assert.equal(w({ cacheRead: 1000 }), 100);
  // «непустое окно» — по взвешенной сумме: прошлое окно только с чтением кэша 10 (вес 1) непусто, с нулями — пусто
  const prev = buildUsage({ records: [rec(1, { out: 1 }), rec(2, { cacheRead: 10 }), rec(3, { cacheWrite: 4 }), rec(4, {}), cur({ in: 1 })], nowMs: NOW }).window5h;
  assert.equal(prev.nonEmptyWindows, 3);
  assert.equal(prev.median, 5);
  assert.equal(prev.enough, true);
});

// ---- действие measure через POST /api/act ----
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const boardDir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
gitInitCommit(boardDir);
const regFile = path.join(tmpDir('reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard });
await board.init();
const registry = createRegistryReader(regFile);
const STUB = '<!doctype html><html><head><meta charset="utf-8"><meta name="vitrina-token" content="__VITRINA_TOKEN__"><title>t</title></head><body></body></html>';
let intents = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++intents + 870000).padStart(12, '0')}`;

async function appWith(measure, { enabled = true } = {}) {
  const web = tmpDir('web-'); fs.writeFileSync(path.join(web, 'index.html'), STUB);
  const data = tmpDir('pult-');
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, log: { write() {} }, measure,
    pult: { enabled, words: true, bell: false, bellDir: path.join(data, 'bell'), actionsLog: path.join(data, 'actions.log'), mirrorDir: tmpDir('mirror-'), lock: lockLib, boardRoot: boardDir },
    pultSeams: { checks: CHECKS } });
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = page.body.match(/content="([0-9a-f]{16,})"/)?.[1] ?? page.body.match(/vitrina-token" content="([^"]+)"/)[1];
  const post = (body) => app.inject({ method: 'POST', url: '/api/act', headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token }, payload: JSON.stringify(body) });
  return { app, post, data };
}

test('POST measure: второй щелчок во время замера — 409 measure-running; после конца — свободно (reused, 200); удачный замер — ok с сообщением', async () => {
  const r = rig({ mode: 'slow' });
  const { post, data } = await appWith(r.m);
  const first = post({ action: 'measure', intentId: uuid() });
  for (let i = 0; i < 100 && !r.m.running(); i++) await sleep(20);
  assert.equal(r.m.running(), true);
  const second = await post({ action: 'measure', intentId: uuid() });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().outcome, 'refused');
  assert.equal(second.json().refusal, 'measure-running');
  const done = await first;
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().outcome, 'ok');
  assert.match(done.json().message, /^5 ч: 69 % · сброс \d\d:\d\d · 7 дн: 34 % · замер \d\d:\d\d$/);
  assert.equal(done.json().reused, undefined);
  // исправный: замера нет — повтор не отказ, а прежний результат
  const third = await post({ action: 'measure', intentId: uuid() });
  assert.equal(third.statusCode, 200);
  assert.equal(third.json().reused, true);
  const lines = fs.readFileSync(path.join(data, 'actions.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.action === 'measure' && l.step === 'refused' && l.refusal === 'measure-running'));
  assert.equal(r.launches.length, 1);
});

test('POST measure: ошибка замера — 200 с outcome error и словами; тело — ровно {action, intentId}: иное поле — 400; пульт выключен — 503', async () => {
  const r = rig({ mode: 'auth' });
  const { post } = await appWith(r.m);
  const bad = await post({ action: 'measure', intentId: uuid() });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.json().outcome, 'error');
  assert.match(bad.json().message, /вход Claude истёк/);
  for (const extra of [{ kind: 'full' }, { text: 'x' }, { card: 'EXT-6' }, { confirm: 'W-000000-000000-0000' }, { project: 'EXT' }]) {
    const res = await post({ action: 'measure', intentId: uuid(), ...extra });
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  assert.equal(r.launches.length, 1, 'отказанные тела не запускали ничего');
  const off = await appWith(rig().m, { enabled: false });
  assert.equal((await off.post({ action: 'measure', intentId: uuid() })).statusCode, 503);
  // нет замера (не подключён) — 501, как у прочих неподключённых
  const none = await appWith(null);
  assert.equal((await none.post({ action: 'measure', intentId: uuid() })).statusCode, 501);
});
