// EXT-50: суточная копия журнала действий пульта (data/vitrina/actions.log) с проверкой восстановления.
// Часы подменены (локальные даты — конструктором Date, пояс машины не важен), каталоги временные, сеть — только
// подменный сервер на 127.0.0.1. Ожидаемые значения — из спеки и из того, что положено в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createBackup, inspectLog, snapshotOf, localDay } from '../lib/backup.mjs';
import { startServer } from '../lib/start.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'restore-actions.mjs');
const H = 3600000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const day = (y, m, d, h = 12, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s);

// строка шага пульта: id действия — как у настоящего (W-ГГММДД-ЧЧММСС-xxxx)
const row = (n, text = `строка ${n}`) => JSON.stringify({ id: `W-261002-1200${String(n).padStart(2, '0')}-a${String(n).padStart(3, '0')}`, step: 'asked', at: '2026-10-02T12:00:00+03:00', text });
const idOf = (n) => `W-261002-1200${String(n).padStart(2, '0')}-a${String(n).padStart(3, '0')}`;
const rows = (...ns) => ns.map((n) => row(n) + '\n').join('');

// площадка: журнал, папка копий, подменные часы, строки server.log в массив
function setup({ keep, fsOf, start = day(2026, 10, 2) } = {}) {
  const data = tmpDir('bk-data-');
  const file = path.join(data, 'actions.log');
  const dir = path.join(data, 'backup');
  const clock = { d: start };
  const lines = [];
  const b = createBackup({ file, dir, keep, now: () => clock.d, ...(fsOf ? { fs: fsOf(dir) } : {}), log: { write: (ev, f) => lines.push({ ev, ...f }) } });
  return { data, file, dir, clock, lines, b, at: (...a) => { clock.d = day(...a); } };
}
const names = (dir) => fs.readdirSync(dir).sort();
const read = (p) => fs.readFileSync(p);

// ---------- сам разбор и снимок ----------

test('inspectLog: каждая строка — JSON; число строк и id последней; пустая строка и битая — нет', () => {
  assert.deepEqual(inspectLog(Buffer.from(rows(1, 2, 3))), { ok: true, lines: 3, lastId: idOf(3), badLine: null });
  assert.deepEqual(inspectLog(Buffer.from('')), { ok: true, lines: 0, lastId: null, badLine: null });
  assert.equal(inspectLog(Buffer.from(rows(1) + '\n' + rows(2))).ok, false, 'пустая строка посреди');
  const bad = inspectLog(Buffer.from(rows(1) + '{"id":\n' + rows(3)));
  assert.deepEqual([bad.ok, bad.badLine], [false, 2]);
  assert.equal(inspectLog(Buffer.from(rows(1) + '{"id":"x"')).ok, false, 'без перевода строки в конце — неполная строка не JSON');
});

test('snapshotOf: до последнего полного перевода строки; нет ни одного — пусто', () => {
  assert.equal(snapshotOf(Buffer.from('a\nb\nc')).toString(), 'a\nb\n');
  assert.equal(snapshotOf(Buffer.from('a\nb\n')).toString(), 'a\nb\n');
  assert.equal(snapshotOf(Buffer.from('abc')).length, 0);
  assert.equal(snapshotOf(Buffer.from('')).length, 0);
});

// ---------- расписание ----------

test('старт: первая копия — файл дня actions-ГГГГ-ММ-ДД.log байт в байт, state и строка server.log', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2, 3));
  const r = s.b.start();
  assert.equal(r.status, 'ok');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log']);
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
  const st = s.b.state();
  assert.equal(st.lastFile, 'actions-2026-10-02.log');
  assert.equal(st.lastError, null);
  assert.equal(st.count, 1);
  assert.equal(st.lastOkAt, s.clock.d.toISOString());
  assert.deepEqual(s.lines, [{ ev: 'backup', file: 'actions-2026-10-02.log', lines: 3, last: idOf(3), kept: 1 }]);
  assert.deepEqual(s.b.freshness(), { lastOkAt: st.lastOkAt, stale: false });
});

