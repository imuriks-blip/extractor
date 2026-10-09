// EXT-87, такт 2: шапка «Служебное» и экран «Расход» на новой форме remaining (спека пульта §1.7 «Чтение замера», §6 п.2 «Свежесть»,
// п.3 «вес по ценам API»; спека витрины §2.11). Выбор данных страницы — web/src/usageData.js, без React; разметка меню — по исходнику
// (JSX node-тест не исполняет), вид и поведение меню в браузере — probe/ext87-shots.mjs. У каждого случая — исправный рядом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { remainingView, measuresLine, measureMenuLine, measureAnswer, windowNote, weightNote, sourceText } = await import('../web/src/usageData.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'fixtures', n), 'utf8'));
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

const MEASURE = {
  source: 'measure', at: '2026-10-09T10:51:00.000Z', ageSec: 300, ageKind: 'exact',
  fiveHour: { utilization: 0.62, resetsAt: '2026-10-09T13:20:00.000Z', fresh: true },
  sevenDay: { utilization: 0.41, resetsAt: '2026-10-11T09:00:00.000Z', fresh: true },
};

test('остаток, замер свежий: проценты ×100, сброс, источник и возраст рядом с числом', () => {
  const v = remainingView({ remaining: MEASURE });
  assert.equal(v.kind, 'ok');
  assert.equal(v.text, `5 ч: 62 % · сброс ${hhmm(MEASURE.fiveHour.resetsAt)} · 7 дн: 41 %`);
  assert.equal(v.source, 'замер 5 мин назад');
  assert.equal(v.at, hhmm(MEASURE.at));
  assert.equal(sourceText({ ...MEASURE, ageSec: 20 }), 'замер меньше минуты назад');
});

test('остаток от прораба: возраст — «не моложе N», не точный', () => {
  const v = remainingView({ remaining: { ...MEASURE, source: 'foreman', ageKind: 'lowerBound', ageSec: 1200 } });
  assert.equal(v.source, 'прогон прораба, не моложе 20 мин');
  assert.equal(v.kind, 'ok');
});

test('несвежее число не показывается, даже если оно пришло: «остаток не виден — последнее событие лимита N назад» и подсказка', () => {
  const stale = { ...MEASURE, ageSec: 7200, fiveHour: { utilization: null, resetsAt: MEASURE.fiveHour.resetsAt, fresh: false }, sevenDay: { utilization: 0.41, resetsAt: MEASURE.sevenDay.resetsAt, fresh: false } };
  const v = remainingView({ remaining: stale });
  assert.equal(v.kind, 'stale');
  assert.equal(v.text, 'остаток не виден — последнее событие лимита 2 ч назад');
  assert.match(v.hint, /Служебное → Замерить остаток/);
  assert.doesNotMatch(JSON.stringify(v), /41|62/, 'числа окна, не прошедшего свежесть, на страницу не выходят');
  // у прораба возраст — нижняя граница
  assert.match(remainingView({ remaining: { ...stale, source: 'foreman', ageKind: 'lowerBound' } }).text, /лимита не моложе 2 ч назад/);
});

test('одно окно свежее, другое нет: свежее показано, у несвежего — «не виден»', () => {
  const v = remainingView({ remaining: { ...MEASURE, ageSec: 3 * 3600, fiveHour: { utilization: null, resetsAt: MEASURE.fiveHour.resetsAt, fresh: false } } });
  assert.equal(v.kind, 'ok');
  assert.equal(v.text, '5 ч: не виден · 7 дн: 41 %');
});

test('событий нет: remainingNote дословно (или запасная фраза) и подсказка', () => {
  assert.equal(remainingView({ remaining: null, remainingNote: 'остаток не виден (событий лимита нет)' }).text, 'остаток не виден (событий лимита нет)');
  assert.equal(remainingView({ remaining: null }).kind, 'none');
  assert.equal(remainingView({ remaining: null }).hint, 'Служебное → Замерить остаток');
});

