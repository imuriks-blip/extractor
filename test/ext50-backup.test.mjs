// EXT-50: суточная копия журнала действий пульта (data/vitrina/actions.log) с проверкой восстановления.
// Часы подменены (локальные даты — конструктором Date, пояс машины не важен), каталоги временные, сеть — только
// подменный сервер на 127.0.0.1. Ожидаемые значения — из спеки и из того, что положено в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createBackup, inspectLog, snapshotOf, localDay } from '../lib/backup.mjs';
import { main as restoreMain } from '../tools/restore-actions.mjs';
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
// папка копий без эталонов .sha256 (их проверяют отдельные тесты)
const logs = (dir) => names(dir).filter((n) => !n.endsWith('.sha256'));
const read = (p) => fs.readFileSync(p);

// ---------- сам разбор и снимок ----------

test('inspectLog: число строк, id последней JSON-строки; строки не JSON — считаются с номерами, разбор не прерывают; пустая — не битая', () => {
  assert.deepEqual(inspectLog(Buffer.from(rows(1, 2, 3))), { ok: true, lines: 3, lastId: idOf(3), badLine: null, badLines: [] });
  assert.deepEqual(inspectLog(Buffer.from('')), { ok: true, lines: 0, lastId: null, badLine: null, badLines: [] });
  assert.deepEqual(inspectLog(Buffer.from(rows(1) + '\n' + rows(2))), { ok: true, lines: 3, lastId: idOf(2), badLine: null, badLines: [] }, 'пустая строка посреди — не битая (читатель пульта её пропускает)');
  assert.deepEqual(inspectLog(Buffer.from(rows(1) + '{"id":\n' + rows(3) + 'мусор\n' + rows(5))), { ok: false, lines: 5, lastId: idOf(5), badLine: 2, badLines: [2, 4] });
  assert.deepEqual(inspectLog(Buffer.from(rows(1) + '{"id":"x"')), { ok: false, lines: 2, lastId: idOf(1), badLine: 2, badLines: [2] }, 'без перевода строки в конце — неполная строка не JSON; последний id — у последней JSON-строки');
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
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log']);
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
  const st = s.b.state();
  assert.equal(st.lastFile, 'actions-2026-10-02.log');
  assert.equal(st.lastError, null);
  assert.equal(st.count, 1);
  assert.equal(st.lastOkAt, s.clock.d.toISOString());
  assert.deepEqual(s.lines, [{ ev: 'backup', file: 'actions-2026-10-02.log', lines: 3, last: idOf(3), kept: 1 }]);
  assert.deepEqual(s.b.freshness(), { lastOkAt: st.lastOkAt, stale: false, journalBad: null });
  // эталон рядом: SHA-256 копии в формате sha256sum
  const copy = read(path.join(s.dir, 'actions-2026-10-02.log'));
  assert.equal(fs.readFileSync(path.join(s.dir, 'actions-2026-10-02.log.sha256'), 'utf8'), `${sha(copy)}  actions-2026-10-02.log\n`);
  assert.deepEqual(names(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-02.log.sha256']);
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
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log']);
  s.at(2026, 10, 3, 0, 0, 2);
  assert.equal(s.b.tick().status, 'ok', 'первый тик после полуночи');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log']);
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
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-04.log']);
});

test('повтор в те же сутки заменяет файл дня: один файл, новое содержимое, временных файлов нет', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 18, 0, 0);
  assert.equal(s.b.run().status, 'ok');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log']);
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
  assert.equal(s.b.state().count, 1);
});

test('старт: файл сегодняшнего дня есть — копии нет (как бы он ни был стар); нет — копия сейчас, даже если вчерашней 2 часа', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const copy = path.join(s.dir, 'actions-2026-10-02.log');
  const mtime = (h) => { const t = (s.clock.d.getTime() - h * H) / 1000; fs.utimesSync(copy, t, t); };
  // перезапуск в те же сутки, копии 11 часов — она сегодняшняя, вторая не нужна
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 23, 0, 0);
  mtime(11);
  const second = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(second.start().status, 'skipped');
  assert.equal(read(copy).toString(), rows(1, 2), 'сегодняшняя копия перезаписана');
  assert.equal(second.state().lastFile, 'actions-2026-10-02.log', 'последняя удачная — из папки');
  assert.equal(second.state().count, 1);
  // перезапуск в 01:00 следующих суток: вчерашней копии 2 часа, но сегодняшней нет — копия сейчас
  s.at(2026, 10, 3, 1, 0, 0);
  mtime(2);
  const third = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(third.start().status, 'ok');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log']);
});

// ---------- ротация ----------

