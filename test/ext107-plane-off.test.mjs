// EXT-107 Р5 (спека, раздел EXT-107 «Р5. Plane после гашения»): API витрины в режиме live без Plane — freshness.mirror = null,
// planeQueue = null; нет .mirror/ — тихо null без ошибок читателей. Экран (EXT-91) не трогается — 1а и 2а проверяют его
// по исходникам web/src, как ext91-t3-page. Гейт Р5: №1, 1а, 2, 2а, 3, 4, 5. Доски — временные копии, не живая доска.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { cardRefs } from '../lib/threads.mjs';
import { buildMarks } from '../lib/waiting.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git } from './helpers.mjs';

const lib = (f) => import(new URL(`file:///${BOARD_LIB}/${f}`).href);
const { parseCard } = await lib('header.mjs');
const { parseLog, latest } = await lib('log.mjs');
const { scan } = await lib('secrets.mjs');
const { similar } = await lib('similar.mjs');
const lockLib = await lib('lock.mjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(BOARD_LIB, '..');
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8')).boardWriteTools;
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');
const PORT = 4317; // только заголовок Host у inject: сервер не слушает
const HOST = `127.0.0.1:${PORT}`;
const Q_MD = 'Ветка готова — `ext-7` можно принимать?';
const LAST_OK = '2026-10-14T09:05:00.000Z';
// подпись — как её пишет зеркало доски (В-5): местное время ДД.ММ ЧЧ:ММ; ожидаемое считается здесь, не кодом под тестом
const p2 = (n) => String(n).padStart(2, '0');
const LABEL = (() => { const d = new Date(LAST_OK); return `доска: зеркало Plane от ${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; })();
const UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
let n = 0;
const intent = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// временная доска: mode из аргумента (null — без board.config.json), .mirror/ вне git (как у живой: в .gitignore)
function makeTmpBoard({ mode = 'live', mirror = true } = {}) {
  const dir = tmpDir('ext107r5-board-');
  makeBoard(dir, { codes: ['EXT'], cards: [{ id: 'EXT-7', status: 'review', title: 'Семь' }, { id: 'EXT-8', status: 'review', title: 'Восемь' }] });
  if (mode) fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode, push: false, tz: 'Europe/Riga' }) + '\n');
  else fs.rmSync(path.join(dir, 'board.config.json'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.mirror/\n');
  fs.cpSync(TOOLS, path.join(dir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) });
  for (const id of ['EXT-7', 'EXT-8']) fs.writeFileSync(path.join(dir, 'EXT', `${id}.log.md`), `### 2026-10-03 12:00 +03:00 · trurl:EXT · коммент\n\n${Q_MD}\n\n`);
  const f8 = path.join(dir, 'EXT', 'EXT-8.md');
  fs.writeFileSync(f8, fs.readFileSync(f8, 'utf8').replace('owner: ""', 'owner: "trurl:EXT"'));
  gitInitCommit(dir);
  git(dir, 'config', 'user.name', 'Иван Тест');
  git(dir, 'config', 'user.email', 'ivan@test.local');
  if (mirror) {
    fs.mkdirSync(path.join(dir, '.mirror'));
    fs.writeFileSync(path.join(dir, '.mirror', 'status.json'), JSON.stringify({ lastOk: LAST_OK }));
    fs.writeFileSync(path.join(dir, '.mirror', 'index.json'), JSON.stringify({ cards: { 'EXT-7': { uuid: UUID } } }));
  }
  return dir;
}

async function setup({ mode = 'live', mirror = true, pultOn = true, planePy = null, python = process.execPath } = {}) {
  const boardDir = makeTmpBoard({ mode, mirror });
  const data = tmpDir('ext107r5-data-');
  const web = tmpDir('ext107r5-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(path.join(tmpDir('ext107r5-reg-'), 'registry.json'));
  const logLines = [];
  const slog = { write: (kind, o) => logLines.push({ kind, ...o }) };
  // pult — как его собирает start.mjs: boardRoot и mirrorDir есть и при выключенном пульте
  const app = await buildApp({ port: PORT, board, registry, scan, similar, webDir: web, log: slog,
    pult: { enabled: pultOn, words: true, actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python, planePy: planePy ?? path.join(tmpDir('ext107r5-noplane-'), 'plane.py') } });
  const get = async (url) => { const r = await app.inject({ method: 'GET', url, headers: { host: HOST } }); assert.equal(r.statusCode, 200, url); return r.json(); };
  const token = (await app.inject({ method: 'GET', url: '/', headers: { host: HOST } })).body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = async (body) => (await app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: intent(), ...body }),
    headers: { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } })).json();
  return { app, board, boardDir, get, press, logLines };
}

