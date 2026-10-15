// EXT-110 ПТ16б (спека пульта, раздел «EXT-110», гейт ПТ16б): кнопки окна «следующий шаг» — вид. Чип-ответ с полем send
// (ставит сервер, ПТ16а) становится кнопкой «ответ треду» пульта: title = send, хвост «→ <начало send>» при send ≠ label, первая —
// pmain; дубли по send снимаются; действия приложения и ответы без send — серые чипы (stepChips(actions, {buttons: true}));
// без параметра stepChips прежний (окно проекта); «Ответить» с формой «в ответ на: вопрос окна»; памятка help.js.
// Разметку в тестах не рисуем (в репозитории нет сборки JSX для node --test): поведение — чистые функции format.js и pultData.js,
// которые зовут Ceh.jsx и Pult.jsx; связка в разметке — по исходнику. Ожидаемое — из спеки, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fmt from '../web/src/format.js'; // stepWords, replyWords, canReplyRow — новое (ПТ16б): через пространство имён
import * as pd from '../web/src/pultData.js'; // wordBody — новое (ПТ16б)
import { HELP } from '../web/src/help.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const call = (f, ...a) => { assert.equal(typeof f, 'function', 'функции ещё нет'); return f(...a); };
// Стражи (№2, №3, №6) зелёные против копии прежнего смысла (OLD): функций ещё нет — стражи берут OLD, переписанный с Ceh.jsx
// (:169 и :180 до ПТ16б: кнопки только у question, у nextStep кнопок нет вовсе); после правки — настоящие функции format.js
const OLD = {
  canReplyRow: (r, { wordsOn, bell, tc }) => !!(wordsOn && r.kind === 'question' && r.uuid && (bell === true || tc)),
  replyWords: (r) => (r.kind === 'question' ? [{ action: 'reply' }, ...(r.card ? [{ action: 'reply', text: `го ${r.card}`, label: `го ${r.card}` }] : [])] : []),
  stepWords: () => [],
};
const guard = (name) => fmt[name] ?? OLD[name];

const LONG = 'правь правила цеха без Голема';
const DA = { label: 'Да', message: 'Да', send: 'Да' };
const OK = { label: 'Ок', message: LONG, send: LONG };
const MERGE = { label: 'Слить', action: 'merge' };
const NOSEND = { label: 'Посмотри', message: 'текст под маской' }; // send не поставлен сервером (маска, предел, управляющие)
const ROW = { kind: 'nextStep', uuid: 'u-wrap', sessionId: 's1', since: '2026-10-15T10:00:00.000Z', card: 'EXT-1', recap: 'итог хода',
  actions: [DA, OK, MERGE, NOSEND] };
const ON = { wordsOn: true, bell: true, tc: undefined };

// блок ветки canReply в Ceh.jsx — от «if (canReply) {» до прежнего вида строки
const cehReply = () => { const s = src('Ceh.jsx'); const i = s.indexOf('if (canReply) {'); return s.slice(i, s.indexOf('<div className="wrow df"', i)); };

