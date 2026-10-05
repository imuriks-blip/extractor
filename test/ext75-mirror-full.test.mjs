// EXT-75, ПТ8, такт 1 (сервер): «Прогони зеркало» полным проходом (второй щелчок, §1.1 п.7), «уже идёт» любого вида,
// ход и итог прохода в данных страницы (/api/mirror: progress из status.json, lastRun из runs.log), «Пересобрать индекс».
// Запуск — подменный (fakeSpawn): настоящий mirror.mjs и wscript тесты не запускают. Ожидаемые значения — из спеки
// (таблица 1.3: «~1,5 ч, ~2 200 запросов…», «зеркало уже идёт (<вид> с ЧЧ:ММ)») и из положенных в тест файлов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { readLastRun } from '../lib/pult/mirror-status.mjs';
import { isRefusal } from '../web/src/mirrorData.js';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const PORT = 4317; // порт — только в Host запросов inject, на нём ничего не слушает
const SELF = `http://127.0.0.1:${PORT}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 0;
const nextIntent = () => uuid(++intents);
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

const boardDir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
gitInitCommit(boardDir);
const regFile = path.join(tmpDir('reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard });
await board.init();
const registry = createRegistryReader(regFile);
const STUB = '<!doctype html><html><head><meta charset="utf-8"><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>';

function launcherBoard() {
  const root = tmpDir('mboard-');
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'tools', 'mirror-hidden.js'), '// заглушка\n');
  return root;
}
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const c = { cmd, args, opts, unref: 0 };
    calls.push(c);
    const ch = new EventEmitter();
    ch.pid = 7000 + calls.length;
    ch.unref = () => { c.unref++; };
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  fn.calls = calls;
  return fn;
}
async function setup({ now, mirrorDir = tmpDir('mirror-'), journals, spawn = fakeSpawn() } = {}) {
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), STUB);
  const data = tmpDir('pult-');
  const actionsLog = path.join(data, 'actions.log');
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, journals, log: { write() {} },
    pult: { enabled: true, words: true, bell: false, actionsLog, mirrorDir, lock: lockLib, boardRoot: launcherBoard() },
    pultSeams: { now, spawn } });
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/content="([^"]+)"/)[1];
  const act = (body) => app.inject({ method: 'POST', url: '/api/act', headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token },
    payload: JSON.stringify({ intentId: nextIntent(), ...body }) });
  const mirror = async () => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();
  return { app, act, lines, mirror, mirrorDir, spawn, actionsLog };
}
const steps = (ls) => ls.map((l) => l.step);
const refusals = (ls) => ls.filter((l) => l.step === 'refused').map((l) => l.refusal);
const tick = () => new Promise((res) => setImmediate(res));
const PRICE = '~1,5 ч, ~2 200 запросов, треды это время делят лимит Plane';
// часы, идущие на 100 с с каждым чтением: своя память запуска (60 с) не держит, подтверждение (5 мин) ещё живо
const fastClock = () => { let x = Date.parse('2026-10-05T12:00:00+03:00'); return () => (x += 100000); };

// ---------------- 1. полный проход: второй щелчок ----------------

test('full без confirm — need-confirm с ценой, ничего не запущено; asked + need-confirm в actions.log, done нет', async () => {
  const { act, lines, spawn } = await setup();
  const r = await act({ action: 'mirror', kind: 'full' });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'need-confirm');
  assert.equal(b.step, 'need-confirm');
  assert.ok(b.message.includes(PRICE), b.message);
  assert.equal(b.confirm.follows, PRICE);
  assert.match(b.confirm.what, /полный проход/);
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual(steps(lines()), ['asked', 'need-confirm']);
  assert.equal(lines()[0].kind, 'full');
});

test('full со вторым щелчком (confirm = id первого) — wscript ... --full, без --changed, отсоединённо и без окна; шаги asked, confirmed, done', async () => {
  const { act, lines, spawn } = await setup();
  const first = (await act({ action: 'mirror', kind: 'full' })).json();
  const r = await act({ action: 'mirror', kind: 'full', confirm: first.id });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().step, r.json().outcome, r.json().message], ['done', 'ok', 'зеркало запущено']);
  assert.equal(spawn.calls.length, 1);
  const [c] = spawn.calls;
  assert.equal(path.basename(c.cmd).toLowerCase(), 'wscript.exe');
  assert.equal(c.args[0], '//B');
  assert.equal(c.args[5], '--full');
  assert.ok(!c.args.includes('--changed'));
  assert.ok(!c.args.includes('--exit-with-parent'), 'рестарт витрины проход не убивает');
  assert.deepEqual([c.opts.detached, c.opts.windowsHide, c.opts.stdio, c.unref], [true, true, 'ignore', 1]);
  const second = lines().filter((l) => l.id === r.json().id);
  assert.deepEqual(steps(second), ['asked', 'confirmed', 'done']);
  assert.equal(second[1].confirm, first.id);
});

test('отрицательный контроль: «обычный» проход — без подтверждения, прямой запуск с --changed (и по умолчанию тоже)', async () => {
  const { act, spawn } = await setup();
  assert.equal((await act({ action: 'mirror', kind: 'changed' })).json().outcome, 'ok');
  assert.equal(spawn.calls[0].args[5], '--changed');
  const d = await setup();
  assert.equal((await d.act({ action: 'mirror' })).json().outcome, 'ok');
  assert.equal(d.spawn.calls[0].args[5], '--changed');
});

test('confirm не от этого нажатия — refused bad-confirm, запуска нет: несуществующий id, id другого действия, id обычного прохода', async () => {
  const { act, lines, spawn } = await setup({ now: fastClock() });
  const ping = (await act({ action: 'ping' })).json();
  const changed = (await act({ action: 'mirror', kind: 'changed' })).json();
  assert.equal(spawn.calls.length, 1, 'запущен только обычный');
  for (const confirm of ['W-261005-120000-abcd', ping.id, changed.id]) {
    const r = await act({ action: 'mirror', kind: 'full', confirm });
    assert.equal(r.json().step, 'refused', confirm);
    assert.equal(r.json().outcome, 'refused');
  }
  assert.deepEqual(refusals(lines()), ['bad-confirm', 'bad-confirm', 'bad-confirm']);
  assert.equal(spawn.calls.length, 1, 'полный не запущен');
});

test('confirm потрачен — второй полный по тому же id bad-confirm; просрочен (> 5 мин после asked) — confirm-expired', async () => {
  let t = Date.parse('2026-10-05T12:00:00+03:00');
  const { act, spawn, lines } = await setup({ now: () => t });
  const first = (await act({ action: 'mirror', kind: 'full' })).json();
  assert.equal((await act({ action: 'mirror', kind: 'full', confirm: first.id })).json().outcome, 'ok');
  t += 61000; // память запуска (60 с) снята; пульса нет — «уже идёт» не мешает, но потраченное подтверждение не годится
  await act({ action: 'mirror', kind: 'full', confirm: first.id });
  assert.equal(refusals(lines()).at(-1), 'bad-confirm');
  assert.equal(spawn.calls.length, 1);
  const f2 = (await act({ action: 'mirror', kind: 'full' })).json();
  t += 5 * 60000 + 1000;
  await act({ action: 'mirror', kind: 'full', confirm: f2.id });
  assert.equal(refusals(lines()).at(-1), 'confirm-expired');
  assert.equal(spawn.calls.length, 1);
});

test('сбой запуска после confirm его не тратит: wscript не поднялся — 500 error, тот же confirm годится снова', async () => {
  const ok = fakeSpawn();
  let broken = true;
  const spawn = (...a) => {
    if (!broken) return ok(...a);
    const ch = new EventEmitter();
    ch.unref = () => {};
    process.nextTick(() => ch.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    return ch;
  };
  const { act, lines } = await setup({ spawn });
  const first = (await act({ action: 'mirror', kind: 'full' })).json();
  assert.equal((await act({ action: 'mirror', kind: 'full', confirm: first.id })).statusCode, 500);
  broken = false;
  const r2 = await act({ action: 'mirror', kind: 'full', confirm: first.id });
  assert.equal(r2.json().outcome, 'ok', JSON.stringify(lines().at(-1)));
  assert.equal(ok.calls.length, 1);
});

// ---------------- 2. «уже идёт» любого вида ----------------

test('«уже идёт»: идёт полный (пульс status.json) — и обычный, и полный (даже без confirm) → 409 mirror-running «зеркало уже идёт (full с ЧЧ:ММ)», запуска и need-confirm нет', async () => {
  const dir = tmpDir('mirror-');
  const t0 = Date.now();
  const started = t0 - 20 * 60000;
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(t0 - 20000).toISOString(), kind: 'full', progress: { phase: 'cards', cards_done: 3, cards_total: 9, at: new Date(t0 - 20000).toISOString(), started_at: new Date(started).toISOString() } }));
  const { act, spawn, lines } = await setup({ mirrorDir: dir });
  for (const body of [{ action: 'mirror', kind: 'changed' }, { action: 'mirror', kind: 'full' }]) {
    const r = await act(body);
    assert.equal(r.statusCode, 409);
    assert.deepEqual([r.json().step, r.json().message], ['refused', `зеркало уже идёт (full с ${hhmm(started)})`]);
  }
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual(steps(lines()), ['asked', 'refused', 'asked', 'refused']);
  assert.deepEqual(refusals(lines()), ['mirror-running', 'mirror-running']);
});

test('«уже идёт» по памяти 60 с: после запуска полного второе нажатие любого вида сразу — «уже идёт (full с …)», один запуск', async () => {
  const t = Date.parse('2026-10-05T12:00:00+03:00');
  const { act, spawn } = await setup({ now: () => t });
  const f = (await act({ action: 'mirror', kind: 'full' })).json();
  assert.equal((await act({ action: 'mirror', kind: 'full', confirm: f.id })).json().outcome, 'ok');
  const r = await act({ action: 'mirror', kind: 'changed' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().message, `зеркало уже идёт (full с ${hhmm(t)})`);
  assert.equal(spawn.calls.length, 1);
});

// ---------------- 3. данные страницы ----------------

const RUNS = [
  '2026-10-01T17:02:01.192Z · начало · full · pid 31716',
  '2026-10-01T18:38:24.187Z · конец · full · pid 31716 · код 0 · 5783 с · запросов 2231',
  '2026-10-02T16:44:28.870Z · начало · changed · pid 19612',
  '2026-10-02T16:52:46.031Z · конец · changed · pid 19612 · код 3 · 497 с · запросов 196',
  '2026-10-02T17:00:00.000Z · начало · changed · dry · pid 11',
  '2026-10-02T17:00:05.000Z · конец · changed · dry · pid 11 · код 0 · 5 с · запросов 1',
  '2026-10-02T22:24:56.748Z · начало · changed · pid 54060',
  'мусорная строка без разбора',
].join('\n');

test('/api/mirror: ход прохода из status.json (фаза, N из M, запросов, темп) и итог lastRun из runs.log (последняя пара «начало/конец», пробный проход не считается), первая строка lastError', async () => {
  const dir = tmpDir('mirror-');
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(t0 - 5000).toISOString(), kind: 'full', lastOk: '2026-10-01T18:38:24.185Z', lastError: 'проход красный — см. last-report.txt\nвторая строка',
    progress: { phase: 'comments', cards_done: 500, cards_total: 700, requests: 900, rpm: 23, at: new Date(t0 - 5000).toISOString(), started_at: new Date(t0 - 3600000).toISOString() } }));
  fs.writeFileSync(path.join(dir, 'runs.log'), RUNS);
  const { mirror } = await setup({ mirrorDir: dir });
  const m = await mirror();
  assert.deepEqual([m.running, m.kind, m.phase, m.cardsDone, m.cardsTotal, m.requests, m.rpm], [true, 'full', 'comments', 500, 700, 900, 23]);
  assert.equal(m.lastOk, '2026-10-01T18:38:24.185Z');
  assert.equal(m.lastError, 'проход красный — см. last-report.txt');
  assert.deepEqual(m.lastRun, { kind: 'changed', startedAt: '2026-10-02T16:44:28.870Z', endedAt: '2026-10-02T16:52:46.031Z', code: 3, seconds: 497, requests: 196 });
});

test('/api/mirror устойчив: нет runs.log, пустой, мусор, обрезанные строки, битый status.json — сервер отвечает, lastRun null или последняя разобранная', async () => {
  const dir = tmpDir('mirror-');
  const { mirror } = await setup({ mirrorDir: dir });
  assert.equal((await mirror()).lastRun, null, 'нет файла');
  assert.equal((await mirror()).reindex.running, false);
  fs.writeFileSync(path.join(dir, 'runs.log'), '');
  assert.equal((await mirror()).lastRun, null, 'пусто');
  fs.writeFileSync(path.join(dir, 'runs.log'), Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a, 0xc3, 0x28, 0x0a]));
  assert.equal((await mirror()).lastRun, null, 'мусор');
  fs.writeFileSync(path.join(dir, 'runs.log'), '2026-10-02T16:52:46.031Z · конец · full · pid 5 · код\nне-дата · конец · full · pid 6 · код 0\n');
  assert.deepEqual((await mirror()).lastRun, { kind: 'full', startedAt: null, endedAt: '2026-10-02T16:52:46.031Z', code: null, seconds: null, requests: null }, 'конец без начала и без кода');
  fs.writeFileSync(path.join(dir, 'status.json'), '{"at": "20');
  assert.equal((await mirror()).running, false, 'битый status.json');
  assert.equal(readLastRun(path.join(dir, 'нет-такого-каталога', 'runs.log')), null);
});

// ---------------- 4. «Пересобрать индекс» ----------------

// подменный читатель журналов: rebuild — под управлением теста
function fakeJournals() {
  const j = { calls: 0, progress: null, resolve: null, reject: null };
  j.state = () => ({ lastOkAt: null });
  j.rebuild = ({ onProgress }) => { j.calls++; j.progress = onProgress; return new Promise((res, rej) => { j.resolve = res; j.reject = rej; }); };
  return j;
}

test('reindex: запуск → ход «N из M журналов» в данных страницы → второй запрос «уже идёт» (409 reindex-running, rebuild один) → по окончании время; затем снова можно', async () => {
  const j = fakeJournals();
  let t = Date.parse('2026-10-05T12:00:00+03:00');
  const { act, mirror, lines } = await setup({ journals: j, now: () => t });
  const r = await act({ action: 'reindex' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().step, r.json().outcome], ['done', 'ok']);
  j.progress(3, 40);
  const m = (await mirror()).reindex;
  assert.deepEqual([m.running, m.done, m.total, m.startedAt], [true, 3, 40, new Date(t).toISOString()]);
  const dup = await act({ action: 'reindex' });
  assert.equal(dup.statusCode, 409);
  assert.deepEqual([dup.json().step, dup.json().outcome], ['refused', 'refused']);
  assert.match(dup.json().message, /уже пересобирается/);
  assert.match(dup.json().message, /3 из 40 журналов/);
  assert.equal(j.calls, 1);
  t += 90000;
  j.resolve({ files: 40 });
  await tick();
  const e = (await mirror()).reindex;
  assert.deepEqual([e.running, e.done, e.total, e.lastAt, e.lastMs, e.lastFiles, e.lastError], [false, null, null, new Date(t).toISOString(), 90000, 40, null]);
  assert.equal((await act({ action: 'reindex' })).json().outcome, 'ok', 'после конца — снова можно');
  assert.equal(j.calls, 2);
  assert.deepEqual(steps(lines()), ['asked', 'done', 'asked', 'refused', 'asked', 'done'], 'второй запрос — одна пара asked/refused, без error');
});

test('reindex: два запроса разом — один пересбор, второй «уже идёт»', async () => {
  const j = fakeJournals();
  const { act } = await setup({ journals: j });
  const [a, b] = await Promise.all([act({ action: 'reindex' }), act({ action: 'reindex' })]);
  assert.deepEqual([a.json().outcome, b.json().outcome].sort(), ['ok', 'refused']);
  assert.equal(j.calls, 1);
});

test('reindex: пересбор не удался — lastError (код), running снят, строка error у того же id в actions.log; повторить можно', async () => {
  const j = fakeJournals();
  const { act, mirror, lines } = await setup({ journals: j });
  const r = (await act({ action: 'reindex' })).json();
  j.reject(Object.assign(new Error('x'), { code: 'EACCES' }));
  await tick();
  const e = (await mirror()).reindex;
  assert.deepEqual([e.running, e.lastError, e.lastAt], [false, 'EACCES', null]);
  const err = lines().filter((l) => l.id === r.id).at(-1);
  assert.deepEqual([err.step, err.result.code], ['error', 'EACCES']);
  assert.equal((await act({ action: 'reindex' })).json().outcome, 'ok');
});

test('reindex без читателя журналов с rebuild — 501 «ещё не подключено», без строки в actions.log', async () => {
  const { act, lines } = await setup();
  assert.equal((await act({ action: 'reindex' })).statusCode, 501);
  assert.equal(lines().length, 0);
});

// ---------------- 4б. сам пересбор в читателе журналов ----------------

const SID = '2fea3135-c7db-442b-9907-4d619949881d';
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'journals');
const noTime = (ss) => JSON.stringify(ss.map((s) => ({ ...s, okAt: null })));
function tree() {
  const root = tmpDir('journals-');
  const proj = path.join(root, 'P1');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FX, `${SID}.jsonl`), path.join(proj, `${SID}.jsonl`));
  for (const f of fs.readdirSync(path.join(FX, SID, 'subagents'))) fs.copyFileSync(path.join(FX, SID, 'subagents', f), path.join(proj, SID, 'subagents', f));
  return root;
}

test('rebuild читателя: индекс пересоздан (испорченный файл → исправный), ход 0…M из M, прежние данные читаются в ходе пересбора, временного файла нет, рестарт берёт новый индекс', async () => {
  const root = tree();
  const indexDir = tmpDir('index-');
  const r = createJournalReader({ root, indexDir });
  await r.refresh();
  const before = JSON.stringify(r.sessions());
  const file = path.join(indexDir, 'journals.json');
  fs.writeFileSync(file, '{"v":1,"испорчен');
  const seen = [];
  let duringOk = true;
  const res = await r.rebuild({ onProgress: (d, m) => { seen.push([d, m]); if (JSON.stringify(r.sessions()) !== before) duringOk = false; } });
  const total = seen[0][1];
  assert.ok(total >= 2, 'журналов: сессия и субагент(ы)');
  assert.deepEqual(seen.map((x) => x[0]), Array.from({ length: total + 1 }, (_, i) => i));
  assert.ok(seen.every((x) => x[1] === total));
  assert.equal(res.files, total);
  assert.equal(duringOk, true, 'витрина читает прежние данные во время пересбора');
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(idx.files).length, total, 'индекс записан заново');
  assert.equal(noTime(r.sessions()), noTime(JSON.parse(before)), 'пересобранное совпало с прежним (кроме времени чтения)');
  assert.deepEqual(fs.readdirSync(indexDir).filter((n) => n.endsWith('.tmp')), []);
  const r2 = createJournalReader({ root, indexDir });
  await r2.refresh();
  assert.equal(noTime(r2.sessions()), noTime(JSON.parse(before)));
});

test('rebuild читателя: сбой чтения журнала — отказ, прежний индекс и данные целы (подмены нет); исправный случай того же читателя проходит', async () => {
  const root = tree();
  const indexDir = tmpDir('index-');
  let breakIt = false;
  const flaky = { ...fs, statSync: (p, ...a) => { if (breakIt && String(p).endsWith(`${SID}.jsonl`)) throw Object.assign(new Error('x'), { code: 'EIO' }); return fs.statSync(p, ...a); } };
  const r = createJournalReader({ root, indexDir, fs: flaky });
  await r.refresh();
  r.flush();
  const file = path.join(indexDir, 'journals.json');
  const idxBefore = fs.readFileSync(file, 'utf8');
  const before = JSON.stringify(r.sessions());
  breakIt = true;
  await assert.rejects(() => r.rebuild(), (e) => e.code === 'EIO');
  assert.equal(fs.readFileSync(file, 'utf8'), idxBefore);
  assert.equal(JSON.stringify(r.sessions()), before);
  breakIt = false;
  assert.ok((await r.rebuild()).files >= 2);
});

// ---------------- 5. вердикт Голема на db1837f ----------------

test('Голем, Критично: тело ответа /api/act несёт refusal — «уже идёт» зеркала и пересбора, bad-confirm (ответ, по которому экран различает отказы)', async () => {
  const dir = tmpDir('mirror-');
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(t0 - 2000).toISOString(), kind: 'full', progress: { phase: 'cards', at: new Date(t0 - 2000).toISOString(), started_at: new Date(t0 - 60000).toISOString() } }));
  const j = fakeJournals();
  const run = await setup({ mirrorDir: dir, journals: j });
  const m = await run.act({ action: 'mirror', kind: 'full' });
  assert.equal(m.statusCode, 409);
  assert.equal(m.json().refusal, 'mirror-running');
  assert.equal((await run.act({ action: 'reindex' })).json().outcome, 'ok');
  const r = await run.act({ action: 'reindex' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().refusal, 'reindex-running');
  // отрицательный контроль: другой отказ несёт свой код — экран не примет его за «уже идёт»
  const idle = await setup();
  const bad = await idle.act({ action: 'mirror', kind: 'full', confirm: 'W-261005-120000-aaaa' });
  assert.equal(bad.json().outcome, 'refused');
  assert.equal(bad.json().refusal, 'bad-confirm');
  assert.equal(isRefusal(bad.json(), 'mirror-running'), false);
  assert.equal(isRefusal(r.json(), 'reindex-running'), true);
  assert.equal(isRefusal(m.json(), 'mirror-running'), true);
  assert.equal(isRefusal({ outcome: 'ok' }, 'mirror-running'), false);
  assert.equal(isRefusal(null, 'mirror-running'), false);
});

test('Голем, Важно 2: lastRun — только обычный и полный проход; card/assets/links/decide (в том числе упавший card) итог не затирают; начало — ближайшее предшествующее того же pid и вида', async () => {
  const dir = tmpDir('mirror-');
  fs.writeFileSync(path.join(dir, 'runs.log'), [
    '2026-10-02T16:44:28.870Z · начало · changed · pid 19612',
    '2026-10-02T16:52:46.031Z · конец · changed · pid 19612 · код 0 · 497 с · запросов 196',
    '2026-10-02T17:00:00.000Z · начало · card · pid 20',
    '2026-10-02T17:00:09.000Z · конец · card · pid 20 · код 5 · 9 с · запросов 3',
    '2026-10-02T17:01:00.000Z · начало · assets · pid 21',
    '2026-10-02T17:01:02.000Z · конец · assets · pid 21 · код 0 · 2 с · запросов 1',
    '2026-10-02T17:02:00.000Z · начало · links · pid 22',
    '2026-10-02T17:02:02.000Z · конец · links · pid 22 · код 0 · 2 с · запросов 1',
    '2026-10-02T17:03:00.000Z · начало · decide-file · pid 23',
    '2026-10-02T17:03:02.000Z · конец · decide-file · pid 23 · код 0 · 2 с · запросов 1',
  ].join('\n'));
  const { mirror } = await setup({ mirrorDir: dir });
  assert.deepEqual((await mirror()).lastRun, { kind: 'changed', startedAt: '2026-10-02T16:44:28.870Z', endedAt: '2026-10-02T16:52:46.031Z', code: 0, seconds: 497, requests: 196 });
  // pid переиспользован: «начало» старого прохода не липнет к «концу» нового без своего «начала»; ближайшее предшествующее — своё
  fs.writeFileSync(path.join(dir, 'runs.log'), [
    '2026-10-01T10:00:00.000Z · начало · full · pid 7',
    '2026-10-01T11:00:00.000Z · конец · full · pid 7 · код 0 · 3600 с · запросов 2000',
    '2026-10-02T10:00:00.000Z · конец · full · pid 7 · код 0 · 5 с · запросов 9',
  ].join('\n'));
  assert.equal((await mirror()).lastRun.startedAt, null, 'начало уже использовано первым «концом»');
  fs.writeFileSync(path.join(dir, 'runs.log'), [
    '2026-10-01T10:00:00.000Z · начало · full · pid 7',
    '2026-10-01T10:30:00.000Z · начало · full · pid 7',
    '2026-10-01T11:00:00.000Z · конец · full · pid 7 · код 0 · 1800 с · запросов 5',
  ].join('\n'));
  assert.equal((await mirror()).lastRun.startedAt, '2026-10-01T10:30:00.000Z', 'ближайшее предшествующее');
});

const jlines = (root) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) n += fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length; } }; walk(root); return n; };

test('Голем, Важно 3: гонка rebuild — параллельный refresh и дозапись журнала во время пересбора: после подмены lines = числу строк файлов, без потерь и двойного счёта', async () => {
  const root = tree();
  const indexDir = tmpDir('index-');
  const r = createJournalReader({ root, indexDir });
  await r.refresh();
  const sess = path.join(root, 'P1', `${SID}.jsonl`);
  const lastLine = fs.readFileSync(sess, 'utf8').split('\n').filter((l) => l.trim()).at(-1);
  let n = 0;
  const parallel = [];
  await r.rebuild({ onProgress: () => { fs.appendFileSync(sess, `${lastLine}\n`); n++; parallel.push(r.refresh()); } });
  assert.ok(n >= 3, 'дозаписей во время пересбора');
  await Promise.all(parallel);
  await r.refresh({ full: true });
  assert.equal(r.state().lines, jlines(root), 'строк в состоянии = строк в файлах');
  r.flush();
  const r2 = createJournalReader({ root, indexDir });
  await r2.refresh();
  assert.equal(r2.state().lines, jlines(root), 'и после рестарта по записанному индексу');
});

test('Голем, Важно 4: rebuild — журнал исчез между обходом и чтением (ENOENT): пересбор не валится, журнала нет в новом индексе; иной сбой чтения по-прежнему отказ', async () => {
  const root = tree();
  const indexDir = tmpDir('index-');
  let vanish = null;
  const gone = { ...fs, statSync: (p, ...a) => { if (vanish && String(p).endsWith(vanish)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return fs.statSync(p, ...a); } };
  const r = createJournalReader({ root, indexDir, fs: gone });
  await r.refresh();
  const total = Object.keys(JSON.parse(JSON.stringify(r.takeFiles()))).length;
  vanish = `${SID}.jsonl`;
  const seen = [];
  const res = await r.rebuild({ onProgress: (d, m) => seen.push([d, m]) });
  assert.equal(res.files, total - 1);
  assert.deepEqual(seen.at(-1), [total, total], 'ход дошёл до конца');
  const idx = JSON.parse(fs.readFileSync(path.join(indexDir, 'journals.json'), 'utf8'));
  assert.equal(Object.keys(idx.files).length, total - 1);
  assert.equal(r.state().errors, 0);
});