test('замеры сегодня: счёт и деньги; ноль — без денег; нет поля — строки нет', () => {
  assert.equal(measuresLine({ measures: { today: { count: 3, costUsd: 0.081, tokens: 40386 } } }), 'замеры сегодня: 3, ≈$0,08');
  assert.equal(measuresLine({ measures: { today: { count: 1, costUsd: 0.002, tokens: 10 } } }), 'замеры сегодня: 1, <$0,01');
  assert.equal(measuresLine({ measures: { today: { count: 0, costUsd: 0, tokens: 0 } } }), 'замеры сегодня: 0');
  assert.equal(measuresLine({}), null);
});

test('подпись пункта меню «Замерить остаток»: по тому же правилу свежести; несвежее — без числа', () => {
  const ok = measureMenuLine({ remaining: MEASURE });
  assert.equal(ok.text, `5 ч: 62 % · сброс ${hhmm(MEASURE.fiveHour.resetsAt)} · 7 дн: 41 % · замер ${hhmm(MEASURE.at)}`);
  const stale = measureMenuLine({ remaining: { ...MEASURE, ageSec: 86400 * 2, fiveHour: { utilization: null, resetsAt: null, fresh: false }, sevenDay: { utilization: null, resetsAt: null, fresh: false } } });
  assert.equal(stale.text, 'остаток не виден — последнее событие лимита 2 дн назад');
  assert.equal(stale.cls, 'pamb');
  assert.equal(measureMenuLine({ remaining: null }).text, 'замеров ещё не было');
  assert.match(measureMenuLine({ remaining: { ...MEASURE, source: 'foreman', ageKind: 'lowerBound', ageSec: 600 } }).text, /прораб, не моложе 10 мин$/);
});

test('ответ на «Замерить остаток» словами: удача, reused, идёт (409), ошибка входа, ошибка, 503', () => {
  const okMsg = '5 ч: 62 % · сброс 16:20 · 7 дн: 41 % · замер 13:51';
  assert.deepEqual(measureAnswer(200, { outcome: 'ok', message: okMsg }), { cls: 'muted', text: okMsg });
  assert.deepEqual(measureAnswer(200, { outcome: 'ok', reused: true, message: `замер был в 13:51: ${okMsg}` }), { cls: 'muted', text: `замер был в 13:51: ${okMsg}` });
  assert.deepEqual(measureAnswer(409, { outcome: 'refused', refusal: 'measure-running', message: 'замер уже идёт (с 13:50)' }), { cls: 'going', text: 'замер уже идёт' });
  const auth = measureAnswer(200, { outcome: 'error', message: 'замер не удался: вход Claude истёк — войди в Claude в обычном терминале' });
  assert.equal(auth.cls, 'pbad');
  assert.match(auth.text, /вход Claude истёк — войди в Claude в обычном терминале/);
  assert.equal(measureAnswer(200, { outcome: 'error' }).text, 'замер не удался');
  assert.equal(measureAnswer(503, {}).text, 'пульт выключен');
  assert.equal(measureAnswer(500, {}).text, 'ошибка: HTTP 500');
});

test('тревога: подпись веса из window5h.weights; без весов — без подписи; число — условные токены', () => {
  const W = { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 };
  assert.equal(weightNote(W), 'вес: вывод ×5, чтение кэша ×0,1');
  assert.equal(weightNote(W, false), 'вес: ввод ×1, вывод ×5, запись кэша ×1,25, чтение кэша ×0,1');
  assert.equal(weightNote(undefined), null);
  const warn = windowNote({ enough: true, warn: true, total: 10e6, median: 6e6, factor: 1.67, weights: W, message: 'за 5 ч расход выше обычного: ≈ 10000000 условных токенов' });
  assert.equal(warn.kind, 'warn');
  assert.match(warn.text, /^≈ 10 млн условных токенов против медианы 6 млн \(×1,67 от медианы; вес: вывод ×5, чтение кэша ×0,1\)$/);
  assert.match(warn.title, /за 5 ч расход выше обычного: ≈ 10000000 условных токенов/);
  assert.match(warn.title, /ввод ×1/);
  assert.doesNotMatch(windowNote({ enough: true, warn: true, total: 10e6, median: 6e6, factor: 1.67 }).text, /вес:/);
  // исправный случай рядом: в норме — не тревога, подпись веса та же
  const ok = windowNote({ enough: true, warn: false, total: 5e6, median: 6e6, weights: W });
  assert.equal(ok.kind, 'ok');
  assert.match(ok.text, /^за 5 ч в норме: ≈ 5 млн условных токенов при медиане 6 млн \(вес: вывод ×5, чтение кэша ×0,1\)$/);
});