test('1 (поломка): ответы с send — кнопки: подпись label, title = send, хвост «→ …» при send ≠ label, первая pmain; тело reply без card', () => {
  assert.equal(call(fmt.canReplyRow, ROW, ON), true, 'строка nextStep с uuid при pult.words и pult.bell — кнопки есть');
  assert.equal(call(fmt.canReplyRow, ROW, { wordsOn: true, bell: false, tc: 'EXT-9' }), true, 'карточка треда вместо звонка');
  const w = call(fmt.stepWords, ROW.actions);
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.label), ['Да', 'Ок']);
  assert.deepEqual(w.map((x) => x.title), ['Да', LONG], 'title ровно равен send');
  assert.deepEqual(w.map((x) => x.text), ['Да', LONG], 'уходит треду — send');
  assert.ok(w.every((x) => x.action === 'reply'));
  assert.equal(w[0].main, true, 'первая — главная');
  assert.ok(!w[1].main);
  assert.ok(!w[0].tail, 'send = label — хвоста нет');
  assert.equal(w[1].tail, `→ ${LONG}`);
  // порядок: чипы-ответы → «Ответить»; «го EXT-1» нет (Д-1)
  assert.deepEqual(call(fmt.replyWords, ROW), [...w, { action: 'reply' }]);
  // тело щелчка по «Ок» у треда без карточки (intentId добавляет fresh в Pult.jsx)
  const thread = { session: 's1', card: undefined, key: 's1|u-wrap', window: true };
  assert.deepEqual(call(pd.wordBody, { thread, q: { uuid: 'u-wrap', at: ROW.since }, action: 'reply', text: w[1].text }),
    { action: 'reply', session: 's1', q: { uuid: 'u-wrap', at: ROW.since }, text: LONG });
  // с карточкой треда — card карточки треда
  assert.equal(call(pd.wordBody, { thread: { ...thread, card: 'EXT-9' }, q: { uuid: 'u-wrap', at: ROW.since }, action: 'reply', text: 'Да' }).card, 'EXT-9');
  // разметка: Ceh зовёт replyWords и canReplyRow; Pult берёт main, title, tail слова; тело — wordBody, через fresh
  const c = cehReply();
  assert.match(src('Ceh.jsx'), /const canReply = canReplyRow\(r, \{ wordsOn, bell: pult\.bell, tc \}\);/);
  assert.match(c, /words=\{\{ btns: replyWords\(r\) \}\}/);
  assert.match(c, /r\.kind === 'nextStep' && <StepChips actions=\{r\.actions\} buttons \/>/, 'серые чипы при кнопках — StepChips с buttons');
  assert.match(src('Ceh.jsx'), /const chips = stepChips\(actions, \{ buttons \}\);/);
  assert.deepEqual(fmt.stepChips(ROW.actions, { buttons: true }).map((c) => c.text), ['действие: merge', 'Посмотри'], 'при кнопках серые — только действие и ответ без send');
  const p = src('Pult.jsx');
  assert.match(p, /className=\{w\.main \|\| \(words\.main === w\.action && !w\.text\) \? 'pbtn pmain' : 'pbtn'\}/);
  assert.match(p, /title=\{w\.title \?\? \(w\.action === 'take' \? 'ручки «В работу» ещё нет' : undefined\)\}/);
  assert.match(p, /\{labelOf\(w\)\}\{w\.tail && <span className="mline faint">\{w\.tail\}<\/span>\}<\/button>/);
  assert.match(p, /send\(fresh\(wordBody\(\{ thread, card, q, action, text \}\)\), key\)/);
  // без текста — поля text нет (кнопки-слова карточки, как было)
  assert.deepEqual(call(pd.wordBody, { card: 'EXT-2', q: { at: null }, action: 'yes' }), { action: 'yes', card: 'EXT-2', q: { at: null } });
});

test('1: хвост — 40 знаков (кодовые точки), длиннее — 39 и «…»; переводы строк — пробелом; без label — первые 24 знака message', () => {
  const s40 = '😀'.repeat(40), s41 = 'а'.repeat(41);
  const [a, b, c, d] = call(fmt.stepWords, [{ label: 'x', send: s40 }, { label: 'y', send: s41 }, { label: 'z', send: 'раз\nдва\r\nтри' },
    { message: 'м'.repeat(30), send: 'м'.repeat(30) }]);
  assert.equal(a.tail, `→ ${s40}`, '40 кодовых точек — целиком (t.length = 80)');
  assert.equal(b.tail, `→ ${'а'.repeat(39)}…`);
  assert.equal(c.tail, '→ раз два три');
  assert.equal(c.title, 'раз\nдва\r\nтри', 'title — ровно send');
  assert.equal(d.label, 'м'.repeat(24));
  assert.equal(d.tail, `→ ${'м'.repeat(30)}`, 'send ≠ подписи — хвост есть');
});

test('2 (ещё поломка, страж): действие приложения и ответ без send — серые чипы, не кнопки; «го EXT-1» нет', () => {
  const w = guard('stepWords')(ROW.actions);
  assert.ok(!w.some((x) => x.label === 'Слить' || x.label === 'Посмотри'), 'действие и ответ без send кнопкой не стали');
  const grey = fmt.stepChips(ROW.actions, { buttons: true }).map((c) => c.text);
  assert.ok(grey.includes('действие: merge') && grey.includes('Посмотри'), 'оба — серыми чипами');
  assert.ok(!guard('replyWords')(ROW).some((x) => /^го /.test(x.text ?? '')), 'у nextStep «го <ID>» нет даже при поле card');
  // подмена: элемент с action и send — всё равно действие
  assert.deepEqual(guard('stepWords')([{ label: 'Слить', action: 'merge', send: 'Слить' }]), []);
});

