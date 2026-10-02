// EXT-37: витрина в покое — нагрузка (А: карта UUID → номер; Б: git по подсказке наблюдателя; В: журналы — горячее
// раз в 2 с, полный обход раз в 30 с) и «ждёт ответа» без открытого вопроса (Г).
// Ожидаемое — из того, что положено в тест здесь же, а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRef } from '../lib/journal-parse.mjs';

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
