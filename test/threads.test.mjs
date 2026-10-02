// В3 (EXT-27): живые процессы, состояние треда (2.1), привязки (1.4), субагенты под тредом (2.2); гейт п.5.
// Форма ~/.claude/sessions/<pid>.json — снята пробой 02.10 (ключи верхнего уровня; procStart — FILETIME Windows
// строкой, совпал с Get-Process StartTime.ToFileTimeUtc() у двух живых pid из двух). Ожидаемые значения — из данных,
// положенных в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessReader, filetimeToMs } from '../lib/processes.mjs';
import { buildThreads, threadState } from '../lib/threads.mjs';

const T0 = Date.parse('2026-10-02T10:00:00Z');
const MIN = 60000;
const SID = 'aaaaaaaa-1111-4000-8000-000000000001';
const sessFile = (o = {}) => JSON.stringify({ pid: 101, sessionId: SID, cwd: 'C:\\x', startedAt: T0 - 60 * MIN, procStart: '134353944217263152', version: '2.1.286', kind: 'interactive', entrypoint: 'claude-desktop', hostSessionId: 'local_h1', name: 'тред', nameSource: 'user', status: 'idle', updatedAt: T0, statusUpdatedAt: T0, ...o });

// подменный fs каталога sessions: файлы — строки; Error — чтение бросает (файл заперт)
function fakeFs(files) {
  return {
    readdirSync: () => Object.keys(files),
    readFileSync: (p) => { const v = files[p.split(/[\\/]/).pop()]; if (v instanceof Error) throw v; if (v === undefined) throw Object.assign(new Error('нет'), { code: 'ENOENT' }); return v; },
  };
}
const busyErr = () => Object.assign(new Error('заперт'), { code: 'EBUSY' });

function reader(files, { starts = { 101: '134353944217263152' }, alive = [101] } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const r = createProcessReader({
    dir: 'C:/s', fs: fakeFs(files), now: () => clock.t,
    isAlive: (pid) => alive.includes(pid),
    procStartOf: async (pids) => { calls.push([...pids]); return new Map(pids.map((p) => [p, starts[p] ?? null])); },
  });
  return { r, clock, calls };
}

const board = { hasCode: (c) => ['EXT', 'CAR', 'IPTV'].includes(c), hasCard: (id) => ['EXT-25', 'EXT-26', 'EXT-27', 'CAR-264'].includes(id) };
const session = (o = {}) => ({ sessionId: SID, ivan: { cards: {} }, boardWrites: [], runs: [], thread: { askOpen: false, askAt: null, endTurnQ: null, endTurnAt: null, lastAt: new Date(T0 - 20 * MIN).toISOString() }, ...o });
const build = (procs, sessions, o = {}) => buildThreads({ procs, desktop: () => null, sessions, board, mirrorIndex: null, maxTurns: (n) => ({ terminus: 90, golem: 40 })[n] ?? null, now: T0, staleMin: 15, ...o });

test('filetimeToMs: procStart (FILETIME, 100 нс с 1601) — миллисекунды Unix', () => {
  // 134353944217263152 → 2026-10-02T03:20:21.726Z (startedAt того же процесса — …821.150, разница 0,6 с)
  assert.equal(filetimeToMs('134353944217263152'), 1790920821726);
});

test('процессы: pid жив и procStart совпадает — живой; сверка времени старта — один раз на pid+procStart', async () => {
  const { r, calls } = reader({ '101.json': sessFile() });
  await r.refresh();
  await r.refresh();
  const [e] = r.entries();
  assert.equal(e.live, true);
  assert.equal(e.sessionId, SID);
  assert.equal(calls.length, 1, 'второй опрос — без нового запроса времени старта');
});

test('гейт 5: pid жив, но procStart не совпадает (pid отдан другому процессу) — тред не живой', async () => {
  const { r } = reader({ '101.json': sessFile() }, { starts: { 101: '134348124492355551' } });
  await r.refresh();
  assert.equal(r.entries()[0].live, false);
  assert.equal(build(r.entries(), [session()]).threads.length, 0);
});

test('процессы: pid мёртв — не живой; файлы *.key и не-pid имена не читаются', async () => {
  const files = { '101.json': sessFile(), '101.abc.key': busyErr(), 'x.json': busyErr() };
  const { r } = reader(files, { alive: [] });
  await r.refresh();
  assert.equal(r.entries().length, 1);
  assert.equal(r.entries()[0].live, false);
  assert.equal(r.state().errors, 0, 'ни *.key, ни x.json не открывались');
});

