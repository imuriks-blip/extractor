// Маска по позициям scan доски (спека витрины 6.2): классы 2 и 5 → [скрыто: <вид>].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, maskDeep } from '../lib/mask.mjs';
import { BOARD_LIB } from './helpers.mjs';

const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
// значение собрано из частей: в исходнике теста нет цельного «секрета»
export const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';

test('маска: префикс класса 2 на второй строке скрыт, остальной текст цел', () => {
  const out = maskText(`первая строка\nключ к гиту ${SECRET} конец`, scan);
  assert.equal(out.includes(SECRET), false);
  assert.match(out, /\[скрыто: [^\]]+\]/);
  assert.ok(out.startsWith('первая строка\nключ к гиту '));
  assert.ok(out.endsWith(' конец'));
});

test('маска: исправный случай — текст без секрета не меняется', () => {
  const t = 'EXT-6 · спека витрины, коммит 8a0f029';
  assert.equal(maskText(t, scan), t);
});

test('маска: класс 3 (хеш 40 hex) не скрывается', () => {
  const t = 'коммит c03dd8a1c03dd8a1c03dd8a1c03dd8a1c03dd8a1';
  assert.equal(maskText(t, scan), t);
});

test('маска: глубоко по объекту — все строки, ключи и числа целы', () => {
  const out = maskDeep({ a: [{ body: `token: ${SECRET}` }], n: 3, id: 'EXT-6', z: null }, scan);
  assert.equal(JSON.stringify(out).includes(SECRET), false);
  assert.equal(out.n, 3);
  assert.equal(out.id, 'EXT-6');
  assert.equal(out.z, null);
});

test('маска: отрицательный контроль — сеть выключена → значение остаётся (тест зрячий)', () => {
  const out = maskText(`ключ ${SECRET}`, () => []);
  assert.ok(out.includes(SECRET));
});
