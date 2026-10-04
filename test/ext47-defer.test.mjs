// EXT-47 (спека пульта §1.3 «Отложить до …», §1.7 defer/undefer): личная отметка Ивана на строке «Ждёт меня» —
// в data/vitrina/defer.json и строкой в actions.log, в Plane ничего. Строка с действующей отметкой — вне waiting.* и
// счётчика, в waiting.deferred[]; в срок — назад с одним тостом «вернулось: …»; исчезла сама — отметка снимается молча;
// новый вопрос (другой key) — виден; рестарт — отметка цела. Часы подменены, каталог данных — временный.
// Ожидаемые значения — из спеки и из того, что положено в тест (сроки — по местному календарю вручную).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { CHECKS } from '../lib/pult/guard.mjs';
import { untilOf, createDeferStore } from '../lib/pult/defer.mjs';
import { localIso } from '../lib/pult/actions-log.mjs';
import { createNotifier, createNotifyLoop, createWake, toastRows } from '../lib/notify.mjs';
import { waitingThreads } from '../lib/waiting.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, gitCommitAll } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 0;
const nextIntent = () => uuid(++intents);
const H = 3600000;

const regFile = path.join(tmpDir('reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const registry = createRegistryReader(regFile);

async function makeBoardReader() {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT', 'CAR'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека витрины' }, { id: 'CAR-1', status: 'review', title: 'Фото сметы' }] });
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  return { dir, board };
}

// строка (а) — как её отдаёт waitingThreads (ключ sessionId|uuid вопроса)
const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const threadRow = (sid, q, title) => ({ sessionId: sid, title, project: 'EXT', projectBy: 'title', kind: 'question', text: `Трурль: вопрос ${q}`, since: '2026-10-04T08:00:00.000Z', overDay: false, key: `${sid}|${q}`, uuid: q });

// jst — состояние читателя журналов (строки (а)): проход удачен — failingSince null, lastOkAt сдвигается pass()
async function setup({ data = tmpDir('defer-'), clock = { t: Date.parse('2026-10-04T10:00:00Z') }, rows, boardR, enabled = true, deferFs } = {}) {
  const { dir, board } = boardR ?? await makeBoardReader();
  const waitingRows = rows ?? [threadRow(SID, uuid(901), 'Тред EXT'), threadRow(SID2, uuid(902), 'Тред CAR')];
  const threads = { list: () => ({ threads: [], subagentsCount: 0, unknownStatus: {}, waiting: waitingRows }), state: () => ({ processes: null, desktop: null }) };
  const jst = { lastOkAt: '2026-10-04T10:00:00.000Z', failingSince: null };
  let passes = 0;
  const pass = ({ ok = true } = {}) => {
    if (ok) { jst.lastOkAt = new Date(Date.parse('2026-10-04T10:00:00Z') + ++passes * 2000).toISOString(); jst.failingSince = null; }
    else jst.failingSince = jst.failingSince ?? jst.lastOkAt;
  };
  const journals = { state: () => ({ ...jst }) };
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const app = await buildApp({
    port: PORT, board, registry, threads, journals, scan, webDir: web,
    pult: { enabled, words: false, actionsLog: path.join(data, 'actions.log'), mirrorDir: tmpDir('mirror-'), lock: lockLib, boardRoot: dir },
    pultSeams: { checks: CHECKS, now: () => clock.t, ...(deferFs ? { deferFs } : {}) },
  });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/<meta name="vitrina-token" content="([^"]+)">/)[1];
  const act = (body) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const ceh = async () => (await app.inject({ method: 'GET', url: '/api/ceh', headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => { const f = path.join(data, 'actions.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const deferFile = path.join(data, 'defer.json');
  // уведомления — как в start.mjs: строки цикла из «Цеха», возврат в срок — sweep отметок того же цикла
  const shown = [];
  const notifier = createNotifier({ file: path.join(data, 'notified.json'), show: (t) => shown.push(t) });
  const cycle = (opts = {}) => {
    const w = app.vitrina.cehPayload().waiting;
    const back = app.vitrina.deferSweep(w);
    return notifier.cycle(toastRows(w, { back, ...opts }), opts);
  };
  // проект окна (В9) — та же форма deferred[]
  const project = async (code) => (await app.inject({ method: 'GET', url: `/api/project/${code}`, headers: { host: `127.0.0.1:${PORT}` } })).json();
  return { app, act, ceh, project, lines, data, clock, waitingRows, deferFile, shown, cycle, dir, board, pass, jst, notifier };
}
const keysOf = (w) => [...w.threads, ...w.yes, ...w.review].map((r) => r.key);

test('отложил строку (а): её нет в waiting.threads, счётчик меньше на 1, она в waiting.deferred; defer.json и actions.log — есть', async () => {
  const s = await setup();
  const before = await s.ceh();
  assert.equal(before.waiting.count, 2);
  assert.deepEqual(before.waiting.deferred, []);
  const key = `${SID}|${uuid(901)}`;
  const r = await s.act({ action: 'defer', rowKey: key, until: '1h' });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'ok');
  // 10:00Z + 1 ч — время возврата в местном времени машины
  const back = new Date(Date.parse('2026-10-04T11:00:00Z'));
  const hhmm = `${String(back.getHours()).padStart(2, '0')}:${String(back.getMinutes()).padStart(2, '0')}`;
  assert.ok(b.message.includes(hhmm), b.message);
  const after = await s.ceh();
  assert.equal(after.waiting.count, 1);
  assert.ok(!keysOf(after.waiting).includes(key));
  assert.equal(after.waiting.deferred.length, 1);
  const d = after.waiting.deferred[0];
  assert.equal(d.key, key);
  assert.equal(d.group, 'thread');
  assert.equal(d.label, 'Тред EXT');
  assert.equal(d.card, null);
  assert.equal(Date.parse(d.until), Date.parse('2026-10-04T11:00:00Z'));
  assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(s.deferFile, 'utf8')).marks, key));
  const ls = s.lines();
  assert.deepEqual(ls.map((l) => [l.action, l.step]), [['defer', 'asked'], ['defer', 'done']]);
  assert.equal(ls[0].rowKey, key);
  assert.equal(ls[0].until, '1h');
});

