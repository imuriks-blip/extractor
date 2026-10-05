// Хвост ПТ7 (EXT-70), страница — выбор данных (web/src/pultData.js): подпись исхода need-confirm в «Моих словах» по bdeal строки
// GET /api/actions; метка главного слова панели карточки — из живой строки (б) или из отложенной строки (б) waiting.deferred.
// Ожидаемое — из ТЗ хвоста и спеки (§1.7, витрина §1.6), не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { outcomeText, cardMainMark } = await import('../web/src/pultData.js');

test('«Мои слова»: need-confirm с Б-делом — «ждёт второго щелчка», без Б-дела — «ждёт выбора треда»', () => {
  assert.equal(outcomeText({ status: 'need-confirm', bdeal: 'слово «сливай»' }), 'ждёт второго щелчка');
  assert.equal(outcomeText({ status: 'need-confirm', bdeal: null }), 'ждёт выбора треда');
  assert.equal(outcomeText({ status: 'need-confirm' }), 'ждёт выбора треда', 'поля нет — не Б-дело');
  // прочие исходы — прежние подписи
  assert.equal(outcomeText({ status: 'done', bdeal: 'слово «сливай»' }), 'записано');
  assert.equal(outcomeText({ status: 'refused' }), 'отказ');
});

test('панель карточки: метка главного слова — у живой строки (б) и у отложенной строки (б) по номеру карточки', () => {
  const live = { yes: [{ id: 'EXT-8', mark: 'сливай' }], deferred: [] };
  assert.equal(cardMainMark(live, 'EXT-8'), 'сливай');
  const deferred = { yes: [], deferred: [{ key: 'EXT-9|k', group: 'yes', card: 'EXT-9', mark: 'выкатывай' }] };
  assert.equal(cardMainMark(deferred, 'EXT-9'), 'выкатывай', 'отложенная строка (б) — метка из deferred');
  // отрицательный контроль: чужая карточка, отложенная строка (в) и (а) метки не дают
  assert.equal(cardMainMark(deferred, 'EXT-10'), undefined);
  const other = { yes: [], deferred: [{ key: 'EXT-9|r', group: 'review', card: 'EXT-9' }, { key: 's|u', group: 'thread', card: null }] };
  assert.equal(cardMainMark(other, 'EXT-9'), undefined);
  assert.equal(cardMainMark(undefined, 'EXT-9'), undefined, 'данных «Цеха» ещё нет');
});
