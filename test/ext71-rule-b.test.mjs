// EXT-71, ПТ7б контроль (17): правило (б) «Ждёт меня» и запись отзыва (спека витрины 2.4, спека пульта §1.9). Доска — временная
// копия в живой форме, журнал разбирает parseLog доски через настоящий читатель; ожидаемые значения — из положенных данных.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { buildWaiting } from '../lib/waiting.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse('2026-10-07T12:00:00Z');

function entry(ms, kind, body) {
  const d = new Date(ms + 3 * 3600000).toISOString();
  return `### ${d.slice(0, 10)} ${d.slice(11, 16)} +03:00 · plane · ${kind}\n\n${body}\n\n`;
}
const header = (ms, kind) => { const d = new Date(ms + 3 * 3600000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 16)} +03:00 · plane · ${kind}`; };
const Q = 'Ждёт «сливай»: влить ветку?';
const word = (id, w) => `<p><b>Слово Ивана · кнопка витрины · ${id}</b>: «${w}»</p><p>Кто решил: слово Ивана · кнопка витрины · ${id}</p>`;
const withdraw = (id, num) => `<p><b>Слово Ивана · кнопка витрины · ${id}</b>: «отозвать ${num}»</p><p>Отзывает: ${num} · 07.10 14:00 · «сливай» — не исполнять; если уже исполнено — сказать Ивану в чате</p><p>Кто решил: слово Ивана · кнопка витрины · ${id}</p>`;

async function waitingOf(logs) {
  const cards = Object.keys(logs).map((id) => ({ id, status: 'review', title: `Карточка ${id}` }));
  const dir = makeBoard(tmpDir('rb-'), { codes: ['EXT'], cards });
  for (const [id, entries] of Object.entries(logs)) fs.writeFileSync(path.join(dir, 'EXT', `${id}.log.md`), entries.join(''));
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  return buildWaiting({ board, now: NOW });
}

const t = (minAgo) => NOW - minAgo * MIN;

test('(17) запись отзыва после вопроса: строка (б) снова в «Ждёт меня», ключ — заголовок записи отзыва, время — от вопроса; исправный рядом снят', async () => {
  const w = await waitingOf({
    // отозванное слово: вопрос → слово «сливай» (W-5) → отзыв (W-6)
    'EXT-1': [entry(t(300), 'коммент', Q), entry(t(200), 'коммент', word('W-5', 'сливай')), entry(t(100), 'коммент', withdraw('W-6', 'W-5'))],
    // исправный: вопрос → слово без отзыва — строка снята
    'EXT-2': [entry(t(300), 'коммент', Q), entry(t(200), 'коммент', word('W-7', 'сливай'))],
  });
  assert.deepEqual(w.yes.map((r) => [r.id, r.mark]), [['EXT-1', 'сливай']], 'отозванное — в (б), исправный — снят');
  const row = w.yes[0];
  assert.equal(row.key, `EXT-1|${header(t(100), 'коммент')}`, 'ключ — заголовок записи отзыва');
  assert.equal(row.since, new Date(t(300)).toISOString(), 'время строки — время записи-вопроса');
  assert.deepEqual(w.review.map((r) => r.id), ['EXT-2'], '(б) важнее (в): отозванная в «Посмотри» не дублируется, исправный (снят из (б)) — там');
});

test('(17) предел 14 дней — от записи-вопроса, не от записи отзыва', async () => {
  const w = await waitingOf({
    'EXT-1': [entry(NOW - 15 * DAY, 'коммент', Q), entry(NOW - 2 * DAY, 'коммент', word('W-5', 'сливай')), entry(NOW - 1 * DAY, 'коммент', withdraw('W-6', 'W-5'))],
    'EXT-2': [entry(NOW - 13 * DAY, 'коммент', Q), entry(NOW - 2 * DAY, 'коммент', word('W-7', 'сливай')), entry(NOW - 1 * DAY, 'коммент', withdraw('W-8', 'W-7'))],
  });
  assert.deepEqual(w.yes.map((r) => r.id), ['EXT-2'], 'вопрос 15 дней назад — за пределом, 13 — в пределе');
});

test('(17) отрицательные контроли: отзыв чужого слова и новая запись после отзыва вопроса не возвращают', async () => {
  const w = await waitingOf({
    // отзыв W-9, а слово на карточке W-5: отозванной записи нет, но сам отзыв всё равно пропускается, последняя — слово W-5 → строки нет
    'EXT-1': [entry(t(300), 'коммент', Q), entry(t(200), 'коммент', word('W-5', 'сливай')), entry(t(150), 'коммент', withdraw('W-6', 'W-9'))],
    // после отзыва пришла новая запись без маркера — она и есть последняя
    'EXT-2': [entry(t(300), 'коммент', Q), entry(t(200), 'коммент', word('W-5', 'сливай')), entry(t(100), 'коммент', withdraw('W-6', 'W-5')), entry(t(50), 'коммент', 'Слито, проверено.')],
    // после отзыва пришёл новый вопрос — он и есть последняя запись (ключ его)
    'EXT-3': [entry(t(300), 'коммент', Q), entry(t(200), 'коммент', word('W-5', 'сливай')), entry(t(100), 'коммент', withdraw('W-6', 'W-5')), entry(t(50), 'коммент', 'Ещё развилка: какой путь?')],
  });
  assert.deepEqual(w.yes.map((r) => [r.id, r.mark]), [['EXT-3', 'развилка']]);
  assert.equal(w.yes[0].key, `EXT-3|${header(t(50), 'коммент')}`, 'ключ — новая последняя запись');
  assert.equal(w.yes[0].since, new Date(t(50)).toISOString());
});
