// EXT-71, ПТ7б, страница — выбор данных кнопки «Отозвать» (web/src/pultData.js; спека пульта §1.9 «Кнопка и что видит Иван»):
// когда кнопка видна, тексты статусов слова и строки отзыва, исход нажатия, отметка отозванного слова как красная.
// Ожидаемые значения — из спеки, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { canWithdraw, wordRingView, withdrawRowView, withdrawResult, markIsRed, RETURN_HINT, LATE_TEXT } = await import('../web/src/pultData.js');

const ON = { enabled: true, words: true, bell: true };
const word = (o = {}) => ({ id: 'W-1', action: 'yes', card: 'EXT-5', status: 'done', ring: 'положено', ...o });

test('кнопка видна: «положено» и «не доставлено: тред закрыт» у любого слова круга', () => {
  for (const action of ['yes', 'go', 'merge', 'deploy', 'no', 'reply', 'return', 'take', 'reread']) {
    assert.equal(canWithdraw(word({ action }), ON), true, `${action}: положено`);
    assert.equal(canWithdraw(word({ action, ring: 'не доставлено: тред закрыт' }), ON), true, `${action}: тред закрыт`);
  }
});

test('кнопки нет: действие вне круга, чужие статусы звонка, withdrawnBy, нет ring', () => {
  for (const action of ['accept', 'mirror', 'defer', 'new-card', 'withdraw']) assert.equal(canWithdraw(word({ action }), ON), false, action);
  for (const ring of ['доставлено', 'прочитано', 'звонок выключен', null]) assert.equal(canWithdraw(word({ ring }), ON), false, String(ring));
  assert.equal(canWithdraw(word({ ring: 'отозвано', withdrawnBy: 'W-2' }), ON), false, 'отозвано кем-то (done) — кнопки нет');
  assert.equal(canWithdraw(word({ withdrawnBy: 'W-2' }), ON), false, 'withdrawnBy — кнопки нет, какой бы ни был ring');
  assert.equal(canWithdraw(null, ON), false);
});

test('«сброшено перезапуском»: кнопка только у слова с карточкой (отзыв — только запись)', () => {
  assert.equal(canWithdraw(word({ ring: 'сброшено перезапуском' }), ON), true);
  assert.equal(canWithdraw(word({ ring: 'сброшено перезапуском', card: null }), ON), false, 'без карточки — нет');
  assert.equal(canWithdraw(word({ ring: 'положено', card: null }), ON), true, 'положено без карточки — отзывается');
});

test('флаги: нет кнопки при pult.enabled = false, bell = false или без флагов; words = false не мешает', () => {
  assert.equal(canWithdraw(word(), { ...ON, enabled: false }), false);
  assert.equal(canWithdraw(word(), { ...ON, bell: false }), false);
  assert.equal(canWithdraw(word(), undefined), false);
  assert.equal(canWithdraw(word(), { enabled: true, bell: true }), true, 'words не читается: отзыв только убирает');
  assert.equal(canWithdraw(word(), { ...ON, words: false }), true);
});

test('partial (звонок снят, записи нет): ring «отозвано…» без withdrawnBy — кнопка остаётся повтором', () => {
  assert.equal(canWithdraw(word({ ring: 'отозвано' }), ON), true);
  assert.equal(canWithdraw(word({ ring: 'отозвано поздно: доставлено' }), ON), true);
  const v = wordRingView(word({ ring: 'отозвано' }));
  assert.match(v.text, /^отозвано · звонок снят, записи об отзыве нет/);
  assert.equal(v.cls, 'amb');
});