test('keep: 15 суток → 14 файлов; чужие файлы, .bad и папка с похожим именем не тронуты', () => {
  const s = setup({ keep: 14, start: day(2026, 10, 1) });
  fs.mkdirSync(s.dir, { recursive: true });
  const foreign = ['notes.txt', 'actions-foo.log', 'actions-2020-01-01.log.bad', 'actions-2021-05-05.log.tmp', 'actions-2026-1-5.log', 'actions-2026-10-01.log.sha256.old', 'actions-2020-01-01.log.sha256x'];
  for (const f of foreign) fs.writeFileSync(path.join(s.dir, f), f);
  fs.mkdirSync(path.join(s.dir, 'actions-2019-12-31.log')); // папка под маску — не файл
  fs.writeFileSync(s.file, rows(1));
  s.b.start();
  for (let d = 2; d <= 15; d++) { // 14 суток подряд: 1 (старт) + 14 тиков = 15 копий
    fs.appendFileSync(s.file, rows(d));
    s.at(2026, 10, d, 0, 5, 0);
    assert.equal(s.b.tick().status, 'ok', `день ${d}`);
  }
  const dated = logs(s.dir).filter((n) => /^actions-\d{4}-\d\d-\d\d\.log$/.test(n) && fs.statSync(path.join(s.dir, n)).isFile());
  assert.equal(dated.length, 14);
  assert.deepEqual(dated, Array.from({ length: 14 }, (_, i) => `actions-2026-10-${String(i + 2).padStart(2, '0')}.log`), 'старейшая (1 октября) удалена, 14 последних целы');
  for (const f of foreign) assert.equal(fs.readFileSync(path.join(s.dir, f), 'utf8'), f, `${f} тронут`);
  assert.ok(fs.statSync(path.join(s.dir, 'actions-2019-12-31.log')).isDirectory(), 'папка под маску удалена');
  assert.equal(s.b.state().count, 14);
  // эталоны: удалён вместе со своей копией, остальные 14 — на месте
  assert.deepEqual(names(s.dir).filter((n) => n.endsWith('.sha256')), dated.map((n) => `${n}.sha256`), 'эталон удалён не парой');
});

// ---------- журнал только дописывается: сверка с самой длинной копией ----------

test('журнал укоротили — неделя суточных копий: тревога каждый день, ни одна старая полная не удалена и не изменена, короткие — рядом вне маски', () => {
  const s = setup({ keep: 14, start: day(2026, 10, 1) });
  fs.writeFileSync(s.file, rows(1));
  s.b.start();
  for (let d = 2; d <= 14; d++) { fs.appendFileSync(s.file, rows(d)); s.at(2026, 10, d, 0, 5, 0); assert.equal(s.b.tick().status, 'ok'); }
  const full = logs(s.dir).filter((n) => /\.log$/.test(n));
  assert.equal(full.length, 14);
  const bytes = Object.fromEntries(full.map((n) => [n, read(path.join(s.dir, n))]));
  fs.writeFileSync(s.file, rows(1, 2)); // укоротили
  for (let d = 15; d <= 21; d++) {
    if (d > 15) fs.appendFileSync(s.file, rows(100 + d)); // журнал живёт дальше, но не начинается с полной копии
    s.at(2026, 10, d, 0, 5, 0);
    const r = s.b.tick();
    assert.equal(r.status, 'short', `день ${d}: ${JSON.stringify(r)}`);
    assert.equal(s.b.state().lastError, 'журнал стал короче или изменился в начале — самая длинная копия actions-2026-10-14.log', `день ${d}`);
    assert.equal(s.b.freshness().stale, true, `день ${d}`);
    assert.equal(fs.existsSync(path.join(s.dir, `actions-2026-10-${d}.log`)), false, `день ${d}: короткая легла файлом дня`);
  }
  for (const n of full) assert.ok(read(path.join(s.dir, n)).equals(bytes[n]), `${n} удалён или изменён`);
  assert.deepEqual(logs(s.dir).filter((n) => /\.log$/.test(n)), full, 'в маске ротации появились или пропали файлы');
  const shorts = logs(s.dir).filter((n) => /\.log\.short-\d{6}$/.test(n));
  assert.equal(shorts.length, 7, logs(s.dir).join(','));
  assert.equal(read(path.join(s.dir, 'actions-2026-10-15.log.short-000500')).toString(), rows(1, 2));
  assert.equal(s.b.state().count, 14);
});

test('укорочение в те же сутки: утренняя полная копия дня цела, короткая — actions-…log.short-ЧЧММСС рядом со своим .sha256; совпало имя — -2', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2, 3));
  assert.equal(s.b.start().status, 'ok'); // 12:00 — утренняя полная
  const dayFile = path.join(s.dir, 'actions-2026-10-02.log');
  const morning = read(dayFile);
  const morningSha = fs.readFileSync(`${dayFile}.sha256`, 'utf8');
  fs.writeFileSync(s.file, rows(1));
  s.at(2026, 10, 2, 18, 0, 0);
  const r = s.b.run();
  assert.deepEqual([r.status, r.file], ['short', 'actions-2026-10-02.log.short-180000']);
  assert.ok(read(dayFile).equals(morning), 'файл дня заменён короткой копией');
  assert.equal(fs.readFileSync(`${dayFile}.sha256`, 'utf8'), morningSha, 'эталон файла дня заменён');
  const short = path.join(s.dir, 'actions-2026-10-02.log.short-180000');
  assert.equal(read(short).toString(), rows(1));
  assert.equal(fs.readFileSync(`${short}.sha256`, 'utf8'), `${sha(read(short))}  actions-2026-10-02.log.short-180000\n`);
  assert.equal(s.b.state().lastError, 'журнал стал короче или изменился в начале — самая длинная копия actions-2026-10-02.log');
  assert.equal(s.b.freshness().stale, true);
  assert.equal(s.b.run().file, 'actions-2026-10-02.log.short-180000-2', 'вторая короткая в ту же секунду затёрла первую');
  assert.equal(read(short).toString(), rows(1));
});

