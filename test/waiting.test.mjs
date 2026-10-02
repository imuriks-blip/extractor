// В4 (EXT-28): «Ждёт меня» (2.4), такт без ответа, обрыв PARTIAL, старые правила, запись субагента в доску (2.3),
// возраст зеркала (В-5); гейт п.6 целиком. Доска — временная копия в живой форме (шапка и журнал §1.2/§1.4 спеки
// доски), журнал разбирается parseLog доски. Ожидаемые значения — из данных, положенных в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { newSessionState, feedSession, newAgentState, feedAgent, agentSummary } from '../lib/journal-parse.mjs';
import { buildWaiting, waitingThreads, buildMarks } from '../lib/waiting.mjs';
import { parseChronicle, createRulesMoment } from '../lib/rules-moment.mjs';
import { BOARD_LIB, tmpDir, makeBoard, cardText, gitInitCommit, gitCommitAll, git } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const RULES = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).boardWriteTools;

const T0 = Date.parse('2026-10-02T10:00:00Z');
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const TH = { taktYellowMin: 60, taktRedMin: 180, waitingOverDayHours: 24 };
const iso = (ms) => new Date(ms).toISOString();
// заголовок записи журнала карточки: время в +03:00 (как пишет зеркало)
function entry(ms, kind, body) {
  const d = new Date(ms + 3 * 3600000).toISOString();
  return `### ${d.slice(0, 10)} ${d.slice(11, 16)} +03:00 · plane · ${kind}\n\n${body}\n\n`;
}
function writeLog(dir, id, entries) {
  fs.writeFileSync(path.join(dir, id.split('-')[0], `${id}.log.md`), entries.join(''));
}

async function boardWith(cards, logs) {
  const dir = makeBoard(tmpDir('b4-'), { codes: ['EXT', 'CAR'], cards });
  for (const [id, entries] of Object.entries(logs)) writeLog(dir, id, entries);
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog });
  await board.init();
  return { dir, board };
}

// ---------- (б) «нужно твоё да» и (в) Review — гейт п.6 ----------

test('гейт 6: Review с последней записью «ждёт «сливай»» — в (б), не в (в); запись-решение последней — в (б) нет; исправный Review — в (в)', async () => {
  const { board } = await boardWith([
    { id: 'EXT-1', status: 'review', title: 'Слить витрину' },
    { id: 'EXT-2', status: 'in-progress', title: 'Решено' },
    { id: 'EXT-3', status: 'review', title: 'Кто решил' },
    { id: 'EXT-4', status: 'review', title: 'Просто Review' },
  ], {
    'EXT-1': [entry(T0 - 3 * DAY, '▶', '▶ выдан: terminus · ext-1 · В4'), entry(T0 - 2 * 60 * MIN, 'коммент', 'Ветка готова, Голем без «Критично». Ждёт «сливай».')],
    'EXT-2': [entry(T0 - 5 * 60 * MIN, 'коммент', 'Развилка: А или Б?'), entry(T0 - 60 * MIN, 'коммент', 'слово Ивана «сливай» 01.10, слито')],
    'EXT-3': [entry(T0 - 60 * MIN, 'решение', 'Выкатывай.\nКто решил: Иван')],
    'EXT-4': [entry(T0 - 30 * MIN, 'коммент', 'Готово, проверено.')],
  });
  const w = buildWaiting({ threads: [], board, now: T0 });
  assert.deepEqual(w.yes.map((r) => [r.id, r.mark]), [['EXT-1', 'сливай']]);
  assert.equal(w.yes[0].since, iso(T0 - 2 * 60 * MIN), 'возраст — от последней записи');
  assert.deepEqual(w.review.map((r) => r.id).sort(), ['EXT-3', 'EXT-4'], 'EXT-1 только в (б); решение EXT-3 — в Review');
  assert.equal(w.count, 1, 'крупное число = (а) + (б)');
  assert.equal(w.more, 2, '«+ N посмотреть» = (в)');
});

