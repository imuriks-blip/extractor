// EXT-125: витрина простыми словами — чистые функции web/src/plainData.js. Ожидаемое — литералами из ТЗ такта и вердикта
// Голема на 594f780 (плашки и коды lib/trace.mjs, уровни пометок как isRedMark lib/threads.mjs, правило «тихих»), не из кода
// под тестом. Где можно — по три случая: поломка, ещё поломка, исправный. Вид — снимками пробы в отчёте такта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pd from '../web/src/plainData.js';
import { isRedMark as serverIsRed } from '../lib/threads.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', f), 'utf8'));
const tr = (state, codes = [], extra = {}) => ({ state, label: 'подпись сервера', reasons: codes.map(([level, code]) => ({ level, code, text: code })), ...extra });

test('плашка: зелёная — только без записей после контракта; поля нет — плашки нет; ещё не посчитано — «проверяю»', () => {
  assert.equal(pd.traceWord(undefined), null);
  assert.deepEqual([pd.traceWord(null).text, pd.traceWord({ state: null }).text], ['проверяю', 'проверяю']);
  const ok = pd.traceWord(tr('ok'));
  assert.deepEqual([ok.text, ok.cls, ok.later], ['цех проверил', 'ok', null]);
});

test('laterRecords: поломка — ok и 2 записи после контракта: жёлтая «проверено, но…» и приписка рядом; ещё поломка — текст причины later; исправный — 0', () => {
  const a = pd.traceWord(tr('ok', [], { laterRecords: 2 }));
  assert.deepEqual([a.text, a.cls, a.later], ['проверено, но после проверки есть новые записи', 'warn', 'после контракта — ещё 2 записи']);
  const b = pd.traceWord({ state: 'ok', label: 'x', laterRecords: 1, reasons: [{ level: 'info', code: 'later', text: 'после контракта — ещё 1 запись (later)' }] });
  assert.equal(b.later, 'после контракта — ещё 1 запись (later)');
  const bad = pd.traceWord(tr('bad', [['bad', 'no-contract']], { laterRecords: 5 }));
  assert.equal(bad.later, 'после контракта — ещё 5 записей', 'приписка — при любом state, как у TraceBadge');
  assert.equal(pd.traceWord(tr('ok', [], { laterRecords: 0 })).text, 'цех проверил');
});

test('красные коды словами: not-in-main — «не слито», not-pushed — «не отправлено», отчёта нет — «нет отчёта»; причина коротко рядом', () => {
  const nim = pd.traceWord(tr('bad', [['bad', 'not-in-main']]));
  assert.deepEqual([nim.text, nim.note], ['не слито', 'работа не слита в основную ветку']);
  const np = pd.traceWord(tr('bad', [['bad', 'not-pushed'], ['warn', 'no-post']]));
  assert.deepEqual([np.text, np.note], ['не отправлено', 'работа не отправлена на сервер']);
  const both = pd.traceWord(tr('bad', [['bad', 'not-pushed'], ['bad', 'not-in-main']]));
  assert.deepEqual([both.text, both.note], ['не слито', 'работа не слита в основную ветку · ещё 1']);
  const rep = pd.traceWord(tr('bad', [['bad', 'not-pushed'], ['bad', 'no-who']]));
  assert.deepEqual([rep.text, rep.note], ['нет отчёта', 'в отчёте не сказано, кто решил · ещё 1'], 'отчёта нет — главнее, чем «не отправлено»');
  assert.equal(pd.traceWord(fx('ceh.json').waiting.review[1].trace).text, 'не отправлено', 'образец: CAR-260 — коммит не отправлен');
});

