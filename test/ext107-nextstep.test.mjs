// EXT-107 Р1 (спека витрины, раздел «EXT-107», Р1): вопрос из окна «следующий шаг» десктопа — вызов
// mcp__ccd_turn__wrap_up с непустым ask. Правило (В) состояния треда, строка (а) «Ждёт меня» kind nextStep, ключ, тост,
// чипы actions (только показ), счётчик дрейфа turnTool. Гейт Р1 — случаи 1–8, 2а, 5а, 8а.
// Фикстуры — вырезанные строки живой формы (тексты под заглушкой, служебные поля с путями убраны; ask, actions и хвосты
// «… in the box below.» оставлены — их цитирует спека): ext107-wrapup-a — журнал ce1b99b5 строки 87–98, ext107-wrapup-b —
// ce1b99b5 строки 197–208, ext107-wrapup-blocked — 6ceb30ff строки 92–95. Ожидаемое — из фикстур и спеки, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSessionState, feedSession, DRIFT_KEYS } from '../lib/journal-parse.mjs';
import { buildThreads } from '../lib/threads.mjs';
import { waitingThreads, buildWaiting } from '../lib/waiting.mjs';
import { createNotifier, toastRows } from '../lib/notify.mjs';
import * as fmt from '../web/src/format.js'; // stepChips — новое (Р1): через пространство имён, чтобы до правки падал только 5а
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const lines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const A = lines('ext107-wrapup-a.jsonl'); // [0] — строка 87 (wrap_up), [3] — строка 90 (хвост end_turn), [11] — строка 98 (слово Ивана)
const B = lines('ext107-wrapup-b.jsonl'); // [0] — строка 197 (wrap_up), [7] — строка 204 (хвост), [11] — строка 208 (кнопка = actions[0].message)
const BL = lines('ext107-wrapup-blocked.jsonl'); // [0] — строка 92 (wrap_up, blocked: true), хвоста нет: [3] — stop_hook_summary
const SID_A = 'ce1b99b5-6235-4d03-aa6d-0fd851e886a5';
const SID_BL = '6ceb30ff-756c-48a4-a807-37cf4cf1e746';
const UUID_A = '10dc779f'; // начало uuid строки 87 (спека: «uuid 10dc779f…»)
const UUID_BL = '371f92ec'; // начало uuid строки 92 6ceb30ff
const NOW = Date.parse('2026-10-14T19:10:00.000Z');
const clone = (d) => structuredClone(d);

// Фикстура на месте: формы, на которые опирается гейт (если вырезка сломана — гейт ложно зелёный)
test('фикстуры: wrap_up с ask и двумя actions, хвост end_turn без «?», нажатая кнопка = actions[0].message', () => {
  const w = (d) => d.message.content.find((p) => p.type === 'tool_use');
  assert.equal(w(A[0]).name, 'mcp__ccd_turn__wrap_up');
  assert.ok(A[0].uuid.startsWith(UUID_A));
  assert.equal(w(A[0]).input.ask, 'С чего стартуем?');
  assert.equal(w(A[0]).input.actions.length, 2);
  assert.equal(A[3].message.stop_reason, 'end_turn');
  assert.ok(!A[3].message.content[0].text.includes('?'));
  assert.equal(w(BL[0]).input.blocked, true);
  assert.ok(BL[0].uuid.startsWith(UUID_BL));
  assert.ok(!BL.some((d) => d.type === 'assistant' && d.message.stop_reason === 'end_turn'), '6ceb30ff: хвоста нет');
  assert.equal(B[11].origin.kind, 'human');
  assert.equal(B[11].message.content, w(B[0]).input.actions[0].message);
});