test('гейт 6: зеркало — статус сменился (review → in-progress), новых записей нет — карточка остаётся в (б); новая запись без маркера — снимает', async () => {
  const { dir, board } = await boardWith([{ id: 'EXT-1', status: 'review', title: 'Слить' }], {
    'EXT-1': [entry(T0 - 2 * 60 * MIN, 'коммент', 'Ждёт «сливай».')],
  });
  assert.deepEqual(buildWaiting({ threads: [], board, now: T0 }).yes.map((r) => r.id), ['EXT-1']);
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-1.md'), cardText({ id: 'EXT-1', status: 'in-progress', title: 'Слить', updated: '2026-10-02T12:30+03:00' }));
  gitCommitAll(dir, 'статус');
  await board.refresh();
  assert.deepEqual(buildWaiting({ threads: [], board, now: T0 }).yes.map((r) => r.id), ['EXT-1'], 'смена статуса (б) не снимает');
  writeLog(dir, 'EXT-1', [entry(T0 - 2 * 60 * MIN, 'коммент', 'Ждёт «сливай».'), entry(T0 - 10 * MIN, 'коммент', 'Принято, ушло в работу.')]);
  gitCommitAll(dir, 'запись');
  await board.refresh();
  assert.deepEqual(buildWaiting({ threads: [], board, now: T0 }).yes, [], 'новая последняя запись без маркера — снимает');
});

test('(б): метка — Б / развилка / выкатывай / сливай, первое сработавшее; без учёта регистра; закрытая карточка — нет; предел 14 дней (В-4) — Review старше остаётся в (в)', async () => {
  const { board } = await boardWith([
    { id: 'EXT-1', status: 'ready', title: 'Б-метка', markB: true },
    { id: 'EXT-2', status: 'in-progress', title: 'Развилка', body: '' },
    { id: 'EXT-3', status: 'ready', title: 'Выкатка' },
    { id: 'EXT-4', status: 'done', title: 'Закрыта' },
    { id: 'EXT-5', status: 'review', title: 'Старая' },
    { id: 'CAR-6', status: 'ready', title: '13 дней' },
  ], {
    'EXT-1': [entry(T0 - 3 * 60 * MIN, 'коммент', 'Сливай после проверки.')],
    'EXT-2': [entry(T0 - 4 * 60 * MIN, 'коммент', 'РАЗВИЛКА: выкатывай сейчас или сливай потом?')],
    'EXT-3': [entry(T0 - 5 * 60 * MIN, 'коммент', 'Выкатывай?')],
    'EXT-4': [entry(T0 - 6 * 60 * MIN, 'коммент', 'сливай')],
    'EXT-5': [entry(T0 - 15 * DAY, 'коммент', 'сливай?')],
    'CAR-6': [entry(T0 - 13 * DAY, 'коммент', 'сливай?')],
  });
  const w = buildWaiting({ threads: [], board, now: T0 });
  assert.deepEqual(w.yes.map((r) => [r.id, r.mark]), [['EXT-1', 'Б'], ['EXT-2', 'развилка'], ['EXT-3', 'выкатывай'], ['CAR-6', 'сливай']], 'свежие сверху');
  assert.deepEqual(w.review.map((r) => r.id), ['EXT-5'], 'Review — все, без предела; старше 14 дней в (б) не попала');
  assert.ok(w.yes.every((r) => typeof r.key === 'string' && r.key.startsWith(`${r.id}|`)), 'ключ уведомления (б) — номер + заголовок последней записи');
  assert.ok(w.yes[1].key.includes('· коммент'));
});

// ---------- (а) тред ждёт ответа ----------

