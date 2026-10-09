// EXT-77 (слово Ивана 06.10 «перенеси кнопку обновить в служебное»): «Обновить» — в «Служебном» на «Цехе» первой строкой,
// над «Полный проход зеркала»; в шапке — только ход и итог, кнопок нет. Вид в живом браузере — проба probe/ext77-drive.mjs;
// здесь — по исходнику (JSX node-тест не исполняет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');
// тело функции-компонента от объявления до следующего объявления верхнего уровня
const body = (s, decl) => { const i = s.indexOf(decl); assert.ok(i >= 0, decl); const j = s.indexOf('\nexport ', i + decl.length); return s.slice(i, j < 0 ? undefined : j); };

test('шапка: ход и итог прохода (MirrorStatus) без кнопок; App ставит в шапку MirrorStatus, не кнопку', () => {
  const m = src('Mirror.jsx');
  const status = body(m, 'export default function MirrorStatus(');
  assert.doesNotMatch(status, /<button/, 'в шапке кнопки прохода нет');
  assert.doesNotMatch(src('App.jsx'), /MirrorButton/);
  assert.match(src('App.jsx'), /<MirrorStatus label=\{mirror\} \/>/);
});

test('«Служебное» (меню в шапке, EXT-87): «Обновить» первой строкой, затем «Полный проход зеркала», затем «Пересобрать индекс», затем «Замерить остаток»', () => {
  const s = src('Service.jsx');
  const a = s.indexOf('<RefreshMirror');
  const b = s.indexOf('<FullMirror');
  const c = s.indexOf("'Пересобрать индекс'");
  const d = s.indexOf("'Замерить остаток'");
  assert.ok(a > 0 && b > a && c > b && d > c, `порядок: ${a} < ${b} < ${c} < ${d}`);
  const refresh = body(src('Mirror.jsx'), 'export function RefreshMirror(');
  assert.match(refresh, /onClick=\{\(\) => press\(\)\}/, 'обычный проход — то же нажатие press() без второго щелчка');
  assert.match(refresh, /'Обновить'/);
});

// вердикт Голема на d2f9851, Важно 1 (решение дирижёра): исход «дотянуть» — всегда в шапке; кнопка «Обновить» — у строки,
// пока «Служебное» раскрыто; показ в одном месте. По поведению pressPlace (mirrorData.js), не по исходнику
test('pressPlace: «дотянуть» — в шапке при раскрытом и свёрнутом «Служебном»; кнопка «Обновить» — у строки, только пока раскрыто; полный — у строки', async () => {
  const { pressPlace } = await import('../web/src/mirrorData.js');
  for (const svc of [true, false]) assert.equal(pressPlace({ kind: 'changed', src: 'pull', svc }), 'header', `дотянуть, svc ${svc}`);
  assert.equal(pressPlace({ kind: 'changed', src: 'button', svc: true }), 'row');
  assert.equal(pressPlace({ kind: 'changed', src: 'button', svc: false }), 'header', 'свёрнуто или окно проекта');
  for (const svc of [true, false]) assert.equal(pressPlace({ kind: 'full', src: 'button', svc }), 'row', `полный, svc ${svc}`);
  assert.equal(pressPlace({ kind: null, src: 'button', svc: false }), 'header', 'до первого нажатия');
  // одно место: для любого состояния ответ ровно один из двух
  for (const kind of ['changed', 'full', null]) for (const src of ['button', 'pull']) for (const svc of [true, false]) assert.ok(['header', 'row'].includes(pressPlace({ kind, src, svc })));
});

test('pullAnswer и pullNote: «ход вверху» — только когда проход идёт; asking и pending — «зеркало занято»; idle — запуск', async () => {
  const { pullAnswer, pullNote } = await import('../web/src/mirrorData.js');
  assert.equal(pullAnswer('idle'), 'started');
  assert.equal(pullAnswer('running'), 'running');
  assert.equal(pullAnswer('asking'), 'busy');
  assert.equal(pullAnswer('pending'), 'busy');
  assert.equal(pullAnswer('off'), 'off');
  assert.equal(pullNote('running'), 'обновление уже идёт — ход вверху');
  assert.equal(pullNote('busy'), 'зеркало занято — попробуй через минуту');
  assert.equal(pullNote('off'), 'пульт выключен — дотянуть нечем');
});

// дозапрос EXT-77 (слово Ивана 06.10 «го, сливай EXT-77 с подсказкой»; спека пульта §2.4)
test('строка (а): подсказка «ждёт тебя в десктопе — ответь там» — у askUserQuestion, permission и незнакомого «?», не у question; на «Цехе» и в окне проекта', async () => {
  const { waitsInDesktop, DESKTOP_HINT } = await import('../web/src/format.js');
  assert.equal(DESKTOP_HINT, 'ждёт тебя в десктопе — ответь там');
  for (const kind of ['askUserQuestion', 'permission', '?']) assert.equal(waitsInDesktop({ kind }), true, kind);
  assert.equal(waitsInDesktop({ kind: 'question' }), false);
  assert.equal(waitsInDesktop({}), false, 'строка без вида — не подсказываем');
  for (const f of ['Ceh.jsx', 'Project.jsx']) assert.match(src(f), /waitsInDesktop\(r\) && <span className="mline muted">\{DESKTOP_HINT\}<\/span>/, f);
});

test('справка: «Обновить» — в меню «Служебное» в шапке, в строке вверху — ход и итог', () => {
  const h = src('help.js');
  assert.match(h, /\*\*Обновить\*\* — первый пункт меню «Служебное»/);
  assert.doesNotMatch(h, /на «Цехе», в блоке «Служебное»|на «Цехе», блок «Служебное»/);
  assert.doesNotMatch(h, /\*\*Обновить\*\* — стоит сразу за временем зеркала/);
});