// Сбор как на сервере: разбор журнала → «Кто работает» → строки (а) → buildWaiting (ручка /api/ceh до маски)
const board = { hasCard: () => false, hasCode: (c) => c === 'EXT', cardsList: () => [], card: () => null };
function run(ls, { sid = ls.find((d) => d.sessionId)?.sessionId, status = 'idle', waitingFor, statusUpdatedAt = '2026-10-14T19:00:00.000Z' } = {}) {
  const st = newSessionState();
  for (const d of ls) feedSession(st, d);
  const sess = { sessionId: sid, lines: ls.length, thread: st.thread, okAt: new Date(NOW).toISOString() };
  const proc = { live: true, sessionId: sid, status, waitingFor, statusUpdatedAt, startedAt: '2026-10-14T18:00:00.000Z', observedAt: NOW, name: 'EXT · тред' };
  const w = buildThreads({ procs: [proc], sessions: [sess], board, now: NOW });
  const rows = waitingThreads({ threads: w.threads, sessions: [sess], now: NOW });
  const api = buildWaiting({ threads: rows, board, now: NOW });
  return { st, thread: w.threads[0], state: w.threads[0].state, rows: api.threads };
}

// ---------- 1, 2: поломка ----------

test('1 (поломка): wrap_up с ask, хвост end_turn без «?», status idle — «ждёт тебя», строка (а) nextStep, текст «Трурль: » + ask, ключ sessionId|uuid строки wrap_up', () => {
  const r = run(A.slice(0, 11)); // 87–97: до слова Ивана
  assert.equal(r.state, 'waiting');
  assert.equal(r.rows.length, 1);
  const [row] = r.rows;
  assert.equal(row.kind, 'nextStep');
  assert.equal(row.text, 'Трурль: С чего стартуем?');
  assert.equal(row.key, `${SID_A}|${A[0].uuid}`);
  assert.equal(row.uuid, A[0].uuid);
  assert.equal(row.since, A[0].timestamp, 'возраст — от строки wrap_up');
  assert.ok(!row.keyTemp);
  assert.equal(row.blocked, false);
  assert.equal(row.recap, '<итог хода>');
});

test('2 (ещё поломка): wrap_up с ask и blocked: true, хвоста нет (6ceb30ff) — то же; blocked: true в ручке', () => {
  const r = run(BL);
  assert.equal(r.state, 'waiting');
  const [row] = r.rows;
  assert.equal(row.kind, 'nextStep');
  assert.equal(row.text, 'Трурль: Какие находки этапа 4 берём в починку?');
  assert.equal(row.key, `${SID_BL}|${BL[0].uuid}`);
  assert.equal(row.blocked, true);
});

test('2а: (Б) и (В) вместе — хвост end_turn с «?» после wrap_up: kind nextStep, текст и ключ — от wrap_up, не от хвоста', () => {
  const ls = A.slice(0, 4).map(clone);
  ls[3].message.content = [{ type: 'text', text: 'План в окне ниже.\n\nНачинаем?' }];
  const r = run(ls);
  assert.equal(r.state, 'waiting');
  const [row] = r.rows;
  assert.equal(row.kind, 'nextStep');
  assert.equal(row.text, 'Трурль: С чего стартуем?');
  assert.equal(row.key, `${SID_A}|${A[0].uuid}`);
});

// ---------- 3: снятие ----------

test('3 (снятие): после wrap_up — слово Ивана (нажатая кнопка, текст = actions[0].message): строки (а) нет, состояние по реестру', () => {
  const r = run(B);
  assert.equal(r.rows.length, 0);
  assert.equal(r.state, 'idle');
  assert.equal(run(A).rows.length, 0, 'обычное слово Ивана (строка 98) — тоже снимает');
});