test('сверка — с самой длинной копией, не с последней: новейшая копия в папке короче старой — журнал, дописанный к новейшей, всё равно «короче»', () => {
  // папка, где новейшая копия короче (осталась от прежних правил или положена руками)
  const s = setup({ keep: 2, start: day(2026, 10, 3) });
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'actions-2026-10-01.log'), rows(1, 2, 3, 4, 5));
  fs.writeFileSync(path.join(s.dir, 'actions-2026-10-02.log'), rows(1, 2));
  const older = read(path.join(s.dir, 'actions-2026-10-01.log'));
  fs.writeFileSync(s.file, rows(1, 2, 3)); // начинается с новейшей, но короче самой длинной
  const r = s.b.start();
  assert.equal(r.status, 'short', JSON.stringify(r));
  assert.ok(read(path.join(s.dir, 'actions-2026-10-01.log')).equals(older), 'самая длинная ушла ротацией');
  assert.deepEqual(logs(s.dir).filter((n) => /\.log$/.test(n)), ['actions-2026-10-01.log', 'actions-2026-10-02.log']);
  assert.equal(s.b.state().lastError, 'журнал стал короче или изменился в начале — самая длинная копия actions-2026-10-01.log');
  assert.equal(s.b.freshness().stale, true);
  // журнал дорос до самой длинной и начинается с неё — обычная копия, ротация идёт
  fs.writeFileSync(s.file, rows(1, 2, 3, 4, 5, 6));
  s.at(2026, 10, 4, 0, 5, 0);
  assert.equal(s.b.tick().status, 'ok');
  assert.deepEqual(logs(s.dir).filter((n) => /\.log$/.test(n)), ['actions-2026-10-02.log', 'actions-2026-10-04.log'], 'keep 2');
  assert.equal(s.b.state().lastError, null);
  assert.equal(s.b.freshness().stale, false);
});

test('изменён в начале при той же и большей длине — тоже «короче или изменился»: ротации нет', () => {
  const s = setup({ keep: 1 });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 3, 0, 5, 0);
  assert.equal(s.b.tick().status, 'ok');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-03.log'], 'keep 1: вчерашняя ушла ротацией');
  fs.writeFileSync(s.file, row(1, 'строка Х') + '\n' + rows(2, 3, 4));
  s.at(2026, 10, 4, 0, 5, 0);
  assert.equal(s.b.tick().status, 'short');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-03.log', 'actions-2026-10-04.log.short-000500']);
  assert.equal(s.b.state().lastError, 'журнал стал короче или изменился в начале — самая длинная копия actions-2026-10-03.log');
});

test('перезапуск с копией дня: журнал короче самой длинной копии — stale и lastError и после перезапуска; журнал цел — чисто', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2, 3));
  s.b.start();
  fs.writeFileSync(s.file, rows(1));
  s.at(2026, 10, 2, 18, 0, 0);
  const again = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(again.start().status, 'skipped');
  assert.equal(again.state().lastError, 'журнал стал короче или изменился в начале — самая длинная копия actions-2026-10-02.log');
  assert.equal(again.freshness().stale, true);
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log'], 'на skipped что-то записано');
  fs.writeFileSync(s.file, rows(1, 2, 3, 4));
  const clean = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(clean.start().status, 'skipped');
  assert.equal(clean.state().lastError, null);
  assert.equal(clean.freshness().stale, false);
});

// ---------- повторное ревью Голема: сбой в сторону «всё хорошо» закрыт ----------

// поломка: statSync / readFileSync / writeFileSync файлов папки копий по имени (функция имени → true — ломать)
function breaker() {
  const br = { stat: null, read: null, write: null, rename: null };
  const fsOf = (dir) => {
    const hit = (f, p) => f && typeof p === 'string' && path.dirname(p) === dir && f(path.basename(p));
    const err = (code) => Object.assign(new Error(code), { code });
    return {
      ...fs,
      statSync: (p, ...a) => { if (hit(br.stat, p)) throw err('EACCES'); return fs.statSync(p, ...a); },
      readFileSync: (p, ...a) => { if (hit(br.read, p)) throw err('EACCES'); return fs.readFileSync(p, ...a); },
      writeFileSync: (p, ...a) => { if (hit(br.write, p)) throw err('ENOSPC'); return fs.writeFileSync(p, ...a); },
      // ломается по имени цели: файл дня занят (Windows — EPERM)
      renameSync: (a, b) => { if (hit(br.rename, b)) throw err('EPERM'); return fs.renameSync(a, b); },
    };
  };
  return { br, fsOf };
}
const listing = (dir) => Object.fromEntries(names(dir).map((n) => [n, sha(read(path.join(dir, n)))]));