test('вторая копия — только после местной полуночи; в те же сутки тик ничего не делает', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2, 3));
  s.b.start();
  s.at(2026, 10, 2, 12, 5);
  assert.equal(s.b.tick(), null);
  fs.appendFileSync(s.file, rows(4));
  s.at(2026, 10, 2, 23, 59, 59);
  assert.equal(s.b.tick(), null, 'до полуночи копии нет');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log']);
  s.at(2026, 10, 3, 0, 0, 2);
  assert.equal(s.b.tick().status, 'ok', 'первый тик после полуночи');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log']);
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3), 'вчерашняя копия не тронута');
  assert.equal(read(path.join(s.dir, 'actions-2026-10-03.log')).toString(), rows(1, 2, 3, 4));
  s.at(2026, 10, 3, 0, 0, 4);
  assert.equal(s.b.tick(), null, 'второй тик той же ночи — ничего');
});

test('пробуждение через полночь: первый тик после сна копирует под датой пробуждения', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  s.at(2026, 10, 4, 9, 0, 0); // машина спала двое суток
  assert.equal(s.b.tick().status, 'ok');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-04.log']);
});

test('повтор в те же сутки заменяет файл дня: один файл, новое содержимое, временных файлов нет', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 18, 0, 0);
  assert.equal(s.b.run().status, 'ok');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log']);
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
  assert.equal(s.b.state().count, 1);
});

test('старт: свежая копия (моложе 24 ч) — копии нет; старше 24 ч или нет совсем — копия сейчас', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const copy = path.join(s.dir, 'actions-2026-10-02.log');
  // перезапуск через 5 часов: копия свежая, вторая не нужна
  const mtime = (h) => { const t = (s.clock.d.getTime() - h * H) / 1000; fs.utimesSync(copy, t, t); };
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 17, 0, 0);
  mtime(5);
  const second = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(second.start().status, 'skipped');
  assert.equal(read(copy).toString(), rows(1, 2), 'свежая копия не перезаписана');
  assert.equal(second.state().lastFile, 'actions-2026-10-02.log', 'последняя удачная — из папки');
  assert.equal(second.state().count, 1);
  // копии 30 часов — старше суток: на старте новая
  mtime(30);
  s.at(2026, 10, 3, 18, 0, 0);
  const third = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(third.start().status, 'ok');
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log']);
});

// ---------- ротация ----------

test('keep: 15 суток → 14 файлов; чужие файлы, .bad и папка с похожим именем не тронуты', () => {
  const s = setup({ keep: 14, start: day(2026, 10, 1) });
  fs.mkdirSync(s.dir, { recursive: true });
  const foreign = ['notes.txt', 'actions-foo.log', 'actions-2020-01-01.log.bad', 'actions-2021-05-05.log.tmp', 'actions-2026-1-5.log'];
  for (const f of foreign) fs.writeFileSync(path.join(s.dir, f), f);
  fs.mkdirSync(path.join(s.dir, 'actions-2019-12-31.log')); // папка под маску — не файл
  fs.writeFileSync(s.file, rows(1));
  s.b.start();
  for (let d = 2; d <= 15; d++) { // 14 суток подряд: 1 (старт) + 14 тиков = 15 копий
    fs.appendFileSync(s.file, rows(d));
    s.at(2026, 10, d, 0, 5, 0);
    assert.equal(s.b.tick().status, 'ok', `день ${d}`);
  }
  const dated = names(s.dir).filter((n) => /^actions-\d{4}-\d\d-\d\d\.log$/.test(n) && fs.statSync(path.join(s.dir, n)).isFile());
  assert.equal(dated.length, 14);
  assert.deepEqual(dated, Array.from({ length: 14 }, (_, i) => `actions-2026-10-${String(i + 2).padStart(2, '0')}.log`), 'старейшая (1 октября) удалена, 14 последних целы');
  for (const f of foreign) assert.equal(fs.readFileSync(path.join(s.dir, f), 'utf8'), f, `${f} тронут`);
  assert.ok(fs.statSync(path.join(s.dir, 'actions-2019-12-31.log')).isDirectory(), 'папка под маску удалена');
  assert.equal(s.b.state().count, 14);
});

// ---------- журнал дописывается ----------