test('3 (снятие): после wrap_up — новая строка assistant (isSidechain нет) с другим message.id и tool_use: строки (а) нет', () => {
  const next = { type: 'assistant', isSidechain: false, uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: '2026-10-14T18:56:00.000Z', sessionId: SID_A,
    message: { id: 'msg_new_turn', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Bash', input: { command: 'git status' } }] } };
  const r = run([...A.slice(0, 4), next]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.state, 'idle');
  // та же строка без поля isSidechain (поля нет — не true) — тоже снимает
  const bare = clone(next); delete bare.isSidechain;
  assert.equal(run([...A.slice(0, 4), bare]).rows.length, 0);
});

// ---------- 4: не снятие ----------

const ring = { parentUuid: null, isSidechain: false, type: 'user', uuid: 'bbbbbbbb-0000-4000-8000-000000000001', timestamp: '2026-10-14T18:57:00.000Z', sessionId: SID_A,
  message: { role: 'user', content: '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": Слово Ивана · кнопка витрины. Перечитай правила.\nW-261014-185700-a1b2 · 18:57 · без карточки · «перечитай правила»\n</system-reminder>' },
  origin: { kind: 'task-notification', producer: 'session-task' } };

test('4 (не снятие): звонок «перечитай правила» после wrap_up — «ждёт тебя» остаётся', () => {
  const r = run([...A.slice(0, 4), ring]);
  assert.equal(r.st.ivan.count, 0, 'звонок — не слово Ивана');
  assert.equal(r.state, 'waiting');
  assert.equal(r.rows[0].kind, 'nextStep');
  assert.equal(r.rows[0].key, `${SID_A}|${A[0].uuid}`);
});

test('4 (не снятие): второй хвост-текст end_turn без tool_use — «ждёт тебя» остаётся', () => {
  const tail2 = { ...clone(A[3]), uuid: 'cccccccc-0000-4000-8000-000000000001', timestamp: '2026-10-14T18:55:40.000Z', message: { ...clone(A[3].message), id: 'msg_tail_2', content: [{ type: 'text', text: 'Жду.' }] } };
  const r = run([...A.slice(0, 4), tail2]);
  assert.equal(r.state, 'waiting');
  assert.equal(r.rows[0].kind, 'nextStep');
});

test('4 (не снятие): строка assistant с isSidechain: true и tool_use в главном журнале — «ждёт тебя» остаётся', () => {
  const side = { type: 'assistant', isSidechain: true, uuid: 'dddddddd-0000-4000-8000-000000000001', timestamp: '2026-10-14T18:56:00.000Z', sessionId: SID_A,
    message: { id: 'msg_side', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'ls' } }] } };
  const r = run([...A.slice(0, 4), side]);
  assert.equal(r.state, 'waiting');
  assert.equal(r.rows[0].key, `${SID_A}|${A[0].uuid}`);
});

// ---------- 5: исправный ----------

test('5 (исправный): wrap_up без ask (только recap) — «свободен»', () => {
  const ls = A.slice(0, 4).map(clone);
  const tu = ls[0].message.content[0];
  tu.input = { recap: tu.input.recap };
  assert.equal(run(ls).state, 'idle');
  // ask из пробелов — тоже нет вопроса (край)
  const sp = A.slice(0, 4).map(clone);
  sp[0].message.content[0].input.ask = '   ';
  assert.equal(run(sp).state, 'idle');
  assert.equal(run(sp).rows.length, 0);
});

test('5 (исправный): end_turn без «?» и без wrap_up — «свободен»', () => {
  assert.equal(run([A[3]]).state, 'idle');
});

test('5 (исправный): wrap_up в строке с isSidechain: true главного журнала — «свободен»', () => {
  const ls = A.slice(0, 4).map(clone);
  ls[0].isSidechain = true;
  const r = run(ls);
  assert.equal(r.state, 'idle');
  assert.equal(r.rows.length, 0);
});

test('5 (край): новый wrap_up заменяет прежний — текст и ключ от нового; новый без ask снимает вопрос', () => {
  const second = clone(B[0]);
  second.sessionId = SID_A;
  const r = run([...A.slice(0, 4), second, B[7]], { sid: SID_A });
  assert.equal(r.rows[0].text, 'Трурль: Даёшь го на EXT-107?');
  assert.equal(r.rows[0].key, `${SID_A}|${B[0].uuid}`);
  const noAsk = clone(second);
  noAsk.message.content[0].input = { recap: 'r' };
  assert.equal(run([...A.slice(0, 4), noAsk], { sid: SID_A }).state, 'idle');
});

// ---------- 5а: чипы ----------