test('статус слова после отзыва: «отозвано · <id>», «сброшено перезапуском · отозвано <id>», поздно — красная строка', () => {
  assert.deepEqual(wordRingView(word({ ring: 'отозвано', withdrawnBy: 'W-7' })), { text: 'отозвано · W-7', cls: 'off' });
  assert.equal(wordRingView(word({ ring: 'сброшено перезапуском', withdrawnBy: 'W-7' })).text, 'сброшено перезапуском · отозвано W-7');
  for (const ring of ['отозвано поздно: доставлено', 'отозвано поздно: прочитано']) {
    const v = wordRingView(word({ ring, withdrawnBy: 'W-7' }));
    assert.equal(v.cls, 'bad', ring);
    assert.ok(v.text.startsWith('отозвано поздно: тред слово получил — скажи ему в чате'), ring);
    assert.equal(LATE_TEXT, 'отозвано поздно: тред слово получил — скажи ему в чате');
  }
  assert.deepEqual(wordRingView(word({ ring: 'доставлено' })), { text: 'доставлено', cls: 'ring' }, 'обычный статус — как был');
  assert.equal(wordRingView(word({ ring: null })), null);
});

test('строка отзыва: «отозвать <номер слова>» и исход; «Вернуть» — подсказка; поздняя гонка — красным', () => {
  const rows = [word({ id: 'W-1', action: 'return', ring: 'отозвано', withdrawnBy: 'W-2' }), word({ id: 'W-3', action: 'yes', ring: 'отозвано поздно: доставлено', withdrawnBy: 'W-4' }), word({ id: 'W-5', action: 'no', ring: 'отозвано', withdrawnBy: 'W-6' })];
  const wd = (id, withdraws, wordNo, status) => ({ id, action: 'withdraw', status, withdraws, word: wordNo });
  assert.deepEqual(withdrawRowView(wd('W-2', 'W-1', 'W-1', 'done'), rows), { label: 'отозвать W-1', text: `отозвано · ${RETURN_HINT}`, cls: null });
  assert.equal(RETURN_HINT, 'звонок снят; карточка осталась в In Progress — попроси дирижёра вернуть в Review');
  assert.deepEqual(withdrawRowView(wd('W-6', 'W-5', 'W-5', 'done'), rows), { label: 'отозвать W-5', text: 'отозвано', cls: null }, 'исправный рядом — без подсказки и без красного');
  assert.equal(withdrawRowView(wd('W-4', 'W-3', 'W-3', 'done'), rows).cls, 'bad');
  assert.equal(withdrawRowView(wd('W-4', 'W-3', 'W-3', 'done'), rows).text, LATE_TEXT);
  assert.equal(withdrawRowView(wd('W-8', 'W-1', 'W-1', 'partial'), rows).cls, 'amb');
  assert.equal(withdrawRowView(wd('W-9', 'W-1', null, 'refused'), rows).label, 'отозвать W-1', 'номер слова не нашёлся — номер действия');
});

test('исход нажатия по ответу сервера', () => {
  assert.deepEqual(withdrawResult(200, { outcome: 'ok', id: 'W-7', message: 'отозвано · запись на EXT-5 легла 12:00' }), { phase: 'ok', by: 'W-7', late: false, text: 'отозвано · запись на EXT-5 легла 12:00' });
  assert.equal(withdrawResult(200, { outcome: 'ok', id: 'W-7', message: 'отозвано поздно: доставлено — тред слово получил, скажи ему в чате' }).late, true);
  assert.equal(withdrawResult(200, { outcome: 'partial', message: 'звонок снят, запись об отзыве не легла — повторить' }).phase, 'partial');
  assert.equal(withdrawResult(200, { outcome: 'refused', refusal: 'not-queued', message: 'нет в памяти звонка' }).phase, 'refused');
  assert.equal(withdrawResult(409, { message: 'EXT-5: предыдущее ещё идёт' }).phase, 'refused', 'card-busy');
  assert.equal(withdrawResult(500, {}).phase, 'error');
});

test('местная отметка: ring «отозвано…» — как красная; обычная и «доставлено» — нет', () => {
  assert.equal(markIsRed({ id: 'W-1', ring: 'отозвано' }), true);
  assert.equal(markIsRed({ id: 'W-1', ring: 'отозвано поздно: прочитано' }), true);
  assert.equal(markIsRed({ id: 'W-1', missing: true, ring: null }), true, 'красная «зеркало не видит» — как была');
  assert.equal(markIsRed({ id: 'W-1', ring: 'положено' }), false);
  assert.equal(markIsRed({ id: 'W-1', ring: 'доставлено', missing: false }), false);
  assert.equal(markIsRed(null), false);
});