// ---------- №1: live с .mirror/status.json — freshness.mirror = null ----------

test('Р5 №1: live, .mirror/status.json с lastOk — /api/ceh и /api/project → freshness.mirror = null (пульт включён и выключен)', async () => {
  for (const pultOn of [true, false]) {
    const s = await setup({ mode: 'live', pultOn });
    // вход годный: читатель доски файл видит и подпись бы дал — null из-за режима, а не из-за файла
    assert.deepEqual(s.board.mirrorStatus(), { lastOkAt: LAST_OK, label: LABEL });
    const ceh = await s.get('/api/ceh');
    assert.equal(ceh.boardMode, 'live');
    assert.equal(ceh.freshness.mirror, null, `pult.enabled=${pultOn}: ${JSON.stringify(ceh.freshness.mirror)}`);
    assert.equal((await s.get('/api/project/EXT')).freshness.mirror, null);
    await s.app.close();
  }
});

// ---------- №1а: экран — в шапке live нет «зеркало Plane от …» (EXT-91, App.jsx) ----------

test('Р5 №1а: экран — подпись возраста зеркала только вне live (App.jsx), в live — «доска в git»', () => {
  const a = src('App.jsx');
  assert.match(a, /\{!live && mirror && <>/);
  assert.match(a, /\{live && <>.*доска в git/);
  assert.match(a, /boardMode === 'live'/);
});

// ---------- №2: live, пульт включён — planeQueue = null ----------

test('Р5 №2: live, пульт включён — /api/health → planeQueue = null; прочие поля health на месте', async () => {
  const s = await setup({ mode: 'live', pultOn: true });
  const h = await s.get('/api/health');
  assert.equal(h.ok, true);
  assert.ok('planeQueue' in h, 'поле есть');
  assert.equal(h.planeQueue, null, JSON.stringify(h.planeQueue));
  assert.deepEqual(h.pult, { enabled: true });
  await s.app.close();
});

// ---------- №2а: экран — меню «Служебное» без зеркала, ход зеркала вне прохода скрыт ----------

test('Р5 №2а: экран — в live меню «Служебное» без пунктов зеркала (Service.jsx), ход зеркала только у идущего прохода (Mirror.jsx)', () => {
  const s = src('Service.jsx');
  assert.match(s, /\{!live && <RefreshMirror shown=\{open\} \/>\}/);
  assert.match(s, /\{!live && <FullMirror \/>\}/);
  const m = src('Mirror.jsx');
  assert.match(m, /if \(live && s\.phase !== 'running'\) return null;/);
});

// ---------- №3: исправный — mirror с .mirror/: подпись и очередь как раньше; неясный режим — тоже как раньше ----------

test('Р5 №3: mirror с .mirror/ — freshness.mirror с подписью, planeQueue — объект очереди; доска без board.config.json — как mirror', async () => {
  for (const mode of ['mirror', null]) {
    const s = await setup({ mode, pultOn: true });
    const ceh = await s.get('/api/ceh');
    assert.equal(ceh.boardMode, mode);
    assert.deepEqual(ceh.freshness.mirror, { lastOkAt: LAST_OK, label: LABEL }, `mode=${mode}`);
    assert.deepEqual((await s.get('/api/project/EXT')).freshness.mirror, { lastOkAt: LAST_OK, label: LABEL });
    assert.deepEqual((await s.get('/api/health')).planeQueue, { running: 0, queued: 0 }, `mode=${mode}`);
    await s.app.close();
  }
  // меню в mirror: пункты зеркала на месте (условие только !live)
  assert.match(src('Service.jsx'), /<RefreshMirror shown=\{open\} \/>/);
  assert.match(src('Service.jsx'), /<FullMirror \/>/);
});

// ---------- №4: live без .mirror/ + журналы с UUID-ссылками ----------

test('Р5 №4: live без .mirror/ — читатели без ошибок, mirrorIndex/mirrorStatus — null; UUID-ссылка без карточки, номерные — как раньше', async () => {
  const s = await setup({ mode: 'live', mirror: false, pultOn: true });
  assert.equal(s.board.mirrorIndex(), null);
  assert.equal(s.board.mirrorStatus(), null);
  const h = await s.get('/api/health');
  assert.equal(h.readers.board.failingSince ?? null, null, JSON.stringify(h.readers.board));
  const ceh = await s.get('/api/ceh');
  assert.equal(ceh.freshness.mirror, null);
  assert.equal(ceh.freshness.board.failingSince, null);
  // журнал: старый вызов Plane по UUID, по номеру и запись board.mjs
  const st = newSessionState();
  const T = Date.parse('2026-10-10T10:00:00Z');
  const call = (k, item) => {
    feedSession(st, { type: 'assistant', timestamp: new Date(T + k * 60000).toISOString(), message: { id: `m${k}`, stop_reason: 'tool_use', content: [item] } }, { rules: RULES });
    feedSession(st, { type: 'user', timestamp: new Date(T + k * 60000 + 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: 'ok' }] } }, { rules: RULES });
  };
  call(1, { type: 'tool_use', id: 'u1', name: 'mcp__plane__create_work_item_comment', input: { work_item_id: UUID, comment_html: '<p>коммент по uuid</p>' } });
  call(2, { type: 'tool_use', id: 'u2', name: 'mcp__plane__create_work_item_comment', input: { work_item_id: 'EXT-7', comment_html: '<p>коммент по номеру</p>' } });
  call(3, { type: 'tool_use', id: 'u3', name: 'Bash', input: { command: 'node C:/projects/unorbis-board/tools/board.mjs --as trurl:EXT log EXT-8 коммент --body "запись"' } });
  assert.equal(st.boardWrites.length, 3, 'все три записи разобраны');
  const sess = { sessionId: 'sid-r5', boardWrites: st.boardWrites };
  assert.deepEqual(cardRefs(sess, s.board, s.board.mirrorIndex()).map((w) => w.ids), [[], ['EXT-7'], ['EXT-8']]);
  // исправный: тот же журнал при индексе зеркала — UUID даёт номер
  assert.deepEqual(cardRefs(sess, s.board, { cards: { 'EXT-7': { uuid: UUID } } }).map((w) => w.ids), [['EXT-7'], ['EXT-7'], ['EXT-8']]);
  assert.doesNotThrow(() => buildMarks({ procs: [{ sessionId: 'sid-r5', live: true, startedAt: T - 86400000 }], sessions: [{ sessionId: 'sid-r5', boardWrites: st.boardWrites }], board: s.board, mirrorIndex: s.board.mirrorIndex(), now: T + 3600000, thresholds: { taktYellowMin: 60, taktRedMin: 180, waitingOverDayHours: 24 } }));
  assert.deepEqual(s.logLines.filter((l) => l.kind === 'error'), [], 'в server.log нет ошибок');
  await s.app.close();
});