test('недописанная последняя строка: в копию — только полные строки, проверка ok; хвост — в следующую копию', () => {
  const s = setup();
  const tail = row(3);
  fs.writeFileSync(s.file, rows(1, 2) + tail.slice(0, 20)); // обрыв посреди строки, без перевода строки
  const r = s.b.start();
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const copy = path.join(s.dir, 'actions-2026-10-02.log');
  assert.equal(read(copy).toString(), rows(1, 2));
  assert.equal(s.b.state().lastError, null);
  assert.deepEqual(s.lines.at(-1), { ev: 'backup', file: 'actions-2026-10-02.log', lines: 2, last: idOf(2), kept: 1 });
  fs.appendFileSync(s.file, tail.slice(20) + '\n'); // строка дописана
  s.at(2026, 10, 3, 0, 1, 0);
  assert.equal(s.b.tick().status, 'ok');
  assert.equal(read(path.join(s.dir, 'actions-2026-10-03.log')).toString(), rows(1, 2, 3), 'хвост попал в следующую копию');
});

test('в журнале только недописанная строка — копии нет, не ошибка', () => {
  const s = setup();
  fs.writeFileSync(s.file, row(1).slice(0, 15));
  assert.equal(s.b.start().status, 'none');
  assert.equal(fs.existsSync(s.dir), false);
  assert.equal(s.b.state().lastError, null);
});

// ---------- порченая копия ----------

// чтение копии подменено: JSON цел, строк и id последней столько же — ловит только сравнение SHA-256
function corruptor() {
  const bad = { on: false };
  const fsOf = (dir) => {
    const isCopy = (p) => typeof p === 'string' && path.dirname(p) === dir && /^actions-\d{4}-\d\d-\d\d\.log$/.test(path.basename(p));
    return { ...fs, readFileSync: (p, ...a) => { const r = fs.readFileSync(p, ...a); return bad.on && isCopy(p) ? Buffer.from(r.toString('utf8').replace('строка 2', 'строка Х'), 'utf8') : r; } };
  };
  return { bad, fsOf };
}

test('порченая копия: ….bad, lastError, строка «backup error», stale true; .bad в счёт keep не входит и ротацией не удаляется', () => {
  const c = corruptor();
  const s = setup({ keep: 2, fsOf: c.fsOf });
  fs.writeFileSync(s.file, rows(1, 2, 3));
  assert.equal(s.b.start().status, 'ok'); // 10-02
  fs.appendFileSync(s.file, rows(4));
  s.at(2026, 10, 3, 0, 5);
  assert.equal(s.b.tick().status, 'ok'); // 10-03
  const okAt = s.b.state().lastOkAt;
  fs.appendFileSync(s.file, rows(5));
  s.at(2026, 10, 4, 0, 5);
  c.bad.on = true;
  const r = s.b.tick(); // 10-04: копия прочиталась порченой
  assert.deepEqual([r.status, r.code], ['error', 'sha-mismatch']);
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log', 'actions-2026-10-04.log.bad']);
  assert.equal(fs.existsSync(path.join(s.dir, 'actions-2026-10-04.log')), false, 'порченый файл остался под боевым именем');
  const st = s.b.state();
  assert.equal(st.lastError, 'sha-mismatch');
  assert.equal(st.count, 2, '.bad в счёт не входит');
  assert.equal(st.lastFile, 'actions-2026-10-03.log', 'последняя удачная — вчерашняя');
  assert.equal(st.lastOkAt, okAt);
  assert.equal(s.b.freshness().stale, true, 'последняя попытка неудачна');
  assert.deepEqual(s.lines.at(-1), { ev: 'backup', error: 'sha-mismatch', file: 'actions-2026-10-04.log' });
  // чтение починили; следующие сутки — удачная копия: keep 2 → 10-02 уходит, .bad остаётся, ошибка снята
  c.bad.on = false;
  fs.appendFileSync(s.file, rows(6));
  s.at(2026, 10, 5, 0, 5);
  assert.equal(s.b.tick().status, 'ok');
  assert.deepEqual(names(s.dir), ['actions-2026-10-03.log', 'actions-2026-10-04.log.bad', 'actions-2026-10-05.log']);
  assert.equal(s.b.state().lastError, null);
  assert.equal(s.b.freshness().stale, false);
});

