// EXT-129: вид строки для Ивана — чистые функции web/src/plainData.js. Ожидаемое — литералами из ТЗ такта (есть brief —
// главный текст строки; нет — заголовок, как раньше; «Проекты»: фаза и шаг мелко серым) и из образцов web/fixtures.
// Вид — снимками пробы в отчёте такта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pd from '../web/src/plainData.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', f), 'utf8'));

test('строка для Ивана: есть — текст без краевых пробелов; null, пусто, пробелы, не строка, нет поля — null', () => {
  assert.equal(pd.lineForIvan({ brief: '  Готово — посмотри и прими  ' }), 'Готово — посмотри и прими');
  for (const x of [{ brief: null }, { brief: '' }, { brief: '   ' }, { brief: 42 }, {}, null, undefined]) {
    assert.equal(pd.lineForIvan(x), null, JSON.stringify(x));
  }
});

test('образцы: строки «Ждёт меня», проект, карточка и карта — строка там, где сервер её отдал', () => {
  const ceh = fx('ceh.json');
  assert.equal(pd.lineForIvan(ceh.waiting.yes.find((r) => r.id === 'LEDGER-168')), 'Кнопка съёмки готова и проверена; нужно твоё «сливай»; дальше — выкатка в апп');
  assert.equal(pd.lineForIvan(ceh.waiting.yes.find((r) => r.id === 'INFRA-80')), null);
  assert.equal(pd.lineForIvan(fx('card-EXT-6.json').header), 'Спека витрины готова — прочти и прими; дальше — вёрстка');
  assert.equal(pd.lineForIvan(fx('roadmap-EXT.json').map.where), 'Карта готова; от тебя ничего не нужно; дальше — окно карты');
});

test('фаза и шаг под строкой: оба, только фаза, только шаг, ничего', () => {
  assert.equal(pd.phaseLine('Вёрстка', 'приёмка'), 'Вёрстка · дальше: приёмка');
  assert.equal(pd.phaseLine('Вёрстка', null), 'Вёрстка');
  assert.equal(pd.phaseLine(null, 'приёмка'), 'дальше: приёмка');
  assert.equal(pd.phaseLine(null, undefined), null);
});

test('«тихо, описания пока нет»: проект со строкой для Ивана — обычной строкой, даже без фазы, шага и счётчиков', () => {
  const bare = { code: 'X', phase: null, next: null, inProgress: 0, ready: 0, review: 0, phaseFailingSince: null };
  assert.equal(pd.isQuiet(bare), true);
  assert.equal(pd.isQuiet({ ...bare, brief: 'Идёт настройка; от тебя ничего; дальше — проверка' }), false);
  assert.equal(pd.isQuiet({ ...bare, brief: '  ' }), true);
});