test('самая длинная копия не читается — LONGEST-READ: файл дня байт в байт прежний, ротации нет, stale, повтор через час', () => {
  const k = breaker();
  const s = setup({ keep: 2, fsOf: k.fsOf, start: day(2026, 10, 1) });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 0, 5);
  assert.equal(s.b.tick().status, 'ok');
  const before = listing(s.dir);
  fs.appendFileSync(s.file, rows(4));
  k.br.read = (n) => n === 'actions-2026-10-02.log'; // самая длинная
  s.at(2026, 10, 2, 18, 0);
  const r = s.b.run();
  assert.deepEqual([r.status, r.code], ['error', 'LONGEST-READ']);
  assert.equal(s.b.state().lastError, 'копия actions-2026-10-02.log не читается — сверка журнала не сделана');
  assert.equal(s.b.freshness().stale, true);
  assert.deepEqual(listing(s.dir), before, 'файлы копий изменились');
  s.at(2026, 10, 2, 18, 30);
  assert.equal(s.b.tick(), null, 'повтор раньше часа');
  k.br.read = null;
  s.at(2026, 10, 2, 19, 0);
  assert.equal(s.b.tick()?.status, 'ok', 'через час — повтор, чтение починили');
  assert.equal(s.b.state().lastError, null);
});

test('stat самой длинной копии не прошёл — LONGEST-READ, а не сверка с более короткой: новой копии нет, ротации нет', () => {
  const k = breaker();
  const s = setup({ keep: 2, fsOf: k.fsOf, start: day(2026, 10, 1) });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 2, 0, 5);
  assert.equal(s.b.tick().status, 'ok');
  const before = listing(s.dir);
  fs.appendFileSync(s.file, rows(4));
  k.br.stat = (n) => n === 'actions-2026-10-02.log';
  s.at(2026, 10, 3, 0, 5);
  const r = s.b.tick();
  assert.deepEqual([r.status, r.code], ['error', 'LONGEST-READ']);
  assert.equal(s.b.state().lastError, 'копия actions-2026-10-02.log не читается — сверка журнала не сделана');
  assert.deepEqual(listing(s.dir), before, 'копия легла или ротация прошла');
  assert.equal(s.b.freshness().stale, true);
});

test('журнал удалили или обнулили, а копии есть — укорочение: stale, lastError, копии нет, ротации нет; и на старте; нет ни журнала, ни копий — не ошибка', () => {
  for (const kill of [(f) => fs.rmSync(f), (f) => fs.writeFileSync(f, '')]) {
    const s = setup({ keep: 1 });
    fs.writeFileSync(s.file, rows(1, 2));
    s.b.start();
    const before = listing(s.dir);
    kill(s.file);
    s.at(2026, 10, 3, 0, 5);
    const r = s.b.tick();
    assert.equal(r.status, 'gone', JSON.stringify(r));
    assert.equal(s.b.state().lastError, 'журнала нет или он пуст, а копии есть — самая длинная actions-2026-10-02.log');
    assert.equal(s.b.freshness().stale, true);
    assert.deepEqual(listing(s.dir), before, 'копии изменились');
    // старт с копией дня (skipped) — то же
    s.at(2026, 10, 2, 20, 0);
    const again = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
    assert.equal(again.start().status, 'skipped');
    assert.equal(again.state().lastError, 'журнала нет или он пуст, а копии есть — самая длинная actions-2026-10-02.log');
    assert.equal(again.freshness().stale, true);
    // старт без копии дня — то же, копии нет
    s.at(2026, 10, 5, 9, 0);
    const third = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
    assert.equal(third.start().status, 'gone');
    assert.equal(third.freshness().stale, true);
    assert.deepEqual(listing(s.dir), before);
  }
});

test('самая длинная копия не сходится со своим .sha256 — «повреждена (эталон не совпал)», stale, файла дня и ротации нет; эталона нет — сверка как обычно', () => {
  const s = setup({ keep: 1 });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const ref = path.join(s.dir, 'actions-2026-10-02.log.sha256');
  fs.writeFileSync(ref, `${'0'.repeat(64)}  actions-2026-10-02.log\n`);
  const before = listing(s.dir);
  fs.appendFileSync(s.file, rows(3));
  s.at(2026, 10, 3, 0, 5);
  const r = s.b.tick();
  assert.deepEqual([r.status, r.code], ['error', 'LONGEST-DAMAGED']);
  assert.equal(s.b.state().lastError, 'копия actions-2026-10-02.log повреждена (эталон не совпал)');
  assert.equal(s.b.freshness().stale, true);
  assert.deepEqual(listing(s.dir), before, 'файл дня лёг или ротация прошла');
  fs.rmSync(ref);
  s.at(2026, 10, 3, 1, 5);
  assert.equal(s.b.tick()?.status, 'ok', 'эталона нет — сверка как обычно');
  assert.equal(s.b.state().lastError, null);
});

