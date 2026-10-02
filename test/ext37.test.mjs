// EXT-37: витрина в покое — нагрузка (А: карта UUID → номер; Б: git по подсказке наблюдателя; В: журналы — горячее
// раз в 2 с, полный обход раз в 30 с) и «ждёт ответа» без открытого вопроса (Г).
// Ожидаемое — из того, что положено в тест здесь же, а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRef } from '../lib/journal-parse.mjs';
import { waitingThreads } from '../lib/waiting.mjs';
import { createNotifier, createNotifyLoop, createWake, toastRows, createAskGate } from '../lib/notify.mjs';
import { tmpDir } from './helpers.mjs';

// ---------- А ----------

// cards под счётчиком перебора: сколько раз кто-то прошёл по ключам объекта
function countedCards(cards) {
  const n = { keys: 0 };
  const p = new Proxy(cards, { ownKeys(t) { n.keys++; return Reflect.ownKeys(t); } });
  return { cards: p, n };
}

test('А: UUID → номер — перебор карточек индекса один раз на объект индекса, не на каждую ссылку', () => {
  const { cards, n } = countedCards({ 'EXT-1': { uuid: 'u-1' }, 'EXT-2': { uuid: 'u-2' }, 'CAR-7': { uuid: 'u-7' } });
  const idx = { cards };
  for (let i = 0; i < 50; i++) {
    assert.equal(resolveRef('u-2', idx), 'EXT-2');
    assert.equal(resolveRef('u-7', idx), 'CAR-7');
    assert.equal(resolveRef('u-404', idx), null);
  }
  assert.equal(n.keys, 1, 'карта строится один раз');
  assert.equal(resolveRef('EXT-9', idx), 'EXT-9', 'номер — как есть');
  assert.equal(resolveRef('u-1', null), null, 'нет индекса — null');
});

test('А: новый объект индекса (зеркало переписало index.json) — новая карта и новый ответ', () => {
  const a = { cards: { 'EXT-1': { uuid: 'u-1' } } };
  assert.equal(resolveRef('u-1', a), 'EXT-1');
  assert.equal(resolveRef('u-2', a), null);
  const b = { cards: { 'EXT-5': { uuid: 'u-1' }, 'EXT-6': { uuid: 'u-2' } } };
  assert.equal(resolveRef('u-1', b), 'EXT-5');
  assert.equal(resolveRef('u-2', b), 'EXT-6');
  assert.equal(resolveRef('u-1', a), 'EXT-1', 'прежний объект — прежний ответ');
});

// ---------- Г ----------

const SID = 'ffffffff-0000-4000-8000-000000000037';
const S1 = '2026-10-02T10:00:00.000Z';
const S2 = '2026-10-02T10:05:00.000Z';
const OLD_ASK = { text: 'Старый вопрос, давно отвечен?', uuid: 'u-old', at: '2026-10-01T08:00:00.000Z' };
const NEW_ASK = { text: 'Какой вариант берём?', uuid: 'u-new', at: '2026-10-02T10:00:01.000Z' };
// тред стоит на «input needed» (реестр процессов: status waiting) — waitingKind askUserQuestion (threads.mjs)
const inputNeeded = (statusUpdatedAt) => ({ sessionId: SID, title: 'EXT · тред', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'askUserQuestion', statusUpdatedAt });
const T = Date.parse('2026-10-02T10:10:00.000Z');

test('Г: старый отвеченный AskUserQuestion + новое ожидание (план, иной вопрос) — строка без текста, ключ sessionId|statusUpdatedAt', () => {
  const [r] = waitingThreads({ threads: [inputNeeded(S1)], sessions: [{ sessionId: SID, thread: { askOpen: false, ask: OLD_ASK } }], now: T });
  assert.equal(r.text, null, 'текст старого вопроса не берётся');
  assert.equal(r.key, `${SID}|${S1}`);
  assert.equal(r.uuid, null);
  assert.equal(r.since, S1, 'с момента ожидания, не с давнего вопроса');
  assert.equal(r.askMissing, true);
});