test('2а (Мелочь 4 Голема): «действие приложения» — одно правило с сервером: элемент с полем action, в том числе action: ""', () => {
  const odd = [{ label: 'Пусто', action: '', send: 'Пусто' }, { label: 'Ноль', action: null }];
  assert.deepEqual(call(fmt.stepWords, odd), []);
  assert.deepEqual(fmt.stepChips(odd).map((c) => c.text), ['действие приложения', 'действие приложения'], 'без параметра — тоже действие, не ответ');
  assert.equal(fmt.stepChips(odd, { buttons: true }).length, 2);
  // сервер (ПТ16а): windowText — a.action !== undefined; вид — то же условие
  assert.match(fs.readFileSync(path.join(ROOT, '..', 'lib', 'pult', 'words.mjs'), 'utf8'), /a\.action !== undefined\) return null;/);
  assert.match(src('format.js'), /const isAppAction = \(a\) => a\.action !== undefined;/);
});

test('3 (исправный, страж): (а) words выкл, (б) keyTemp, (в) звонок выкл и без карточки — прежний вид; (г) question — как было', () => {
  const can = guard('canReplyRow');
  assert.equal(can(ROW, { ...ON, wordsOn: false }), false);
  assert.equal(can({ ...ROW, uuid: null, keyTemp: true }, ON), false);
  assert.equal(can(ROW, { wordsOn: true, bell: false, tc: undefined }), false);
  assert.equal(can({ kind: 'permission', uuid: 'u' }, ON), false, 'разрешение на команду — только в десктопе');
  assert.equal(can({ kind: 'askUserQuestion', uuid: 'u' }, ON), false);
  // прежний вид: все чипы и подсказка десктопа
  assert.equal(fmt.stepChips(ROW.actions).length, 4);
  assert.equal(fmt.waitsInDesktop(ROW), true);
  const s = src('Ceh.jsx'), df = s.slice(s.indexOf('<div className="wrow df"', s.indexOf('if (canReply) {')));
  assert.match(df.slice(0, 900), /r\.kind === 'nextStep' && <StepChips actions=\{r\.actions\} \/>/);
  assert.match(df.slice(0, 900), /waitsInDesktop\(r\) && <span className="mline muted">\{DESKTOP_HINT\}<\/span>/);
  // (г) question: «Ответить» без main, title, tail; «го EXT-1» при поле card; форма «вопрос треда»
  const q = { kind: 'question', uuid: 'u-q', card: 'EXT-1' };
  assert.equal(can(q, ON), true);
  assert.deepEqual(guard('replyWords')(q), [{ action: 'reply' }, { action: 'reply', text: 'го EXT-1', label: 'го EXT-1' }]);
  assert.deepEqual(guard('replyWords')({ kind: 'question', uuid: 'u-q' }), [{ action: 'reply' }]);
  // форма без thread.window — «вопрос треда» (до правки — та же строка без условия)
  assert.match(src('Pult.jsx'), /в ответ на: вопрос треда\$\{thread\.card|в ответ на: вопрос \$\{thread\.window \? 'окна' : 'треда'\}/);
});

test('4 (в пути): «положено», «доставлено» — все кнопки строки неактивны; «сброшено перезапуском» — активны', () => {
  const p = src('Pult.jsx');
  assert.match(p, /export const FLIGHT = \['положено', 'доставлено'\];/);
  assert.match(p, /const inFlight = thread && \(\(markMine && FLIGHT\.includes\(mark\.ring\)\) \|\| \(phase === 'ok' && !markMine\)\);/);
  assert.match(p, /const off = busy \|\| confirming \|\| inFlight;/);
  // исключение — только «Ответить» без текста при открытой форме; чипы окна (reply с text) в пути неактивны и при открытой форме
  assert.match(p, /disabled=\{off && !\(w\.action === 'reply' && !w\.text && form === 'reply'\)\}/);
  // чипы-ответы и «Ответить» — слова одного ряда btns (одна кнопка wordBtn), не отдельный вид
  assert.deepEqual(call(fmt.replyWords, ROW).map((x) => x.action), ['reply', 'reply', 'reply']);
  assert.match(cehReply(), /mark=\{r\.pultMark\}/);
});

test('5 (дубли): одинаковый send — одна кнопка с label первого, второй не рисуется ни кнопкой, ни чипом; ключи слов разные', () => {
  const acts = [{ label: 'Первый', message: 'го', send: 'го' }, { label: 'Второй', message: 'го', send: 'го' }, { label: 'Иное', send: 'иное' }];
  const w = call(fmt.stepWords, acts);
  assert.deepEqual(w.map((x) => x.label), ['Первый', 'Иное']);
  assert.deepEqual(fmt.stepChips(acts, { buttons: true }), []);
  const keys = call(fmt.replyWords, { kind: 'nextStep', uuid: 'u', actions: acts }).map((x) => x.action + (x.text ?? ''));
  assert.equal(new Set(keys).size, keys.length, 'ключ React action + text не повторяется');
});

test('6 (окно проекта, страж): stepChips без параметра — все чипы; Project.jsx зовёт StepChips без buttons', () => {
  assert.deepEqual(fmt.stepChips(ROW.actions).map((c) => c.text), ['Да', 'Ок', 'действие: merge', 'Посмотри']);
  const p = src('Project.jsx');
  assert.match(p, /\{r\.kind === 'nextStep' && <StepChips actions=\{r\.actions\} \/>\}/);
  assert.doesNotMatch(p, /buttons/);
  assert.doesNotMatch(p, /replyWords|canReplyRow|<Pult /);
});

test('7 (подсказка и форма): у текста строки с кнопками title = recap; Ceh даёт thread.window у nextStep, форма — «вопрос окна»', () => {
  const c = cehReply();
  assert.match(c, /<span className="tt" title=\{r\.recap \|\| undefined\}>/);
  assert.match(c, /window: r\.kind === 'nextStep'/);
  assert.doesNotMatch(c, /DESKTOP_HINT/, 'в ветке кнопок подсказки десктопа нет');
  assert.match(src('Pult.jsx'), /`в ответ на: вопрос \$\{thread\.window \? 'окна' : 'треда'\}\$\{thread\.card \?/);
});

test('8 (памятка): «Ждёт меня» :16–:17 — текст спеки; старых фраз нет', () => {
  const items = HELP.find((s) => s.title === '«Ждёт меня»').items;
  assert.equal(items[0], '**Тред ждёт ответа** — тред задал тебе вопрос или ждёт разрешения на команду. На вопрос можно ответить и здесь — кнопкой „Ответить“ (ответ уйдёт треду звонком); разрешение на команду и вопрос с вариантами (AskUserQuestion) — только в десктопе.');
  assert.equal(items[1], 'Вопрос из окна „следующий шаг“ десктопа — тоже вопрос. Его кнопки-ответы нажимаются и здесь: под кнопкой — что уйдёт треду (подсказка и „→ …“), ответ уйдёт звонком; рядом — „Ответить“ своими словами. Серые „действие: …“ (commit, merge…) — кнопки самого десктопа, их жми там. Ответил в десктопе — на витрине не жми: тред получит ответ дважды.');
  const all = items.join('\n');
  assert.doesNotMatch(all, /Отвечать — в самом треде/);
  assert.doesNotMatch(all, /кнопки под ним — подсказка/);
});

test('дозапрос Голема п.1: подпись без label — пустой, из пробелов или управляющих — первые 24 знака message (как признак в звонке)', () => {
  const msg = 'начни с документации проекта целиком';
  const w = call(fmt.stepWords, ['', '  ', '\u0007'].map((label, i) => ({ label, message: msg + i, send: msg + i })));
  assert.deepEqual(w.map((x) => x.label), [0, 1, 2].map(() => [...msg].slice(0, 24).join('')));
});

test('9 (вёрстка, находка дирижёра 15.10): на ширине шире 560 кнопки окна — второй строкой под текстом вопроса, не колонкой справа', () => {
  const c = cehReply();
  // класс win — только у вида nextStep; question (кнопки «го»/«Ответить») — прежний «wrow pr stack»
  assert.match(c, /<div className=\{r\.kind === 'nextStep' \? 'wrow pr stack win' : 'wrow pr stack'\} key=\{r\.key\}>/);
  const css = src('styles.css');
  const i = css.indexOf('.wrow.pr.win{');
  assert.ok(i > 0, 'правила .wrow.pr.win нет');
  const head = css.slice(css.lastIndexOf('@media', i), i);
  assert.match(head, /^@media \(min-width:561px\)\{\s*$/, 'правило .win — только шире 560 (до 560 — .stack)');
  const blk = css.slice(i, css.indexOf('\n}', i));
  assert.match(blk, /\.wrow\.pr\.win\{grid-template-columns:150px auto auto minmax\(0,1fr\) 64px;/);
  assert.match(blk, /\.wrow\.pr\.win>\.tt\{grid-area:1\/2\/2\/5\}/, 'текст вопроса — во всю ширину первой строки');
  assert.match(blk, /\.wrow\.pr\.win \.pbtns\{grid-area:2\/2\}/, 'кнопки — второй строкой');
  assert.match(blk, /\.wrow\.pr\.win>\.dfr\{grid-area:2\/3\}/);
  assert.match(blk, /\.wrow\.pr\.win>\.age\{grid-area:1\/5\}/);
  assert.equal(css.split('.win').length - 1, 5, '.win — только в этом блоке: прочие строки «Ждёт меня» без изменений');
});