test('эталон файла дня: старый удаляется до замены файла дня — сбой записи нового: рядом нет старого эталона, restore говорит «эталона нет», а не «повреждена»', async () => {
  const k = breaker();
  const s = setup({ fsOf: k.fsOf });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const dayFile = path.join(s.dir, 'actions-2026-10-02.log');
  assert.ok(fs.existsSync(`${dayFile}.sha256`));
  fs.appendFileSync(s.file, rows(3));
  k.br.write = (n) => /\.sha256\.\d+\.tmp$/.test(n);
  s.at(2026, 10, 2, 18, 0);
  assert.equal(s.b.run().code, 'ENOSPC'); // код сбоя записи эталона — код ошибки fs
  assert.equal(read(dayFile).toString(), rows(1, 2, 3), 'файл дня должен быть заменён новой копией');
  assert.equal(fs.existsSync(`${dayFile}.sha256`), false, 'рядом с новым файлом дня — старый эталон');
  const out = [];
  const err = [];
  const data = tmpDir('bk-r-');
  assert.equal(await restoreMain([dayFile, '--data-dir', data], { out: (x) => out.push(x), err: (x) => err.push(x) }), 0, err.join('\n'));
  assert.match(out.join('\n'), /эталона нет/);
  assert.doesNotMatch(out.join('\n') + err.join('\n'), /повреждена/);
});