test('жёлтая и серая: у «проверь сам» подпись сервера видна рядом; state none — «без проверки»', () => {
  const w = pd.traceWord(tr('warn', [['warn', 'no-origin']], { label: 'abc1234 в main, но origin/main нет' }));
  assert.deepEqual([w.text, w.note], ['проверь сам', 'abc1234 в main, но origin/main нет']);
  const n = pd.traceWord(tr('none'));
  assert.deepEqual([n.text, n.cls, n.kind], ['без проверки', 'none', 'none']);
  assert.equal(pd.traceWord(tr('что-то-новое')).text, 'без проверки');
});

test('слова фильтра — те же, что на плашках', () => {
  assert.deepEqual(pd.FILTER_WORD, { ok: 'цех проверил', warn: 'проверь сам', bad: 'нет отчёта, не слито, не отправлено' });
  for (const t of [tr('bad', [['bad', 'not-in-main']]), tr('bad', [['bad', 'not-pushed']]), tr('bad', [['bad', 'no-contract']])]) {
    assert.ok(pd.FILTER_WORD.bad.includes(pd.traceWord(t).text), pd.traceWord(t).text);
  }
  assert.doesNotMatch(src('plainData.js') + src('Ceh.jsx'), /не сходится/);
});

test('свёртка подгруппы «Готово, посмотри»: все с одной плашкой — одной строкой; разные или одна строка — нет', () => {
  const row = (t) => ({ trace: t });
  assert.equal(pd.reviewSubView([row(tr('bad', [['bad', 'no-contract']])), row(tr('bad', [['bad', 'no-lines']]))]).uniform, 'нет отчёта');
  assert.equal(pd.reviewSubView([row(tr('bad', [['bad', 'not-in-main']])), row(tr('bad', [['bad', 'not-pushed']]))]).uniform, null, '«не слито» и «не отправлено» — разные');
  assert.equal(pd.reviewSubView([row(tr('ok'))]).uniform, null);
  assert.equal(pd.reviewSubView([row(undefined), row(undefined)]).uniform, null, 'без следа — не сворачиваем');
});

test('уровни замечаний — как isRedMark сервера: старые правила, PARTIAL, запись субагента, красный такт — красные; жёлтый такт и общий файл — жёлтые', () => {
  const marks = [
    { kind: 'oldRules', missing: [{ path: 'a' }] }, { kind: 'partial', who: 'Бальд' }, { kind: 'subagentWrite', who: 'Голем' },
    { kind: 'takt', level: 'red', card: 'EXT-1' }, { kind: 'takt', level: 'amber', card: 'EXT-2' }, { kind: 'collision', other: { title: 'EXT' } },
  ];
  for (const m of marks) assert.equal(pd.isRedMark(m), serverIsRed(m), m.kind + (m.level ? ` ${m.level}` : ''));
  const r = pd.threadRemarks({ marks });
  assert.deepEqual(r.map((x) => [x.kind, x.level]), [['oldRules', 'red'], ['partial', 'red'], ['subagentWrite', 'red'], ['takt', 'red'], ['takt', 'amber'], ['collision', 'amber']]);
  assert.equal(new Set(r.map((x) => x.key)).size, r.length, 'ключи уникальны');
  assert.deepEqual(r.filter((x) => x.kind === 'takt').map((x) => x.text), ['задача EXT-1 выдана, ответа от неё нет', 'задача EXT-2 выдана, ответа от неё нет'], 'два такта — с номерами, не сливаются');
  assert.equal(pd.threadRemarks({ marks: [], memory: { warn: true } })[0].level, 'amber', 'память — жёлтая');
  assert.equal(pd.threadRemarks({ marks: [{ kind: 'oldRules' }] })[0].reread, false, 'набора нет — без кнопки');
});