test('порча без изменения числа строк и последнего id: сравнение SHA-256 — единственное, что её видит', () => {
  const c = corruptor();
  const s = setup({ fsOf: c.fsOf });
  fs.writeFileSync(s.file, rows(1, 2, 3));
  c.bad.on = true;
  s.b.start();
  const live = read(s.file);
  const damaged = Buffer.from(live.toString('utf8').replace('строка 2', 'строка Х'), 'utf8');
  const a = inspectLog(live);
  const d = inspectLog(damaged);
  assert.deepEqual([d.ok, d.lines, d.lastId], [a.ok, a.lines, a.lastId], 'порча должна быть невидима для остальных проверок');
  assert.notEqual(sha(damaged), sha(live));
  assert.equal(s.b.state().lastError, 'sha-mismatch');
});

test('сбой записи копии и нечитаемый журнал — ошибка в state и server.log, не исключение; stale true', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.data, 'backup'), 'я файл, а не папка'); // папку копий создать нельзя
  fs.writeFileSync(s.file, rows(1));
  const r = s.b.start();
  assert.equal(r.status, 'error');
  assert.ok(s.b.state().lastError, 'lastError пуст');
  assert.equal(s.b.freshness().stale, true);
  assert.equal(s.lines.at(-1).ev, 'backup');
  assert.ok(s.lines.at(-1).error);
  // журнал есть, но читаться не может (здесь — папка на его месте): это не «журнала нет»
  const t = setup();
  fs.mkdirSync(t.file);
  assert.equal(t.b.start().status, 'error');
  assert.equal(t.b.state().lastError, 'EISDIR');
  assert.equal(fs.existsSync(t.dir), false);
});

// ---------- журнала нет или он пуст ----------

test('журнала нет или он пуст — копии нет, это не ошибка: ни папки, ни lastError, ни строки в server.log, stale false', () => {
  for (const make of [() => {}, (s) => fs.writeFileSync(s.file, '')]) {
    const s = setup();
    make(s);
    assert.equal(s.b.start().status, 'none');
    s.at(2026, 10, 3, 0, 5);
    assert.equal(s.b.tick().status, 'none');
    assert.equal(fs.existsSync(s.dir), false, 'папка копий создана без копии');
    assert.deepEqual(s.b.state(), { lastOkAt: null, lastFile: null, lastError: null, count: 0 });
    assert.deepEqual(s.b.freshness(), { lastOkAt: null, stale: false });
    assert.deepEqual(s.lines, []);
  }
});

// ---------- 48 часов ----------

test('48 часов без удачной копии — stale true; до 48 часов — false', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const okAt = s.b.state().lastOkAt;
  s.at(2026, 10, 4, 11, 0); // 47 часов
  assert.deepEqual(s.b.freshness(), { lastOkAt: okAt, stale: false });
  s.at(2026, 10, 4, 13, 0); // 49 часов, тиков не было — копии нет
  assert.deepEqual(s.b.freshness(), { lastOkAt: okAt, stale: true });
});

// ---------- ручки ----------

async function boardApp(opts) {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека' }] });
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(regFile), scan, ...opts });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { app, get };
}

test('/api/health → backup {lastOkAt, lastFile, lastError, count}; /api/ceh → freshness.backup {lastOkAt, stale}; проект — без backup', async () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const { get } = await boardApp({ backup: s.b });
  const h = await get('/api/health');
  assert.deepEqual(h.backup, { lastOkAt: s.clock.d.toISOString(), lastFile: 'actions-2026-10-02.log', lastError: null, count: 1 });
  const ceh = await get('/api/ceh');
  assert.deepEqual(ceh.freshness.backup, { lastOkAt: s.clock.d.toISOString(), stale: false });
  assert.deepEqual(Object.keys(ceh.freshness).sort(), ['backup', 'board', 'journals', 'mirror']);
  assert.equal('backup' in (await get('/api/project/EXT')).freshness, false, 'backup — только в /api/ceh');
  // порча: ручки её показывают
  const c = corruptor();
  const t = setup({ fsOf: c.fsOf });
  fs.writeFileSync(t.file, rows(1, 2, 3));
  c.bad.on = true;
  t.b.start();
  const bad = await boardApp({ backup: t.b });
  assert.equal((await bad.get('/api/health')).backup.lastError, 'sha-mismatch');
  assert.equal((await bad.get('/api/ceh')).freshness.backup.stale, true);
});

