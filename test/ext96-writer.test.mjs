// ПТ14 (EXT-96; спека пульта §2.3 правило 1а «последний писавший на карточку», §1.7 confirm.target и ringTarget, §3.3 пп.17–18,
// §3.4 target.by, §7 строка ПТ14): выбор (pickThread с готовым списком писателей), разбор вывода git, сведение номера через
// priorCliSessionIds (buildWorkers → prior), маршруты (слова, «Вернуть», одно чтение на POST, mirror / нет boardRoot / session /
// pick — без git, сбой и таймаут git — правила 2–4 и writer-skip), метка writer в исходе, actions.log, /api/actions и подписях страницы.
// Git в маршрутах — шов seams.writersGit (считает вызовы, бросает, висит); одна проверка — на ВРЕМЕННОЙ доске настоящим board.mjs
// (§3.3 п.18), никогда не на C:\projects\unorbis-board. Ожидания — из спеки и из положенного в тест.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickThread, parseWriters, writerArgs, readWriters, WRITER_DEPTH, WRITER_TIMEOUT_MS } from '../lib/pult/bell.mjs';
import { buildWorkers } from '../lib/waiting.mjs';
import { actionRows } from '../lib/pult/actions-log.mjs';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git } from './helpers.mjs';

const { ringTargetNote, confirmTargetNote } = await import('../web/src/pultData.js');
const lib = (f) => import(new URL(`file:///${BOARD_LIB}/${f}`).href);
const { parseCard } = await lib('header.mjs');
const { parseLog, latest } = await lib('log.mjs');
const { scan } = await lib('secrets.mjs');
const { similar } = await lib('similar.mjs');
const lockLib = await lib('lock.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(BOARD_LIB, '..');
const PORT = 4317; // только заголовок Host у app.inject — порт не слушается
const SELF = `http://127.0.0.1:${PORT}`;
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S1 = sid(1); const S2 = sid(2); const S3 = sid(3); const S4 = sid(4); const S5 = sid(5); const S9 = sid(9);
const OLD = sid(71); const FORK = sid(72);
const NOW = Date.parse('2026-10-11T12:00:00Z');
let intents = 9600;
const nextIntent = () => sid(++intents);

// живые треды: строки «Кто работает»
const th = (sessionId, o = {}) => ({ sessionId, title: `Тред ${sessionId.slice(-2)}`, project: 'EXT', card: null, state: 'busy', lastSeenAt: new Date(NOW).toISOString(), ...o });
const L = (hash, as, sess) => [hash, as, sess].join('\x1f');

// ---------------- выбор: pickThread с готовым списком писателей ----------------

test('1а: писатель жив → он, by writer; тред с той же карточкой треда рядом (правило 2) не выбран; без писателей — правило 2 (контроль)', () => {
  const threads = [th(S1), th(S2, { card: 'EXT-7' })];
  const r = pickThread({ threads, card: 'EXT-7', writers: [S1], now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.sessionId, S1);
  assert.equal(r.target.by, 'writer');
  const before = pickThread({ threads, card: 'EXT-7', now: NOW });
  assert.deepEqual([before.kind, before.target.sessionId, before.target.by], ['one', S2, 'card']);
});

test('1а: писатель мёртв, следующий (старее) жив → следующий; повтор той же сессии — одна проверка, не «несколько»', () => {
  const threads = [th(S1), th(S2)];
  const r = pickThread({ threads, card: 'EXT-9', writers: [S9, S9, S2, S1], now: NOW });
  assert.deepEqual([r.kind, r.target.sessionId, r.target.by], ['one', S2, 'writer']);
});

test('1а: писатель — прораб (foreman) → к следующей, более старой сессии — тред проекта', () => {
  const threads = [th(S1), th(S3, { foreman: true, card: 'EXT-9' })];
  const r = pickThread({ threads, card: 'EXT-9', writers: [S3, S1], now: NOW });
  assert.deepEqual([r.kind, r.target.sessionId, r.target.by], ['one', S1, 'writer']);
  // только прораб среди писателей — правила 2–4 (прораб не кандидат: остаётся S1 по проекту)
  const only = pickThread({ threads, card: 'EXT-9', writers: [S3], now: NOW });
  assert.deepEqual([only.kind, only.target.sessionId, only.target.by], ['one', S1, 'project']);
});

test('1а: писатель «устарело» → он, со staleMin («нет вестей N мин»)', () => {
  const threads = [th(S1), th(S2, { state: 'stale', lastSeenAt: new Date(NOW - 25 * 60000).toISOString() })];
  const r = pickThread({ threads, card: 'EXT-9', writers: [S2], now: NOW });
  assert.deepEqual([r.kind, r.target.sessionId, r.target.by, r.target.staleMin], ['one', S2, 'writer', 25]);
});

test('1а (В3): писатель жив, но тред другого проекта и не этой карточки — пропуск; тред без проекта (не этой карточки) — пропуск; к следующей сессии', () => {
  const threads = [th(S1), th(S2), th(S4, { project: 'CAR' }), th(S5, { project: null })];
  const r = pickThread({ threads, card: 'EXT-9', writers: [S4, S5, S1], now: NOW });
  assert.deepEqual([r.kind, r.target.sessionId, r.target.by], ['one', S1, 'writer']);
  // ни одна не прошла (в) — правила 2–4: два треда EXT → несколько
  const none = pickThread({ threads, card: 'EXT-9', writers: [S4, S5], now: NOW });
  assert.equal(none.kind, 'many');
  // тред без проекта, но с карточкой треда = эта — проходит (в)
  const own = pickThread({ threads: [th(S1), th(S2), th(S5, { project: null, card: 'EXT-9' })], card: 'EXT-9', writers: [S5], now: NOW });
  assert.deepEqual([own.target.sessionId, own.target.by], [S5, 'writer']);
});

test('1а (В4): старый номер в priorCliSessionIds ровно одного живого треда → он; у двух живых (форк) → пропуск; нигде → пропуск', () => {
  const threads = [th(S1), th(S2)];
  const prior = new Map([[OLD, [S1]], [FORK, [S1, S2]]]);
  const one = pickThread({ threads, card: 'EXT-9', writers: [OLD], prior, now: NOW });
  assert.deepEqual([one.kind, one.target.sessionId, one.target.by], ['one', S1, 'writer']);
  const fork = pickThread({ threads, card: 'EXT-9', writers: [FORK], prior, now: NOW });
  assert.equal(fork.kind, 'many', 'форк — пропуск, дальше правила 2–4');
  const fork2 = pickThread({ threads, card: 'EXT-9', writers: [FORK, S2], prior, now: NOW });
  assert.deepEqual([fork2.target.sessionId, fork2.target.by], [S2, 'writer'], 'после пропуска форка — следующая сессия');
  const nowhere = pickThread({ threads, card: 'EXT-9', writers: [S9], prior, now: NOW });
  assert.equal(nowhere.kind, 'many');
});

test('1а исправный откат: ни одна сессия из списка не жива → исход правил 2–4 ровно как до EXT-96; строка (а) (session) писателей не смотрит', () => {
  const dead = Array.from({ length: 30 }, (_, i) => sid(100 + i));
  for (const threads of [[th(S1), th(S2)], [th(S1)], [th(S2, { card: 'EXT-9' }), th(S1)], [th(S4, { project: 'CAR' })]]) {
    assert.deepEqual(pickThread({ threads, card: 'EXT-9', writers: dead, now: NOW }), pickThread({ threads, card: 'EXT-9', now: NOW }));
  }
  const row = pickThread({ threads: [th(S1), th(S2)], card: 'EXT-9', session: S2, writers: [S1], now: NOW });
  assert.deepEqual([row.target.sessionId, row.target.by], [S2, 'row']);
});

// ---------------- разбор вывода git и команда ----------------

test('команда — ровно из спеки: log -n 30 --no-merges, трейлеры с unfold и separator=%x2C, пути карточки; глубина 30, таймаут 3 с', () => {
  assert.equal(WRITER_DEPTH, 30);
  assert.equal(WRITER_TIMEOUT_MS, 3000);
  assert.deepEqual(writerArgs('EXT-96'), ['log', '-n', '30', '--no-merges',
    '--format=%H%x1f%(trailers:key=Board-As,valueonly,unfold,separator=%x2C)%x1f%(trailers:key=Board-Session,valueonly,unfold,separator=%x2C)',
    '--', 'EXT/EXT-96.md', 'EXT/EXT-96.log.md']);
});

test('разбор: два значения Board-Session или Board-As, пустое, не UUID, неверное число полей, чужая подпись, ivan — не считается только этот коммит; соседи читаются; повтор — один раз', () => {
  const out = [
    L('a1', 'trurl:EXT', S1),
    L('a2', 'trurl:EXT', `${S2},${S3}`), // два значения сессии
    L('a3', 'trurl:EXT,trurl:EXT', S3), // два значения подписи
    L('a4', 'trurl:EXT', ''), // пустое
    L('a5', 'trurl:EXT', 'not-a-uuid'),
    ['a6', 'trurl:EXT'].join('\x1f'), // два поля
    [L('a7', 'trurl:EXT', S3), 'x'].join('\x1f'), // четыре поля
    L('a8', 'trurl:INFRA', S3), // тред другой зоны
    L('a9', 'ivan', ''),
    L('b1', 'mirror', S3),
    L('b2', 'trurl:EXT', S1), // повтор
    L('b3', 'trurl:EXT', S2.toUpperCase()),
    '',
    L('b4', 'trurl:EXT', S4),
  ].join('\n') + '\n';
  assert.deepEqual(parseWriters(out, 'EXT'), [S1, S2, S4]);
  // CRLF не ломает строки
  assert.deepEqual(parseWriters(`${L('c1', 'trurl:EXT', S1)}\r\n${L('c2', 'trurl:EXT', S2)}\r\n`, 'EXT'), [S1, S2]);
  assert.deepEqual(parseWriters('', 'EXT'), []);
});

test('readWriters: один вызов обёртки в boardRoot ровно этой командой; сбой — исключение с кодом; висит дольше таймаута — TIMEOUT', async () => {
  const calls = [];
  const ok = await readWriters({ git: async (repo, args) => { calls.push([repo, args]); return `${L('h', 'trurl:EXT', S2)}\n`; }, root: 'C:/b', card: 'EXT-9' });
  assert.deepEqual(ok, [S2]);
  assert.deepEqual(calls, [['C:/b', writerArgs('EXT-9')]]);
  await assert.rejects(readWriters({ git: async () => { throw Object.assign(new Error('x'), { code: 128 }); }, root: 'C:/b', card: 'EXT-9' }), (e) => e.code === 'EXIT_128');
  const t0 = Date.now();
  await assert.rejects(readWriters({ git: () => new Promise(() => {}), root: 'C:/b', card: 'EXT-9', timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
});

// ---------------- сведение номера: prior из buildWorkers ----------------

test('buildWorkers отдаёт prior: прежний номер → живые сессии, у форка — две (признак «два и более»)', () => {
  const A = sid(11); const B = sid(12);
  const proc = (s, host) => ({ pid: Number(s.slice(-2)), sessionId: s, name: 'EXT · тред', live: true, startedAt: NOW - 3600000, status: 'busy', observedAt: NOW, statusUpdatedAt: NOW, hostSessionId: host });
  const desktop = (h) => (h === 'ha' ? { title: 'EXT · а', priorCliSessionIds: [OLD, FORK, A] } : h === 'hb' ? { title: 'EXT · б', priorCliSessionIds: [FORK] } : null);
  const board = { hasCard: () => false, card: () => null, hasCode: (c) => c === 'EXT', hasBoard: true };
  const w = buildWorkers({ exists: () => true, procs: [proc(A, 'ha'), proc(B, 'hb')], desktop, sessions: [], board, now: NOW });
  assert.ok(w.prior instanceof Map);
  assert.deepEqual(w.prior.get(OLD), [A]);
  assert.deepEqual([...w.prior.get(FORK)].sort(), [A, B].sort());
  assert.equal(w.prior.has(A), false, 'свой номер — не прежний');
});

// ---------------- /api/actions и подписи страницы ----------------

test('actionRows: ringTarget из ring-queued.target ({title, by, staleMin?}); шага ring-queued нет — null', () => {
  const at = '2026-10-11T12:00:00.000+03:00';
  const rows = actionRows([
    { id: 'W-1', step: 'asked', at, action: 'return', card: 'EXT-9' },
    { id: 'W-1', step: 'ring-queued', at, action: 'return', card: 'EXT-9', target: { sessionId: S1, title: 'Тред 01', by: 'writer' } },
    { id: 'W-1', step: 'done', at, action: 'return', card: 'EXT-9', result: { outcome: 'ok' } },
    { id: 'W-2', step: 'asked', at, action: 'yes', card: 'EXT-9' },
    { id: 'W-2', step: 'ring-queued', at, action: 'yes', card: 'EXT-9', target: { sessionId: S2, title: 'Тред 02', by: 'project', staleMin: 20 } },
    { id: 'W-3', step: 'asked', at, action: 'accept', card: 'EXT-9' },
    { id: 'W-3', step: 'done', at, action: 'accept', card: 'EXT-9', result: { outcome: 'ok' } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.ringTarget]));
  assert.deepEqual(by['W-1'], { title: 'Тред 01', by: 'writer' });
  assert.deepEqual(by['W-2'], { title: 'Тред 02', by: 'project', staleMin: 20 });
  assert.equal(by['W-3'], null);
});

test('подписи страницы — дословно из спеки: «Мои слова» у writer, confirm.target у Б-слова; у прочих by подписи writer нет', () => {
  assert.equal(ringTargetNote({ title: 'EXT · витрина', by: 'writer' }), 'тред «EXT · витрина» · последним писал на карточку');
  assert.equal(ringTargetNote({ title: 'EXT · витрина', by: 'project' }), null);
  assert.equal(ringTargetNote(null), null);
  assert.equal(confirmTargetNote({ sessionId: S1, title: 'EXT · витрина', by: 'writer' }), 'сейчас последним писал тред «EXT · витрина» — звонок выберет при втором щелчке');
  assert.equal(confirmTargetNote(null), null);
});

// ---------------- маршруты ----------------

function makeLiveBoard({ mode = 'live' } = {}) {
  const dir = tmpDir('ext96-board-');
  makeBoard(dir, { codes: ['EXT', 'CAR'], cards: [
    { id: 'EXT-7', status: 'review', title: 'Семь' }, { id: 'EXT-8', status: 'review', title: 'Восемь' }, { id: 'EXT-9', status: 'in-progress', title: 'Девять' },
  ] });
  fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode, push: false, tz: 'Europe/Riga' }) + '\n');
  fs.cpSync(TOOLS, path.join(dir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) });
  for (const id of ['EXT-7', 'EXT-8', 'EXT-9']) fs.writeFileSync(path.join(dir, 'EXT', `${id}.log.md`), '### 2026-10-03 12:00 +03:00 · trurl:EXT · коммент\n\nготово — можно принимать?\n\n');
  gitInitCommit(dir);
  git(dir, 'config', 'user.name', 'Иван Тест');
  git(dir, 'config', 'user.email', 'ivan@test.local');
  return dir;
}
const Q = { at: '2026-10-03T09:00:00.000Z', head: 'готово — можно принимать?' };
const QU = { uuid: '11111111-2222-4333-8444-555555555555', at: '2026-10-11T08:00:00.000Z' };

// writersGit — шов чтения писателей (null — настоящий git); calls — его вызовы; slog — строки server.log
async function setup({ mode = 'live', threads = [th(S1), th(S2)], writers = null, noRoot = false, prior = null, timeoutMs = null, before = null, listHook = null } = {}) {
  const boardDir = makeLiveBoard({ mode });
  before?.(boardDir);
  const data = tmpDir('ext96-data-');
  const actionsLog = path.join(data, 'actions.log');
  const pdir = tmpDir('ext96-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  fs.writeFileSync(path.join(pdir, 'state.json'), JSON.stringify({ status: 'Review', comments: [], clock: '2026-10-03T09:20:00.123456Z' }));
  const web = tmpDir('ext96-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(path.join(tmpDir('ext96-reg-'), 'registry.json'));
  const calls = [];
  const slog = [];
  const threadsApi = { list: () => (listHook?.(boardDir), { threads, prior: prior ?? new Map(), subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: '2026-10-11T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions: () => [{ sessionId: S1, lines: 3, thread: { q: QU } }] };
  const seams = writers ? { writersGit: (repo, args) => { calls.push({ repo, args }); return writers(calls.length, repo, args); } } : {};
  const app = await buildApp({ port: PORT, board, registry, scan, similar, webDir: web, threads: threadsApi, journals,
    log: { write: (event, f = {}) => { slog.push({ event, ...f }); return ''; }, writeLine() {} },
    pult: { enabled: true, words: true, bell: true, bellDir: path.join(data, 'bell'), actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: noRoot ? null : boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { ...seams, ...(timeoutMs ? { writersTimeoutMs: timeoutMs } : {}) } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const getActions = () => app.inject({ method: 'GET', url: '/api/actions', headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'x-vitrina-token': token } });
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const queued = (id) => lines().find((l) => l.id === id && l.step === 'ring-queued');
  const entries = (id) => parseLog(fs.readFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), 'utf8'));
  const qOf = async (id) => (await app.inject({ method: 'GET', url: `/api/card/${id}`, headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'x-vitrina-token': token } })).json().pult.q;
  return { app, press, lines, queued, entries, calls, slog, boardDir, getActions, qOf };
}
const one = (s) => async () => `${L('h1', 'trurl:EXT', s)}\n`;

test('маршрут: не-Б слово при двух живых тредах EXT и живом писателе → без need-confirm: запись и звонок писателю (by writer в ring-queued и в исходе); одно чтение на POST', async () => {
  const s = await setup({ writers: one(S2) });
  const r = await s.press({ action: 'yes', card: 'EXT-9', q: Q });
  const b = r.json();
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.match(b.message, /тред «Тред 02» \(последним писал на карточку\): положено — тред услышит, когда закончит ход$/);
  assert.deepEqual(s.queued(b.id).target, { sessionId: S2, title: 'Тред 02', by: 'writer' });
  assert.ok(s.entries('EXT-9').at(-1).body.includes(b.id), 'запись на карточке легла');
  assert.equal(s.calls.length, 1, 'одно чтение на проверку «несколько» и звонок');
  assert.equal(s.calls[0].repo, s.boardDir);
  assert.deepEqual(s.calls[0].args, writerArgs('EXT-9'));
  // ringTarget в «Моих словах»
  const row = (await s.getActions()).json().find((x) => x.id === b.id);
  assert.deepEqual(row.ringTarget, { title: 'Тред 02', by: 'writer' });
});

test('маршрут: писатель не жив (исправный откат) → как до EXT-96: два треда — need-confirm с кандидатами, writer в кандидатах нет', async () => {
  const s = await setup({ writers: one(S9) });
  const r = await s.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r.json().outcome, 'need-confirm');
  assert.deepEqual(r.json().confirm.candidates.map((c) => [c.sessionId, c.by]), [[S1, 'project'], [S2, 'project']]);
  assert.equal(r.json().confirm.target, undefined);
});

test('маршрут: Б-слово → первый щелчок даёт confirm.target (by writer, название по маске) и тот же target в need-confirm; второй читает git заново и зовёт фактического писателя', async () => {
  const s = await setup({ writers: async (n) => `${L('h', 'trurl:EXT', n === 1 ? S1 : S2)}\n` });
  const first = await s.press({ action: 'merge', card: 'EXT-7', q: Q });
  const f = first.json();
  assert.equal(f.outcome, 'need-confirm', JSON.stringify(f));
  assert.deepEqual(f.confirm.target, { sessionId: S1, title: 'Тред 01', by: 'writer' });
  assert.equal(f.confirm.candidates, undefined);
  const nc = s.lines().find((l) => l.id === f.id && l.step === 'need-confirm');
  assert.deepEqual(nc.confirm.target, f.confirm.target);
  assert.equal(s.calls.length, 1);
  const second = await s.press({ action: 'merge', card: 'EXT-7', q: Q, confirm: f.id });
  assert.equal(second.json().outcome, 'ok', JSON.stringify(second.json()));
  assert.equal(s.calls.length, 2, 'второй щелчок — новое чтение');
  assert.deepEqual(s.queued(second.json().id).target, { sessionId: S2, title: 'Тред 02', by: 'writer' });
});

test('маршрут: «Вернуть» — одно чтение до звонка, звонок писателю без выбора; «Принять» (звонка нет) git не читает', async () => {
  const s = await setup({ writers: one(S1) });
  const r = await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'доделай' });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.match(r.json().message, /тред «Тред 01» \(последним писал на карточку\): положено/);
  assert.equal(r.json().ring?.state ?? s.lines().find((l) => l.id === r.json().id && l.step === 'done').result.ring.state, 'queued');
  assert.deepEqual(s.queued(r.json().id).target.by, 'writer');
  assert.equal(s.calls.length, 1);
  const a = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(a.json().outcome, 'ok', JSON.stringify(a.json()));
  assert.equal(s.calls.length, 1, '«Принять» git не читает');
});

test('маршрут: режим mirror и нет boardRoot → 0 вызовов git, выбор как до EXT-96 (несколько — need-confirm); кроме прораба никого — git не читается', async () => {
  const m = await setup({ mode: 'mirror', writers: one(S1) });
  const r = await m.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r.json().outcome, 'need-confirm');
  assert.equal(m.calls.length, 0);
  const n = await setup({ noRoot: true, writers: one(S1) });
  const r2 = await n.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r2.json().outcome, 'need-confirm');
  assert.equal(n.calls.length, 0);
  const f = await setup({ threads: [th(S3, { foreman: true })], writers: one(S1) });
  const r3 = await f.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r3.json().outcome, 'ok', JSON.stringify(r3.json()));
  assert.equal(f.calls.length, 0);
  // контроль: live с корнем и живыми тредами — читает
  const c = await setup({ writers: one(S1) });
  await c.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(c.calls.length, 1);
});