test('5а (чипы): ручка — поля actions как во вводе; чипы: ответ с message — подсказка message; без message — label; action: merge — «действие: merge» без label', () => {
  const ls = A.slice(0, 4).map(clone);
  ls[0].message.content[0].input.actions = [
    { label: 'Го', message: 'го на EXT-107: спека' },
    { label: 'Позже' },
    { label: 'Слить', action: 'merge' },
  ];
  const [row] = run(ls).rows;
  assert.deepEqual(row.actions, [{ label: 'Го', message: 'го на EXT-107: спека' }, { label: 'Позже' }, { label: 'Слить', action: 'merge' }]);
  const chips = fmt.stepChips(row.actions);
  assert.equal(chips.length, 3);
  assert.equal(chips[0].text, 'Го');
  assert.equal(chips[0].title, 'го на EXT-107: спека');
  assert.equal(chips[1].text, 'Позже');
  assert.equal(chips[1].title, 'Позже');
  assert.equal(chips[2].text, 'действие: merge');
  assert.ok(!chips[2].text.includes('Слить') && !String(chips[2].title).includes('Слить'), 'label действия приложения не показывается');
  // живая форма (две кнопки-ответа с message)
  const live = fmt.stepChips(run(A.slice(0, 4)).rows[0].actions);
  assert.deepEqual(live.map((c) => c.text), ['Го: 76 + 104 + доки', 'Только доки и 76']);
  assert.equal(live[1].title, 'го на закрытие EXT-76 и доки 105/106; EXT-104 пока держим');
  // без actions и с мусором — пусто, не падение
  assert.deepEqual(fmt.stepChips(undefined), []);
  assert.deepEqual(fmt.stepChips([null, 5, {}]), []);
});

test('5а: подсказка «ждёт тебя в десктопе — ответь там» у nextStep остаётся; у question — нет', () => {
  assert.equal(fmt.waitsInDesktop({ kind: 'nextStep' }), true);
  assert.equal(fmt.waitsInDesktop({ kind: 'question' }), false);
});

// ---------- 6: регресс ----------

