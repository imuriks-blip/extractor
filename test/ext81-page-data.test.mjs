// EXT-81, ПТ9, страница — данные кнопки «Новая карточка» (web/src/newCardData.js; спека пульта §1.3, §1.4, §1.6, §1.7):
// когда кнопка видна, список проектов, когда «создать» активна, нагрузка, вид исхода по ответу /api/act.
// Ожидаемые значения — из спеки и контракта ответов, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { canNewCard, canNewCardIn, projectChoices, canSubmit, buildPayload, classifyReply, copyText, TITLE_MAX, TEXT_MAX } = await import('../web/src/newCardData.js');

const ON = { enabled: true, words: true, bell: true };

test('кнопка видна только при pult.enabled и pult.words; у RADAR её нет', () => {
  assert.equal(canNewCard(ON), true);
  assert.equal(canNewCard({ ...ON, enabled: false }), false);
  assert.equal(canNewCard({ ...ON, words: false }), false);
  assert.equal(canNewCard(undefined), false);
  assert.equal(canNewCardIn(ON, 'EXT'), true);
  assert.equal(canNewCardIn(ON, null), true, 'на «Цехе» проекта нет — кнопка есть');
  assert.equal(canNewCardIn(ON, 'RADAR'), false);
  assert.equal(canNewCardIn({ ...ON, words: false }, 'EXT'), false);
});

test('список проектов: RADAR нет, остальные в порядке данных', () => {
  const l = projectChoices([{ code: 'EXT' }, { code: 'RADAR' }, { code: 'INFRA' }, null, {}]);
  assert.deepEqual(l, ['EXT', 'INFRA']);
  assert.deepEqual(projectChoices(undefined), []);
});

test('«создать» неактивна, пока не выбран проект, нет заголовка или RADAR', () => {
  assert.equal(canSubmit({ project: '', title: 'а', text: '' }), false, 'проект не выбран');
  assert.equal(canSubmit({ project: 'EXT', title: '   ', text: '' }), false, 'заголовок пуст');
  assert.equal(canSubmit({ project: 'RADAR', title: 'а', text: '' }), false, 'RADAR');
  assert.equal(canSubmit({ project: 'EXT', title: 'а', text: '' }), true);
  assert.equal(canSubmit({ project: 'EXT', title: 'а'.repeat(TITLE_MAX), text: 'б'.repeat(TEXT_MAX) }), true, 'ровно по пределу');
  assert.equal(canSubmit({ project: 'EXT', title: 'а'.repeat(TITLE_MAX + 1), text: '' }), false);
  assert.equal(canSubmit({ project: 'EXT', title: 'а', text: 'б'.repeat(TEXT_MAX + 1) }), false);
});

test('нагрузка: text только если не пуст, confirm только когда дан, значения обрезаны по краям', () => {
  assert.deepEqual(buildPayload({ project: 'EXT', title: ' Заголовок ', text: '  ' }, 'i1'), { action: 'new-card', intentId: 'i1', project: 'EXT', title: 'Заголовок' });
  assert.deepEqual(buildPayload({ project: 'EXT', title: 'З', text: ' тело ' }, 'i2', 'W-9'), { action: 'new-card', intentId: 'i2', project: 'EXT', title: 'З', text: 'тело', confirm: 'W-9' });
});

test('200 ok: «создана» с номером из поля created, без поля — из сообщения', () => {
  assert.deepEqual(classifyReply(200, { outcome: 'ok', message: 'создана EXT-41 · Backlog', created: 'EXT-41' }), { kind: 'created', created: 'EXT-41', message: 'создана EXT-41 · Backlog', retry: false, copy: false });
  assert.equal(classifyReply(200, { outcome: 'ok', message: 'создана EXT-42 · Backlog' }).created, 'EXT-42');
  assert.equal(classifyReply(200, { outcome: 'ok', message: 'готово' }).created, null);
});

test('need-confirm: похожие (не больше 5), возраст зеркала, id для второго щелчка', () => {
  const similar = Array.from({ length: 7 }, (_, i) => ({ id: `EXT-${i + 1}`, title: `т ${i}` }));
  const v = classifyReply(200, { id: 'W-5', outcome: 'need-confirm', message: 'похожие: …', confirm: { what: 'Новая карточка · EXT: х', follows: 'создастся карточка в Backlog', mirrorAt: '2026-10-07T08:00:00Z', similar } });
  assert.equal(v.kind, 'confirm');
  assert.equal(v.id, 'W-5');
  assert.equal(v.similar.length, 5);
  assert.equal(v.mirrorAt, '2026-10-07T08:00:00Z');
  assert.equal(v.retry, false);
  assert.equal(classifyReply(200, { id: 'W-6', outcome: 'need-confirm', confirm: { what: 'х', similar: [] } }).similar.length, 0);
});