test('витрина без модуля копии: поля на месте, пустые, stale false', async () => {
  const { get } = await boardApp({});
  assert.deepEqual((await get('/api/health')).backup, { lastOkAt: null, lastFile: null, lastError: null, count: 0 });
  assert.deepEqual((await get('/api/ceh')).freshness.backup, { lastOkAt: null, stale: false });
});

// ---------- настройки ----------

test('настройки: backup по умолчанию в config.default.json; свой backup.keep сливается по ключам, dir остаётся прежним', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  assert.deepEqual(defaults.backup, { dir: 'data/vitrina/backup/', keep: 14 });
  const data = tmpDir('bk-cfg-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port: 4400, backup: { keep: 7 } }));
  const c = loadConfig({ dataDir: data, defaults });
  assert.deepEqual(c.backup, { dir: 'data/vitrina/backup/', keep: 7 });
  assert.equal(c.port, 4400);
});

// ---------- в живой витрине ----------

function request(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };

async function bootServer({ withLog, backup, clock }) {
  const board = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
  gitInitCommit(board);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [board] } } }));
  const dataDir = tmpDir('bk-start-');
  if (withLog) fs.writeFileSync(path.join(dataDir, 'actions.log'), rows(1, 2, 3));
  const port = 45000 + Math.floor(Math.random() * 2000);
  const config = { port, paths: { board, boardLib: BOARD_LIB, registry: reg }, pollMs: { board: 60000, journals: 50 }, statsEveryMin: 10, ...(backup ? { backup } : {}) };
  const s = await startServer({ config, dataDir, backupNow: () => clock.d });
  return { s, dataDir, port };
}

test('витрина: копия на старте и на первом цикле после полуночи; /api/health и freshness показывают; server.log — строки backup', async () => {
  const dir = path.join(tmpDir('bk-dir-'), 'copies');
  const clock = { d: day(2026, 10, 2, 12, 0) };
  const { s, dataDir, port } = await bootServer({ withLog: true, backup: { dir, keep: 14 }, clock });
  try {
    assert.deepEqual(names(dir), ['actions-2026-10-02.log'], 'копии на старте нет');
    assert.equal(read(path.join(dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
    assert.equal((await request(port, '/api/health')).backup.lastFile, 'actions-2026-10-02.log');
    assert.equal((await request(port, '/api/ceh')).freshness.backup.stale, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(names(dir), ['actions-2026-10-02.log'], 'цикл копирует чаще раза в сутки');
    fs.appendFileSync(path.join(dataDir, 'actions.log'), rows(4));
    clock.d = day(2026, 10, 3, 0, 0, 30);
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'actions-2026-10-03.log'))), 'после полуночи копии нет');
    assert.equal(read(path.join(dir, 'actions-2026-10-03.log')).toString(), rows(1, 2, 3, 4));
  } finally { await s.stop(); }
  const log = fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8');
  assert.match(log, / backup file=actions-2026-10-02\.log lines=3 last=W-261002-120003-a003 kept=1\n/);
  assert.match(log, / backup file=actions-2026-10-03\.log lines=4 /);
});

test('витрина: журнала нет — копии нет, папки нет, строк backup в server.log нет; без настройки папка — <данные>/backup', async () => {
  const clock = { d: day(2026, 10, 2, 12, 0) };
  const a = await bootServer({ withLog: false, clock });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(path.join(a.dataDir, 'backup')), false);
    assert.equal((await request(a.port, '/api/health')).backup.lastError, null);
  } finally { await a.s.stop(); }
  assert.doesNotMatch(fs.readFileSync(path.join(a.dataDir, 'server.log'), 'utf8'), / backup /);
  const b = await bootServer({ withLog: true, clock }); // настройки backup нет вовсе — умолчания по ключам
  try {
    assert.deepEqual(names(path.join(b.dataDir, 'backup')), ['actions-2026-10-02.log']);
  } finally { await b.s.stop(); }
});

