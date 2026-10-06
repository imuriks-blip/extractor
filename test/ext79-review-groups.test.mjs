// EXT-79: «Готово, посмотри» на «Цехе» — подгруппы по проекту в порядке таблицы «Проекты» и чипы следа (вариант В макета,
// решения Ивана 06.10: порог 11, слова «проверен · проверь · нет следа», «показано N из M» при включённом фильтре).
// Тест по поведению функции данных web/src/reviewData.js; ожидаемое — из ТЗ и решений Ивана, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { reviewView, nextFilter, isReviewFilter, REVIEW_GROUP_MIN, TRACE_CHIPS } = await import('../web/src/reviewData.js');

const ORDER = ['CAR', 'LEDGER', 'MAKAR', 'EXT', 'INFRA'];
const T0 = Date.parse('2026-10-06T12:00:00Z');
// строка (в) как в /api/ceh: id, project, at, trace {state}; свежие сверху
const row = (id, state, minAgo) => ({ id, project: id.split('-')[0], title: `карточка ${id}`, at: new Date(T0 - minAgo * 60000).toISOString(), trace: state === undefined ? undefined : state === null ? null : { state, label: state } });
function many(n) {
  // n карточек: EXT, INFRA, MAKAR вперемешку; следы bad/warn/ok/none по кругу
  const codes = ['EXT', 'INFRA', 'MAKAR'];
  const st = ['bad', 'warn', 'ok', 'none'];
  return Array.from({ length: n }, (_, i) => row(`${codes[i % 3]}-${100 + i}`, st[i % 4], i * 10));
}

test('порог: 10 карточек — плоский список без подгрупп и чипов, сохранённый фильтр не действует', () => {
  assert.equal(REVIEW_GROUP_MIN, 11);
  const v = reviewView(many(10), ORDER, 'ok');
  assert.equal(v.grouped, false);
  assert.equal(v.groups, null);
  assert.deepEqual(v.chips, []);
  assert.equal(v.rows.length, 10, 'все 10 строк — плоским списком');
  assert.equal(v.filter, 'all', 'фильтр «проверен» ниже порога не применяется');
  assert.equal(v.head, '10', 'в заголовке просто число');
  assert.equal(v.empty, false);
});

test('с 11 карточек — подгруппы в порядке таблицы «Проекты», не в порядке свежести', () => {
  const rows = many(11); // первая (самая свежая) — EXT
  const v = reviewView(rows, ORDER, 'all');
  assert.equal(v.grouped, true);
  assert.deepEqual(v.groups.map((g) => g.code), ['MAKAR', 'EXT', 'INFRA'], 'порядок таблицы; проектов без карточек нет');
  assert.equal(v.groups.reduce((a, g) => a + g.rows.length, 0), 11, 'каждая карточка — ровно в одной подгруппе');
  for (const g of v.groups) {
    assert.ok(g.rows.every((r) => r.project === g.code));
    assert.equal(g.total, g.rows.length, 'без фильтра «из M» не нужно');
    const ages = g.rows.map((r) => Date.parse(r.at));
    assert.deepEqual(ages, [...ages].sort((a, b) => b - a), 'внутри подгруппы — свежие сверху');
    assert.equal(g.at, g.rows[0].at, 'давность подгруппы — самая свежая карточка');
  }
  assert.equal(v.head, '11');
  assert.equal(v.rows, null);
});

test('проект, которого нет в таблице «Проекты», — следом за остальными, не теряется', () => {
  const rows = [...many(11), row('RADAR-1', 'ok', 5)];
  const v = reviewView(rows, ORDER, 'all');
  assert.deepEqual(v.groups.map((g) => g.code), ['MAKAR', 'EXT', 'INFRA', 'RADAR']);
});

test('сводка следа подгруппы: ✕ / ! / ✓ по карточкам под фильтром; «–» и «проверяю след» не считаются', () => {
  const rows = [
    row('EXT-1', 'bad', 1), row('EXT-2', 'bad', 2), row('EXT-3', 'warn', 3), row('EXT-4', 'ok', 4), row('EXT-5', 'none', 5), row('EXT-6', null, 6),
    row('INFRA-1', 'bad', 7), row('INFRA-2', 'bad', 8), row('INFRA-3', 'bad', 9), row('INFRA-4', undefined, 10), row('INFRA-5', 'ok', 11),
  ];
  const v = reviewView(rows, ORDER, 'all');
  const ext = v.groups.find((g) => g.code === 'EXT');
  assert.deepEqual(ext.counts, { ok: 1, warn: 1, bad: 2 });
  assert.equal(ext.rows.length, 6, 'карточки без следа в подгруппе видны');
});