test('(а): вопрос (Б) — абзац с «Трурль: », AskUserQuestion — текст вопроса, разрешение — без текста, от statusUpdatedAt; «ждёт больше суток»; старые сверху; ключи', () => {
  const sA = 'aaaaaaaa-0000-4000-8000-000000000001';
  const sB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const sC = 'cccccccc-0000-4000-8000-000000000003';
  const sD = 'dddddddd-0000-4000-8000-000000000004';
  const threads = [
    { sessionId: sA, title: 'EXT', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(T0) },
    { sessionId: sB, title: 'CAR', project: 'CAR', projectBy: 'title', state: 'waiting', waitingKind: 'askUserQuestion', statusUpdatedAt: iso(T0) },
    { sessionId: sC, title: 'Без кода', project: null, projectBy: null, state: 'waiting', waitingKind: 'permission', statusUpdatedAt: iso(T0 - 25 * 60 * MIN) },
    { sessionId: sD, title: 'Свободен', project: 'EXT', projectBy: 'title', state: 'idle', waitingKind: null, statusUpdatedAt: iso(T0) },
  ];
  const sessions = [
    { sessionId: sA, thread: { q: { text: 'Сливаю — да?', uuid: 'u-a', at: iso(T0 - 30 * MIN) } } },
    { sessionId: sB, thread: { ask: { text: 'Какой вариант?', uuid: 'u-b', at: iso(T0 - 2 * 60 * MIN) } } },
    { sessionId: sC, thread: {} },
    { sessionId: sD, thread: {} },
  ];
  const rows = waitingThreads({ threads, sessions, now: T0, thresholds: TH });
  assert.deepEqual(rows.map((r) => r.sessionId), [sC, sB, sA], 'старые сверху; свободный — не в (а)');
  assert.equal(rows[2].text, 'Трурль: Сливаю — да?');
  assert.equal(rows[2].key, `${sA}|u-a`);
  assert.equal(rows[1].text, 'Трурль: Какой вариант?');
  assert.equal(rows[1].since, iso(T0 - 2 * 60 * MIN));
  assert.equal(rows[0].text, 'ждёт разрешения на команду');
  assert.equal(rows[0].since, iso(T0 - 25 * 60 * MIN));
  assert.equal(rows[0].key, `${sC}|${iso(T0 - 25 * 60 * MIN)}`, 'разрешение: sessionId + statusUpdatedAt');
  assert.deepEqual(rows.map((r) => r.overDay), [true, false, false]);
  const long = waitingThreads({ threads: [threads[0]], sessions: [{ sessionId: sA, thread: { q: { text: 'я'.repeat(300), uuid: 'u', at: iso(T0) } } }], now: T0, thresholds: TH });
  assert.equal(long[0].text.length, 'Трурль: '.length + 160, 'до 160 знаков');
  const w = buildWaiting({ threads: rows, board: { cardsList: () => [] }, now: T0 });
  assert.equal(w.count, 3);
});

test('(а): незнакомое waitingFor — причина «?», строка есть', () => {
  const sid = 'eeeeeeee-0000-4000-8000-000000000005';
  const rows = waitingThreads({ threads: [{ sessionId: sid, title: 'X', project: null, projectBy: null, state: 'waiting', waitingKind: '?', statusUpdatedAt: iso(T0 - MIN) }], sessions: [], now: T0, thresholds: TH });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, '?');
  assert.equal(rows[0].since, iso(T0 - MIN));
});

test('разбор журнала: (Б) — абзац, uuid и время сохраняются; слово Ивана снимает; AskUserQuestion — текст вопроса', () => {
  const st = newSessionState();
  feedSession(st, { type: 'assistant', uuid: 'u1', timestamp: iso(T0 - 10 * MIN), message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Сделал.\n\nСливаю — да?' }] } });
  assert.deepEqual(st.thread.q, { text: 'Сливаю — да?', uuid: 'u1', at: iso(T0 - 10 * MIN) });
  feedSession(st, { type: 'user', timestamp: iso(T0 - 5 * MIN), message: { role: 'user', content: 'да' } });
  assert.equal(st.thread.q, null);
  feedSession(st, { type: 'assistant', uuid: 'u2', timestamp: iso(T0 - 4 * MIN), message: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: { questions: [{ question: 'Какой вариант?', header: 'h', multiSelect: false, options: [] }] } }] } });
  assert.deepEqual(st.thread.ask, { text: 'Какой вариант?', uuid: 'u2', at: iso(T0 - 4 * MIN) });
});

// ---------- такт без ответа — гейт п.6 (по журналам тредов, В-16 (а)) ----------

const SID1 = '11111111-0000-4000-8000-000000000001';
const SID2 = '22222222-0000-4000-8000-000000000002';
const cardBoard = (status = { 'EXT-7': 'in-progress' }) => ({
  hasCard: (id) => id in status,
  card: (id) => (id in status ? { id, code: id.split('-')[0], status: status[id], title: 't' } : null),
});
const sess = (sid, writes, o = {}) => ({ sessionId: sid, ivan: { lastAt: null, cards: {} }, runs: [], partials: [], boardWrites: writes, thread: {}, ...o });
const w = (ms, line, refs = ['EXT-7']) => ({ at: iso(ms), refs, firstLine: line, tool: 't' });
const marksOf = (sessions, o = {}) => buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - 5 * 60 * MIN }], sessions, board: cardBoard(o.status), now: T0, thresholds: TH, ...o });

