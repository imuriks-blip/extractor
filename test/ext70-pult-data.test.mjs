// ПТ7, серверная часть (EXT-70; спека пульта §1.7 «Данные страницы для кнопок-слов», §2.3, §2.8, §3.2, §3.4; спека витрины §1.4,
// §2.4 (а)): pult {enabled, words, bell} в /api/ceh и /api/card, candidates с маской и staleMin, поле card у строки (а),
// pultMark одной формы на все действия, отметка строки (а), контракт «го <ID>» из строки (а).
// Подменный plane.py (test/fake-plane.mjs), временная доска; настоящий plane.py и mirror.mjs не запускаются.
// Ожидаемые значения — из спеки и из того, что положено в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { waitingThreads } from '../lib/waiting.mjs';
import { rowMarks } from '../lib/pult/row-marks.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 1700;
const nextIntent = () => uuid(++intents);
const SID = uuid(801);
const SID2 = uuid(802);
const QU = uuid(901);
const Q_AT = '2026-10-03T09:00:00.000Z';
const QT_AT = '2026-10-04T10:00:00.000Z';
const Q_MD = 'Ветка готова — можно принимать?';
const Q_HTML = `<p>${Q_MD}</p>`;
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;

// EXT-20, EXT-21 обычные; EXT-22, EXT-27 в Review; EXT-24 закрыта; CAR-5 — карточка чужого проекта
const boardDir = makeBoard(tmpDir('ext70-board-'), { codes: ['EXT', 'CAR'], cards: [
  { id: 'EXT-20', status: 'in-progress', title: 'Обычная' }, { id: 'EXT-21', status: 'in-progress', title: 'Вторая' },
  { id: 'EXT-22', status: 'review', title: 'Слияние' }, { id: 'EXT-24', status: 'done', title: 'Закрыта' },
  { id: 'EXT-27', status: 'review', title: 'Принять' }, { id: 'CAR-5', status: 'in-progress', title: 'Чужая' },
] });
for (const id of ['EXT-20', 'EXT-21', 'EXT-22', 'EXT-24', 'EXT-27']) fs.writeFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), logWith(Q_MD));
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: '2026-10-03T09:30:00.000Z', lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка\n');
const regFile = path.join(tmpDir('ext70-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, CAR: { repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

function fakeSpawn() {
  const fn = (cmd, args, opts) => {
    const ch = new EventEmitter();
    ch.pid = 9100;
    ch.unref = () => {};
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  return fn;
}

const thread = (sid, o = {}) => ({ sessionId: sid, title: `тред ${sid.slice(-3)}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), ...o });
// тред, ждущий ответа на вопрос: строка (а) строится настоящей waitingThreads по выжимке журнала
const waitingThread = (sid, o = {}) => thread(sid, { state: 'waiting', waitingKind: 'question', statusUpdatedAt: QT_AT, ...o });
const sessionOf = (sid, text, uuidQ = QU, extra = {}) => ({ sessionId: sid, lines: 10, thread: { q: text === null ? null : { text, uuid: uuidQ, at: QT_AT } }, ...extra });

// opts: threads, sessions (массив или функция), words/bell, bellDir (false — папка звонка не задана), clock {t}, data (рестарт)
async function setup(plane = {}, { threads = [], sessions = [], words = true, bell = true, bellDir = true, enabled = true, clock = null, data: dataIn = null } = {}) {
  const data = dataIn ?? tmpDir('ext70-data-'); // data — папка прежнего экземпляра: рестарт на том же actions.log
  const pdir = tmpDir('ext70-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'In Progress', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z', ...plane }));
  const web = tmpDir('ext70-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const live = { threads, sessions: typeof sessions === 'function' ? sessions : () => live.sess };
  live.sess = Array.isArray(sessions) ? sessions : [];
  const nowMs = () => (clock ? clock.t : Date.now());
  const threadsApi = {
    list: () => ({ threads: live.threads, waiting: waitingThreads({ threads: live.threads, sessions: live.sessions(), now: nowMs() }), subagentsCount: 0, unknownStatus: {} }),
    state: () => ({ processes: { lastOkAt: '2026-10-04T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions: () => live.sessions() };
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, threads: threadsApi, journals,
    pult: { enabled, words, bell, ...(bellDir ? { bellDir: path.join(data, 'bell') } : {}), actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: fakeSpawn(), ...(clock ? { now: () => clock.t } : {}) } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pl = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rowOf = async (sid) => (await get('/api/ceh')).waiting.threads.find((x) => x.sessionId === sid);
  return { app, press, get, lines, pl, live, rowOf, actionsLog, data };
}

const Q = { at: Q_AT, head: Q_MD };
const QT = { uuid: QU, at: QT_AT };
const MARK_KEYS = ['action', 'at', 'id', 'ring', 'state'];

// ---------------- 1. pult {enabled, words, bell} ----------------

test('1: /api/ceh и /api/card/:id отдают pult {enabled, words, bell}; bell — действующее состояние звонка (флаг и папка), не флаг из конфига', async () => {
  const cases = [
    [{}, { enabled: true, words: true, bell: true }],
    [{ words: false }, { enabled: true, words: false, bell: true }],
    [{ bell: false }, { enabled: true, words: true, bell: false }],
    [{ bell: true, bellDir: false }, { enabled: true, words: true, bell: false }], // флаг включён, папки звонка нет — звонка нет
    [{ enabled: false, words: false, bell: false }, { enabled: false, words: false, bell: false }],
  ];
  for (const [opts, want] of cases) {
    const s = await setup({}, opts);
    assert.deepEqual((await s.get('/api/ceh')).pult, want, JSON.stringify(opts));
    const c = await s.get('/api/card/EXT-20');
    assert.deepEqual({ enabled: c.pult.enabled, words: c.pult.words, bell: c.pult.bell }, want, JSON.stringify(opts));
    // тот же bell, что on в /api/health
    assert.equal((await s.get('/api/health')).bell.on, want.bell, JSON.stringify(opts));
  }
});

// ---------------- 2. confirm.candidates ----------------

test('2: candidates[] = {sessionId, title, by, staleMin?}: title по маске и тот же в шаге need-confirm actions.log; staleMin — только у «устарело»', async () => {
  const clock = { t: Date.now() };
  const stale = thread(SID2, { title: `тред ${SECRET}`, state: 'stale', lastSeenAt: new Date(clock.t - 20 * 60000).toISOString() });
  const s = await setup({}, { clock, threads: [thread(SID), stale] });
  const b = (await s.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(b.outcome, 'need-confirm');
  const byId = Object.fromEntries(b.confirm.candidates.map((c) => [c.sessionId, c]));
  assert.deepEqual(byId[SID], { sessionId: SID, title: 'тред 801', by: 'project' }, 'исправный: staleMin нет совсем');
  assert.deepEqual(Object.keys(byId[SID2]).sort(), ['by', 'sessionId', 'staleMin', 'title']);
  assert.equal(byId[SID2].staleMin, 20);
  assert.ok(!byId[SID2].title.includes(SECRET), 'в ответе страницы — по маске');
  const logged = s.lines().find((l) => l.id === b.id && l.step === 'need-confirm');
  assert.deepEqual(logged.confirm.candidates, b.confirm.candidates, 'в журнал уходит та же замаскированная строка');
  assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes(SECRET), 'секрета в actions.log нет');
});

// ---------------- 3. поле card у строки (а) ----------------

const rowCard = async (text, { project = 'EXT', kind = 'question', board: extra = null } = {}) => {
  const s = await setup({}, { threads: [waitingThread(SID, { project, waitingKind: kind })], sessions: [sessionOf(SID, text)] });
  return { s, row: await s.rowOf(SID) };
};

test('3: card строки (а) — единственный номер с кодом проекта треда в полном тексте (после 160 знаков, без \\b); иначе поля нет', async () => {
  const long = `${'Длинный абзац. '.repeat(20)}Принимаешь EXT-21?`; // номер за обрезкой в 160 знаков
  assert.ok(long.indexOf('EXT-21') > 160);
  for (const [text, want] of [
    ['Принимаешь EXT-21?', 'EXT-21'],
    [long, 'EXT-21'],
    ['Принимаешь EXT-21? Да, именно EXT-21?', 'EXT-21'], // тот же номер дважды — один номер
    ['карточка:EXT-21?', 'EXT-21'],
    ['вопрос по карточкеEXT-21а, ок?', 'EXT-21'], // кириллица вплотную: \b тут не работает
    ['Принимаешь EXT-21 или EXT-20?', undefined], // два разных — поля нет
    ['Принимаешь CAR-5?', undefined], // код чужого проекта
    ['Принимаешь EXT-21 и CAR-5?', 'EXT-21'], // чужой код не мешает
    ['Принимаешь EXT-99?', undefined], // карточки нет в файлах доски
    ['Принимаешь EXT-24?', undefined], // закрыта (done)
    ['Принимаешь XEXT-21?', undefined], // латинская буква вплотную — не номер
    ['Без номера?', undefined],
  ]) {
    const { row } = await rowCard(text);
    assert.equal(row.card, want, text);
    if (want === undefined) assert.ok(!('card' in row), `поля нет совсем: ${text}`);
  }
});

test('3: тред без проекта и строки не-question — поля card нет', async () => {
  assert.ok(!('card' in (await rowCard('Принимаешь EXT-21?', { project: null })).row), 'тред без проекта');
  assert.ok(!('card' in (await rowCard('Принимаешь EXT-21?', { kind: 'askUserQuestion' })).row), 'askUserQuestion кнопок не получает');
});

// ---------------- 4. pultMark одной формы ----------------

// читатель доски кэширует разбор журнала карточки по mtime: каждая правка файла в тесте получает свой, строго растущий mtime
let mt = Math.floor(Date.now() / 1000) + 1000;
const editLog = (file, fn) => { fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'))); fs.utimesSync(file, ++mt, mt); };
const cardMark = async (s, id) => (await s.get(`/api/card/${id}`)).pult.mark;

test('4: у всех действий одна форма {id, action, at, state, ring}: слова — state null, ring по 2.8; «Принять» — ring null, missing и text; «Вернуть» — ring', async () => {
  const s = await setup({}, { threads: [thread(SID, { card: 'EXT-20' })] });
  const yes = (await s.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  const m = await cardMark(s, 'EXT-20');
  assert.deepEqual(Object.keys(m).sort(), MARK_KEYS, 'у слов нет missing и text');
  assert.equal(m.id, yes.id);
  assert.equal(m.action, 'yes');
  assert.equal(m.state, null);
  assert.equal(m.ring, 'положено');
  assert.match(m.at, /^\d{4}-\d\d-\d\dT/);
  // строка (б)/(в) несёт ту же отметку и уходит в «отвечено, ждёт зеркала»
  const acc = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-27' })] });
  const a = (await acc.press({ action: 'accept', card: 'EXT-27', q: Q })).json();
  const am = await cardMark(acc, 'EXT-27');
  assert.deepEqual(Object.keys(am).sort(), [...MARK_KEYS, 'missing', 'text'].sort());
  assert.deepEqual([am.id, am.action, am.state, am.ring, am.missing], [a.id, 'accept', 'Done', null, false]);
  assert.match(am.text, /^принято · Done в Plane \d\d:\d\d · зеркало ещё не видело$/);
  const ret = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-27' })] });
  const r = (await ret.press({ action: 'return', card: 'EXT-27', q: Q, text: 'не так' })).json();
  const rm = await cardMark(ret, 'EXT-27');
  assert.deepEqual([rm.id, rm.action, rm.state, rm.ring, rm.missing], [r.id, 'return', 'In Progress', 'положено', false]);
  assert.match(rm.text, /^возвращено · In Progress в Plane/);
  const row = (await ret.get('/api/ceh')).waiting.review.find((x) => x.id === 'EXT-27');
  assert.deepEqual(row.pultMark, rm);
  assert.equal(row.answered, true);
});

test('4: слова всех видов ставят отметку (yes, go, no, reply с карточкой, merge и deploy после второго щелчка)', async () => {
  for (const [action, extra, card, status] of [['go', {}, 'EXT-20'], ['no', { text: 'нет' }, 'EXT-20'], ['reply', { text: 'делай' }, 'EXT-20'],
    ['merge', {}, 'EXT-22', 'Review'], ['deploy', {}, 'EXT-22', 'Review']]) {
    const s = await setup(status ? { status } : {}, { threads: [thread(SID, { card })] });
    let b = (await s.press({ action, card, q: Q, ...extra })).json();
    if (b.outcome === 'need-confirm') b = (await s.press({ action, card, q: Q, ...extra, confirm: b.id })).json();
    assert.equal(b.outcome, 'ok', `${action}: ${b.message}`);
    const m = await cardMark(s, card);
    assert.deepEqual([m.id, m.action, m.state, m.ring], [b.id, action, null, 'положено'], action);
  }
});

test('4: отметка — только при исходе ok/partial: отказ (карточка закрыта), ошибка (Plane не принял) и need-confirm её не ставят', async () => {
  const s = await setup({}, { threads: [thread(SID, { card: 'EXT-20' })] });
  assert.equal((await s.press({ action: 'yes', card: 'EXT-24', q: Q })).json().outcome, 'refused');
  assert.equal(await cardMark(s, 'EXT-24'), null);
  const err = await setup({ fail: { comment: 'refuse' } }, { threads: [thread(SID, { card: 'EXT-20' })] });
  assert.equal((await err.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'error');
  assert.equal(await cardMark(err, 'EXT-20'), null);
  const bd = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-22' })] });
  assert.equal((await bd.press({ action: 'merge', card: 'EXT-22', q: Q })).json().outcome, 'need-confirm');
  assert.equal(await cardMark(bd, 'EXT-22'), null);
  // исправный случай: то же слово ok — отметка есть
  assert.equal((await s.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'ok');
  assert.notEqual(await cardMark(s, 'EXT-20'), null);
});

test('4: partial («Принять»: запись есть, статус не сменился) ставит отметку той же формы, state null', async () => {
  const s = await setup({ status: 'Review', fail: { state: 'net' } });
  const b = (await s.press({ action: 'accept', card: 'EXT-27', q: Q })).json();
  assert.equal(b.outcome, 'partial');
  const m = await cardMark(s, 'EXT-27');
  assert.deepEqual([m.id, m.action, m.state, m.missing], [b.id, 'accept', null, false]);
  assert.match(m.text, /^частично: запись есть, статус не сменился/);
});

// Решение дирижёра (ПТ7, находка Голема на 227bb2d, Важно 1): побеждает самое позднее действие; красная держится только против
// действий старше её — новое слово под красной даёт свою отметку, его запись пришла — снова видна красная старшего
test('4: одна отметка на карточку — побеждает последнее действие, и под красной; запись нового пришла — снова красная старшего; mirror-seen — и для слов', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({}, { clock, threads: [thread(SID, { card: 'EXT-20' })] });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const cardLog = path.join(boardDir, 'EXT', 'EXT-20.log.md');
  try {
    const first = (await s.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
    // правило «последнее действие» без красной: второе слово вытесняет первое
    clock.t += 60000;
    const second = (await s.press({ action: 'go', card: 'EXT-20', q: Q })).json();
    assert.equal((await cardMark(s, 'EXT-20')).id, second.id, 'побеждает последнее действие');
    // проход зеркала между двумя действиями: после первого, до второго — красная только у первого
    fs.writeFileSync(runs, `${new Date(Date.parse('2026-10-04T12:00:10Z')).toISOString()} · начало · changed · pid 1
${new Date(Date.parse('2026-10-04T12:00:20Z')).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3
`);
    const newer = await cardMark(s, 'EXT-20');
    assert.equal(newer.id, second.id, 'второе действие новее красной первого — побеждает оно');
    assert.equal(newer.action, 'go');
    assert.deepEqual(Object.keys(newer).sort(), MARK_KEYS, 'отметка второго не красная — у слова missing и text нет');
    // проход после обоих действий: красные оба — побеждает последнее, красная второго
    fs.writeFileSync(runs, `${new Date(Date.parse('2026-10-04T12:01:10Z')).toISOString()} · начало · changed · pid 1
${new Date(Date.parse('2026-10-04T12:01:20Z')).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3
`);
    const bothRed = await cardMark(s, 'EXT-20');
    assert.equal(bothRed.id, second.id);
    assert.equal(bothRed.text, `зеркало не видит запись ${second.id}`);
    fs.writeFileSync(runs, `${new Date(Date.parse('2026-10-04T12:00:10Z')).toISOString()} · начало · changed · pid 1
${new Date(Date.parse('2026-10-04T12:00:20Z')).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3
`);
    // запись второго действия дотянута, первого — нет: снова красная первого; mirror-seen пишется для слова
    editLog(cardLog, (t) => t + `
### 2026-10-04 15:10 +03:00 · plane · коммент

**Слово Ивана · кнопка витрины · ${second.id}**: «го»
`);
    const held = await cardMark(s, 'EXT-20');
    assert.equal(held.id, first.id, 'запись второго пришла — снова красная первого');
    assert.equal(held.action, 'yes');
    assert.deepEqual(Object.keys(held).sort(), [...MARK_KEYS, 'missing', 'text'].sort(), 'красная у слова несёт missing и text');
    assert.equal(held.missing, true);
    assert.equal(held.text, `зеркало не видит запись ${first.id}`);
    await s.app.pult.tick();
    await s.app.pult.tick();
    assert.equal(s.lines().filter((l) => l.id === second.id && l.step === 'mirror-seen').length, 1, 'mirror-seen для слова');
    assert.equal(s.lines().filter((l) => l.id === first.id && l.step === 'mirror-seen').length, 0);
    assert.equal(s.lines().filter((l) => l.id === first.id && l.step === 'mirror-missing').length, 1, 'красная первого записана шагом');
    // запись первого пришла — отметка снята
    editLog(cardLog, (t) => t + `
### 2026-10-04 15:11 +03:00 · plane · коммент

**Слово Ивана · кнопка витрины · ${first.id}**: «да»
`);
    assert.equal(await cardMark(s, 'EXT-20'), null);
    await s.app.pult.tick();
    assert.equal(s.lines().filter((l) => l.id === first.id && l.step === 'mirror-seen').length, 1);
  } finally {
    if (fs.existsSync(runs)) fs.unlinkSync(runs);
    editLog(cardLog, () => logWith(Q_MD)); // доска общая для файла
  }
});

test('4: проход зеркала без записи слова — шаг mirror-missing пишется и для слова, отметка слова на месте', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({}, { clock, threads: [thread(SID, { card: 'EXT-21' })] });
  const w = (await s.press({ action: 'yes', card: 'EXT-21', q: Q })).json();
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  fs.writeFileSync(runs, `${new Date(clock.t + 1000).toISOString()} · начало · changed · pid 1\n${new Date(clock.t + 2000).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3\n`);
  try {
    await s.app.pult.tick();
    assert.equal(s.lines().filter((l) => l.id === w.id && l.step === 'mirror-missing').length, 1, 'шаг mirror-missing и для слова');
    assert.equal((await cardMark(s, 'EXT-21')).id, w.id);
  } finally { fs.unlinkSync(runs); editLog(path.join(boardDir, 'EXT', 'EXT-21.log.md'), () => logWith(Q_MD)); }
});

// Кнопки под красной (слово Ивана 05.10, §1.7 «Местная отметка»): обычная отметка — строка в «Отвечено, ждёт зеркала»,
// вне счётчика; красная «зеркало не видит запись» — строка в своей группе «Ждёт меня» и в счётчике, отметка при ней в данных
test('4: под красной строка (б)/(в) не «отвечено» — в своей группе и в счётчике, отметка красная в данных; обычная — в «Отвечено»; запись пришла — отметки нет', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({ status: 'Review' }, { clock, threads: [thread(SID, { card: 'EXT-27' })] });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const cardLog = path.join(boardDir, 'EXT', 'EXT-27.log.md');
  const pass = (from, to) => fs.writeFileSync(runs, `${new Date(from).toISOString()} · начало · changed · pid 1\n${new Date(to).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3\n`);
  const view = async () => {
    const c = await s.get('/api/ceh');
    const rowIn = (g) => c.waiting[g].find((x) => x.id === 'EXT-27') ?? null;
    const p = await s.get('/api/project/EXT');
    return { c, group: ['yes', 'review'].find((g) => rowIn(g)) ?? null, row: rowIn('yes') ?? rowIn('review'), count: c.waiting.count + c.waiting.more,
      projCount: p.waitingCount.count + p.waitingCount.more, projRow: p.waiting.find((x) => x.id === 'EXT-27' && x.group !== 'thread') ?? null };
  };
  try {
    // исходное: отметки нет — строка в своей группе, в счётчике
    const before = await view();
    assert.ok(before.row, 'у EXT-27 есть строка (б)/(в)');
    assert.equal(before.row.pultMark, null);
    assert.equal(before.row.answered, false);
    const w = (await s.press({ action: 'yes', card: 'EXT-27', q: Q })).json();
    assert.equal(w.outcome, 'ok', w.message);
    // обычная отметка: строка «отвечено», из счётчика уходит
    const plain = await view();
    assert.equal(plain.row.pultMark.id, w.id);
    assert.ok(!('missing' in plain.row.pultMark), 'обычная отметка слова — не красная');
    assert.equal(plain.row.answered, true, 'обычная отметка — «Отвечено, ждёт зеркала»');
    assert.equal(plain.count, before.count - 1, 'обычная — вне счётчика');
    assert.equal(plain.projRow.answered, true);
    assert.equal(plain.projCount, before.projCount - 1, 'окно проекта: обычная — вне счётчика');
    // проход зеркала после действия кончился, записи нет — красная
    pass(clock.t + 1000, clock.t + 2000);
    const red = await view();
    assert.equal(red.group, before.group, 'красная — в своей группе');
    assert.equal(red.row.pultMark.id, w.id);
    assert.equal(red.row.pultMark.missing, true, 'отметка красная — в данных');
    assert.equal(red.row.pultMark.text, `зеркало не видит запись ${w.id}`);
    assert.equal(red.row.answered, false, 'под красной строка не «отвечено»');
    assert.equal(red.count, before.count, 'красная — в счётчике');
    assert.equal(red.projRow.answered, false, 'окно проекта: под красной не «отвечено»');
    assert.equal(red.projRow.pultMark.missing, true);
    assert.equal(red.projCount, before.projCount, 'окно проекта: красная — в счётчике');
    // панель карточки: красная отметка вместе с данными для кнопок слов (флаги и q — те же, что без отметки)
    const card = (await s.get('/api/card/EXT-27')).pult;
    assert.equal(card.mark.missing, true);
    assert.equal(card.mark.text, `зеркало не видит запись ${w.id}`);
    assert.equal(card.enabled, true);
    assert.equal(card.words, true, 'кнопки слов под красной — по флагу words');
    assert.ok(card.q && typeof card.q.at === 'string', 'q для POST слов есть под красной');
    // запись пришла — отметки нет, строка в своей группе и в счётчике
    editLog(cardLog, (t) => t + `\n### 2026-10-04 15:10 +03:00 · plane · коммент\n\n**Слово Ивана · кнопка витрины · ${w.id}**: «да»\n`);
    const seen = await view();
    assert.equal(seen.row.pultMark, null, 'запись пришла — отметки нет');
    assert.equal(seen.row.answered, false);
    assert.equal(seen.count, before.count);
    assert.equal((await s.get('/api/card/EXT-27')).pult.mark, null);
  } finally {
    if (fs.existsSync(runs)) fs.unlinkSync(runs);
    editLog(cardLog, () => logWith(Q_MD));
  }
});

// Находка Голема на 227bb2d (Важно 1), решение дирижёра: нажатие под красной — отметка нового слова (обычная: «Отвечено», кнопок
// нет), не красная старшего; иначе через минуту снова красная с кнопками и строка в «Ждёт меня» — окно для второго слова
test('4: нажатие под красной — отметка нового слова, строка «отвечено»; его запись пришла — снова красная старшего в «Ждёт меня»; запись старшего — отметки нет', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({ status: 'Review' }, { clock, threads: [thread(SID, { card: 'EXT-27' })] });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const cardLog = path.join(boardDir, 'EXT', 'EXT-27.log.md');
  const t0 = clock.t;
  const pass = (from, to) => fs.writeFileSync(runs, `${new Date(from).toISOString()} · начало · changed · pid 1\n${new Date(to).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3\n`);
  const view = async () => {
    const c = await s.get('/api/ceh');
    const rowIn = (g) => c.waiting[g].find((x) => x.id === 'EXT-27') ?? null;
    return { group: ['yes', 'review'].find((g) => rowIn(g)) ?? null, row: rowIn('yes') ?? rowIn('review'), count: c.waiting.count + c.waiting.more,
      mark: (await s.get('/api/card/EXT-27')).pult.mark };
  };
  try {
    const before = await view();
    assert.equal(before.row.answered, false);
    const w1 = (await s.press({ action: 'yes', card: 'EXT-27', q: Q })).json();
    assert.equal(w1.outcome, 'ok', w1.message);
    pass(t0 + 1000, t0 + 2000); // проход после W1, до W2 — W1 красная
    const red = await view();
    assert.equal(red.mark.id, w1.id);
    assert.equal(red.mark.missing, true);
    assert.equal(red.row.answered, false);
    assert.equal(red.count, before.count);
    // Иван жмёт «да» под красной — W2 ok
    clock.t = t0 + 60000;
    const w2 = (await s.press({ action: 'yes', card: 'EXT-27', q: Q })).json();
    assert.equal(w2.outcome, 'ok', w2.message);
    const after = await view();
    assert.equal(after.mark.id, w2.id, 'отметка нового слова, не красная W1');
    assert.ok(!('missing' in after.mark), 'отметка W2 — обычная');
    assert.equal(after.row.pultMark.id, w2.id);
    assert.equal(after.row.answered, true, 'строка — «Отвечено, ждёт зеркала»');
    assert.equal(after.count, before.count - 1, 'вне счётчика «Цеха»');
    // пришла запись W2, W1 без записи — снова красная W1, строка в «Ждёт меня»
    editLog(cardLog, (t) => t + `\n### 2026-10-04 15:10 +03:00 · plane · коммент\n\n**Слово Ивана · кнопка витрины · ${w2.id}**: «да»\n`);
    const back = await view();
    assert.equal(back.mark.id, w1.id, 'запись W2 пришла — снова красная W1');
    assert.equal(back.mark.missing, true);
    assert.equal(back.row.answered, false);
    assert.equal(back.group, before.group, 'строка в своей группе «Ждёт меня»');
    assert.equal(back.count, before.count, 'и в счётчике');
    // пришла запись W1 — отметки нет
    editLog(cardLog, (t) => t + `\n### 2026-10-04 15:11 +03:00 · plane · коммент\n\n**Слово Ивана · кнопка витрины · ${w1.id}**: «да»\n`);
    const gone = await view();
    assert.equal(gone.mark, null);
    assert.equal(gone.row.pultMark, null);
  } finally {
    if (fs.existsSync(runs)) fs.unlinkSync(runs);
    editLog(cardLog, () => logWith(Q_MD));
  }
});

// Отрицательный контроль к правилу «новее побеждает»: без нового нажатия красная держится против действия старше её.
// Старшее обычное действие при красной младшем в живых данных не бывает (проход после младшего — после и старшего), поэтому
// старшее тут — красное тоже; если новое слово не нажато — видна красная младшего, не отметка старшего
test('4: без нового нажатия красная держится против старшего действия: побеждает младшее (красное), не старшее', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({ status: 'Review' }, { clock, threads: [thread(SID, { card: 'EXT-27' })] });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const t0 = clock.t;
  try {
    const w0 = (await s.press({ action: 'yes', card: 'EXT-27', q: Q })).json();
    clock.t = t0 + 60000;
    const w1 = (await s.press({ action: 'go', card: 'EXT-27', q: Q })).json();
    assert.deepEqual([w0.outcome, w1.outcome], ['ok', 'ok']);
    fs.writeFileSync(runs, `${new Date(t0 + 61000).toISOString()} · начало · changed · pid 1\n${new Date(t0 + 62000).toISOString()} · конец · changed · pid 1 · код 0 · 1 с · запросов 3\n`);
    const m = (await s.get('/api/card/EXT-27')).pult.mark;
    assert.equal(m.id, w1.id, 'младшая красная, не старшее действие');
    assert.equal(m.missing, true);
    const row = (await s.get('/api/ceh')).waiting.review.find((x) => x.id === 'EXT-27');
    assert.equal(row.answered, false, 'под красной — «Ждёт меня»');
  } finally {
    if (fs.existsSync(runs)) fs.unlinkSync(runs);
  }
});

// ---------------- 5. отметка строки (а) ----------------

test('5: после «Ответить» строка (а) несёт pultMark той же формы (ключ — session и q.uuid), ring «положено»; чужая строка и новый вопрос — без отметки', async () => {
  const s = await setup({}, { threads: [waitingThread(SID), waitingThread(SID2)], sessions: [sessionOf(SID, 'Слышишь?'), sessionOf(SID2, 'Слышишь?', uuid(902))] });
  assert.equal((await s.rowOf(SID)).pultMark, null, 'до ответа — null');
  const b = (await s.press({ action: 'reply', session: SID, q: QT, text: 'слышу' })).json();
  assert.equal(b.outcome, 'ok', b.message);
  const m = (await s.rowOf(SID)).pultMark;
  assert.deepEqual(Object.keys(m).sort(), MARK_KEYS);
  assert.deepEqual([m.id, m.action, m.state, m.ring], [b.id, 'reply', null, 'положено']);
  assert.equal((await s.rowOf(SID2)).pultMark, null, 'другой тред — без отметки');
  // тред задал новый вопрос — у строки новый uuid, отметка к ней не липнет
  s.live.sess = [sessionOf(SID, 'Новый вопрос?', uuid(903)), sessionOf(SID2, 'Слышишь?', uuid(902))];
  assert.equal((await s.rowOf(SID)).pultMark, null);
  // строка остаётся в «Ждёт меня» и в счётчике: отметка строку не убирает
  assert.ok((await s.get('/api/ceh')).waiting.threads.some((x) => x.sessionId === SID));
});

test('5: ring отметки строки (а) идёт по 2.8: «прочитано» — форма звонка есть в журнале треда; последняя просьба — по общему правилу (новее по at)', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({}, { clock, threads: [waitingThread(SID)], sessions: [sessionOf(SID, 'Слышишь?')] });
  const one = (await s.press({ action: 'reply', session: SID, q: QT, text: 'раз' })).json();
  clock.t += 120000;
  const two = (await s.press({ action: 'reply', session: SID, q: QT, text: 'два' })).json();
  const m = (await s.rowOf(SID)).pultMark;
  assert.equal(m.id, two.id, 'побеждает последняя просьба');
  assert.notEqual(m.id, one.id);
  // тред прочитал звонок второй просьбы (журнал: rings) — статус «прочитано»
  s.live.sess = [sessionOf(SID, 'Слышишь?', QU, { rings: { [two.id]: '2026-10-04T12:03:00.000Z' } })];
  assert.equal((await s.rowOf(SID)).pultMark.ring, 'прочитано');
  // отрицательный контроль: «прочитано» первой просьбы не делает отметку «прочитано»
  s.live.sess = [sessionOf(SID, 'Слышишь?', QU, { rings: { [one.id]: '2026-10-04T12:03:00.000Z' } })];
  assert.equal((await s.rowOf(SID)).pultMark.ring, 'положено');
});

test('5: ответ, отказанный или не доставленный (error), отметки строки не ставит', async () => {
  const s = await setup({}, { threads: [waitingThread(SID)], sessions: [sessionOf(SID, 'Слышишь?')] });
  const bad = (await s.press({ action: 'reply', session: SID, q: { uuid: uuid(999), at: QT_AT }, text: 'мимо' })).json();
  assert.equal(bad.outcome, 'refused');
  assert.equal((await s.rowOf(SID)).pultMark, null);
});

// ---------------- 5б. контракт «го <ID>» из строки (а) ----------------

test('контракт «го <ID>»: reply с текстом «го <ID>», session и q.uuid строки; card у reply — карточка треда или ничего, поле card строки сервер не принимает как карточку reply', async () => {
  const text = 'Принимаешь EXT-21?';
  // тред без карточки: reply без card — запись на доске нет, звонок «без карточки»; со строковой card — отказ thread-card
  const s = await setup({}, { threads: [waitingThread(SID)], sessions: [sessionOf(SID, text)] });
  const row = await s.rowOf(SID);
  assert.equal(row.card, 'EXT-21');
  const wrong = (await s.press({ action: 'reply', session: SID, card: row.card, q: { uuid: row.uuid, at: QT_AT }, text: `го ${row.card}` })).json();
  assert.equal(wrong.outcome, 'refused', 'card строки у reply — не карточка треда');
  assert.equal(s.lines().at(-1).refusal, 'thread-card');
  assert.equal(s.pl().calls, undefined, 'Plane не звался');
  const right = (await s.press({ action: 'reply', session: SID, q: { uuid: row.uuid, at: QT_AT }, text: `го ${row.card}` })).json();
  assert.equal(right.outcome, 'ok', right.message);
  const asked = s.lines().find((l) => l.id === right.id && l.step === 'asked');
  assert.equal(asked.card, undefined, 'у reply card нет');
  assert.equal(asked.text, 'го EXT-21');
  assert.equal(s.pl().calls, undefined, 'записи на доске нет');
  // тред с карточкой EXT-20: reply с card треда — запись на EXT-20 с текстом «го EXT-21»; поле card строки в запись не попадает
  const t2 = await setup({}, { threads: [waitingThread(SID, { card: 'EXT-20' })], sessions: [sessionOf(SID, text)] });
  const ok = (await t2.press({ action: 'reply', session: SID, card: 'EXT-20', q: { uuid: row.uuid, at: QT_AT }, text: 'го EXT-21' })).json();
  assert.equal(ok.outcome, 'ok', ok.message);
  const html = t2.pl().comments.at(-1).html;
  assert.ok(html.includes('<p>го EXT-21</p>'), html);
  assert.equal(t2.lines().find((l) => l.id === ok.id && l.step === 'asked').card, 'EXT-20');
});

test('bdeal — в теле ответа need-confirm (Б-дело отличается флагом, не началом message); у выбора треда без Б-дела поля нет', async () => {
  const bd = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-22' })] });
  const b = (await bd.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  assert.equal(b.outcome, 'need-confirm');
  assert.equal(b.bdeal, 'слово «сливай»');
  assert.equal(bd.lines().find((l) => l.id === b.id && l.step === 'need-confirm').bdeal, b.bdeal, 'как в actions.log');
  const pick = await setup({}, { threads: [thread(SID), thread(SID2)] });
  const p = (await pick.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(p.outcome, 'need-confirm');
  assert.ok(!('bdeal' in p), 'выбор треда — не Б-дело');
});

// повтор того же intentId (§1.1 п.3): в том же процессе — прежний исход; после рестарта — исход по actions.log
// (restoreIntents, routes.mjs) — bdeal в теле тот же, что у первого щелчка; у выбора треда без Б-дела поля нет и в повторе
test('bdeal — повтор того же intentId (в том же процессе и после рестарта по actions.log) отдаёт тот же bdeal; без Б-дела — поля нет', async () => {
  const bodyB = { action: 'merge', card: 'EXT-22', q: Q };
  const bd = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-22' })] });
  const iB = nextIntent();
  const b = (await bd.press(bodyB, iB)).json();
  assert.deepEqual([b.outcome, b.bdeal], ['need-confirm', 'слово «сливай»']);
  const same = (await bd.press(bodyB, iB)).json();
  assert.deepEqual([same.id, same.outcome, same.bdeal], [b.id, 'need-confirm', 'слово «сливай»'], 'повтор в том же процессе');
  const re = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-22' })], data: bd.data });
  const r = (await re.press(bodyB, iB)).json();
  assert.equal(r.id, b.id, 'после рестарта — тот же id, не новое действие');
  assert.equal(r.outcome, 'need-confirm');
  assert.match(r.message, /\(по журналу\)/, 'исход восстановлен по actions.log');
  assert.equal(r.bdeal, 'слово «сливай»', 'bdeal в повторе после рестарта');
  assert.deepEqual(r.confirm, b.confirm);
  assert.equal(re.lines().filter((l) => l.step === 'asked').length, 1, 'повтор не завёл второго действия');
  // отрицательный контроль: выбор треда без Б-дела — в повторе после рестарта поля bdeal нет
  const bodyP = { action: 'yes', card: 'EXT-20', q: Q };
  const pick = await setup({}, { threads: [thread(SID), thread(SID2)] });
  const iP = nextIntent();
  const p = (await pick.press(bodyP, iP)).json();
  assert.equal(p.outcome, 'need-confirm');
  const reP = await setup({}, { threads: [thread(SID), thread(SID2)], data: pick.data });
  const rp = (await reP.press(bodyP, iP)).json();
  assert.deepEqual([rp.id, rp.outcome], [p.id, 'need-confirm']);
  assert.match(rp.message, /\(по журналу\)/);
  assert.ok(!('bdeal' in rp), 'выбор треда без Б-дела — поля нет и в повторе');
});

// Б-дело при нескольких живых тредах без pick (words.mjs): одно подтверждение несёт и bdeal, и candidates; без Б — только candidates
test('bdeal — Б-дело при нескольких тредах без pick: флаг в теле и в actions.log, кандидаты есть; без Б-дела у того же выбора флага нет', async () => {
  const s = await setup({ status: 'Review' }, { threads: [thread(SID), thread(SID2)] });
  const b = (await s.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  assert.equal(b.outcome, 'need-confirm');
  assert.equal(b.bdeal, 'слово «сливай»', 'Б-дело с выбором треда — флаг есть');
  assert.deepEqual(b.confirm.candidates.map((c) => c.sessionId).sort(), [SID, SID2].sort(), 'кандидаты — оба треда');
  assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'need-confirm').bdeal, 'слово «сливай»', 'как в actions.log');
  const d = (await s.press({ action: 'deploy', card: 'EXT-22', q: Q })).json();
  assert.deepEqual([d.outcome, d.bdeal], ['need-confirm', 'слово «выкатывай»']);
  // отрицательный контроль: те же два треда, слово без Б-дела — кандидаты есть, флага нет
  const p = (await s.press({ action: 'yes', card: 'EXT-22', q: Q })).json();
  assert.equal(p.outcome, 'need-confirm');
  assert.equal(p.confirm.candidates.length, 2);
  assert.ok(!('bdeal' in p), 'без Б-дела — флага нет');
  assert.ok(!('bdeal' in s.lines().find((l) => l.id === p.id && l.step === 'need-confirm')));
});

test('rowMarks: отметка при ok и partial, не при refused/error (юнит по строкам журнала)', () => {
  const line = (id, step, outcome, extra = {}) => ({ id, step, at: '2026-10-05T10:00:00+03:00', action: 'reply', result: { outcome, record: id }, ...extra });
  const ask = (id, u) => ({ id, step: 'asked', at: '2026-10-05T10:00:00+03:00', action: 'reply', session: SID, q: { uuid: u, at: QT_AT } });
  const lines = [ask('W-1', 'u1'), line('W-1', 'partial', 'partial'), ask('W-2', 'u2'), line('W-2', 'done', 'ok'), ask('W-3', 'u3'), line('W-3', 'error', 'error'), ask('W-4', 'u4'), { id: 'W-4', step: 'refused' }];
  const m = rowMarks({ lines });
  assert.deepEqual([...m.keys()].sort(), [`${SID}|u1`, `${SID}|u2`]);
});

// хвост ПТ7 (EXT-70, п.1 ТЗ): строка «Моих слов» несёт признак Б-дела шага need-confirm — bdeal как в actions.log; страница по
// нему отличает «ждёт второго щелчка» (Б-дело) от «ждёт выбора треда» (несколько тредов без pick, Б нет)
test('GET /api/actions: строка need-confirm несёт bdeal шага need-confirm (как в actions.log); выбор треда без Б-дела — bdeal null', async () => {
  const s = await setup({ status: 'Review' }, { threads: [thread(SID), thread(SID2)] });
  const b = (await s.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  const p = (await s.press({ action: 'yes', card: 'EXT-22', q: Q })).json();
  assert.deepEqual([b.outcome, p.outcome], ['need-confirm', 'need-confirm']);
  const rows = await s.get('/api/actions');
  const rb = rows.find((x) => x.id === b.id);
  const rp = rows.find((x) => x.id === p.id);
  assert.equal(rb.status, 'need-confirm');
  assert.equal(rb.bdeal, 'слово «сливай»', 'Б-дело — признак из шага need-confirm');
  assert.equal(rb.bdeal, s.lines().find((l) => l.id === b.id && l.step === 'need-confirm').bdeal, 'как в actions.log');
  assert.equal(rp.status, 'need-confirm');
  assert.equal(rp.bdeal, null, 'выбор треда без Б-дела — признака нет');
});