test('маршрут: session (строка (а)) и pick → 0 вызовов git, цель прежняя (row / pick)', async () => {
  const s = await setup({ writers: one(S1) });
  const rr = await s.press({ action: 'reply', session: S1, q: QU, text: 'ок' });
  assert.equal(rr.json().outcome, 'ok', JSON.stringify(rr.json()));
  assert.equal(s.queued(rr.json().id).target.by, 'row');
  const pk = await s.press({ action: 'yes', card: 'EXT-9', q: Q, pick: S2 });
  assert.equal(pk.json().outcome, 'ok', JSON.stringify(pk.json()));
  assert.deepEqual(s.queued(pk.json().id).target, { sessionId: S2, title: 'Тред 02', by: 'pick' });
  assert.equal(s.calls.length, 0);
});

test('маршрут: сбой git (шов бросает) → правила 2–4, исход не error, строка writer-skip в server.log с кодом словом', async () => {
  const s = await setup({ threads: [th(S1), th(S4, { project: 'CAR' })], writers: async () => { throw Object.assign(new Error('fatal: not a git repository'), { code: 128 }); } });
  const r = await s.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.deepEqual(s.queued(r.json().id).target, { sessionId: S1, title: 'Тред 01', by: 'project' });
  assert.deepEqual(s.slog.filter((l) => l.event === 'writer-skip'), [{ event: 'writer-skip', route: 'bell', card: 'EXT-9', code: 'EXIT_128' }]);
  assert.ok(!JSON.stringify(s.slog).includes('not a git repository'), 'вывода git в server.log нет');
});