test('гейт 6: ▶ без ⏸ — 61 мин жёлтый, 181 мин красный, 59 мин — нет; агент из первой строки', () => {
  const at61 = marksOf([sess(SID1, [w(T0 - 61 * MIN, '▶ выдан: terminus · ext-7 · В4')])]).bySession[SID1];
  assert.deepEqual(at61.map((m) => [m.kind, m.level, m.card, m.agent, m.issuedAt]), [['takt', 'yellow', 'EXT-7', 'terminus', iso(T0 - 61 * MIN)]]);
  const at181 = marksOf([sess(SID1, [w(T0 - 181 * MIN, '▶ выдан: terminus · ext-7 · В4')])]).bySession[SID1];
  assert.equal(at181[0].level, 'red');
  assert.deepEqual(marksOf([sess(SID1, [w(T0 - 59 * MIN, '▶ выдан: terminus · ext-7 · В4')])]).bySession[SID1] ?? [], []);
});

test('гейт 6: дописан ⏸ (в другом треде, без двоеточия) — блока нет; исправный ▶ + ⏸ — блока нет; маркеры без двоеточия и с U+FE0F', () => {
  assert.deepEqual(marksOf([sess(SID1, [w(T0 - 200 * MIN, '▶ выдан: terminus · ext-7 · В4')]), sess(SID2, [w(T0 - 100 * MIN, '⏸ получен terminus · ext-7 · готово')])]).bySession[SID1] ?? [], []);
  assert.deepEqual(marksOf([sess(SID1, [w(T0 - 200 * MIN, '▶ выдан: terminus · a · b'), w(T0 - 190 * MIN, '⏸ получен: terminus · a · b')])]).bySession[SID1] ?? [], []);
  const open = marksOf([sess(SID1, [w(T0 - 300 * MIN, '⏸ получен: terminus · a · b'), w(T0 - 200 * MIN, '▶️ выдан terminus · a · b')])]).bySession[SID1];
  assert.equal(open[0].level, 'red', '▶ новее ⏸; маркер без двоеточия и с вариационным селектором');
});

test('такт: предел 14 дней (В-4) — ▶ 15 дней назад не показывается, 13 дней — красный; закрытая карточка — нет', () => {
  assert.deepEqual(marksOf([sess(SID1, [w(T0 - 15 * DAY, '▶ выдан: terminus · a · b')])]).bySession[SID1] ?? [], []);
  assert.equal(marksOf([sess(SID1, [w(T0 - 13 * DAY, '▶ выдан: terminus · a · b')])]).bySession[SID1][0].level, 'red');
  assert.deepEqual(marksOf([sess(SID1, [w(T0 - 200 * MIN, '▶ выдан: terminus · a · b')])], { status: { 'EXT-7': 'done' } }).bySession[SID1] ?? [], []);
});

test('такт под закрытым тредом — В-6 (б): строка «тред закрыт» с проектом карточки, на живых тредах — нет', () => {
  const m = marksOf([sess(SID2, [w(T0 - 200 * MIN, '▶ выдан: terminus · a · b')])]);
  assert.equal(m.bySession[SID2], undefined);
  assert.deepEqual(m.closed.map((c) => [c.sessionId, c.project, c.closed, c.marks[0].kind]), [[SID2, 'EXT', true, 'takt']]);
});