// мелочь третьей проверки Голема: переименование в файл дня упало (файл занят) — прежний файл дня цел, и его эталон
// возвращён на место (правка дирижёра)
test('переименование в файл дня упало (EPERM) — прежний файл дня и его эталон целы байт в байт', () => {
  const k = breaker();
  const s = setup({ fsOf: k.fsOf });
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const dayFile = path.join(s.dir, 'actions-2026-10-02.log');
  const before = { log: read(dayFile), sha: read(`${dayFile}.sha256`) };
  fs.appendFileSync(s.file, rows(3));
  k.br.rename = (n) => n === 'actions-2026-10-02.log';
  s.at(2026, 10, 2, 18, 0);
  assert.equal(s.b.run().code, 'EPERM');
  assert.ok(read(dayFile).equals(before.log), 'файл дня изменён');
  assert.ok(fs.existsSync(`${dayFile}.sha256`), 'эталон прежнего файла дня пропал');
  assert.ok(read(`${dayFile}.sha256`).equals(before.sha), 'эталон прежнего файла дня изменён');
  assert.equal(s.b.freshness().stale, true);
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

// чтение временного файла копии подменено: JSON цел, строк и id последней столько же — ловит только сравнение SHA-256
function corruptor() {
  const bad = { on: false };
  const fsOf = (dir) => {
    const isCopy = (p) => typeof p === 'string' && path.dirname(p) === dir && /^actions-\d{4}-\d\d-\d\d\.log\.\d+\.tmp$/.test(path.basename(p)); // временный файл копии
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
  const bad04 = logs(s.dir).filter((n) => n.endsWith('.bad'));
  assert.equal(bad04.length, 1, logs(s.dir).join(','));
  assert.match(bad04[0], /^actions-2026-10-04\.log\.[\d-]+\.bad$/, 'у .bad — метка времени');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log', bad04[0]]);
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
  assert.deepEqual(logs(s.dir), ['actions-2026-10-03.log', bad04[0], 'actions-2026-10-05.log']);
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

test('повторная порченая копия в те же сутки не затирает удачную: файл дня байт в байт прежний, рядом .bad с меткой времени, lastError', () => {
  const c = corruptor();
  const s = setup({ fsOf: c.fsOf });
  fs.writeFileSync(s.file, rows(1, 2, 3));
  assert.equal(s.b.start().status, 'ok'); // утренняя удачная копия 10-02 12:00
  const dayFile = path.join(s.dir, 'actions-2026-10-02.log');
  const morning = read(dayFile);
  assert.equal(morning.toString(), rows(1, 2, 3));
  const okAt = s.b.state().lastOkAt;
  fs.appendFileSync(s.file, rows(4));
  c.bad.on = true;
  s.at(2026, 10, 2, 18, 0, 0);
  const r = s.b.run(); // повтор в те же сутки — копия прочиталась порченой
  assert.deepEqual([r.status, r.code], ['error', 'sha-mismatch']);
  c.bad.on = false;
  assert.ok(read(dayFile).equals(morning), 'файл дня изменён порченой повторной копией');
  const bads = () => logs(s.dir).filter((n) => n.endsWith('.bad'));
  assert.equal(bads().length, 1, logs(s.dir).join(','));
  assert.match(bads()[0], /^actions-2026-10-02\.log\.[\d-]+\.bad$/);
  assert.equal(s.b.state().lastError, 'sha-mismatch');
  assert.equal(s.b.state().lastFile, 'actions-2026-10-02.log');
  assert.equal(s.b.state().lastOkAt, okAt, 'lastOkAt сдвинут неудачной копией');
  assert.equal(s.b.state().count, 1);
  assert.equal(s.b.freshness().stale, true);
  // ещё две неудачи в те же сутки — позже и в ту же секунду: .bad друг друга не затирают
  c.bad.on = true;
  s.at(2026, 10, 2, 19, 30, 0);
  assert.equal(s.b.run().status, 'error');
  assert.equal(s.b.run().status, 'error');
  c.bad.on = false;
  assert.equal(bads().length, 3, logs(s.dir).join(','));
  assert.ok(read(dayFile).equals(morning), 'файл дня изменён');
  assert.deepEqual(logs(s.dir).filter((n) => n.endsWith('.tmp')), [], 'временные файлы остались');
});

test('битая строка в живом журнале не останавливает копии: копия удачная (файл дня, не .bad); journalBad {count, first}, lastError пуст, stale false', () => {
  const s = setup();
  const live = rows(1) + '{"id": оборвано\n' + rows(3);
  fs.writeFileSync(s.file, live);
  const r = s.b.start();
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log'], 'копия ушла в .bad или не легла');
  assert.equal(read(path.join(s.dir, 'actions-2026-10-02.log')).toString(), live, 'копия не байт в байт');
  const st = s.b.state();
  assert.equal(st.lastError, null, 'lastError — для сбоев копии');
  assert.deepEqual(st.journalBad, { count: 1, first: 2 });
  assert.equal(st.lastFile, 'actions-2026-10-02.log');
  assert.equal(st.lastOkAt, s.clock.d.toISOString());
  assert.equal(st.count, 1);
  assert.deepEqual(s.b.freshness(), { lastOkAt: st.lastOkAt, stale: false, journalBad: { count: 1, first: 2 } });
  // на следующие сутки битых две (и пустая строка — не битая)
  fs.appendFileSync(s.file, 'не json\n\n' + rows(6));
  s.at(2026, 10, 3, 0, 5);
  assert.equal(s.b.tick().status, 'ok');
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log', 'actions-2026-10-03.log']);
  assert.deepEqual(s.b.state().journalBad, { count: 2, first: 2 });
  assert.equal(s.b.freshness().stale, false);
});

test('перезапуск с копией дня (skipped): журнал всё равно читается — битая строка держит journalBad; чистый журнал — null', () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1) + 'мусор\n' + rows(3));
  assert.equal(s.b.start().status, 'ok');
  s.at(2026, 10, 2, 15, 0, 0);
  const again = createBackup({ file: s.file, dir: s.dir, now: () => s.clock.d, log: { write() {} } });
  assert.equal(again.start().status, 'skipped');
  assert.deepEqual(again.state().journalBad, { count: 1, first: 2 });
  assert.deepEqual(again.freshness(), { lastOkAt: again.state().lastOkAt, stale: false, journalBad: { count: 1, first: 2 } });
  assert.equal(again.state().lastError, null);
  assert.deepEqual(logs(s.dir), ['actions-2026-10-02.log'], 'на skipped копия всё же снята');
  // чистый журнал (своя площадка: переписать журнал целиком — это уже «изменился в начале»)
  const c = setup();
  fs.writeFileSync(c.file, rows(1, 2, 3));
  c.b.start();
  fs.appendFileSync(c.file, rows(4));
  const clean = createBackup({ file: c.file, dir: c.dir, now: () => c.clock.d, log: { write() {} } });
  assert.equal(clean.start().status, 'skipped');
  assert.equal(clean.state().journalBad, null);
  assert.equal(clean.freshness().stale, false);
});

// ---------- после неудачи — повтор раз в час (п.5 вердикта) ----------

test('после неудачной попытки — повтор не раньше чем через час, не каждый цикл и не только после полуночи', () => {
  const c = corruptor();
  const s = setup({ fsOf: c.fsOf });
  fs.writeFileSync(s.file, rows(1, 2));
  c.bad.on = true;
  assert.equal(s.b.start().status, 'error'); // 12:00
  s.at(2026, 10, 2, 12, 30, 0);
  assert.equal(s.b.tick(), null, 'через полчаса — рано');
  s.at(2026, 10, 2, 12, 59, 59);
  assert.equal(s.b.tick(), null, 'без секунды час — рано');
  s.at(2026, 10, 2, 13, 0, 0);
  assert.equal(s.b.tick()?.status, 'error', 'через час — повтор');
  assert.equal(s.b.tick(), null, 'тот же миг — второго повтора нет');
  c.bad.on = false;
  s.at(2026, 10, 2, 13, 40, 0);
  assert.equal(s.b.tick(), null);
  s.at(2026, 10, 2, 14, 0, 0);
  assert.equal(s.b.tick()?.status, 'ok', 'ещё через час — удачно');
  assert.equal(s.b.state().lastError, null);
  s.at(2026, 10, 2, 15, 0, 1);
  assert.equal(s.b.tick(), null, 'после удачи — до полуночи ничего');
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
    assert.deepEqual(s.b.state(), { lastOkAt: null, lastFile: null, lastError: null, count: 0, journalBad: null });
    assert.deepEqual(s.b.freshness(), { lastOkAt: null, stale: false, journalBad: null });
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
  assert.deepEqual(s.b.freshness(), { lastOkAt: okAt, stale: false, journalBad: null });
  s.at(2026, 10, 4, 13, 0); // 49 часов, тиков не было — копии нет
  assert.deepEqual(s.b.freshness(), { lastOkAt: okAt, stale: true, journalBad: null });
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

test('/api/health → backup {lastOkAt, lastFile, lastError, count, journalBad}; /api/ceh → freshness.backup {lastOkAt, stale, journalBad}; проект — без backup', async () => {
  const s = setup();
  fs.writeFileSync(s.file, rows(1, 2));
  s.b.start();
  const { get } = await boardApp({ backup: s.b });
  const h = await get('/api/health');
  assert.deepEqual(h.backup, { lastOkAt: s.clock.d.toISOString(), lastFile: 'actions-2026-10-02.log', lastError: null, count: 1, journalBad: null });
  const ceh = await get('/api/ceh');
  assert.deepEqual(ceh.freshness.backup, { lastOkAt: s.clock.d.toISOString(), stale: false, journalBad: null });
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
  // битые строки журнала: ручки показывают journalBad, stale — нет
  const j = setup();
  fs.writeFileSync(j.file, rows(1) + 'мусор\n' + rows(3));
  j.b.start();
  const jb = await boardApp({ backup: j.b });
  assert.deepEqual((await jb.get('/api/health')).backup.journalBad, { count: 1, first: 2 });
  assert.deepEqual((await jb.get('/api/ceh')).freshness.backup, { lastOkAt: j.clock.d.toISOString(), stale: false, journalBad: { count: 1, first: 2 } });
});

test('витрина без модуля копии: поля на месте, пустые, stale false', async () => {
  const { get } = await boardApp({});
  assert.deepEqual((await get('/api/health')).backup, { lastOkAt: null, lastFile: null, lastError: null, count: 0, journalBad: null });
  assert.deepEqual((await get('/api/ceh')).freshness.backup, { lastOkAt: null, stale: false, journalBad: null });
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
    assert.deepEqual(logs(dir), ['actions-2026-10-02.log'], 'копии на старте нет');
    assert.equal(read(path.join(dir, 'actions-2026-10-02.log')).toString(), rows(1, 2, 3));
    assert.equal((await request(port, '/api/health')).backup.lastFile, 'actions-2026-10-02.log');
    assert.equal((await request(port, '/api/ceh')).freshness.backup.stale, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(logs(dir), ['actions-2026-10-02.log'], 'цикл копирует чаще раза в сутки');
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
    assert.deepEqual(logs(path.join(b.dataDir, 'backup')), ['actions-2026-10-02.log']);
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

test('restore: копия с битыми строками — восстанавливается как есть, печатает их число и номера', async () => {
  const a = restoreArea();
  const copy = rows(1) + '{"id": битая\n' + rows(3) + 'мусор\n' + rows(5);
  fs.writeFileSync(a.copy, copy);
  const r = await tool([a.copy, '--data-dir', a.data]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(read(path.join(a.data, 'actions.restored.log')).equals(Buffer.from(copy)), 'восстановлено не байт в байт');
  assert.match(r.stdout + r.stderr, /битых строк: 2 \(строки 2, 4\)/);
  assert.match(r.stdout, /строк: 5 · последний id: W-261002-120005-a005/);
  assert.deepEqual(names(a.data), ['actions.log', 'actions.restored.log', 'config.json']);
});

test('restore --to: витрина отвечает на своём порту (любой HTTP-ответ) — отказ с кодом ≠ 0, цель и папка не тронуты', async () => {
  for (const status of [200, 404, 500]) {
    const { srv, port } = await listen(status);
    try {
      const a = restoreArea(port);
      const before = sha(read(a.live));
      const r = await tool([a.copy, '--to', a.live, '--data-dir', a.data]);
      assert.equal(r.code, 3, `${status}: ${r.stderr}`);
      assert.match(r.stderr, /занят/);
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

test('restore --to: порт принимает соединение и молчит — отказ (код 3), живой файл байт в байт прежний', async () => {
  const held = [];
  const srv = net.createServer((sock) => { held.push(sock); }); // соединение принято, ответа нет
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const a = restoreArea(port);
    const before = read(a.live);
    const r = await tool([a.copy, '--to', a.live, '--data-dir', a.data]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.ok(read(a.live).equals(before), 'живой журнал перезаписан при занятом порте');
    assert.deepEqual(names(a.data), ['actions.log', 'config.json']);
  } finally { for (const x of held) x.destroy(); await closed(srv); }
});

test('restore: эталон .sha256 рядом — сошёлся: пишет; не сошёлся: «копия повреждена», код 1, ничего не записано; нет: предупреждение', async () => {
  const a = restoreArea();
  const body = read(a.copy);
  fs.writeFileSync(`${a.copy}.sha256`, `${sha(body)}  actions-2026-10-02.log\n`);
  const ok = await tool([a.copy, '--data-dir', a.data]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /целость: SHA-256 совпал с эталоном/);
  assert.doesNotMatch(ok.stdout, /эталона нет/);
  // копия испорчена после снятия — эталон её ловит
  const b = restoreArea();
  fs.writeFileSync(`${b.copy}.sha256`, `${sha(read(b.copy))}  actions-2026-10-02.log\n`);
  fs.writeFileSync(b.copy, read(b.copy).toString().replace('строка 2', 'строка Х'));
  const bad = await tool([b.copy, '--data-dir', b.data]);
  assert.equal(bad.code, 1, bad.stdout);
  assert.match(bad.stderr, /копия повреждена/);
  assert.deepEqual(names(b.data), ['actions.log', 'config.json'], 'повреждённая копия записана');
  // эталона нет — разбирает как есть и предупреждает
  const c = restoreArea();
  const none = await tool([c.copy, '--data-dir', c.data]);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /эталона нет.*целость не проверена/);
});

test('restore: actions.restored.log и .replaced-<время> не затираются — суффикс -2, -3', async () => {
  const a = restoreArea();
  fs.writeFileSync(path.join(a.data, 'actions.restored.log'), 'прежний\n');
  const q = { out() {}, err() {} };
  assert.equal(await restoreMain([a.copy, '--data-dir', a.data], q), 0);
  assert.equal(await restoreMain([a.copy, '--data-dir', a.data], q), 0);
  assert.equal(read(path.join(a.data, 'actions.restored.log')).toString(), 'прежний\n', 'прежний restored затёрт');
  assert.equal(read(path.join(a.data, 'actions.restored-2.log')).toString(), rows(1, 2, 3));
  assert.equal(read(path.join(a.data, 'actions.restored-3.log')).toString(), rows(1, 2, 3));
  // два --to в одну секунду: второй .replaced- не затирает первый
  const fixed = () => day(2026, 10, 4, 10, 0, 0);
  const free = async () => false;
  const v1 = read(a.live).toString();
  assert.equal(await restoreMain([a.copy, '--to', a.live, '--data-dir', a.data], { ...q, probe: free, now: fixed }), 0);
  fs.writeFileSync(a.live, 'второй живой\n');
  assert.equal(await restoreMain([a.copy, '--to', a.live, '--data-dir', a.data], { ...q, probe: free, now: fixed }), 0);
  assert.equal(read(path.join(a.data, 'actions.log.replaced-20261004-100000')).toString(), v1);
  assert.equal(read(path.join(a.data, 'actions.log.replaced-20261004-100000-2')).toString(), 'второй живой\n');
});

test('restore: неверный вызов — код 2 без записи', async () => {
  assert.equal((await tool([])).code, 2);
  assert.equal((await tool(['x.log', '--to'])).code, 2);
  assert.equal((await tool(['x.log', '--нет'])).code, 2);
  const a = restoreArea();
  assert.equal((await tool([path.join(a.data, 'нет-такой-копии.log'), '--data-dir', a.data])).code, 1);
});

test('restore не тянет сервер: граф импорта от tools/restore-actions.mjs — без fastify, lib/start.mjs, lib/app.mjs; lib/port.mjs — только node:', () => {
  const seen = new Set();
  const bare = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else bare.add(spec);
    }
  };
  walk(TOOL);
  const rel = [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.ok(rel.includes('lib/port.mjs'), rel.join(','));
  for (const heavy of ['lib/start.mjs', 'lib/app.mjs']) assert.ok(!rel.includes(heavy), `restore тянет ${heavy}: ${rel.join(',')}`);
  assert.deepEqual([...bare].filter((b) => !b.startsWith('node:')), [], 'restore тянет внешние пакеты');
  const portSrc = fs.readFileSync(path.join(ROOT, 'lib', 'port.mjs'), 'utf8');
  assert.deepEqual([...portSrc.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((x) => !x.startsWith('node:')), []);
});

test('localDay: местная дата ГГГГ-ММ-ДД', () => {
  assert.equal(localDay(day(2026, 1, 5, 23, 59, 59)), '2026-01-05');
  assert.equal(localDay(day(2026, 12, 31, 0, 0, 0)), '2026-12-31');
});