const SID6 = 'eeeeeeee-0000-4000-8000-000000000006';
const askUser = { type: 'assistant', isSidechain: false, uuid: 'eeeeeeee-0000-4000-8000-0000000000a1', timestamp: '2026-10-14T18:50:00.000Z', sessionId: SID6,
  message: { id: 'msg_ask', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Какой вариант?' }] } }] } };
const endQ = { type: 'assistant', isSidechain: false, uuid: 'eeeeeeee-0000-4000-8000-0000000000b1', timestamp: '2026-10-14T18:51:00.000Z', sessionId: SID6,
  message: { id: 'msg_q', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово.\n\nСливать?' }] } };

test('6 (регресс): открытый AskUserQuestion, waiting + «input needed» — прежний kind askUserQuestion и ключ sessionId|uuid', () => {
  const r = run([askUser], { status: 'waiting', waitingFor: 'input needed' });
  assert.equal(r.rows[0].kind, 'askUserQuestion');
  assert.equal(r.rows[0].key, `${SID6}|${askUser.uuid}`);
  assert.equal(run([askUser]).rows[0].kind, 'askUserQuestion', '(А) при idle');
});

test('6 (регресс): waiting + «permission prompt» — kind permission, ключ sessionId|statusUpdatedAt, и при открытом окне wrap_up', () => {
  const r = run([endQ], { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: '2026-10-14T18:52:00.000Z' });
  assert.equal(r.rows[0].kind, 'permission');
  assert.equal(r.rows[0].key, `${SID6}|2026-10-14T18:52:00.000Z`);
  const w = run(A.slice(0, 4), { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: '2026-10-14T18:58:00.000Z' });
  assert.equal(w.rows[0].kind, 'permission', 'шаг (1) раньше (В)');
});

test('6 (регресс): (Б) без wrap_up — kind question, текст абзаца и ключ sessionId|uuid хвоста', () => {
  const r = run([endQ]);
  assert.equal(r.rows[0].kind, 'question');
  assert.equal(r.rows[0].text, 'Трурль: Сливать?');
  assert.equal(r.rows[0].key, `${SID6}|${endQ.uuid}`);
  assert.equal(r.rows[0].actions, undefined, 'у question полей окна нет');
});

// ---------- 7: busy ----------

test('7 (busy): wrap_up с ask, status busy — «работает», строки (а) нет', () => {
  const r = run(A.slice(0, 4), { status: 'busy' });
  assert.equal(r.state, 'busy');
  assert.equal(r.rows.length, 0);
});

// ---------- 8, 8а: тост ----------

const rowsOf = (ls) => ({ threads: run(ls).rows, yes: [] });

test('8 (тост): два цикла подряд и рестарт (notified.json) — один тост, повтора нет', () => {
  const file = path.join(tmpDir('ext107-'), 'notified.json');
  const shown = [];
  const a = createNotifier({ file, show: (r) => shown.push(r) });
  a.cycle([], { silent: true }); // первый цикл после старта — пусто
  a.cycle(toastRows(rowsOf(A.slice(0, 4))));
  a.cycle(toastRows(rowsOf(A.slice(0, 4))));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].key, `${SID_A}|${A[0].uuid}`);
  assert.equal(shown[0].body, 'Трурль: С чего стартуем?');
  const b = createNotifier({ file, show: (r) => shown.push(r) });
  b.cycle(toastRows(rowsOf(A.slice(0, 4))));
  assert.equal(shown.length, 1, 'после рестарта ключ из notified.json не всплывает');
});

test('8а (временный ключ): строка nextStep сначала без uuid (keyTemp), на следующем цикле с uuid — тост ровно один, после смены ключа', () => {
  const file = path.join(tmpDir('ext107-'), 'notified.json');
  const shown = [];
  const n = createNotifier({ file, show: (r) => shown.push(r.key) });
  n.cycle([], { silent: true });
  const noUuid = A.slice(0, 4).map(clone);
  delete noUuid[0].uuid;
  const first = rowsOf(noUuid);
  assert.equal(first.threads[0].keyTemp, true);
  assert.equal(first.threads[0].kind, 'nextStep');
  n.cycle(toastRows(first));
  assert.deepEqual(shown, [], 'строке с временным ключом тоста нет');
  n.cycle(toastRows(rowsOf(A.slice(0, 4))));
  assert.deepEqual(shown, [`${SID_A}|${A[0].uuid}`]);
});

test('8а (временный ключ, строки как из ручки): nextStep без uuid в тосты не идёт, с uuid — идёт', () => {
  const temp = { kind: 'nextStep', key: `${SID_A}|2026-10-14T18:55:26.720Z`, keyTemp: true, uuid: null, title: 'т', text: 'Трурль: ?' };
  const real = { ...temp, key: `${SID_A}|u-1`, keyTemp: undefined, uuid: 'u-1' };
  assert.deepEqual(toastRows({ threads: [temp], yes: [] }), []);
  assert.deepEqual(toastRows({ threads: [real], yes: [] }).map((r) => r.key), [`${SID_A}|u-1`]);
});

// ---------- дрейф turnTool ----------

test('дрейф: mcp__ccd_turn__* кроме wrap_up и update_plan — счётчик turnTool; известные — не в счёт', () => {
  assert.ok(DRIFT_KEYS.includes('turnTool'));
  const call = (name, i) => ({ type: 'assistant', isSidechain: false, uuid: `ffffffff-0000-4000-8000-00000000000${i}`, timestamp: '2026-10-14T18:55:00.000Z', sessionId: SID_A,
    message: { id: `m${i}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } });
  const r = run([call('mcp__ccd_turn__wrap_up', 1), call('mcp__ccd_turn__update_plan', 2), call('mcp__ccd_turn__ask_more', 3), call('mcp__ccd_turn__ask_more', 4), call('Bash', 5)]);
  assert.deepEqual(r.st.drift?.turnTool, { mcp__ccd_turn__ask_more: 2 });
  assert.equal(run(A).st.drift?.turnTool, undefined, 'живая форма — без дрейфа');
});

// ---------- края строки (а): возраст, «больше суток», карточка в тексте ask ----------

test('1 (край): возраст — от строки wrap_up, даже старше процесса; с 24 ч — «ждёт больше суток»', () => {
  const st = newSessionState();
  for (const d of A.slice(0, 4)) feedSession(st, d);
  const sess = [{ sessionId: SID_A, thread: st.thread }];
  const th = (startedAt) => ({ sessionId: SID_A, title: 'EXT · тред', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'nextStep', statusUpdatedAt: startedAt });
  const day = Date.parse(A[0].timestamp) + 24 * 3600000;
  const [late] = waitingThreads({ threads: [th('2026-10-15T18:00:00.000Z')], sessions: sess, now: day });
  assert.equal(late.since, A[0].timestamp);
  assert.equal(late.overDay, true);
  const [early] = waitingThreads({ threads: [th('2026-10-15T18:00:00.000Z')], sessions: sess, now: day - 1 });
  assert.equal(early.overDay, false);
});

test('ручка: карточка проекта треда в тексте ask — поле card, как у question (кнопок пульта у nextStep нет — решает вид)', () => {
  const st = newSessionState();
  for (const d of B.slice(0, 8)) feedSession(st, d); // до слова Ивана: «Даёшь го на EXT-107?»
  const sess = [{ sessionId: SID_A, thread: st.thread }];
  const rows = waitingThreads({ threads: [{ sessionId: SID_A, title: 'EXT · тред', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'nextStep', statusUpdatedAt: null }], sessions: sess, now: NOW });
  const brd = { cardsList: () => [], card: (id) => (id === 'EXT-107' ? { id, status: 'in-progress' } : null) };
  const [row] = buildWaiting({ threads: rows, board: brd, now: NOW }).threads;
  assert.equal(row.kind, 'nextStep');
  assert.equal(row.card, 'EXT-107');
  const none = buildWaiting({ threads: waitingThreads({ threads: [{ sessionId: SID_A, title: 't', project: 'CAR', projectBy: 'title', state: 'waiting', waitingKind: 'nextStep' }], sessions: sess, now: NOW }), board: brd, now: NOW }).threads[0];
  assert.equal(none.card, undefined, 'номер чужого проекта — поля нет');
});

// ---------- дозапрос Голема: снятие держится условием «ДРУГОЙ message.id», sidechain не заменяет ----------

test('4 (не снятие): строка главного треда с ТЕМ ЖЕ message.id, что у wrap_up, и tool_use — вопрос не снимается', () => {
  const same = { type: 'assistant', isSidechain: false, uuid: 'abababab-0000-4000-8000-000000000001', timestamp: '2026-10-14T18:55:27.000Z', sessionId: SID_A,
    message: { id: A[0].message.id, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_same', name: 'Bash', input: { command: 'ls' } }] } };
  const r = run([...A.slice(0, 4), same]);
  assert.equal(r.state, 'waiting');
  assert.equal(r.rows[0].kind, 'nextStep');
  assert.equal(r.rows[0].key, `${SID_A}|${A[0].uuid}`);
  // исправный рядом: тот же вызов с другим message.id — снимает
  const other = { ...same, message: { ...same.message, id: 'msg_other' } };
  assert.equal(run([...A.slice(0, 4), other]).rows.length, 0);
});

test('4 (не снятие): новый wrap_up в строке с isSidechain: true не заменяет прежний вопрос', () => {
  const side = clone(B[0]);
  side.sessionId = SID_A;
  side.isSidechain = true;
  const r = run([...A.slice(0, 4), side], { sid: SID_A });
  assert.equal(r.rows[0].text, 'Трурль: С чего стартуем?');
  assert.equal(r.rows[0].key, `${SID_A}|${A[0].uuid}`);
  // исправный рядом: тот же wrap_up в главном треде — заменяет
  const main = { ...side, isSidechain: false };
  assert.equal(run([...A.slice(0, 4), main], { sid: SID_A }).rows[0].key, `${SID_A}|${B[0].uuid}`);
});