test('разбор: запись на доску с маркером без двоеточия — первая строка как есть; упавший вызов такта не открывает', () => {
  const st = newSessionState();
  const call = (id, html) => feedSession(st, { type: 'assistant', timestamp: iso(T0 - 70 * MIN), message: { id: `m${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'mcp__plane__create_work_item_comment', input: { work_item_id: 'EXT-7', comment_html: html } }] } }, { rules: RULES });
  const res = (id, isError) => feedSession(st, { type: 'user', timestamp: iso(T0 - 69 * MIN), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } }, { rules: RULES });
  call('c1', '<p>▶ выдан terminus · a · b</p>'); res('c1', false);
  call('c2', '<p>⏸ получен: terminus · a · b</p>'); res('c2', true);
  const m = buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - DAY }], sessions: [sess(SID1, st.boardWrites)], board: cardBoard(), now: T0, thresholds: TH });
  assert.equal(m.bySession[SID1][0].level, 'yellow', 'упавший ⏸ такт не закрыл');
});

// ---------- обрыв PARTIAL: блок и снятие словом Ивана (В-3 (а)) ----------

const run = { agentId: 'a1', agentType: 'terminus', cards: ['CAR-9', 'EXT-7'], starts: [iso(T0 - 3 * 60 * MIN)], lastText: 'Сделал половину.', left: 'Осталось: тесты', alive: false };
const partialSess = (sid, ivanLastAt) => sess(sid, [], { ivan: { lastAt: ivanLastAt, cards: {} }, runs: [run], partials: [{ agentId: 'a1', at: iso(T0 - 60 * MIN), limit: 90, where: 'Agent' }] });

test('PARTIAL: блок — агент, карточка из ТЗ, время, сделано (коммиты), последний текст, осталось, причина; ждёт твоего слова', () => {
  const m = marksOf([partialSess(SID1, iso(T0 - 2 * 60 * MIN))], { commitsOf: () => [{ hash: 'abc1234', subject: 'тема' }] });
  const [p] = m.bySession[SID1];
  assert.equal(p.kind, 'partial');
  assert.equal(p.who, 'Терминус');
  assert.equal(p.card, 'EXT-7', 'первая карточка из ТЗ, которая есть на доске');
  assert.equal(p.endedAt, iso(T0 - 60 * MIN));
  assert.equal(p.turnLimit, 90);
  assert.deepEqual(p.done, [{ hash: 'abc1234', subject: 'тема' }]);
  assert.equal(p.lastText, 'Сделал половину.');
  assert.equal(p.left, 'Осталось: тесты');
  assert.equal(p.canContinue, true);
  assert.equal(p.waitingWord, true);
  assert.deepEqual(marksOf([partialSess(SID1, null)], { commitsOf: () => [] }).bySession[SID1][0].done, [], 'коммитов нет — пустой список');
});

test('PARTIAL снимается сообщением Ивана после обрыва — текстом и картинкой; сообщение до обрыва не снимает', () => {
  assert.deepEqual(marksOf([partialSess(SID1, iso(T0 - 30 * MIN))]).bySession[SID1] ?? [], []);
  // через разбор: обрыв в результате Agent, затем картинка без текста
  const st = newSessionState();
  feedSession(st, { type: 'assistant', timestamp: iso(T0 - 4 * 60 * MIN), message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ta', name: 'Agent', input: { prompt: 'Такт EXT-7, ориентир ~50 ходов', subagent_type: 'terminus', description: 'В4' } }] } });
  feedSession(st, { type: 'user', timestamp: iso(T0 - 60 * MIN), toolUseResult: { status: 'completed', agentId: 'a1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ta', content: [{ type: 'text', text: 'Agent stopped at its 90-turn limit.\nagentId: a1' }] }] } });
  const live = () => buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - DAY }], sessions: [sess(SID1, [], { ivan: st.ivan, runs: Object.values(st.runs).map((r) => ({ ...r, lastText: null, left: null })), partials: st.partials })], board: cardBoard(), now: T0, thresholds: TH }).bySession[SID1] ?? [];
  assert.equal(live().length, 1, 'обрыв виден');
  feedSession(st, { type: 'user', timestamp: iso(T0 - 10 * MIN), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
  assert.deepEqual(live(), [], 'картинка без текста — слово Ивана, блок снят');
});

test('PARTIAL у закрытого треда — строкой «тред закрыт» (В-6 (б)) с проектом карточки', () => {
  const m = marksOf([partialSess(SID2, null)]);
  assert.deepEqual(m.closed.map((c) => [c.sessionId, c.project, c.marks[0].kind]), [[SID2, 'EXT', 'partial']]);
});

test('разбор субагента: последний текст (200 знаков), строка «осталось:», успешные записи на доску', () => {
  const st = newAgentState();
  feedAgent(st, { type: 'assistant', timestamp: iso(T0 - 9 * MIN), message: { id: 'x1', content: [{ type: 'text', text: 'Сделано много.\nОсталось: тесты витрины\nконец' }] } }, { rules: RULES });
  feedAgent(st, { type: 'assistant', timestamp: iso(T0 - 8 * MIN), message: { id: 'x2', content: [{ type: 'tool_use', id: 'w1', name: 'mcp__plane__create_work_item_comment', input: { work_item_id: 'EXT-7', comment_html: '<p>коммент</p>' } }] } }, { rules: RULES });
  feedAgent(st, { type: 'user', timestamp: iso(T0 - 8 * MIN), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }, { rules: RULES });
  feedAgent(st, { type: 'assistant', timestamp: iso(T0 - 7 * MIN), message: { id: 'x3', content: [{ type: 'text', text: 'ю'.repeat(300) + '\n- **Осталось:** тесты витрины' }] } }, { rules: RULES });
  const s = agentSummary(st);
  assert.equal(s.lastText, 'ю'.repeat(200), 'последний текст — первые 200 знаков');
  assert.equal(s.left, '- **Осталось:** тесты витрины', 'строка «осталось» — из последнего текста');
  feedAgent(st, { type: 'assistant', timestamp: iso(T0 - 6 * MIN), message: { id: 'x4', content: [{ type: 'text', text: 'Итог без остатка.' }] } }, { rules: RULES });
  assert.equal(agentSummary(st).left, null, 'в последнем тексте строки нет — «агент не указал»');
  assert.deepEqual(s.boardWrites.map((x) => [x.at, x.refs[0]]), [[iso(T0 - 8 * MIN), 'EXT-7']]);
});

test('запись субагента в доску (В-15 (а)) — красная пометка под живым тредом; старше 14 дней — нет', () => {
  const r = { agentId: 'a2', agentType: 'golem', cards: [], starts: [], alive: true, boardWrites: [{ at: iso(T0 - 20 * MIN), refs: ['EXT-7'], firstLine: 'x' }, { at: iso(T0 - 20 * DAY), refs: ['EXT-7'], firstLine: 'y' }] };
  const m = marksOf([sess(SID1, [], { runs: [r] })]).bySession[SID1];
  assert.deepEqual(m.map((x) => [x.kind, x.who, x.card, x.at]), [['subagentWrite', 'Голем', 'EXT-7', iso(T0 - 20 * MIN)]]);
});

// ---------- старые правила (2.3) ----------

test('хроника: последняя строка «· правила обновлены:» — дата и хеши последнего сегмента; строка без «·» перед словами — не в счёт', () => {
  const r = parseChronicle([
    { name: '2026-09.md', text: '24.09 · портал · пост; правила обновлены: x · INFRA-71 · adaee7f\n25.09 · цех · правила обновлены: список · INFRA-74 · 2dad5d9\n' },
    { name: '2026-10.md', text: '01.10 · цех · правила обновлены: реестр · EXT-6 · ed2012b (~/.claude), 6731704\n02.10 · витрина · В3 слита\n' },
  ]);
  assert.deepEqual(r, { year: 2026, month: 10, day: 1, hashes: ['ed2012b', '6731704'] });
  assert.equal(parseChronicle([{ name: '2026-09.md', text: '24.09 · портал · пост; правила обновлены: x · INFRA-71 · adaee7f\n' }]), null);
});

test('старые правила: время — по коммиту из хеша (git log репозитория); без хеша — по дате строки; тред до — пометка, после — свежий', async () => {
  const repo = tmpDir('vault-');
  fs.writeFileSync(path.join(repo, 'a.md'), 'x');
  const full = gitInitCommit(repo);
  const commitAt = Date.parse(git(repo, 'log', '-1', '--format=%cI', full).trim());
  const chron = tmpDir('chron-');
  fs.writeFileSync(path.join(chron, '2026-10.md'), `01.10 · цех · правила обновлены: правка · EXT-6 · ${full.slice(0, 7)}\n`);
  const rm = createRulesMoment({ dir: chron, git: createGitRead(), repos: [tmpDir('empty-'), repo] });
  await rm.refresh();
  assert.equal(Date.parse(rm.get().at), commitAt);
  assert.equal(rm.get().by, 'commit');
  fs.writeFileSync(path.join(chron, '2026-10.md'), '01.10 · цех · правила обновлены: правка · EXT-6\n');
  fs.utimesSync(path.join(chron, '2026-10.md'), new Date(), new Date(Date.now() + 5000));
  await rm.refresh();
  assert.equal(rm.get().at, new Date(2026, 9, 1).toISOString());
  assert.equal(rm.get().by, 'date');

  const rulesAt = iso(T0 - 60 * MIN);
  const old = buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - 2 * 60 * MIN }], sessions: [], board: cardBoard(), now: T0, thresholds: TH, rulesAt });
  assert.deepEqual(old.bySession[SID1], [{ kind: 'oldRules', rulesUpdatedAt: rulesAt }]);
  const fresh = buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - 30 * MIN }], sessions: [], board: cardBoard(), now: T0, thresholds: TH, rulesAt });
  assert.equal(fresh.bySession[SID1], undefined);
  assert.equal(fresh.rulesFresh[SID1], true);
  assert.equal(old.rulesFresh[SID1], false);
});

// ---------- возраст зеркала (В-5) ----------

test('зеркало: «доска: зеркало Plane от ДД.ММ ЧЧ:ММ» из .mirror/status.json → lastOk; нет файла — null', async () => {
  const { dir, board } = await boardWith([], {});
  assert.equal(board.mirrorStatus(), null);
  fs.mkdirSync(path.join(dir, '.mirror'));
  const lastOk = '2026-10-01T18:38:24.185Z';
  fs.writeFileSync(path.join(dir, '.mirror', 'status.json'), JSON.stringify({ at: lastOk, kind: 'full', lastOk }));
  const d = new Date(lastOk);
  const p2 = (n) => String(n).padStart(2, '0');
  assert.deepEqual(board.mirrorStatus(), { lastOkAt: lastOk, label: `доска: зеркало Plane от ${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}` });
});

test('PARTIAL «сделано»: коммиты репозиториев проекта за заход (git log через обёртку); до ответа — null, потом из кэша', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = tmpDir('proj-');
  const commit = (msg, when) => {
    fs.writeFileSync(path.join(repo, `${msg}.txt`), msg);
    const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    execFileSync('git', ['-C', repo, 'add', '.'], { env, windowsHide: true });
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], { env, windowsHide: true });
    return git(repo, 'rev-parse', '--short=7', 'HEAD').trim();
  };
  git(repo, 'init', '-q', '-b', 'main');
  commit('до захода', '2026-10-02T06:00:00Z');
  const inside = commit('в заходе', '2026-10-02T08:00:00Z');
  commit('после обрыва', '2026-10-02T09:30:00Z');
  const { createCommitsCache } = await import('../lib/waiting.mjs');
  const cc = createCommitsCache({ git: createGitRead(), reposOf: (code) => (code === 'EXT' ? [repo] : []) });
  const q = { key: 'k', code: 'EXT', since: '2026-10-02T07:00:00Z', until: '2026-10-02T09:00:00Z' };
  assert.equal(cc.get(q), null, 'первый запрос — фоном');
  await cc.settle();
  assert.deepEqual(cc.get(q), [{ hash: inside, subject: 'в заходе' }]);
  assert.equal(cc.get({ ...q, key: 'z', code: null }), null, 'карточки нет — неизвестно');
});

test('маска: строка (а) треда с проектом по карточкам — строгой сетью, по названию — сетью проекта; (б) — сетью проекта карточки', async () => {
  const { buildApp } = await import('../lib/app.mjs');
  // подменная сеть: «SECRET» — находка только строгой сети (IPTV), «CARKEY» — только сети CAR
  const scan = (text, opts = {}) => {
    const out = [];
    for (const [word, proj] of [['SECRET', 'IPTV'], ['CARKEY', 'CAR']]) {
      const i = text.indexOf(word);
      if (i >= 0 && opts.project === proj) out.push({ cls: 2, kind: 'ключ', line: 1, start: i, end: i + word.length });
    }
    return out;
  };
  const { board } = await boardWith([{ id: 'CAR-1', status: 'ready', title: 'Ключ CARKEY' }], { 'CAR-1': [entry(Date.now() - 60 * MIN, 'коммент', 'сливай?')] });
  const row = (sid, projectBy) => ({ sessionId: sid, title: 't', project: 'EXT', projectBy, kind: 'question', text: 'Трурль: SECRET?', since: iso(Date.now()), overDay: false, key: sid });
  const threads = { list: () => ({ threads: [], subagentsCount: 0, unknownStatus: {}, closed: [], rulesFresh: {}, waiting: [row('s-cards', 'cards'), row('s-title', 'title')] }), state: () => ({ processes: null, desktop: null }) };
  const app = await buildApp({ port: 4317, board, registry: { get: () => ({ codes: [] }), state: () => ({}) }, threads, scan });
  const res = (await app.inject({ method: 'GET', url: '/api/ceh', headers: { host: '127.0.0.1:4317' } })).json();
  const by = Object.fromEntries(res.waiting.threads.map((r) => [r.sessionId, r.text]));
  assert.equal(by['s-cards'], 'Трурль: [скрыто: ключ]?', 'проект по карточкам — строгая сеть');
  assert.equal(by['s-title'], 'Трурль: SECRET?', 'код из названия — сеть проекта (исправный случай)');
  assert.equal(res.waiting.yes[0].title, 'Ключ [скрыто: ключ]', '(б) — сетью проекта карточки');
});
