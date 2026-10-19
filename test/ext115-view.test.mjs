// EXT-115, EXT-128, EXT-126 (вид витрины; ветка ext-115-128-126). Ожидаемое — литералами из ТЗ такта и записей «решение»
// 19.10 15:42 на карточках, не из кода под тестом. По три случая, где можно: поломка, ещё поломка, исправный.
// EXT-115 — жёлтое warn рядом с «Принять» (поле сервера у слитой Б-карточки, lib/pult/accept.mjs); EXT-128 — строка треда
// не повторяет плашку «работает», незнакомая пометка словом; EXT-126 — нет кнопки «Перечитать правила» и «старых правил».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pd from '../web/src/plainData.js';
import { acceptWarn } from '../web/src/pultData.js';
import { HELP } from '../web/src/help.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WARN = 'выкатка ещё не сделана? «Принять» её не снимает';

/* ---------- EXT-115: warn у «Принять» ---------- */

test('EXT-115: warn — только при can === true и непустой строке; у обычной карточки (поля нет) и без кнопки — нет', () => {
  assert.equal(acceptWarn({ can: true, why: null, hint: null, branch: null, warn: WARN }), WARN, 'слитая Б-карточка, ручная выкатка');
  assert.equal(acceptWarn({ can: true, why: null, hint: null, branch: null }), null, 'обычная карточка — поля нет');
  assert.equal(acceptWarn({ can: true, warn: null }), null, 'Б-карточка с автовыкаткой — warn null');
  assert.equal(acceptWarn({ can: true, warn: '  ' }), null, 'пустая строка — не рисуем');
  assert.equal(acceptWarn({ can: false, warn: WARN, hint: 'ветка не слита' }), null, 'кнопки нет — и предупреждения нет');
  assert.equal(acceptWarn({ can: null, warn: WARN }), null, 'ещё проверяю — нет');
  assert.equal(acceptWarn({ can: 'true', warn: WARN }), null, 'can строго true');
  assert.equal(acceptWarn(null), null);
  assert.equal(acceptWarn(undefined), null);
});

test('EXT-115: в пульте warn рисуется жёлтым приёмом рядом с кнопками, «Принять» не прячет; все места кнопки — через Pult', () => {
  const p = src('Pult.jsx');
  assert.match(p, /const warn = ar \? acceptWarn\(accept\) : null;/);
  assert.match(p, /\{arShown && warn && <span className="pamb" role="note">\{warn\}<\/span>\}/, 'жёлтое — класс pamb существующих предупреждений');
  assert.match(p, /\{arShown && accept && canAccept && <button type="button" className="pbtn pmain" disabled=\{busy \|\| confirming \|\| !!form\} onClick=\{\(\) => press\('accept'\)\}>Принять<\/button>\}/, 'кнопка — по прежнему условию, warn в нём нет');
  assert.equal((p.match(/>Принять<\/button>/g) || []).length, 1, 'кнопка «Принять» одна — в Pult');
  // места кнопки: строки «Готово, посмотри» на «Цехе» и панель карточки — отдают Pult ответ сервера целиком (с warn)
  assert.match(src('Ceh.jsx'), /<Pult card=\{r\.id\} q=\{r\.q \?\? null\} accept=\{r\.accept\} mark=\{r\.pultMark\} ar=\{pultOn\} \/>/);
  assert.match(src('CardPanel.jsx'), /<Pult card=\{id\} q=\{pf\.q \?\? null\} accept=\{pf\.accept\}/);
  for (const f of fs.readdirSync(ROOT).filter((x) => /\.jsx$/.test(x) && x !== 'Pult.jsx')) {
    assert.doesNotMatch(src(f), />Принять<\/button>/, `${f}: своей кнопки «Принять» нет`);
  }
  assert.match(JSON.stringify(HELP), /выкатка ещё не сделана\? «Принять» её не снимает/, 'памятка объясняет предупреждение');
});

/* ---------- EXT-128: «работает» не дважды; незнакомая пометка словом ---------- */

test('EXT-128: у «работает» без подмастерьев строки нет; с подмастерьем — его задача; прочие состояния — как были', () => {
  assert.equal(pd.threadDoing({ state: 'busy', subagents: [] }), null, 'плашка «работает» не повторяется');
  assert.equal(pd.threadDoing({ state: 'busy', card: 'EXT-1' }), null, 'карточка — под «подробнее», не строкой');
  assert.equal(pd.threadDoing({ state: 'busy', subagents: [{ who: 'Бальд', description: 'вид витрины' }] }), 'Бальд: вид витрины');
  assert.equal(pd.threadDoing({ state: 'busy', subagents: [{ agent: 'bard' }] }), 'bard: задача без описания');
  assert.equal(pd.threadDoing({ state: 'idle', subagents: [] }), 'свободен');
  assert.equal(pd.threadDoing({ state: 'waiting', subagents: [] }), 'ждёт твоего ответа');
  assert.equal(pd.threadDoing({ state: 'stale', subagents: [] }), 'нет вестей');
  const c = src('Ceh.jsx');
  assert.match(c, /const doing = !remarks\.length \|\| t\.subagents\.length > 0 \? threadDoing\(t\) : null;/);
  assert.match(c, /\{doing && <div className="pl">\{doing\}<\/div>\}/, 'пустой строки-обёртки нет');
  assert.match(JSON.stringify(HELP), /строки нет — хватает плашки «работает»/);
});