for (const [name, bad] of [['заперт', busyErr()], ['битый', '{"pid": 101, "status": "id']]) {
  test(`гейт 5: файл реестра процессов ${name} — тред «устарело» с возрастом последнего наблюдения, не пропал и не «свободен»`, async () => {
    const files = { '101.json': sessFile() };
    const { r, clock } = reader(files);
    await r.refresh();
    files['101.json'] = bad;
    clock.t = T0 + 16 * MIN;
    await r.refresh();
    assert.equal(r.state().errors, 1);
    const { threads } = build(r.entries(), [session()], { now: clock.t });
    assert.equal(threads.length, 1, 'не пропал');
    assert.equal(threads[0].state, 'stale');
    assert.equal(threads[0].lastState, 'idle', 'последнее вычисленное состояние');
    assert.equal(threads[0].lastSeenAt, new Date(T0).toISOString(), 'возраст — от последнего удачного наблюдения');
  });
}

test('гейт 5, исправный случай: реестр читается, тред простаивает 20 мин — «свободен», не «устарело»', async () => {
  const { r, clock } = reader({ '101.json': sessFile({ updatedAt: T0 - 20 * MIN, statusUpdatedAt: T0 - 20 * MIN }) });
  clock.t = T0;
  await r.refresh();
  const { threads } = build(r.entries(), [session()]);
  assert.equal(threads[0].state, 'idle');
  assert.equal(threads[0].lastState, null);
});

const live = (o = {}) => ({ pid: 101, sessionId: SID, hostSessionId: 'local_h1', name: 'тред', status: 'idle', startedAt: T0 - 60 * MIN, observedAt: T0, live: true, ...o });

test('(А) открытый AskUserQuestion — «ждёт тебя» при любом status, в том числе busy', () => {
  for (const status of ['busy', 'idle']) {
    const t = build([live({ status })], [session({ thread: { ...session().thread, askOpen: true, askAt: new Date(T0).toISOString() } })]).threads[0];
    assert.equal(t.state, 'waiting', status);
    assert.equal(t.waitingKind, 'askUserQuestion');
  }
});

test('(Б) законченный ответ с «?» — «ждёт тебя» только при status ≠ busy; без вопроса — свободен / работает', () => {
  const q = session({ thread: { ...session().thread, endTurnQ: true, endTurnAt: new Date(T0).toISOString() } });
  assert.deepEqual([build([live({ status: 'idle' })], [q]).threads[0].state, build([live({ status: 'idle' })], [q]).threads[0].waitingKind], ['waiting', 'question']);
  assert.equal(build([live({ status: 'busy' })], [q]).threads[0].state, 'busy');
  const noQ = session({ thread: { ...session().thread, endTurnQ: false } });
  assert.equal(build([live({ status: 'idle' })], [noQ]).threads[0].state, 'idle');
  assert.equal(build([live({ status: 'busy' })], [noQ]).threads[0].state, 'busy');
});

test('незнакомый status — «свободен» и счётчик по значению', () => {
  const r = build([live({ status: 'waiting_for_permission' })], [session()]);
  assert.equal(r.threads[0].state, 'idle');
  assert.deepEqual(r.unknownStatus, { waiting_for_permission: 1 });
  assert.equal(threadState({ status: 'busy', askOpen: false, endTurnQ: null }), 'busy');
});

test('проект треда (1): название «<КОД> · » или «<КОД>: » и код есть на доске', () => {
  const desk = (title) => () => ({ title });
  assert.equal(build([live()], [session()], { desktop: desk('EXT · витрина') }).threads[0].project, 'EXT');
  assert.equal(build([live()], [session()], { desktop: desk('CAR: портал') }).threads[0].project, 'CAR');
  assert.equal(build([live({ name: 'IPTV · плеер' })], [session()]).threads[0].project, 'IPTV', 'нет десктопного названия — name реестра процессов');
  assert.equal(build([live()], [session()], { desktop: desk('ZZZ · чужое') }).threads[0].project, null, 'кода нет на доске — не код');
  assert.equal(build([live()], [session()], { desktop: desk('Портал: CAR new') }).threads[0].project, null, 'код не в начале');
});

test('проект треда (2): код карточек Ивана и записей на доску — больше половины упоминаний; иначе «не определён»', () => {
  const at = new Date(T0 - 30 * MIN).toISOString();
  const s3 = session({ ivan: { cards: { 'EXT-26': { n: 2, firstAt: at, lastAt: at }, 'CAR-264': { n: 1, firstAt: at, lastAt: at } } }, boardWrites: [{ at, refs: ['EXT-27'], firstLine: 'коммент' }] });
  assert.equal(build([live()], [s3]).threads[0].project, 'EXT', '3 из 4');
  const s2 = session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: at, lastAt: at }, 'CAR-264': { n: 1, firstAt: at, lastAt: at } } } });
  assert.equal(build([live()], [s2]).threads[0].project, null, 'ровно половина — не больше');
  const ghost = session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: at, lastAt: at }, 'CAR-9999': { n: 5, firstAt: at, lastAt: at } } } });
  assert.equal(build([live()], [ghost]).threads[0].project, 'EXT', 'несуществующий номер не считается');
  assert.equal(build([live()], [session()]).threads[0].project, null);
});