// ---------- №5: live, plane.py нет, подменный python пишет аргументы — ни одного вызова ----------

// «python» — node с предзагрузкой (NODE_OPTIONS --require): каждый запуск node пишет свои аргументы в файл. Вызов plane.py
// узнаётся по пути planePy в аргументах; исправный ряд (mirror) показывает, что запись срабатывает.
async function withRecorder(fn) {
  const dir = tmpDir('ext107r5-rec-');
  const out = path.join(dir, 'argv.log');
  const rec = path.join(dir, 'rec.cjs');
  fs.writeFileSync(rec, `require('fs').appendFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)) + '\\n');\n`);
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${prev ? prev + ' ' : ''}--require "${rec.replaceAll('\\', '/')}"`; // в кавычках NODE_OPTIONS «\» — экранирование
  try { return await fn(() => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])); }
  finally { if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev; }
}

test('Р5 №5: live, pult.planePy на несуществующий файл — за «Принять», «Вернуть» и проход зеркала ни одного вызова python; проход — отказ mode-live; исправный ряд mirror — вызов есть', async () => {
  await withRecorder(async (argv) => {
    const planePy = path.join(tmpDir('ext107r5-gone-'), 'plane.py');
    const s = await setup({ mode: 'live', pultOn: true, planePy });
    const Q = { at: '2026-10-03T09:00:00.000Z', head: Q_MD };
    const a = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
    assert.equal(a.outcome, 'ok', JSON.stringify(a));
    const r = await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'нет теста' });
    assert.equal(r.outcome, 'ok', JSON.stringify(r));
    for (const body of [{ action: 'mirror' }, { action: 'mirror', kind: 'full' }]) {
      const m = await s.press(body);
      assert.deepEqual([m.outcome, m.refusal], ['refused', 'mode-live'], JSON.stringify(m));
    }
    await s.get('/api/health');
    await s.get('/api/ceh');
    assert.ok(argv().length > 0, 'запись аргументов работает (board.mjs — тоже node)');
    assert.deepEqual(argv().filter((a2) => a2.includes(planePy)), [], 'plane.py не звался');
    assert.equal(fs.existsSync(planePy), false);
    await s.app.close();
    // исправный ряд: mirror, тот же подменный python — «Принять» зовёт plane.py
    const m = await setup({ mode: 'mirror', pultOn: true, planePy });
    await m.press({ action: 'accept', card: 'EXT-7', q: Q });
    assert.ok(argv().some((a2) => a2.includes(planePy)), `в mirror plane.py зовётся: ${JSON.stringify(argv())}`);
    await m.app.close();
  });
});