test('маршрут: git висит дольше таймаута → правила 2–4, исход не error, writer-skip TIMEOUT', async () => {
  const s = await setup({ threads: [th(S1), th(S4, { project: 'CAR' })], writers: () => new Promise(() => {}), timeoutMs: 200 });
  const r = await s.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.equal(s.queued(r.json().id).target.by, 'project');
  assert.deepEqual(s.slog.filter((l) => l.event === 'writer-skip').map((l) => l.code), ['TIMEOUT']);
});

test('временная доска (§3.3 п.18): коммит настоящим board.mjs с CLAUDE_CODE_SESSION_ID — «Вернуть» без шва зовёт этого писателя; запись витрины (ivan) не считается', async () => {
  const body = path.join(tmpDir('ext96-body-'), 'b.md');
  fs.writeFileSync(body, 'сделал, смотри\n');
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: S2 };
  const write = (dir) => execFileSync(process.execPath, [path.join(dir, 'tools', 'board.mjs'), '--as', 'trurl:EXT', '--root', dir, 'log', 'EXT-8', 'коммент', '--body-file', body], { env, windowsHide: true, encoding: 'utf8' });
  const s = await setup({ threads: [th(S1), th(S2)], before: write });
  assert.equal(git(s.boardDir, 'log', '-1', '--format=%(trailers:key=Board-Session,valueonly)').trim(), S2);
  const real = () => readWriters({ git: createGitRead({ timeoutMs: WRITER_TIMEOUT_MS }), root: s.boardDir, card: 'EXT-8' });
  assert.deepEqual(await real(), [S2]);
  const r = await s.press({ action: 'return', card: 'EXT-8', q: await s.qOf('EXT-8'), text: 'доделай' });
  const b = r.json();
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.deepEqual(s.queued(b.id).target, { sessionId: S2, title: 'Тред 02', by: 'writer' });
  // после записи витрины (Board-As: ivan, без Board-Session) последним «писателем» остаётся S2
  assert.ok(git(s.boardDir, 'log', '-1', '--format=%(trailers:key=Board-As,valueonly)').includes('ivan'));
  assert.deepEqual(await real(), [S2]);
});