test('фикстуры страницы — новая форма: источник, возраст, fresh; несвежее с utilization null', () => {
  for (const n of ['usage.json', 'usage-ok.json', 'usage-stale.json']) {
    const r = fixture(n).remaining;
    assert.ok(['measure', 'foreman'].includes(r.source), n);
    assert.ok(['exact', 'lowerBound'].includes(r.ageKind), n);
    for (const w of [r.fiveHour, r.sevenDay]) {
      assert.equal(typeof w.fresh, 'boolean', n);
      assert.equal(w.fresh, w.utilization !== null, `${n}: fresh и число согласованы`);
    }
    assert.ok(fixture(n).measures.today, n);
  }
  assert.equal(remainingView(fixture('usage-stale.json')).kind, 'stale');
  assert.equal(remainingView(fixture('usage.json')).kind, 'ok');
  assert.equal(remainingView(fixture('usage-empty.json')).kind, 'none');
  assert.equal(windowNote(fixture('usage.json').window5h).kind, 'warn');
  assert.equal(windowNote(fixture('usage-ok.json').window5h).kind, 'ok');
});

test('меню «Служебное»: кнопка в шапке рядом со «Словарём» и «?», на «Цехе» блока нет, закрытие и сброс подтверждения', () => {
  const app = src('App.jsx');
  const tb = app.slice(app.indexOf('<span className="tbtns">'), app.indexOf('</span>', app.indexOf('<span className="tbtns">')));
  assert.ok(tb.indexOf('<ServiceMenu') > 0 && tb.indexOf('<ServiceMenu') < tb.indexOf('<Glossary') && tb.indexOf('<Glossary') < tb.indexOf('<Help'), 'порядок: Служебное, Словарь, ?');
  assert.doesNotMatch(src('Ceh.jsx'), /Service/, 'блока «Служебное» на «Цехе» больше нет');
  const s = src('Service.jsx');
  assert.match(s, /e\.key !== 'Escape'[\s\S]*stopImmediatePropagation[\s\S]*close\(true\)/, 'Escape закрывает меню и не пускает дальше (панель карточки не закрывается), фокус — на кнопку');
  assert.match(s, /pointerdown/, 'щелчок мимо');
  assert.match(s, /open \? close\(true\) : setOpen\(true\)/, 'повторный щелчок закрывает');
  assert.match(s, /setOpen\(false\);\s*dropConfirm\(\)/, 'закрыл меню — ждущее подтверждение сброшено');
  assert.match(src('Mirror.jsx'), /export function dropConfirm\(\) \{ if \(get\(\)\.cf\) setCf\(null\); \}/);
});

test('телефон: меню во всю ширину, кнопка остаётся в той же группе .tbtns', () => {
  const css = src('styles.css');
  assert.match(css, /@media \(max-width:560px\)\{\s*\.smw\{position:static\}\s*\.smenu,\.smenu\.left\{left:0;right:0;width:auto\}/);
});

test('«Расход»: кнопка замера на экране и общий замер с меню; памятка и подсказки без «блока Служебное на Цехе»', () => {
  const u = src('Usage.jsx');
  assert.match(u, /onClick=\{\(\) => measure\(\)\}/);
  assert.match(u, /measuresLine\(d\)/);
  const help = src('help.js');
  assert.match(help, /\*\*Замерить остаток\*\*/);
  assert.match(help, /остаток не виден — последнее событие лимита N назад/);
  assert.match(help, /вывод ×5, запись кэша ×1,25, чтение кэша ×0,1, ввод ×1/);
  for (const f of ['help.js', 'App.jsx', 'Mirror.jsx']) assert.doesNotMatch(src(f), /на «Цехе»[^.]{0,40}блок[^.]{0,12}«Служебное»|в блоке «Служебное»/, f);
});