test('отказы: секрет, «может быть секретом» (с id отказа), no-new-card, bad-confirm / confirm-expired', () => {
  assert.equal(classifyReply(200, { outcome: 'refused', refusal: 'secret', message: 'похоже на секрет — на доску не пишется' }).kind, 'secret');
  const maybe = classifyReply(200, { id: 'W-7', outcome: 'refused', refusal: 'secret-maybe', message: 'может быть секретом' });
  assert.equal(maybe.kind, 'secret-maybe');
  assert.equal(maybe.rid, 'W-7');
  assert.equal(classifyReply(200, { outcome: 'refused', refusal: 'secret-maybe', message: 'м' }).kind, 'secret', 'без id отказа «не секрет» не предлагается');
  assert.equal(classifyReply(200, { outcome: 'refused', refusal: 'no-new-card', message: 'в RADAR …' }).kind, 'refused');
  assert.equal(classifyReply(200, { outcome: 'refused', refusal: 'no-new-card', message: 'в RADAR …' }).message, 'в RADAR …');
  for (const refusal of ['bad-confirm', 'confirm-expired']) assert.equal(classifyReply(200, { outcome: 'refused', refusal, message: 'нажми заново' }).kind, 'retype', refusal);
  assert.equal(classifyReply(429, { outcome: 'refused', message: 'слишком часто' }).kind, 'refused');
});

test('error «не создана»: форма остаётся, «создать» можно заново', () => {
  const v = classifyReply(200, { outcome: 'error', message: 'не создана: Доска ответила 400' });
  assert.equal(v.kind, 'not-created');
  assert.equal(v.retry, true);
  assert.equal(v.message, 'не создана: Доска ответила 400');
});

test('«исход неясен» — отрицательный контроль: повтора нет, есть копирование; то же при 5xx и «по журналу»', () => {
  for (const [st, b] of [
    [200, { outcome: 'error', message: 'исход неясен — проверь доску: карточка могла создаться (повторять вслепую нельзя)' }],
    [200, { outcome: 'error', message: 'исход неясен (по журналу) — проверь доску: карточка могла создаться' }],
    [502, {}], [500, { outcome: 'error', message: 'что-то' }],
  ]) {
    const v = classifyReply(st, b);
    assert.equal(v.kind, 'unclear', JSON.stringify([st, b]));
    assert.equal(v.retry, false);
    assert.equal(v.copy, true);
  }
  assert.equal(classifyReply(200, { outcome: 'error', message: 'не создана: нет проекта' }).copy, false, '«не создана» — не «неясен»');
});

test('прочее: 503 и 501 словами, иное error — message, пустое тело — HTTP', () => {
  assert.equal(classifyReply(503, { message: 'пульт выключен' }).kind, 'off');
  assert.equal(classifyReply(503, {}).message, 'пульт или слова выключены');
  assert.equal(classifyReply(501, {}).message, 'ещё не подключено');
  assert.equal(classifyReply(501, {}).kind, 'none');
  const e = classifyReply(200, { outcome: 'error', message: 'не вышло по-другому' });
  assert.equal(e.kind, 'error');
  assert.equal(e.message, 'не вышло по-другому');
  assert.equal(classifyReply(400, null).message, 'ошибка: HTTP 400');
  assert.equal(classifyReply(400, null).retry, false);
});

test('текст для буфера: заголовок и текст через пустую строку', () => {
  assert.equal(copyText({ title: ' З ', text: ' т ' }), 'З\n\nт');
  assert.equal(copyText({ title: 'З', text: '' }), 'З');
});

test('«Мои слова»: у new-card исход — про карточку, не про тред; у слов прежнее (отрицательный контроль)', async () => {
  const { outcomeText } = await import('../web/src/pultData.js');
  assert.equal(outcomeText({ action: 'new-card', status: 'done' }), 'создана');
  assert.equal(outcomeText({ action: 'new-card', status: 'need-confirm' }), 'ждёт «всё равно создать»');
  assert.match(outcomeText({ action: 'new-card', status: 'error' }), /проверь доску/);
  assert.equal(outcomeText({ action: 'yes', status: 'need-confirm' }), 'ждёт выбора треда');
  assert.equal(outcomeText({ action: 'new-card', status: 'refused' }), 'отказ');
});