test('отложил строку (в) «Готово, посмотри»: у неё есть key, после defer её нет в review, more меньше, в deferred — карточка', async () => {
  const s = await setup();
  const before = await s.ceh();
  assert.equal(before.waiting.more, 2);
  const row = before.waiting.review.find((r) => r.id === 'EXT-6');
  assert.ok(typeof row.key === 'string' && row.key.startsWith('EXT-6|'), `key строки (в): ${row.key}`);
  assert.equal((await s.act({ action: 'defer', rowKey: row.key, until: 'tomorrow9' })).json().outcome, 'ok');
  const after = await s.ceh();
  assert.equal(after.waiting.more, 1);
  assert.ok(!after.waiting.review.some((r) => r.id === 'EXT-6'));
  const d = after.waiting.deferred.find((x) => x.key === row.key);
  assert.deepEqual({ group: d.group, card: d.card, label: d.label, project: d.project }, { group: 'review', card: 'EXT-6', label: 'Спека витрины', project: 'EXT' });
});

test('срок прошёл: строка снова в «Ждёт меня», отметка снята, уведомление «вернулось: …» — ровно одно', async () => {
  const s = await setup();
  assert.equal(s.cycle({ silent: true }), 0); // первый цикл после старта — тихий, ключи строк запомнены
  const key = `${SID}|${uuid(901)}`;
  await s.act({ action: 'defer', rowKey: key, until: '1h' });
  s.cycle();
  assert.equal(s.shown.length, 0, 'пока отложена — тостов нет');
  s.clock.t += H + 1000;
  const w = (await s.ceh()).waiting;
  assert.ok(keysOf(w).includes(key));
  assert.equal(w.count, 2);
  s.cycle();
  s.cycle();
  assert.equal(s.shown.length, 1, JSON.stringify(s.shown));
  assert.equal(s.shown[0].title, 'вернулось: Тред EXT');
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(s.deferFile, 'utf8')).marks, key), 'отметка снята');
  assert.deepEqual((await s.ceh()).waiting.deferred, []);
});