test('«Кто работает»: красный счётчик — только треды с красными пометками; старые правила — тревога сводки', () => {
  const v = pd.workersView([
    { sessionId: 'a', state: 'idle', marks: [{ kind: 'oldRules', missing: [{ path: 'x' }] }], subagents: [] },
    { sessionId: 'b', state: 'busy', marks: [{ kind: 'collision', other: { title: 'EXT' } }], subagents: [] },
    { sessionId: 'c', state: 'idle', marks: [], memory: { warn: true }, subagents: [] },
    { sessionId: 'd', state: 'idle', marks: [], subagents: [] },
  ]);
  assert.equal(v.withRed, 1);
  assert.equal(v.withRemarks, 3);
  assert.deepEqual(v.shown.map((r) => r.t.sessionId), ['a', 'b', 'c'], 'красный первым');
  assert.deepEqual(v.idle.map((t) => t.sessionId), ['d']);
  // жёлтое тред не поднимает (решение Ивана 10): ждёт и работает — выше свободного с жёлтым замечанием
  const y = pd.workersView([
    { sessionId: 'y', state: 'idle', marks: [{ kind: 'collision', other: { title: 'EXT' } }], subagents: [] },
    { sessionId: 'w', state: 'waiting', marks: [], subagents: [] },
    { sessionId: 'r', state: 'idle', marks: [{ kind: 'oldRules', missing: [{ path: 'x' }] }], subagents: [] },
    { sessionId: 'b', state: 'busy', marks: [], subagents: [] },
  ]);
  assert.deepEqual(y.shown.map((r) => r.t.sessionId), ['r', 'w', 'b', 'y'], 'красное — первым, жёлтое — после ждёт и работает');
  assert.equal(pd.briefNow([{ title: 'BW · приёмка', state: 'idle', marks: [{ kind: 'oldRules' }] }]).alarm, 'BW · приёмка: работает по старым правилам');
  assert.equal(pd.briefNow([{ title: 'X', state: 'busy', marks: [{ kind: 'collision', other: {} }] }]).alarm, null, 'жёлтое — не тревога');
  const ceh = fx('ceh.json');
  assert.equal(pd.workersView(ceh.workers.threads).withRed, ceh.workers.threads.filter((t) => t.marks.some(serverIsRed)).length);
});

test('сводка «Цеха»: «Сейчас» — треды и тревога; «Ждёт меня» — (а)+(б) и посмотреть; строки «Дальше» нет', () => {
  const ceh = fx('ceh.json');
  const b = pd.briefNow(ceh.workers.threads);
  assert.equal(b.line, 'Тредов 6: работают 2, ждут ответа 2, свободны 1, нет вестей 1.');
  assert.match(b.alarm, /^LEDGER · учётка: помощник .+ остановился на полпути/, 'обрыв помощника срочнее старых правил у EXT, хотя EXT выше в списке');
  assert.equal(pd.briefNow([]).line, 'Живых тредов нет.');
  assert.equal(pd.briefMe({ count: 1, more: 0 }), '1 ждёт ответа или «да»');
  assert.equal(pd.briefMe({ count: 3, more: 14 }), '3 ждут ответа или «да», 14 — посмотреть');
  assert.equal(pd.briefMe({ count: 0, more: 0 }), 'ничего не ждёт');
  assert.doesNotMatch(src('Ceh.jsx'), /className="l">Дальше</, '«Дальше» — после строки «для Ивана» (INFRA-113)');
});

test('«тихие» проекты: поломка — есть счётчики; ещё поломка — сбой чтения; исправный — пусто во всём', () => {
  const base = { code: 'X', phase: null, next: null, inProgress: 0, ready: 0, review: 0, phaseFailingSince: null };
  assert.equal(pd.isQuiet({ ...base, review: 2 }), false, 'со счётчиками — обычной строкой');
  assert.equal(pd.isQuiet({ ...base, phaseFailingSince: '2026-10-18T10:00:00Z' }), false, 'сбой чтения — обычной строкой с серым «чтение не удаётся»');
  assert.equal(pd.isQuiet({ ...base, next: { short: 'шаг' } }), false);
  assert.equal(pd.isQuiet(base), true);
  const { described, quiet } = pd.splitProjects(fx('ceh.json').projects);
  assert.deepEqual(quiet.map((p) => p.code), ['RADAR'], 'IPTV образца — в очереди 1: обычной строкой');
  assert.equal(described.length + quiet.length, 9);
  assert.deepEqual(pd.projectCounts({ inProgress: 3, ready: 0, review: 14 }), ['в работе 3', 'посмотри 14']);
});

