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

test('«Служебное»: «Обновить» первой строкой, затем «Полный проход зеркала», затем «Пересобрать индекс»', () => {
  const s = src('Service.jsx');
  const a = s.indexOf('<RefreshMirror');
  const b = s.indexOf('<FullMirror');
  const c = s.indexOf("'Пересобрать индекс'");
  assert.ok(a > 0 && b > a && c > b, `порядок: ${a} < ${b} < ${c}`);
  const refresh = body(src('Mirror.jsx'), 'export function RefreshMirror(');
  assert.match(refresh, /onClick=\{\(\) => press\(\)\}/, 'обычный проход — то же нажатие press() без второго щелчка');
  assert.match(refresh, /'Обновить'/);
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

test('справка: «Обновить» — в «Служебном» на «Цехе», в шапке — ход и итог', () => {
  const h = src('help.js');
  assert.match(h, /\*\*Обновить\*\* — на «Цехе», в блоке «Служебное»/);
  assert.doesNotMatch(h, /\*\*Обновить\*\* — стоит сразу за временем зеркала/);
});