test('отложил строку раньше, чем её увидели уведомления: в срок — одно «вернулось», без второго «ждёт ответа»', async () => {
  const s = await setup();
  const key = `${SID}|${uuid(901)}`;
  await s.act({ action: 'defer', rowKey: key, until: '1h' });
  s.cycle({ silent: true });
  s.cycle();
  s.clock.t += H + 1000;
  s.cycle();
  s.cycle();
  assert.deepEqual(s.shown.map((t) => t.title), ['вернулось: Тред EXT']);
});

test('строка исчезла сама до срока: отметка снимается молча, уведомления нет; вернулась тем же ключом — видна', async () => {
  const s = await setup();
  s.cycle({ silent: true });
  const key = `${SID}|${uuid(901)}`;
  const row = s.waitingRows[0];
  await s.act({ action: 'defer', rowKey: key, until: '3days9' });
  s.waitingRows.splice(0, 1); // тред ответили — строки нет
  for (let i = 0; i < 3; i++) { s.pass(); s.cycle(); } // В3: три цикла подряд при удачных проходах читателя
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(s.deferFile, 'utf8')).marks, key), 'отметка ушла');
  assert.deepEqual((await s.ceh()).waiting.deferred, []);
  s.clock.t += 4 * 24 * H;
  s.cycle();
  assert.equal(s.shown.length, 0);
  s.clock.t -= 4 * 24 * H;
  s.waitingRows.unshift(row);
  assert.ok(keysOf((await s.ceh()).waiting).includes(key));
});

test('новый вопрос того же треда (другой key): строка видна, отметка старого вопроса её не прячет', async () => {
  const s = await setup();
  const key = `${SID}|${uuid(901)}`;
  await s.act({ action: 'defer', rowKey: key, until: 'monday9' });
  s.waitingRows[0] = threadRow(SID, uuid(903), 'Тред EXT');
  const w = (await s.ceh()).waiting;
  assert.ok(keysOf(w).includes(`${SID}|${uuid(903)}`));
  assert.equal(w.count, 2);
  assert.deepEqual(w.deferred, []);
});

test('новая запись на карточке (в) (другое q.at): строка видна, хотя карточка та же', async () => {
  const s = await setup();
  const row = (await s.ceh()).waiting.review.find((r) => r.id === 'EXT-6');
  await s.act({ action: 'defer', rowKey: row.key, until: '1h' });
  assert.ok(!(await s.ceh()).waiting.review.some((r) => r.id === 'EXT-6'));
  fs.appendFileSync(path.join(s.dir, 'EXT', 'EXT-6.log.md'), '### 2026-10-04 12:10 +03:00 · plane · коммент\n\nНовый вопрос треда.\n\n');
  gitCommitAll(s.dir, 'запись'); // читатель доски видит коммит, не файл
  await s.board.refresh();
  const w = (await s.ceh()).waiting;
  const again = w.review.find((r) => r.id === 'EXT-6');
  assert.ok(again, 'строка (в) снова видна');
  assert.notEqual(again.key, row.key);
  assert.equal(again.q.at.slice(0, 10), '2026-10-04');
});

test('undefer: строка видна сразу, отметки нет, в actions.log — asked и done', async () => {
  const s = await setup();
  const key = `${SID}|${uuid(901)}`;
  await s.act({ action: 'defer', rowKey: key, until: 'tomorrow9' });
  assert.ok(!keysOf((await s.ceh()).waiting).includes(key));
  const r = await s.act({ action: 'undefer', rowKey: key });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'ok');
  const w = (await s.ceh()).waiting;
  assert.ok(keysOf(w).includes(key));
  assert.equal(w.count, 2);
  assert.deepEqual(w.deferred, []);
  assert.deepEqual(s.lines().filter((l) => l.action === 'undefer').map((l) => l.step), ['asked', 'done']);
});

test('рестарт: отметка из defer.json цела — строка по-прежнему отложена', async () => {
  const data = tmpDir('defer-');
  const clock = { t: Date.parse('2026-10-04T10:00:00Z') };
  const boardR = await makeBoardReader();
  const s1 = await setup({ data, clock, boardR });
  const key = `${SID}|${uuid(901)}`;
  await s1.act({ action: 'defer', rowKey: key, until: '3days9' });
  await s1.app.close();
  const s2 = await setup({ data, clock, boardR });
  const w = (await s2.ceh()).waiting;
  assert.ok(!keysOf(w).includes(key));
  assert.deepEqual(w.deferred.map((d) => d.key), [key]);
});