test('карточка треда: последний «▶ выдан»; нет — последний номер Ивана; нет — без карточки; «идёт» — от первого упоминания', () => {
  const a = new Date(T0 - 50 * MIN).toISOString();
  const b = new Date(T0 - 40 * MIN).toISOString();
  const c = new Date(T0 - 10 * MIN).toISOString();
  const ivan = { cards: { 'EXT-26': { n: 1, firstAt: a, lastAt: a }, 'EXT-25': { n: 1, firstAt: c, lastAt: c } } };
  const writes = [{ at: b, refs: ['EXT-26'], firstLine: '▶ выдан: Терминусу В2' }, { at: c, refs: ['EXT-25'], firstLine: '⏸ получен: Голем' }];
  const t = build([live()], [session({ ivan, boardWrites: writes })]).threads[0];
  assert.equal(t.card, 'EXT-26');
  assert.equal(t.sinceKind, 'card');
  assert.equal(t.since, a, 'первое упоминание карточки в сессии — сообщение Ивана раньше записи');
  const t2 = build([live()], [session({ ivan })]).threads[0];
  assert.equal(t2.card, 'EXT-25', 'последний по времени номер в сообщениях Ивана');
  const t3 = build([live()], [session()]).threads[0];
  assert.equal(t3.card, null);
  assert.equal(t3.sinceKind, 'opened');
  assert.equal(t3.since, new Date(T0 - 60 * MIN).toISOString(), 'открыт — от startedAt');
  const uuid = session({ boardWrites: [{ at: b, refs: ['5b0c0a6e-0000-4000-8000-00000000000a'], firstLine: '▶ выдан Терминусу' }] });
  assert.equal(build([live()], [uuid], { mirrorIndex: { cards: { 'EXT-27': { uuid: '5b0c0a6e-0000-4000-8000-00000000000a' } } } }).threads[0].card, 'EXT-27', 'UUID — через index.json зеркала; маркер без двоеточия');
});

test('субагенты: живой запуск живого треда — кто, что, ходы текущего захода, тормоз, ориентир; копия с итогом в другой сессии — снята', () => {
  const run = (o) => ({ agentId: 'a1', agentType: 'terminus', description: 'EXT-27 В3', target: 60, alive: true, lastEndAt: null, currentZakhod: 12, lastAt: new Date(T0 - 5 * MIN).toISOString(), ...o });
  const mine = session({ runs: [run(), run({ agentId: 'a2', agentType: 'golem' }), run({ agentId: 'a3', alive: false })] });
  const other = { ...session(), sessionId: 'bbbbbbbb-2222-4000-8000-000000000002', runs: [run({ agentId: 'a2', alive: false, lastEndAt: new Date(T0 - 1 * MIN).toISOString() })] };
  const r = build([live()], [mine, other]);
  assert.deepEqual(r.threads[0].subagents, [{ agent: 'terminus', who: 'Терминус', description: 'EXT-27 В3', turns: 12, maxTurns: 90, target: 60 }]);
  assert.equal(r.subagentsCount, 1);
  // исправный случай: итог в другой сессии раньше последней строки агента (агент продолжен) — живой
  const otherOld = { ...other, runs: [run({ agentId: 'a2', alive: false, lastEndAt: new Date(T0 - 30 * MIN).toISOString() })] };
  assert.equal(build([live()], [mine, otherOld]).threads[0].subagents.length, 2);
});

test('сессия-копия: два файла процесса с одним sessionId — одна строка; мёртвый тред не показывается', () => {
  const r = build([live(), live({ pid: 202 }), live({ pid: 303, sessionId: 'cccccccc-3333-4000-8000-000000000003', live: false })], [session()]);
  assert.equal(r.threads.length, 1);
});

test('порядок: ждёт тебя → работает → свободен → устарело; внутри — свежие сверху', () => {
  const S = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
  const procs = [live({ sessionId: S(1), status: 'idle' }), live({ sessionId: S(2), status: 'busy' }), live({ sessionId: S(3), observedAt: T0 - 20 * MIN }), live({ sessionId: S(4), status: 'idle' })];
  const ss = [1, 2, 3, 4].map((n) => session({ sessionId: S(n), thread: { ...session().thread, askOpen: n === 4, lastAt: new Date(T0 - n * MIN).toISOString() } }));
  assert.deepEqual(build(procs, ss).threads.map((t) => [t.sessionId.slice(0, 8), t.state]), [['00000004', 'waiting'], ['00000002', 'busy'], ['00000001', 'idle'], ['00000003', 'stale']]);
});

