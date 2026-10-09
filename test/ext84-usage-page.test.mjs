// EXT-84, ПТ12, страница «Расход» — данные экрана (web/src/usageData.js): сокращение чисел, доли, столбики, строка остатка, плашка 5 ч.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fmtTokens, exact, shares, dayBars, dayLabel, windowNote, ageText, noUsage, breakdownRows } = await import('../web/src/usageData.js');

test('сокращение чисел: тыс / млн / млрд, три значащие цифры, запятая', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1000), '1 тыс');
  assert.equal(fmtTokens(12300), '12,3 тыс');
  assert.equal(fmtTokens(123456), '123 тыс');
  assert.equal(fmtTokens(4_200_000), '4,2 млн');
  assert.equal(fmtTokens(910_000_000), '910 млн');
  assert.equal(fmtTokens(2_450_000_000), '2,45 млрд');
  assert.equal(fmtTokens(null), '—');
  assert.equal(exact(1234567), '1 234 567');
});

test('доли четырёх чисел: сумма 100, малое — «<1», пустая строка — нули', () => {
  const s = shares({ in: 88000, out: 210000, cacheRead: 910e6, cacheWrite: 14.5e6 });
  assert.deepEqual(s.map((p) => p.k), ['in', 'out', 'cacheRead', 'cacheWrite']);
  assert.equal(s[0].pct, '<1');
  assert.equal(s[2].pct, '98');
  assert.equal(s[3].pct, '2');
  assert.equal(shares({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })[2].pct, '0');
});

test('столбики по дням: высота от самого большого, последний — сегодня; подпись ДД.ММ', () => {
  const b = dayBars([{ date: '2026-10-06', in: 0, out: 0, cacheRead: 50, cacheWrite: 0, total: 50 }, { date: '2026-10-07', in: 0, out: 0, cacheRead: 100, cacheWrite: 0, total: 100 }]);
  assert.deepEqual(b.map((x) => x.h), [0.5, 1]);
  assert.deepEqual(b.map((x) => x.today), [false, true]);
  assert.equal(b[0].label, '06.10');
  assert.equal(dayLabel('x'), '—');
  assert.deepEqual(dayBars(undefined), []);
});

test('возраст словами: меньше минуты / часы (остаток новой формы — в ext87-usage-page.test.mjs)', () => {
  assert.equal(ageText(30), 'меньше минуты');
  assert.equal(ageText(7200), '2 ч');
  assert.equal(ageText(90000), '1 дн');
});

test('плашка 5 ч: warn / в норме / мало данных (подпись веса — в ext87-usage-page.test.mjs)', () => {
  assert.equal(windowNote({ enough: false }).kind, 'few');
  const w = windowNote({ enough: true, warn: true, total: 41.2e6, median: 12.8e6, factor: 3.22 });
  assert.equal(w.kind, 'warn');
  assert.match(w.text, /41,2 млн условных токенов против медианы 12,8 млн \(×3,22/);
  assert.equal(windowNote({ enough: true, warn: false, total: 9.6e6, median: 12.8e6, factor: 0.75 }).kind, 'ok');
  assert.equal(windowNote(null).kind, 'none');
});

test('пусто и разрезы: нули — нет данных; названия тредов как пришли, у агента и проекта — label', () => {
  assert.equal(noUsage({ today: { total: 0 }, week: { total: 0 } }), true);
  assert.equal(noUsage({ today: { total: 0 }, week: { total: 5 } }), false);
  const d = { byThread: { today: [{ sessionId: 's', title: 'Демо-тред', project: 'EXT', total: 1 }] }, byAgent: { week: [{ agent: 'foreman', label: 'прораб', total: 1 }] } };
  assert.equal(breakdownRows(d, 'byThread', 'today')[0].name, 'Демо-тред');
  assert.equal(breakdownRows(d, 'byThread', 'today')[0].tag, 'EXT');
  assert.equal(breakdownRows(d, 'byAgent', 'week')[0].name, 'прораб');
  assert.deepEqual(breakdownRows(d, 'byProject', 'today'), []);
});