test('Г: открытый AskUserQuestion — текст и ключ вопроса', () => {
  const [r] = waitingThreads({ threads: [inputNeeded(S1)], sessions: [{ sessionId: SID, thread: { askOpen: true, ask: NEW_ASK } }], now: T });
  assert.equal(r.text, 'Трурль: Какой вариант берём?');
  assert.equal(r.key, `${SID}|u-new`);
  assert.equal(r.uuid, 'u-new');
  assert.equal(r.since, NEW_ASK.at);
  assert.ok(!r.askMissing);
});

// цикл уведомлений как на сервере: строки (а) из waitingThreads над текущим журналом, ворота «3 цикла подряд»
function rig(initial) {
  let th = initial;
  const shown = [];
  const gate = createAskGate();
  const rowsOf = (opts) => {
    const w = { threads: waitingThreads({ threads: [th.thread], sessions: [{ sessionId: SID, thread: th.journal }], now: T }), yes: [] };
    return toastRows(w, { confirmed: gate.see(w), ...opts });
  };
  const c = { t: T };
  const loop = createNotifyLoop({
    notifier: createNotifier({ file: path.join(tmpDir('ext37-notified-'), 'notified.json'), show: (r) => shown.push(r) }),
    rows: rowsOf,
    readAll: async () => {},
    wake: createWake({ now: () => c.t, jumpMs: 90000 }),
  });
  return { set: (x) => { th = x; }, shown, loop, tick: async () => { c.t += 2000; await loop.tick(); } };
}
const idleThread = { ...inputNeeded(S1), state: 'idle', waitingKind: null };

test('Г: вопрос дописался в журнал на втором цикле — один тост, с текстом вопроса', async () => {
  const r = rig({ thread: idleThread, journal: { askOpen: false, ask: OLD_ASK } });
  await r.loop.start(Promise.resolve());
  r.set({ thread: inputNeeded(S1), journal: { askOpen: false, ask: OLD_ASK } }); // процесс уже ждёт, журнал ещё нет
  await r.tick();
  assert.equal(r.shown.length, 0, 'первый цикл без вопроса — тоста нет');
  r.set({ thread: inputNeeded(S1), journal: { askOpen: true, ask: NEW_ASK } });
  for (let i = 0; i < 5; i++) await r.tick();
  assert.deepEqual(r.shown.map((x) => [x.key, x.body]), [[`${SID}|u-new`, 'Трурль: Какой вариант берём?']]);
});

test('Г: открытого вопроса нет 3 цикла подряд при том же statusUpdatedAt — один тост без текста; новое ожидание — счёт заново', async () => {
  const r = rig({ thread: idleThread, journal: { askOpen: false, ask: OLD_ASK } });
  await r.loop.start(Promise.resolve());
  r.set({ thread: inputNeeded(S1), journal: { askOpen: false, ask: OLD_ASK } });
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 0, 'два цикла — ещё рано');
  await r.tick();
  assert.deepEqual(r.shown.map((x) => [x.key, x.title, x.body]), [[`${SID}|${S1}`, 'EXT · тред ждёт ответа', '']]);
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 1, 'тот же ключ второй раз не показывается');
  // ответил, тред поработал и снова встал — новый statusUpdatedAt; два цикла, потом вопрос открылся — тост вопроса
  r.set({ thread: inputNeeded(S2), journal: { askOpen: false, ask: OLD_ASK } });
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 1, 'новое ожидание: счёт с нуля');
  r.set({ thread: inputNeeded(S2), journal: { askOpen: true, ask: NEW_ASK } });
  await r.tick(); await r.tick(); await r.tick();
  assert.deepEqual(r.shown.map((x) => x.key), [`${SID}|${S1}`, `${SID}|u-new`]);
});

test('Г: прерванный счёт (цикл с открытым вопросом между) — не «подряд»; тихий первый цикл запоминает и строку без вопроса', async () => {
  const g = createAskGate();
  const row = { key: `${SID}|${S1}`, kind: 'askUserQuestion', askMissing: true, uuid: null, title: 'т', text: null };
  const w = (rows) => ({ threads: rows, yes: [] });
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([])).has(row.key), false, 'строка ушла — счёт сброшен');
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), true, 'третий подряд');
  // тихий цикл (старт, пробуждение): строка без вопроса идёт в notified.json сразу — без лавины после старта
  assert.deepEqual(toastRows(w([row]), { silent: true }).map((x) => x.key), [row.key]);
  assert.deepEqual(toastRows(w([row])).map((x) => x.key), [], 'без подтверждения — не тост');
});
