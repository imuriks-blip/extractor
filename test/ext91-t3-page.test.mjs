// EXT-91 такт 3 (+ EXT-92): вид режима live на странице и положение меню «Служебное». Проверки по исходникам web/src (сборка
// и снимки — probe/ext91-t3-shots.mjs); режим в /api/ceh — в ext91-live.test.mjs и fixtures.test.mjs (поле boardMode).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');

test('live: в меню «Служебное» нет «Обновить» и «Полного прохода зеркала»; индекс и замер остаются', () => {
  const s = src('Service.jsx');
  assert.match(s, /\{!live && <RefreshMirror shown=\{open\} \/>\}/);
  assert.match(s, /\{!live && <FullMirror \/>\}/);
  assert.match(s, /'Пересобрать индекс'/);
  assert.match(s, /'Замерить остаток'/);
});

test('live: в шапке «доска в git» вместо возраста зеркала, ход идущего прохода виден; в mirror всё как было', () => {
  const a = src('App.jsx');
  assert.match(a, /\{live && <>.*доска в git/);
  assert.match(a, /\{!live && mirror && <>.*<span title="Зеркало доски целиком обновляется/s);
  assert.match(a, /boardMode === 'live'/);
  const m = src('Mirror.jsx');
  assert.match(m, /if \(live && s\.phase !== 'running'\) return null;/, 'в live — только ход прохода, начатого до переключения');
  assert.match(m, /s\.off \|\| live \? undefined : setPuller/, 'в live «дотянуть» не регистрируется');
});

test('live: тексты хода записи — «в доску», без «7–8 с» Plane; mirror-тексты не тронуты', () => {
  const p = src('Pult.jsx');
  assert.match(p, /live \? 'в доску' : 'в Plane'/);
  assert.match(p, /!live && <span className="faint"> · обычно 7–8 с<\/span>/);
  assert.match(p, /st\.pull && !live/, 'кнопки «дотянуть» в live нет');
  assert.doesNotMatch(p, /isLiveMode/, 'режим читается с подпиской (useBoardMode), не разовым чтением');
  assert.match(p, /useBoardMode\(\) === 'live'/);
});

test('EXT-92: сторона меню не считается один раз при открытии — положение пересчитывается по наблюдателям, пока меню открыто', () => {
  const s = src('Service.jsx');
  assert.doesNotMatch(s, /alignLeft/);
  assert.match(s, /new ResizeObserver\(again\)/);
  assert.match(s, /new MutationObserver\(again\)/);
  assert.match(s, /addEventListener\('resize', again\)/);
  assert.doesNotMatch(src('styles.css'), /\.smenu\.left/);
});

test('такт 6: warnings ответа пульта — серыми строками под исходом; нет warnings — ничего', () => {
  const p = src('Pult.jsx');
  assert.match(p, /Array\.isArray\(b\.warnings\)/);
  assert.match(p, /st\?\.warnings\?\.length \? <span className="pwarn faint"/);
  assert.match(p, /<Warns st=\{st\} \/>/);
  assert.match(src('styles.css'), /\.pwarn\{display:block;font-size:12px/);
});