// ---------- tools/restore-actions.mjs ----------

function tool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 20000 }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr }));
  });
}

// копия, папка данных с «живым» журналом и настройкой порта
function restoreArea(port = 4317) {
  const data = tmpDir('bk-restore-');
  fs.writeFileSync(path.join(data, 'actions.log'), rows(7, 8));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port }));
  const copy = path.join(tmpDir('bk-copy-'), 'actions-2026-10-02.log');
  fs.writeFileSync(copy, rows(1, 2, 3));
  return { data, copy, live: path.join(data, 'actions.log') };
}
const listen = (status = 200) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => { res.statusCode = status; res.end('{}'); });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const closed = (srv) => new Promise((resolve) => srv.close(resolve));

test('restore: по умолчанию пишет actions.restored.log рядом с живым журналом, живой не трогает; печатает строки и id последней', async () => {
  const a = restoreArea();
  const before = sha(read(a.live));
  const r = await tool([a.copy, '--data-dir', a.data]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /строк: 3 · последний id: W-261002-120003-a003/);
  assert.equal(read(path.join(a.data, 'actions.restored.log')).toString(), rows(1, 2, 3));
  assert.equal(sha(read(a.live)), before, 'живой actions.log тронут');
  assert.deepEqual(names(a.data), ['actions.log', 'actions.restored.log', 'config.json']);
});

test('restore: копия с битой строкой — отказ, ничего не записано', async () => {
  const a = restoreArea();
  fs.writeFileSync(a.copy, rows(1) + '{"id": битая\n' + rows(3));
  const r = await tool([a.copy, '--data-dir', a.data]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /строка 2 не JSON/);
  assert.deepEqual(names(a.data), ['actions.log', 'config.json']);
});

test('restore --to: витрина отвечает на своём порту (любой HTTP-ответ) — отказ с кодом ≠ 0, цель и папка не тронуты', async () => {
  for (const status of [200, 404, 500]) {
    const { srv, port } = await listen(status);
    try {
      const a = restoreArea(port);
      const before = sha(read(a.live));
      const r = await tool([a.copy, '--to', a.live, '--data-dir', a.data]);
      assert.equal(r.code, 3, `${status}: ${r.stderr}`);
      assert.match(r.stderr, /витрина отвечает/);
      assert.equal(sha(read(a.live)), before, `${status}: журнал перезаписан при живой витрине`);
      assert.deepEqual(names(a.data), ['actions.log', 'config.json'], `${status}: в папке данных появились файлы`);
    } finally { await closed(srv); }
  }
});

test('restore --to: витрина молчит — пишет; заменённый файл не пропадает, а уходит рядом', async () => {
  const { srv, port } = await listen();
  await closed(srv); // порт свободен — никто не отвечает
  const a = restoreArea(port);
  const old = read(a.live).toString();
  const r = await tool([a.copy, '--to', a.live, '--data-dir', a.data]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(read(a.live).toString(), rows(1, 2, 3));
  const kept = names(a.data).filter((n) => n.startsWith('actions.log.replaced-'));
  assert.equal(kept.length, 1, names(a.data).join(','));
  assert.equal(read(path.join(a.data, kept[0])).toString(), old, 'прежний журнал потерян');
  assert.match(r.stdout, /прежний файл сохранён/);
  assert.deepEqual(names(a.data).filter((n) => n.endsWith('.tmp')), []);
});

test('restore: неверный вызов — код 2 без записи', async () => {
  assert.equal((await tool([])).code, 2);
  assert.equal((await tool(['x.log', '--to'])).code, 2);
  assert.equal((await tool(['x.log', '--нет'])).code, 2);
  const a = restoreArea();
  assert.equal((await tool([path.join(a.data, 'нет-такой-копии.log'), '--data-dir', a.data])).code, 1);
});

test('localDay: местная дата ГГГГ-ММ-ДД', () => {
  assert.equal(localDay(day(2026, 1, 5, 23, 59, 59)), '2026-01-05');
  assert.equal(localDay(day(2026, 12, 31, 0, 0, 0)), '2026-12-31');
});