test('чипы: слова Ивана, число по всем карточкам; чип с нулём скрыт; «все» — отдельно, не в списке', () => {
  assert.deepEqual(TRACE_CHIPS.map((c) => c.word), ['проверен', 'проверь', 'нет следа']);
  const rows = many(12).map((r) => (r.trace?.state === 'warn' ? { ...r, trace: { state: 'bad' } } : r)); // жёлтых нет
  const v = reviewView(rows, ORDER, 'all');
  assert.deepEqual(v.chips.map((c) => [c.val, c.n, c.on]), [['ok', 3, false], ['bad', 6, false]]);
});

test('фильтр «проверен»: в заголовке «показано N из M», пустые подгруппы скрыты, у неполной подгруппы — «из M»', () => {
  const rows = many(32);
  const v = reviewView(rows, ORDER, 'ok');
  const okCount = rows.filter((r) => r.trace?.state === 'ok').length;
  assert.equal(v.filter, 'ok');
  assert.equal(v.shown, okCount);
  assert.equal(v.head, `показано ${okCount} из 32`);
  assert.ok(v.groups.every((g) => g.rows.length > 0 && g.rows.every((r) => r.trace.state === 'ok')));
  for (const g of v.groups) assert.equal(g.total, rows.filter((r) => r.project === g.code).length, 'M подгруппы — все её карточки');
  assert.ok(v.chips.find((c) => c.val === 'ok').on);
  assert.equal(v.empty, false);
});

test('отрицательный контроль: проект без карточек под фильтром — скрыт', () => {
  const rows = [...many(11).map((r) => (r.project === 'MAKAR' ? { ...r, trace: { state: 'bad' } } : r))];
  const all = reviewView(rows, ORDER, 'all');
  assert.ok(all.groups.some((g) => g.code === 'MAKAR'), 'без фильтра MAKAR есть');
  const v = reviewView(rows, ORDER, 'ok');
  assert.ok(!v.groups.some((g) => g.code === 'MAKAR'), 'у MAKAR проверенных нет — подгруппы нет');
  assert.ok(v.groups.length > 0);
});

test('отрицательный контроль: «проверен» при нуле проверенных — пустая строка-подсказка, «показано 0 из M», чип выбранный виден', () => {
  const rows = many(14).map((r) => (r.trace?.state === 'ok' ? { ...r, trace: { state: 'bad' } } : r));
  const v = reviewView(rows, ORDER, 'ok');
  assert.equal(v.empty, true);
  assert.deepEqual(v.groups, []);
  assert.equal(v.head, 'показано 0 из 14');
  const ok = v.chips.find((c) => c.val === 'ok');
  assert.ok(ok && ok.on && ok.n === 0, 'выбранный чип с нулём остаётся, чтобы его можно было снять');
  // а без фильтра подсказки нет
  assert.equal(reviewView(rows, ORDER, 'all').empty, false);
});

test('«показано N из M» — всегда при включённом фильтре, даже когда фильтр ничего не убрал', () => {
  const rows = many(11).map((r) => ({ ...r, trace: { state: 'warn' } }));
  assert.equal(reviewView(rows, ORDER, 'warn').head, 'показано 11 из 11');
});

test('сохранённое чужое значение фильтра — как «все»; щелчок по чипу переключает, повторный — снимает', () => {
  assert.equal(reviewView(many(12), ORDER, 'красный').filter, 'all');
  assert.equal(reviewView(many(12), ORDER, null).head, '12');
  assert.ok(isReviewFilter('all') && isReviewFilter('ok') && isReviewFilter('warn') && isReviewFilter('bad'));
  assert.ok(!isReviewFilter('none') && !isReviewFilter('') && !isReviewFilter('жёлтый'));
  assert.equal(nextFilter('all', 'ok'), 'ok');
  assert.equal(nextFilter('ok', 'ok'), 'all');
  assert.equal(nextFilter('ok', 'bad'), 'bad');
  assert.equal(nextFilter('bad', 'all'), 'all');
});

test('пусто и без данных — не падает', () => {
  const v = reviewView(undefined, undefined, 'ok');
  assert.equal(v.total, 0);
  assert.equal(v.grouped, false);
  assert.equal(v.head, '0');
});