// ---------- дозапрос EXT-27: status «waiting» + waitingFor (факт дирижёра 02.10, тред pid 13920) ----------
test('status waiting: «permission prompt» — ждёт тебя (разрешение); «input needed» — ждёт тебя (вопрос); при любых (А)/(Б)', () => {
  const p = build([live({ status: 'waiting', waitingFor: 'permission prompt' })], [session()]);
  assert.deepEqual([p.threads[0].state, p.threads[0].waitingKind], ['waiting', 'permission']);
  assert.deepEqual(p.unknownStatus, {}, 'waiting — известное значение');
  const i = build([live({ status: 'waiting', waitingFor: 'input needed' })], [session()]).threads[0];
  assert.deepEqual([i.state, i.waitingKind], ['waiting', 'askUserQuestion']);
});

test('status waiting с незнакомым waitingFor — ждёт тебя с причиной «?» и счётчик; исправный idle — свободен', () => {
  const r = build([live({ status: 'waiting', waitingFor: 'something new' })], [session()]);
  assert.deepEqual([r.threads[0].state, r.threads[0].waitingKind], ['waiting', '?']);
  assert.deepEqual(r.unknownWaitingFor, { 'something new': 1 });
  const ok = build([live({ status: 'idle', waitingFor: null })], [session()]);
  assert.deepEqual([ok.threads[0].state, ok.threads[0].waitingKind], ['idle', null]);
  assert.deepEqual(ok.unknownWaitingFor, {});
});

test('процессы: поле waitingFor читается из файла реестра', async () => {
  const { r } = reader({ '101.json': sessFile({ status: 'waiting', waitingFor: 'permission prompt' }) });
  await r.refresh();
  assert.equal(r.entries()[0].waitingFor, 'permission prompt');
});

test('«идёт N»: первое упоминание карточки раньше старта процесса (копия сессии) — от startedAt', () => {
  const old = new Date(T0 - 300 * MIN).toISOString();
  const t = build([live()], [session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: old, lastAt: old } } } })]).threads[0];
  assert.equal(t.card, 'EXT-26');
  assert.equal(t.sinceKind, 'card');
  assert.equal(t.since, new Date(T0 - 60 * MIN).toISOString());
  const fresh = new Date(T0 - 30 * MIN).toISOString();
  assert.equal(build([live()], [session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: fresh, lastAt: fresh } } } })]).threads[0].since, fresh, 'исправный случай: упоминание после старта');
});

test('проект: пометка источника — по названию / по карточкам / не определён; название — третья ступень custom-title', () => {
  const at = new Date(T0 - 30 * MIN).toISOString();
  assert.equal(build([live()], [session()], { desktop: () => ({ title: 'EXT · витрина' }) }).threads[0].projectBy, 'title');
  assert.equal(build([live()], [session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: at, lastAt: at } } } })]).threads[0].projectBy, 'cards');
  assert.equal(build([live()], [session()]).threads[0].projectBy, null);
  const ct = build([live({ name: null })], [session({ thread: { ...session().thread, customTitle: 'CAR · портал' } })]).threads[0];
  assert.deepEqual([ct.title, ct.project, ct.projectBy], ['CAR · портал', 'CAR', 'title']);
});

// ---------- дозапрос EXT-27: Иван назвал треды голым кодом («EXT», «CAR», «LETGER» с опечаткой) — снимок 02.10 ----------
test('проект по названию: равно коду или код + пробел/·/:/—/- в начале → код; «CARS», «LETGER», код не в начале → по карточкам', () => {
  const at = new Date(T0 - 30 * MIN).toISOString();
  const withCards = session({ ivan: { cards: { 'EXT-26': { n: 1, firstAt: at, lastAt: at } } } });
  const p = (title) => { const t = build([live()], [withCards], { desktop: () => ({ title }) }).threads[0]; return [t.project, t.projectBy]; };
  for (const [title, code] of [['EXT', 'EXT'], ['  CAR  ', 'CAR'], ['CAR · портал', 'CAR'], ['CAR: x', 'CAR'], ['CAR — x', 'CAR'], ['CAR-x', 'CAR'], ['IPTV плеер', 'IPTV']]) {
    assert.deepEqual(p(title), [code, 'title'], title);
  }
  for (const title of ['CARS', 'LETGER', 'Портал: CAR new', 'CARS · x']) assert.deepEqual(p(title), ['EXT', 'cards'], title);
  assert.deepEqual(build([live()], [session()], { desktop: () => ({ title: 'LETGER' }) }).threads[0].project, null, 'исправный: ни кода, ни карточек — не определён');
});
