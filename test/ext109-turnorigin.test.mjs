// EXT-109 (спека витрины, раздел «Такт EXT-109 и PARTIAL под прорабом»): разрешающий список turnOrigin в слове Ивана,
// признак «сессия без окна» (noWindow), PARTIAL под прорабом и без окна — не красная пометка Ивану, счётчик дрейфа
// turnOrigin. Гейт — случаи 1, 1а, 1б, 2, 3, 3а, 3б, 4, 5 (6 — полный npm test и гейты EXT-107 Р4, EXT-74).
// Фикстуры — вырезанные строки живой формы, тексты под заглушкой, служебные поля с путями убраны (cwd, gitBranch):
// ext109-turnorigin — журнал d32e3fb4 (C--projects-extractor-ext91) строки 5 (ТЗ прораба, turnOrigin sdk) и 274 (таймер
// цикла: isMeta, turnOrigin scheduled); ext107-foreman — d30580af строки 1–5 и 156 (имя прораба, ТЗ sdk, end_turn);
// ext107-wrapup-a — ce1b99b5 строки 87–98 (wrap_up с ask). Ожидаемое — из фикстур и спеки, не из кода под тестом.
// Разбор — настоящим читателем журналов во временной папке; сбор — buildWorkers и buildWaiting, как на сервере.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { buildWorkers, buildWaiting, waitingThreads } from '../lib/waiting.mjs';
import { buildThreads } from '../lib/threads.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const lines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const [SDK, SCHED] = lines('ext109-turnorigin.jsonl'); // d32e3fb4 строки 5 и 274
const F = lines('ext107-foreman.jsonl'); // d30580af строки 1–5, 156
const WA = lines('ext107-wrapup-a.jsonl'); // ce1b99b5 строки 87–98
const NAME = 'EXT · Тарантога · EXT-91';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const MIN = 60000;
const H = 60 * MIN;
const clone = (d) => structuredClone(d);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// строка живой формы под свою сессию и своё время; drop — снять поля (isMeta у строки таймера — случай 1)
const as = (d, sid, time, { drop = [], ...extra } = {}) => {
  const x = { ...clone(d), sessionId: sid, timestamp: time, uuid: uid(), parentUuid: null, ...extra };
  for (const k of drop) delete x[k];
  return x;
};
const user = (sid, time, text, o = {}) => ({ type: 'user', isSidechain: false, uuid: uid(), sessionId: sid, timestamp: time, message: { role: 'user', content: text }, ...o });
const asking = (sid, time, text = 'Сделано.\n\nСливать?') => ({ type: 'assistant', isSidechain: false, uuid: uid(), sessionId: sid, timestamp: time, message: { id: `m-${uid()}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
// обрыв подмастерья в главном журнале: вызов Agent и его результат «stopped at its 90-turn limit» (форма partial.jsonl)
const partial = (sid, time, agentId = 'a0123456789abcdef') => {
  const id = `toolu_${agentId}`;
  return [
    { type: 'assistant', isSidechain: false, uuid: uid(), sessionId: sid, timestamp: time, message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'terminus', description: 'такт EXT-91', prompt: 'Такт EXT-91' } }] } },
    { type: 'user', isSidechain: false, uuid: uid(), sessionId: sid, timestamp: time, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: 'Agent stopped at its 90-turn limit' }] }] }, toolUseResult: { status: 'completed', agentId, agentType: 'terminus', content: [{ type: 'text', text: 'Agent stopped at its 90-turn limit' }] } },
  ];
};

const board = { hasCard: (id) => ['EXT-91'].includes(id), hasCode: (c) => c === 'EXT', card: () => null, cardsList: () => [] };
const proc = (sid, name) => ({ pid: 1, sessionId: sid, ...(name ? { name } : {}), live: true, status: 'idle', startedAt: at(30 * H), observedAt: NOW, statusUpdatedAt: at(MIN) });

async function workers(journals, procs) {
  const root = tmpDir('ext109-');
  const proj = path.join(root, 'C--projects-extractor-ext91');
  fs.mkdirSync(proj, { recursive: true });
  for (const [sid, ls] of Object.entries(journals)) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), ls.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const r = createJournalReader({ root, indexDir: tmpDir('ext109-index-') });
  await r.refresh();
  const sessions = r.sessions();
  const w = buildWorkers({ procs, sessions, board, now: NOW, thresholds: {}, exists: () => true });
  const api = buildWaiting({ threads: w.waiting, board, now: NOW });
  const row = (sid) => w.threads.find((t) => t.sessionId === sid);
  return {
    w, rows: api.threads, row, drift: r.state().drift,
    sess: (sid) => sessions.find((s) => s.sessionId === sid),
    partialMarks: (sid) => (row(sid)?.marks ?? []).filter((m) => m.kind === 'partial'),
    closedOf: (sid) => w.closed.filter((c) => c.sessionId === sid),
  };
}

const C = '33333333-3333-4333-8333-333333333333'; // обычный тред с окном
const B = '22222222-2222-4222-8222-222222222222'; // прораб по запуску / сессия без окна
const A = '11111111-1111-4111-8111-111111111111'; // дирижёр
const SID = F[0].sessionId; // d30580af — прораб по имени

test('фикстуры: d32e3fb4 строка 5 — user без isMeta и origin, turnOrigin sdk; строка 274 — isMeta, turnOrigin scheduled, без origin; d30580af строка 5 — sdk', () => {
  assert.equal(SDK.type, 'user');
  assert.equal(SDK.turnOrigin, 'sdk');
  assert.equal('isMeta' in SDK, false);
  assert.equal('origin' in SDK, false);
  assert.equal(SCHED.type, 'user');
  assert.equal(SCHED.turnOrigin, 'scheduled');
  assert.equal(SCHED.isMeta, true);
  assert.equal('origin' in SCHED, false);
  assert.ok(SCHED.message.content.startsWith('# Autonomous loop tick'));
  assert.equal(F[4].turnOrigin, 'sdk');
  assert.equal(F[0].customTitle, NAME);
});

// ---------- 1: поломка — строка sdk / scheduled без isMeta ----------

for (const [label, line] of [['sdk', SDK], ['scheduled без isMeta', SCHED]]) {
  test(`1 (поломка): обычный тред, end_turn с «?», затем строка user ${label} без origin — «ждёт тебя» остаётся, ivan.count и ivan.lastAt не меняются`, async () => {
    const ivanAt = at(2 * H);
    const r = await workers({ [C]: [user(C, ivanAt, 'Что с EXT-91?'), asking(C, at(H)), as(line, C, at(30 * MIN), { drop: ['isMeta'] })] }, [proc(C, 'EXT · тред')]);
    assert.equal(r.row(C).state, 'waiting');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].kind, 'question');
    assert.equal(r.sess(C).ivan.count, 1);
    assert.equal(r.sess(C).ivan.lastAt, ivanAt);
  });
}

// ---------- 1а: поломка (В) ----------

test('1а (поломка (В)): wrap_up с ask, затем строка sdk без isMeta — (В) открыт, строка (а) nextStep на месте', () => {
  const NOW_A = Date.parse('2026-10-14T19:10:00.000Z');
  const base = WA.slice(0, 11); // строки 87–97: до слова Ивана
  const last = base.at(-1);
  const ls = [...base, as(SDK, last.sessionId, new Date(Date.parse(last.timestamp) + 1000).toISOString())];
  const st = newSessionState();
  for (const d of ls) feedSession(st, d);
  const sid = last.sessionId;
  const sess = { sessionId: sid, lines: ls.length, thread: st.thread, okAt: new Date(NOW_A).toISOString() };
  const p = { live: true, sessionId: sid, status: 'idle', statusUpdatedAt: '2026-10-14T19:00:00.000Z', startedAt: '2026-10-14T18:00:00.000Z', observedAt: NOW_A, name: 'EXT · тред' };
  const w = buildThreads({ procs: [p], sessions: [sess], board, now: NOW_A });
  const rows = buildWaiting({ threads: waitingThreads({ threads: w.threads, sessions: [sess], now: NOW_A }), board, now: NOW_A }).threads;
  assert.equal(w.threads[0].state, 'waiting');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'nextStep');
  assert.equal(st.ivan.count, 0);
});

// ---------- 1б: дрейф ----------

test('1б (дрейф): строка user с turnOrigin «user» (незнакомое) — не слово Ивана, drift.turnOrigin.user +1; шесть знакомых значений и строка без поля — без дрейфа', async () => {
  const r = await workers({ [C]: [user(C, at(2 * H), 'Что с EXT-91?'), asking(C, at(H)), user(C, at(30 * MIN), 'да', { turnOrigin: 'user' })] }, [proc(C, 'EXT · тред')]);
  assert.equal(r.sess(C).ivan.count, 1);
  assert.equal(r.row(C).state, 'waiting');
  assert.deepEqual(r.drift.turnOrigin, { user: 1 });
  const known = ['human', 'sdk', 'scheduled', 'task_notification', 'peer', 'system'];
  const q = await workers({ [C]: [user(C, at(3 * H), 'Что с EXT-91?'), ...known.map((v, i) => user(C, at(2 * H - i * MIN), `строка ${v}`, { turnOrigin: v }))] }, [proc(C, 'EXT · тред')]);
  assert.deepEqual(q.drift.turnOrigin, {});
  // строка субагента (isSidechain) с незнакомым значением — не в счёт
  const s = await workers({ [C]: [user(C, at(2 * H), 'да', { isSidechain: true, turnOrigin: 'user' })] }, [proc(C, 'EXT · тред')]);
  assert.deepEqual(s.drift.turnOrigin, {});
});

// ---------- 2: исправный (список) ----------

test('2 (исправный): слово Ивана без turnOrigin и с turnOrigin human снимает (Б), ivan.count +1; строка таймера живой формы (isMeta, scheduled) — нет', async () => {
  const none = await workers({ [C]: [asking(C, at(H)), user(C, at(30 * MIN), 'да')] }, [proc(C, 'EXT · тред')]);
  assert.notEqual(none.row(C).state, 'waiting');
  assert.equal(none.sess(C).ivan.count, 1);
  assert.equal(none.rows.length, 0);
  const human = await workers({ [C]: [asking(C, at(H)), user(C, at(30 * MIN), 'да', { origin: { kind: 'human' }, promptSource: 'user', turnOrigin: 'human' })] }, [proc(C, 'EXT · тред')]);
  assert.notEqual(human.row(C).state, 'waiting');
  assert.equal(human.sess(C).ivan.count, 1);
  assert.equal(human.sess(C).ivan.lastAt, at(30 * MIN));
  const sched = await workers({ [C]: [asking(C, at(H)), as(SCHED, C, at(30 * MIN))] }, [proc(C, 'EXT · тред')]);
  assert.equal(sched.row(C).state, 'waiting');
  assert.equal(sched.sess(C).ivan.count, 0);
});

test('2 (вложение queued_command, п.2): с turnOrigin sdk строки — не слово Ивана; без поля — слово Ивана, как было', async () => {
  const q = (o = {}) => ({ type: 'attachment', isSidechain: false, uuid: uid(), sessionId: C, timestamp: at(30 * MIN), attachment: { type: 'queued_command', prompt: 'да', commandMode: 'prompt', origin: { kind: 'human' } }, ...o });
  const plain = await workers({ [C]: [asking(C, at(H)), q()] }, [proc(C, 'EXT · тред')]);
  assert.equal(plain.sess(C).ivan.count, 1);
  assert.notEqual(plain.row(C).state, 'waiting');
  const sdk = await workers({ [C]: [asking(C, at(H)), q({ turnOrigin: 'sdk' })] }, [proc(C, 'EXT · тред')]);
  assert.equal(sdk.sess(C).ivan.count, 0);
  assert.equal(sdk.row(C).state, 'waiting');
});

// ---------- noWindow ----------

test('4а (признак): первая строка user с turnOrigin sdk — noWindow; sdk позже первой строки — признака нет; обычный тред — нет', async () => {
  const r = await workers({
    [B]: [as(SDK, B, at(3 * H)), asking(B, at(2 * H))],
    [C]: [user(C, at(3 * H), 'Что с EXT-91?'), as(SDK, C, at(2 * H))],
    [A]: [user(A, at(3 * H), 'го')],
  }, []);
  assert.equal(r.sess(B).noWindow, true);
  assert.equal(r.sess(C).noWindow, false);
  assert.equal(r.sess(A).noWindow, false);
});

// ---------- 3, 3а, 3б: закрытая сессия — строки «тред закрыт» нет ----------

test('3 (поломка PARTIAL): закрытая сессия прораба (foremanTitle) с обрывом подмастерья — строки «тред закрыт» нет; и без turnOrigin у ТЗ (держит имя)', async () => {
  const r = await workers({ [SID]: [...F.map(clone), ...partial(SID, '2026-10-10T18:50:00.000Z')] }, []);
  assert.deepEqual(r.closedOf(SID), []);
  const byName = F.map(clone);
  delete byName[4].turnOrigin;
  const n = await workers({ [SID]: [...byName, ...partial(SID, '2026-10-10T18:50:00.000Z')] }, []);
  assert.notEqual(n.sess(SID).noWindow, true, 'держит имя, не noWindow');
  assert.deepEqual(n.closedOf(SID), []);
});

const P = 'C:\\w\\x';
const launch = (sid, time) => {
  const id = `b-${uid().slice(-4)}`;
  return [
    { type: 'assistant', uuid: uid(), sessionId: sid, timestamp: time, message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `node C:\\projects\\_foreman\\foreman-launch.mjs --card EXT-91 --project EXT --cwd ${P} --task C:\\t\\tz.md` } }] } },
    { type: 'user', uuid: uid(), sessionId: sid, timestamp: time, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Command running in background' }] } },
  ];
};
// дирижёр A вызвал прораба на папку P в момент L; первая строка прораба B — в P через минуту
const familyScene = (L, first) => ({
  [A]: [user(A, at(L + 2 * H), 'го', { cwd: 'C:\\other' }), ...launch(A, at(L))],
  [B]: [{ ...first, cwd: P }, asking(B, at(L - 30 * MIN), 'Готово наполовину.'), ...partial(B, at(L - 40 * MIN))],
});

test('3а (поломка, семья истекла): закрытый прораб только по семье, первая строка sdk, запуск 40 ч назад — строки «тред закрыт» нет (держит noWindow); та же сцена без sdk — строка есть (семья истекла)', async () => {
  const L = 40 * H;
  const r = await workers(familyScene(L, as(SDK, B, at(L - MIN))), [proc(A, 'EXT-91 · дирижёр')]);
  assert.deepEqual(r.closedOf(B), []);
  const plain = await workers(familyScene(L, user(B, at(L - MIN), 'Твоё задание — в файле …')), [proc(A, 'EXT-91 · дирижёр')]);
  assert.equal(plain.closedOf(B).length, 1);
  assert.equal(plain.closedOf(B)[0].marks[0].kind, 'partial');
});

test('3б (поломка, без окна): закрытая сессия без имени и семьи, первая строка sdk, обрыв подмастерья — строки «тред закрыт» нет; sdk не первой строкой — строка есть', async () => {
  const r = await workers({ [B]: [as(SDK, B, at(3 * H)), ...partial(B, at(2 * H))] }, []);
  assert.deepEqual(r.closedOf(B), []);
  const later = await workers({ [B]: [user(B, at(4 * H), 'Что с EXT-91?'), as(SDK, B, at(3 * H)), ...partial(B, at(2 * H))] }, []);
  assert.equal(later.closedOf(B).length, 1);
  assert.equal(later.closedOf(B)[0].marks[0].kind, 'partial');
});

test('3 (не все держатели): обрыв лежит и в сессии без окна, и в обычной закрытой — строка «тред закрыт» есть', async () => {
  const t = at(2 * H);
  const r = await workers({
    [B]: [as(SDK, B, at(3 * H)), ...partial(B, t)],
    [C]: [user(C, at(3 * H), 'Что с EXT-91?'), ...partial(C, t)],
  }, []);
  assert.equal(r.w.closed.filter((c) => c.marks.some((m) => m.kind === 'partial')).length, 1);
});

// ---------- 4: живой прораб ----------

test('4 (поломка PARTIAL): живой прораб по foremanTitle с обрывом после последней строки user — пометки «Обрыв · PARTIAL» и waitingWord нет, в «Ждёт меня» нет', async () => {
  const ls = F.map(clone);
  delete ls[4].turnOrigin; // держит имя, не noWindow
  const r = await workers({ [SID]: [...ls, ...partial(SID, '2026-10-10T18:50:00.000Z')] }, [proc(SID, NAME)]);
  assert.equal(r.row(SID).foreman, true);
  assert.deepEqual(r.partialMarks(SID), []);
  assert.equal((r.row(SID).marks ?? []).some((m) => m.waitingWord), false);
  assert.deepEqual(r.rows, []);
});

test('4 (поломка PARTIAL): живой прораб только по семье запуска (ТЗ без turnOrigin), обрыв после последней строки user — пометки и waitingWord нет', async () => {
  const L = 3 * H;
  const scene = familyScene(L, user(B, at(L - MIN), 'Твоё задание — в файле …'));
  const r = await workers(scene, [proc(A, 'EXT-91 · дирижёр'), proc(B, 'EXT-91 · прораб')]);
  assert.equal(r.row(B).foreman, true);
  assert.notEqual(r.sess(B).noWindow, true, 'держит семья, не noWindow');
  assert.deepEqual(r.partialMarks(B), []);
  assert.equal((r.row(B).marks ?? []).some((m) => m.waitingWord), false);
  assert.deepEqual(r.rows, []);
});

// ---------- 5: исправный (PARTIAL) ----------

test('5 (исправный): обычный закрытый тред с обрывом — строка «тред закрыт» с пометкой; слово Ивана после обрыва — снята; живой — пометка с waitingWord', async () => {
  const base = [user(C, at(3 * H), 'Что с EXT-91?'), ...partial(C, at(2 * H))];
  const closed = await workers({ [C]: base }, []);
  assert.equal(closed.closedOf(C).length, 1);
  assert.equal(closed.closedOf(C)[0].marks[0].kind, 'partial');
  const answered = await workers({ [C]: [...base, user(C, at(H), 'продолжай', { origin: { kind: 'human' }, turnOrigin: 'human' })] }, []);
  assert.deepEqual(answered.closedOf(C), []);
  const live = await workers({ [C]: base }, [proc(C, 'EXT · тред')]);
  const [m] = live.partialMarks(C);
  assert.equal(m?.waitingWord, true);
});