test('неверный until (произвольная дата, чужое слово, нет поля) и нет rowKey — 400 по форме §1.7, в actions.log ничего', async () => {
  const s = await setup();
  const key = `${SID}|${uuid(901)}`;
  for (const [body, why] of [
    [{ action: 'defer', rowKey: key, until: '2026-10-05T09:00+03:00' }, 'until'],
    [{ action: 'defer', rowKey: key, until: '2h' }, 'until'],
    [{ action: 'defer', rowKey: key }, 'until'],
    [{ action: 'defer', until: '1h' }, 'rowKey'],
    [{ action: 'defer', rowKey: '', until: '1h' }, 'rowKey'],
    [{ action: 'undefer', rowKey: key, until: '1h' }, 'until'],
  ]) {
    const r = await s.act(body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(r.json(), { id: null, step: null, outcome: 'refused', message: `неверный параметр: ${why}` });
  }
  assert.deepEqual(s.lines(), []);
  assert.ok(!fs.existsSync(s.deferFile));
});

test('defer строки, которой нет в «Ждёт меня», — отказ no-row (200, refused), отметки нет', async () => {
  const s = await setup();
  const r = await s.act({ action: 'defer', rowKey: `${SID}|${uuid(999)}`, until: '1h' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'no-row');
  assert.ok(!fs.existsSync(s.deferFile) || Object.keys(JSON.parse(fs.readFileSync(s.deferFile, 'utf8')).marks).length === 0);
});

test('сроки по местному времени машины: 1h, tomorrow9, 3days9, monday9 (понедельник — следующий, не сегодняшний)', () => {
  const sat = new Date(2026, 9, 3, 22, 30).getTime(); // суббота 03.10 22:30
  assert.equal(untilOf('1h', sat), new Date(2026, 9, 3, 23, 30).getTime());
  assert.equal(untilOf('tomorrow9', sat), new Date(2026, 9, 4, 9, 0).getTime());
  assert.equal(untilOf('3days9', sat), new Date(2026, 9, 6, 9, 0).getTime());
  assert.equal(untilOf('monday9', sat), new Date(2026, 9, 5, 9, 0).getTime());
  const mon = new Date(2026, 9, 5, 7, 0).getTime(); // понедельник 05.10 07:00
  assert.equal(untilOf('monday9', mon), new Date(2026, 9, 12, 9, 0).getTime());
  const sun = new Date(2026, 9, 4, 23, 59).getTime();
  assert.equal(untilOf('monday9', sun), new Date(2026, 9, 5, 9, 0).getTime());
  assert.equal(untilOf('tomorrow9', new Date(2026, 9, 31, 12, 0).getTime()), new Date(2026, 10, 1, 9, 0).getTime());
  assert.equal(untilOf('bogus', sat), null);
});

// ---------------- вердикт Голема (дозапрос EXT-47) ----------------

const SID3 = '33333333-3333-4333-8333-333333333333';
const KEY1 = `${SID}|${uuid(901)}`;
const marksOf = (s) => (fs.existsSync(s.deferFile) ? JSON.parse(fs.readFileSync(s.deferFile, 'utf8')).marks : {});
// цикл уведомлений как в start.mjs (createNotifyLoop + wake), часы — подменные
function loopOf(s) {
  const wake = createWake({ now: () => s.clock.t });
  const rows = (opts) => { const w = s.app.vitrina.cehPayload().waiting; return toastRows(w, { back: s.app.vitrina.deferSweep(w), ...opts }); };
  return createNotifyLoop({ notifier: s.notifier, rows, readAll: async () => {}, wake });
}

test('В1: срок истёк во сне — после пробуждения одно «вернулось», новая строка (а) того же цикла — тихая', async () => {
  const s = await setup();
  const loop = loopOf(s);
  await loop.start(Promise.resolve());
  await s.act({ action: 'defer', rowKey: KEY1, until: '1h' });
  await loop.tick();
  s.clock.t += 2 * H; // сон дольше срока
  s.waitingRows.push(threadRow(SID3, uuid(904), 'Тред новый'));
  await loop.tick(); // пробуждение: полный цикл чтения, тихий цикл
  assert.deepEqual(s.shown.map((t) => t.title), ['вернулось: Тред EXT']);
  await loop.tick();
  assert.deepEqual(s.shown.map((t) => t.title), ['вернулось: Тред EXT'], 'новая строка (а) запомнена тихо, второго тоста нет');
});

test('В1: срок истёк при выключенной витрине — после старта одно «вернулось», прочие строки тихие', async () => {
  const data = tmpDir('defer-');
  const clock = { t: Date.parse('2026-10-04T10:00:00Z') };
  const boardR = await makeBoardReader();
  const s1 = await setup({ data, clock, boardR });
  s1.cycle({ silent: true });
  await s1.act({ action: 'defer', rowKey: KEY1, until: '1h' });
  await s1.app.close();
  clock.t += 3 * H;
  const s2 = await setup({ data, clock, boardR });
  s2.waitingRows.push(threadRow(SID3, uuid(905), 'Тред новый'));
  await loopOf(s2).start(Promise.resolve());
  assert.deepEqual(s2.shown.map((t) => t.title), ['вернулось: Тред EXT']);
});

test('В2: pult.enabled = false — отметки не применяются, строки видны, defer.json не тронут; включили — отметка снова действует', async () => {
  const data = tmpDir('defer-');
  const clock = { t: Date.parse('2026-10-04T10:00:00Z') };
  const boardR = await makeBoardReader();
  const s1 = await setup({ data, clock, boardR });
  await s1.act({ action: 'defer', rowKey: KEY1, until: '3days9' });
  await s1.app.close();
  const before = fs.readFileSync(path.join(data, 'defer.json'), 'utf8');
  const s2 = await setup({ data, clock, boardR, enabled: false });
  const w = (await s2.ceh()).waiting;
  assert.ok(keysOf(w).includes(KEY1));
  assert.equal(w.count, 2);
  assert.deepEqual(w.deferred, []);
  s2.waitingRows.splice(0, 1);
  for (let i = 0; i < 4; i++) { s2.pass(); s2.cycle(); }
  assert.equal(fs.readFileSync(path.join(data, 'defer.json'), 'utf8'), before, 'файл не тронут');
  await s2.app.close();
  const s3 = await setup({ data, clock, boardR });
  assert.ok(!keysOf((await s3.ceh()).waiting).includes(KEY1));
});

test('В3: строки нет один и два цикла — отметка цела; три удачных прохода подряд — снята; вернулась до третьего — счёт заново', async () => {
  const s = await setup();
  s.cycle({ silent: true }); // первый цикл после старта — тихий
  const row = s.waitingRows[0];
  await s.act({ action: 'defer', rowKey: KEY1, until: '3days9' });
  s.waitingRows.splice(0, 1);
  s.pass(); s.cycle();
  assert.ok(Object.hasOwn(marksOf(s), KEY1), 'один цикл — цела');
  s.pass(); s.cycle();
  assert.ok(Object.hasOwn(marksOf(s), KEY1), 'два цикла — цела');
  s.waitingRows.unshift(row); // вернулась — счёт сброшен
  s.pass(); s.cycle();
  assert.deepEqual((await s.ceh()).waiting.deferred.map((d) => d.key), [KEY1]);
  s.waitingRows.splice(0, 1);
  s.pass(); s.cycle(); s.pass(); s.cycle();
  assert.ok(Object.hasOwn(marksOf(s), KEY1), 'после сброса два цикла — цела');
  s.pass(); s.cycle();
  assert.ok(!Object.hasOwn(marksOf(s), KEY1), 'три — снята');
  assert.equal(s.shown.length, 0);
});

test('В3: неудачный проход читателя и цикл без нового прохода не считаются', async () => {
  const s = await setup();
  await s.act({ action: 'defer', rowKey: KEY1, until: '3days9' });
  s.waitingRows.splice(0, 1);
  s.pass({ ok: false }); s.cycle(); // строка пропала, а проход читателя не удался — не в счёт, хотя его lastOkAt ещё не считан
  s.pass(); s.cycle();
  s.pass({ ok: false }); s.cycle(); s.cycle(); s.cycle();
  s.pass(); s.cycle();
  s.cycle(); s.cycle(); // тот же проход — не новый
  assert.ok(Object.hasOwn(marksOf(s), KEY1), 'засчитано два удачных прохода — цела');
  s.pass(); s.cycle();
  assert.ok(!Object.hasOwn(marksOf(s), KEY1));
});

test('В3: строка (в) ушла с доски — снятие по проходам читателя доски', async () => {
  const s = await setup();
  const row = (await s.ceh()).waiting.review.find((r) => r.id === 'CAR-1');
  await s.act({ action: 'defer', rowKey: row.key, until: '3days9' });
  const f = path.join(s.dir, 'CAR', 'CAR-1.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: review', 'status: done'));
  gitCommitAll(s.dir, 'done');
  for (let i = 0; i < 2; i++) { await new Promise((r) => setTimeout(r, 5)); await s.board.refresh(); s.cycle(); }
  assert.ok(Object.hasOwn(marksOf(s), row.key), 'два прохода доски — цела');
  await new Promise((r) => setTimeout(r, 5)); await s.board.refresh(); s.cycle();
  assert.ok(!Object.hasOwn(marksOf(s), row.key));
});

test('В3: строка (а) с временным ключом (хвост журнала не дочитан) — keyTemp: true; defer по ней — отказ key-temp', async () => {
  const threads = [{ sessionId: SID3, state: 'waiting', waitingKind: 'question', statusUpdatedAt: '2026-10-04T09:00:00.000Z', title: 'Т' },
    { sessionId: SID2, state: 'waiting', waitingKind: 'question', statusUpdatedAt: '2026-10-04T09:00:00.000Z', title: 'Т2' },
    { sessionId: SID, state: 'waiting', waitingKind: 'permission', statusUpdatedAt: '2026-10-04T09:00:00.000Z', title: 'Т3' }];
  const sessions = [{ sessionId: SID2, lines: 1, thread: { q: { text: 'вопрос', at: '2026-10-04T08:59:00.000Z', uuid: null } } }];
  const rows = waitingThreads({ threads, sessions, now: Date.parse('2026-10-04T10:00:00Z') });
  const by = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
  assert.equal(by[SID3].keyTemp, true, 'нет сообщения — ключ statusUpdatedAt');
  assert.equal(by[SID2].keyTemp, true, 'сообщение без uuid — ключ src.at');
  assert.equal(by[SID].keyTemp, undefined, 'разрешение ключуется statusUpdatedAt всегда — ключ не временный');
  const s = await setup({ rows: [{ ...threadRow(SID3, 'x', 'Тред'), key: by[SID3].key, uuid: null, keyTemp: true }] });
  const r = await s.act({ action: 'defer', rowKey: by[SID3].key, until: '1h' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /ещё нельзя отложить/);
  assert.equal(s.lines().at(-1).refusal, 'key-temp');
  assert.deepEqual(marksOf(s), {});
});

test('В9: /api/project/:code — свой deferred[] (тред — по проекту треда, карточка — по коду) и deferOptions', async () => {
  const s = await setup();
  s.waitingRows[1].project = 'CAR';
  const car = (await s.ceh()).waiting.review.find((r) => r.id === 'CAR-1');
  await s.act({ action: 'defer', rowKey: KEY1, until: '1h' });
  await s.act({ action: 'defer', rowKey: car.key, until: '1h' });
  const ext = await s.project('EXT');
  assert.deepEqual(ext.deferred.map((d) => [d.key, d.group, d.card]), [[KEY1, 'thread', null]]);
  assert.ok(!ext.waiting.some((r) => r.key === KEY1));
  const c = await s.project('CAR');
  assert.deepEqual(c.deferred.map((d) => [d.group, d.card]), [['review', 'CAR-1']]);
  assert.deepEqual(c.deferOptions.map((o) => o.until), ['1h', 'tomorrow9', '3days9', 'monday9']);
});

test('deferOptions в /api/ceh: четыре пункта меню с подписью и готовым временем на момент ответа', async () => {
  const s = await setup();
  const o = (await s.ceh()).waiting.deferOptions;
  assert.deepEqual(o.map((x) => [x.until, x.label]), [['1h', 'на 1 ч'], ['tomorrow9', 'завтра 9:00'], ['3days9', 'через 3 дня 9:00'], ['monday9', 'в понедельник 9:00']]);
  // 10:00Z + 1 ч; остальные — 9:00 местного дня (сами дни проверены в тесте сроков)
  assert.equal(Date.parse(o[0].at), Date.parse('2026-10-04T11:00:00Z'));
  for (const x of o) assert.match(x.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  for (const x of o.slice(1)) assert.equal(new Date(x.at).getHours(), 9);
});

test('М5: запись defer.json не удалась — память как была, ответ «не вышло», строка видна; снятие тоже', async () => {
  const sw = { fail: false };
  const deferFs = { ...fs, renameSync: (...a) => { if (sw.fail) throw Object.assign(new Error('rename'), { code: 'EPERM' }); return fs.renameSync(...a); } };
  const s = await setup({ deferFs });
  sw.fail = true;
  const r = await s.act({ action: 'defer', rowKey: KEY1, until: '1h' });
  assert.equal(r.json().outcome, 'error');
  assert.match(r.json().message, /^не вышло/);
  assert.ok(keysOf((await s.ceh()).waiting).includes(KEY1));
  sw.fail = false;
  await s.act({ action: 'defer', rowKey: KEY1, until: '1h' });
  sw.fail = true;
  const u = await s.act({ action: 'undefer', rowKey: KEY1 });
  assert.equal(u.json().outcome, 'error');
  assert.match(u.json().message, /^не вышло/);
  assert.deepEqual((await s.ceh()).waiting.deferred.map((d) => d.key), [KEY1], 'отметка в памяти осталась');
  // то же на уровне хранилища
  const st = createDeferStore({ file: path.join(tmpDir('st-'), 'defer.json'), fs: deferFs });
  assert.throws(() => st.set('a|b', Date.now() + H, 'W-1'));
  assert.equal(st.has('a|b'), false);
});

test('М7: rowKey с переводом строки, табуляцией или иным управляющим — 400 rowKey', async () => {
  const s = await setup();
  for (const k of [`${KEY1}\n`, 'a\tb', 'a\u0000b', 'a\u007fb']) {
    const r = await s.act({ action: 'defer', rowKey: k, until: '1h' });
    assert.equal(r.statusCode, 400, JSON.stringify(k));
    assert.equal(r.json().message, 'неверный параметр: rowKey');
  }
});

test('М8: битый и пустой defer.json при старте — витрина живёт, отметок нет, defer работает', async () => {
  for (const text of ['{не json', '']) {
    const data = tmpDir('defer-');
    fs.writeFileSync(path.join(data, 'defer.json'), text);
    const s = await setup({ data });
    const w = (await s.ceh()).waiting;
    assert.equal(w.count, 2);
    assert.deepEqual(w.deferred, []);
    assert.equal((await s.act({ action: 'defer', rowKey: KEY1, until: '1h' })).json().outcome, 'ok');
    assert.deepEqual(Object.keys(marksOf(s)), [KEY1]);
  }
});

test('М8: строка (б) «нужно твоё да» — defer прячет её из yes и счётчика, в срок — «вернулось: <номер> · <заголовок>»', async () => {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT', 'CAR'], cards: [{ id: 'EXT-8', status: 'in-progress', title: 'Слить витрину' }] });
  const [d, t] = localIso(new Date(Date.now() - H)).split('T');
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-8.log.md'), `### ${d} ${t.slice(0, 5)} ${t.slice(8)} · plane · коммент\n\nВетка готова — сливай?\n\n`);
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const s = await setup({ boardR: { dir, board }, rows: [] });
  s.cycle({ silent: true });
  const w0 = (await s.ceh()).waiting;
  const row = w0.yes.find((r) => r.id === 'EXT-8');
  assert.ok(row, 'строка (б) есть');
  assert.equal(w0.count, 1);
  await s.act({ action: 'defer', rowKey: row.key, until: '1h' });
  const w1 = (await s.ceh()).waiting;
  assert.equal(w1.count, 0);
  assert.deepEqual(w1.deferred.map((x) => [x.group, x.card, x.label]), [['yes', 'EXT-8', 'Слить витрину']]);
  s.clock.t += H + 1000;
  s.cycle(); s.cycle();
  assert.deepEqual(s.shown.map((x) => [x.title, x.body]), [['вернулось: EXT-8 · Слить витрину', 'сливай · нужно твоё «да»']]);
  assert.equal((await s.ceh()).waiting.count, 1);
});