test('карта: статус словом; «нет на доске» не дважды; значок следа в строке при не-зелёном следе', () => {
  assert.deepEqual(['in-progress', 'review', 'ready', 'backlog', 'done', 'cancelled'].map((s) => pd.mapStatus(s).text),
    ['делаем', 'посмотри', 'потом', 'потом', 'сделано', 'снято']);
  const r = src('Roadmap.jsx');
  assert.match(r, /\{c\.exists !== false && <span className=\{`rm-st s-\$\{stCls\}`\}>\{st\.text\}<\/span>\}/);
  assert.match(r, /const \{ traced, hot \} = cardTraceView\(c\);/);
  assert.match(r, /\{hot && <TraceBadge t=\{c\.trace\} \/>\}/);
  assert.match(r, /const stCls = st\.cls === 'done' && \(!traced \|\| hot\) \? 'later' : st\.cls;/, '«сделано» зелёным — только при зелёном следе');
  assert.match(r, /\{hot && <TraceBadge t=\{v\.trace\} \/>\}/, 'идея — так же');
  assert.equal(pd.markWord('Б'), 'необратимо');
  assert.equal(pd.markWord('другое'), 'другое');
});

test('служебное — под «подробнее», действия на месте; прораб и код проекта — в заголовке строки треда', () => {
  const c = src('Ceh.jsx');
  // EXT-129: при строке для Ивана под «подробнее» первым уходит и заголовок
  assert.match(c, /<More>\{lineForIvan\(r\) && <span className="dd-t">\{r\.title\}<\/span>\}<span className="mono">\{r\.id\}<\/span><TraceBadge t=\{r\.trace\} \/><\/More>/);
  assert.match(c, /<Pult card=\{r\.id\} q=\{r\.q \?\? null\} accept=\{r\.accept\} mark=\{r\.pultMark\} ar=\{pultOn\} \/>/, '«Принять»/«Вернуть» — как были');
  assert.match(c, /<Reread session=\{t\.sessionId\} missing=\{oldRules\.missing\} now=\{now\} bare \/>/);
  assert.match(c, /sid=\{inner \? undefined : t\.sessionId\}/, 'под «подробнее» кнопка не дублируется');
  assert.match(c, /<div key=\{r\.key\} className=\{`pl pl-\$\{r\.level\}`\}>/);
  assert.equal((c.match(/foremanLabel\(t\) && <span className="faint"> · \{foremanLabel\(t\)\}<\/span>/g) || []).length, 2, 'метка прораба — в Thread и в PlainThread');
});

// повторное ревью Голема на cfca486, Важно 1: у карточки не в «done» сервер отдаёт trace: null (lib/roadmap.mjs) —
// значка «проверяю след» в строке быть не должно; у «done» null — «проверяю», красный — значок, зелёный — нет
test('карта: значок следа в строке — только у «done» с не-зелёным следом', async () => {
  const { cardTraceView } = await import('../web/src/roadmapData.js');
  assert.deepEqual(cardTraceView({ status: 'in-progress', trace: null }), { traced: false, hot: false });
  assert.deepEqual(cardTraceView({ status: 'cancelled', trace: null }), { traced: false, hot: false });
  assert.deepEqual(cardTraceView({ status: 'done', trace: null }), { traced: true, hot: true });
  assert.deepEqual(cardTraceView({ status: 'done', trace: { state: 'bad' } }), { traced: true, hot: true });
  assert.deepEqual(cardTraceView({ status: 'done', trace: { state: 'ok' } }), { traced: true, hot: false });
});
