// EXT-130 такт 3 (спека Vault extractor/SPEC-extractor-roadmap.md, раздел 3; ТЗ дирижёра): блок «Сейчас» карты проекта — вид.
// Разметку не рисуем (сборки JSX для node --test нет): слова — чистая функция nowView (plainData.js), связка — по исходнику.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowView } from '../web/src/plainData.js';
import { HELP } from '../web/src/help.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const ONE = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', 'roadmap-EXT.json'), 'utf8'));

test('«Сейчас»: строка для Ивана первой, нет — заголовок; статус словом; review ждёт Ивана; порядок — сервера', () => {
  assert.deepEqual(nowView(ONE.now), [
    { id: 'EXT-6', text: 'Спека витрины готова — прочти и прими; дальше — вёрстка', title: 'Спека', word: 'на приёмке', cls: 'look', me: true },
    { id: 'EXT-7', text: 'Слить', title: null, word: 'в работе', cls: 'work', me: false },
  ]);
});

test('«Сейчас»: пусто, поля нет (старый сервер), не массив — пустой список; пробелы в brief — как нет строки', () => {
  assert.deepEqual(nowView([]), []);
  assert.deepEqual(nowView(undefined), []);
  assert.deepEqual(nowView(null), []);
  assert.deepEqual(nowView({}), []);
  assert.deepEqual(nowView([null, { title: 'без номера' }]), []);
  assert.equal(nowView([{ id: 'EXT-9', title: 'Заголовок', status: 'in-progress', brief: '   ' }])[0].text, 'Заголовок');
});

test('«Сейчас» в разметке: сразу под «Где стоим», пустой — не рисуется, строка — ссылка на карточку; памятка знает блок', () => {
  const r = src('Roadmap.jsx');
  const w = r.indexOf('<Where w={m.where} />'), n = r.indexOf('<Now code={code} list={d.now} />', w);
  assert.ok(w > 0 && n > w && n < r.indexOf('<Ask code={code}'), 'сразу под «Где стоим»');
  assert.match(r, /if \(!rows\.length\) return null;/);
  assert.match(r, /<a className="rm-now" key=\{x\.id\} href=\{cardHref\(x\.id\)\}/);
  const items = HELP.find((s) => s.title === 'Карта проекта').items;
  assert.ok(items.some((t) => t.startsWith('**Сейчас**') && t.includes('собирается сам')));
});