test('EXT-128: незнакомый вид пометки — словом «пометка», не сырым именем; уровень — как у сервера (красный)', () => {
  const r = pd.threadRemarks({ marks: [{ kind: 'newKindX' }, { kind: 'partial', who: 'Голем' }] });
  assert.deepEqual(r.map((x) => [x.text, x.level]), [['незнакомая пометка — смотри «подробнее»', 'red'], ['помощник Голем остановился на полпути', 'red']]);
  assert.ok(!r.some((x) => x.text.includes('newKindX')), 'сырое имя вида в строку не попадает');
  assert.equal(pd.threadRemarks({ marks: [{ kind: 'collision', other: { title: 'EXT' } }] })[0].text, 'правит общие файлы вместе с: EXT', 'знакомые — прежними словами');
});

/* ---------- EXT-126: без «Перечитать правила» и «старых правил» ---------- */

test('EXT-126: кнопки «Перечитать правила» нет нигде в виде; пометка oldRules не видна ни на «Цехе», ни в окне проекта', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'Reread.jsx')), false, 'Reread.jsx удалён');
  for (const f of fs.readdirSync(ROOT).filter((x) => /\.jsx?$/.test(x) && x !== 'rereadFeed.js')) {
    const s = src(f).replace(/\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, ''); // без комментариев: история — в них
    assert.doesNotMatch(s, /Reread\.jsx|from '\.\/rereadFeed\.js'/, `${f}: не зовёт кнопку и её опрос`);
    assert.doesNotMatch(s, /Перечитать правила|старым правилам|>Старые правила</, `${f}: слов кнопки и пометки нет`);
  }
  const h = JSON.stringify(HELP);
  assert.doesNotMatch(h, /Перечитать правила|Старые правила|старые правила|правила перечитаны/i, 'памятка не говорит о кнопке и «старых правилах»');
  assert.deepEqual(pd.shownMarks([{ kind: 'oldRules', missing: [{ path: 'x' }] }, { kind: 'takt', level: 'red' }, null]).map((m) => m?.kind), ['takt', undefined]);
  assert.deepEqual(pd.shownMarks(undefined), []);
  const c = src('Ceh.jsx');
  assert.match(c, /case 'oldRules':\r?\n\s*\/\/[^\n]*\r?\n\s*return null;/, 'Mark сам ничего не рисует');
  assert.match(c, /\{shownMarks\(t\.marks\)\.map\(\(m, i\) => <Mark key=\{`\$\{m\.kind\}-\$\{i\}`\} m=\{m\} now=\{now\} \/>\)\}/);
  assert.doesNotMatch(c.replace(/\/\/.*$/gm, ''), /правила свежие|правила перечитаны/, 'строк о правилах в шапке треда нет');
  const p = src('Project.jsx');
  assert.match(p, /shownMarks\(t\.marks\)\.filter\(isRed\)\.length/, 'красный счётчик окна проекта старых правил не считает');
  assert.match(p, /const shut = closed\.filter\(\(t\) => shownMarks\(t\.marks\)\.length > 0\);/, 'закрытый тред только со «старыми правилами» не рисуется');
});

test('EXT-126: тред, у которого только «старые правила», — среди свободных; тревоги и счётчика нет; соседняя красная — на месте', () => {
  const v = pd.workersView([
    { sessionId: 'o', state: 'idle', marks: [{ kind: 'oldRules', missing: [{ path: 'x' }] }], subagents: [] },
    { sessionId: 'p', state: 'idle', marks: [{ kind: 'oldRules' }, { kind: 'subagentWrite', who: 'Голем' }], subagents: [] },
  ]);
  assert.deepEqual(v.idle.map((t) => t.sessionId), ['o']);
  assert.deepEqual(v.shown.map((r) => [r.t.sessionId, r.remarks.map((x) => x.kind)]), [['p', ['subagentWrite']]]);
  assert.equal(v.withRed, 1);
  assert.equal(pd.briefNow([{ title: 'P', state: 'idle', marks: [{ kind: 'oldRules' }, { kind: 'subagentWrite', who: 'Голем' }] }]).alarm, 'P: помощник Голем записал в доску — так нельзя');
});