// ревью Голема на 726a3a6, Важно 1: сбой сбора тредов в writersFor у «Вернуть» (после setStatus) — не ошибка нажатия.
// До EXT-96 тот же сбой в звонке давал ring.state error при исходе ok; исключение из writersFor не должно уходить из actLive
const returned = (dir) => /^status: ready/m.test(fs.readFileSync(path.join(dir, 'EXT', 'EXT-8.md'), 'utf8'));
test('«Вернуть»: threads.list бросает только в вызове writersFor после setStatus → исход ok, статус сменён, writer-skip ERR, звонок по правилам 2–4 (project)', async () => {
  let thrown = 0;
  const s = await setup({ threads: [th(S1), th(S4, { project: 'CAR' })], writers: one(S1),
    listHook: (dir) => { if (!thrown && returned(dir)) { thrown += 1; throw new Error('сбор тредов упал'); } } });
  const r = await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'доделай' });
  const b = r.json();
  assert.equal(thrown, 1, 'сбой случился ровно в одном вызове — после смены статуса');
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.ok(returned(s.boardDir), 'карточка вернулась (ready)');
  assert.equal(s.calls.length, 0, 'до git не дошло');
  assert.deepEqual(s.slog.filter((l) => l.event === 'writer-skip'), [{ event: 'writer-skip', route: 'bell', card: 'EXT-8', code: 'ERR' }]);
  assert.deepEqual(s.queued(b.id).target, { sessionId: S1, title: 'Тред 01', by: 'project' });
});

test('«Вернуть»: threads.list бросает во всех вызовах после setStatus → исход ok, ring.state error — как до EXT-96', async () => {
  const s = await setup({ writers: one(S1), listHook: (dir) => { if (returned(dir)) throw new Error('сбор тредов упал'); } });
  const r = await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'доделай' });
  const b = r.json();
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.ok(returned(s.boardDir));
  assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'done').result.ring.state, 'error');
  assert.equal(s.calls.length, 0);
});
