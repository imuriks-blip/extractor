// EXT-125: витрина простыми словами — чистые функции web/src/plainData.js. Ожидаемое — из ТЗ такта (плашки «цех проверил» /
// «проверь сам» / «нет отчёта» / «не отправлено», свёртка однотипного, сводка «Сейчас» / «Ждёт меня», проекты строками,
// статусы карты словами), не из кода под тестом. Вид — снимками пробы в отчёте такта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pd from '../web/src/plainData.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', f), 'utf8'));
const tr = (state, ...codes) => ({ state, label: 'x', reasons: codes.map(([level, code]) => ({ level, code, text: code })) });

test('плашка следа словами: проверен / проверь / нет отчёта / не отправлено; поля нет — плашки нет', () => {
  assert.equal(pd.traceWord(undefined), null);
  assert.equal(pd.traceWord(null).text, 'проверяю');
  assert.equal(pd.traceWord(tr('ok')).text, 'цех проверил');
  assert.equal(pd.traceWord(tr('warn', ['warn', 'no-origin'])).text, 'проверь сам');
  assert.equal(pd.traceWord(tr('bad', ['bad', 'no-contract'])).text, 'нет отчёта');
  assert.equal(pd.traceWord(tr('bad', ['bad', 'not-pushed'], ['warn', 'no-post'])).text, 'не отправлено');
  assert.equal(pd.traceWord(tr('bad', ['bad', 'not-in-main'])).text, 'не отправлено');
  assert.equal(pd.traceWord(tr('bad', ['bad', 'not-pushed'], ['bad', 'no-who'])).text, 'нет отчёта', 'отчёта нет — главнее, чем «не отправлено»');
  const ceh = fx('ceh.json');
  assert.equal(pd.traceWord(ceh.waiting.review[1].trace).text, 'не отправлено', 'образец: CAR-260 — коммит не отправлен');
});

test('свёртка подгруппы «Готово, посмотри»: все строки с одной плашкой — одной строкой; разные или одна строка — нет', () => {
  const row = (t) => ({ trace: t });
  assert.equal(pd.reviewSubView([row(tr('bad', ['bad', 'no-contract'])), row(tr('bad', ['bad', 'no-lines']))]).uniform, 'нет отчёта');
  assert.equal(pd.reviewSubView([row(tr('bad', ['bad', 'no-contract'])), row(tr('ok'))]).uniform, null);
  assert.equal(pd.reviewSubView([row(tr('ok'))]).uniform, null);
  assert.equal(pd.reviewSubView([row(undefined), row(undefined)]).uniform, null, 'без следа — не сворачиваем');
});

test('«Кто работает»: замечания треда строкой по-людски; без замечаний — свободные и «нет вестей» одной строкой', () => {
  const ceh = fx('ceh.json');
  const v = pd.workersView(ceh.workers.threads);
  const all = [...v.shown.map((r) => r.t), ...v.idle, ...v.stale];
  assert.equal(all.length, ceh.workers.threads.length, 'ни один тред не потерян');
  assert.ok(v.shown[0].remarks.some((r) => r.level === 'red'), 'тред с тревогой — первым');
  const led = v.shown.find((r) => r.t.project === 'LEDGER');
  assert.deepEqual(led.remarks.map((r) => r.kind), ['partial', 'takt', 'subagentWrite', 'oldRules']);
  const ext = v.shown.find((r) => r.t.project === 'EXT');
  assert.ok(ext.remarks.find((r) => r.kind === 'collision').text.startsWith('правит общие файлы вместе с: '));
  assert.equal(pd.threadRemarks({ marks: [], memory: { warn: true } })[0].kind, 'memory');
  assert.equal(pd.threadRemarks({ marks: [{ kind: 'oldRules', missing: [{ path: 'a' }] }] })[0].reread, true, 'кнопка «Перечитать правила» — у строки');
  assert.equal(pd.threadRemarks({ marks: [{ kind: 'oldRules' }] })[0].reread, false, 'набора нет — без кнопки');
  assert.deepEqual(v.stale.map((t) => t.state), ['stale']);
  assert.equal(pd.threadDoing({ state: 'idle', subagents: [] }), 'свободен');
  assert.equal(pd.threadDoing({ state: 'busy', subagents: [{ who: 'Терминус', description: 'Справка' }] }), 'Терминус: Справка');
});

test('сводка «Цеха»: «Сейчас» — треды и тревога; «Ждёт меня» — (а)+(б) и посмотреть; строки «Дальше» нет', () => {
  const ceh = fx('ceh.json');
  const b = pd.briefNow(ceh.workers.threads);
  assert.match(b.line, /^Тредов 6: работают 2, ждут ответа 2, свободны 1, нет вестей 1\.$/);
  assert.match(b.alarm, /^LEDGER · учётка: помощник .+ остановился на полпути/);
  assert.equal(pd.briefNow([]).line, 'Живых тредов нет.');
  assert.equal(pd.briefNow([{ state: 'idle', marks: [] }]).alarm, null);
  assert.equal(pd.briefMe({ count: 1, more: 0 }), '1 ждёт ответа или «да»');
  assert.equal(pd.briefMe({ count: 3, more: 14 }), '3 ждут ответа или «да», 14 — посмотреть');
  assert.equal(pd.briefMe({ count: 0, more: 0 }), 'ничего не ждёт');
  assert.doesNotMatch(src('Ceh.jsx'), /className="l">Дальше</, '«Дальше» — после строки «для Ивана» (INFRA-113)');
});

test('проекты строками: без фазы и шага — одной строкой; счётчики словами, только ненулевые', () => {
  const ceh = fx('ceh.json');
  const { described, quiet } = pd.splitProjects(ceh.projects);
  assert.deepEqual(quiet.map((p) => p.code), ['RADAR', 'IPTV']);
  assert.equal(described.length + quiet.length, ceh.projects.length);
  assert.deepEqual(pd.projectCounts({ inProgress: 3, ready: 0, review: 14 }), ['в работе 3', 'посмотри 14']);
  assert.doesNotMatch(src('Ceh.jsx'), /<table className="ptable">/, 'таблицы проектов на «Цехе» нет');
});

test('карта: статус карточки словом; метка строки (б) словом', () => {
  assert.deepEqual(['in-progress', 'review', 'ready', 'backlog', 'done', 'cancelled'].map((s) => pd.mapStatus(s).text),
    ['делаем', 'посмотри', 'потом', 'потом', 'сделано', 'снято']);
  assert.equal(pd.mapStatus(null).text, 'нет на доске');
  assert.equal(pd.markWord('Б'), 'необратимо');
  assert.equal(pd.markWord('сливай'), 'слить');
  assert.equal(pd.markWord('другое'), 'другое');
});

test('служебное — под «подробнее», действия на месте: номер и след строки (в), список файлов «Старых правил»', () => {
  const c = src('Ceh.jsx');
  assert.match(c, /<More><span className="mono">\{r\.id\}<\/span><TraceBadge t=\{r\.trace\} \/><\/More>/);
  assert.match(c, /<Pult card=\{r\.id\} q=\{r\.q \?\? null\} accept=\{r\.accept\} mark=\{r\.pultMark\} ar=\{pultOn\} \/>/, '«Принять»/«Вернуть» — как были');
  assert.match(c, /<Reread session=\{t\.sessionId\} missing=\{oldRules\.missing\} now=\{now\} bare \/>/);
  assert.match(c, /sid=\{inner \? undefined : t\.sessionId\}/, 'под «подробнее» кнопка не дублируется');
  assert.match(src('Summary.jsx'), /export function More\(/);
});
