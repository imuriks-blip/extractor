// Общая оснастка тестов «Отозвать» (EXT-71, спека пульта §1.9): витрина на подменном plane.py (test/fake-plane.mjs) и временной доске,
// «рестарт» — второй buildApp на тех же data/bell/actions.log/state.json. Настоящий Plane и mirror.mjs не запускаются.
// Подмена выхода plane.py — seams.planeRun: «висит на comment» (до записи или после неё) — промис, который не завершается.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createPlaneSpawn } from '../lib/pult/accept.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 71000;
export const nextIntent = () => uuid(++intents);
export const SID = uuid(801);
export const SID2 = uuid(802);

export const Q_MD = '**Ветка** готова — `ext-7` можно принимать?';
export const Q_HTML = '<p><strong>Ветка</strong> готова — <code>ext-7</code> можно принимать?</p>';
export const Q_AT = '2026-10-03T09:00:00.000Z';
export const Q = { at: Q_AT, head: Q_MD };
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;

// EXT-20, EXT-21 обычные (А-дело), EXT-22 в Review (сливай), EXT-24 закрыта
export const boardDir = makeBoard(tmpDir('ext71-board-'), { codes: ['EXT'], cards: [
  { id: 'EXT-20', status: 'in-progress', title: 'Обычная' }, { id: 'EXT-21', status: 'in-progress', title: 'Обычная два' },
  { id: 'EXT-22', status: 'review', title: 'Слияние' }, { id: 'EXT-24', status: 'done', title: 'Закрыта' },
] });
for (const id of ['EXT-20', 'EXT-21', 'EXT-22', 'EXT-24']) fs.writeFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), logWith(Q_MD));
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: '2026-10-03T09:30:00.000Z', lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка: настоящий не запускается\n');
const regFile = path.join(tmpDir('ext71-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
export const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

export const thread = (sid, o = {}) => ({ sessionId: sid, title: `тред ${sid.slice(-3)}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), ...o });

export function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ch = new EventEmitter();
    ch.pid = 9000 + calls.length;
    ch.unref = () => {};
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  fn.calls = calls;
  return fn;
}

// env — файлы одной «витрины»: общие для запуска и рестарта
export function makeEnv(plane = {}) {
  const data = tmpDir('ext71-data-');
  const pdir = tmpDir('ext71-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'In Progress', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z', ...plane }));
  const web = tmpDir('ext71-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  return { data, pdir, stateFile, web, actionsLog: path.join(data, 'actions.log'), bellDir: path.join(data, 'bell'),
    // подмена выхода plane.py и часы — общие для запусков
    hook: { hang: null }, clock: { t: null }, threads: [], sessions: [] };
}

// запуск (и «рестарт» — повторный запуск на том же env)
export async function boot(env, { words = true, bell = true, mirror = false, threads = env.threads } = {}) {
  env.threads = threads;
  const spawn = fakeSpawn();
  const real = createPlaneSpawn({ python: process.execPath, planePy: path.join(env.pdir, 'fake-plane.mjs') });
  const hung = () => new Promise(() => {});
  const planeRun = async (args) => {
    const h = env.hook.hang;
    if (h === 'show' && args[0] === 'show') return hung();
    if (h === 'comment-before' && args[0] === 'comment') return hung();
    if (h === 'comment-gate' && args[0] === 'comment') { await env.hook.gate; return real(args); } // пауза, которую отпускает тест
    if (h === 'comment-after' && args[0] === 'comment') { await real(args); return hung(); }
    return real(args);
  };
  const threadsApi = { list: () => ({ threads: env.threads, subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: '2026-10-04T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions: () => env.sessions };
  const server = []; // server.log: [вид, поля]
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: env.web, threads: threadsApi, journals, log: { write: (k, o) => server.push([k, o]) },
    pult: { enabled: true, words, bell, bellDir: env.bellDir, actionsLog: env.actionsLog, ...(mirror ? { mirrorDir: path.join(boardDir, '.mirror') } : {}), lock: lockLib, boardRoot: boardDir },
    pultSeams: { spawn, planeRun, ...(env.clock.t ? { now: () => env.clock.t } : {}) } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => (fs.existsSync(env.actionsLog) ? fs.readFileSync(env.actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // state.json пишет подменный plane.py: чтение в момент записи — повтор
  const pl = () => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(fs.readFileSync(env.stateFile, 'utf8')); } catch (e) { if (i > 40) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
    }
  };
  const setPlane = (patch) => fs.writeFileSync(env.stateFile, JSON.stringify({ ...pl(), ...patch }));
  const bellGet = (sid) => app.inject({ method: 'GET', url: `/api/bell/${sid}`, headers: { host: `127.0.0.1:${PORT}` } }).then((x) => x.json());
  const bellLog = (o) => { fs.mkdirSync(env.bellDir, { recursive: true }); fs.appendFileSync(path.join(env.bellDir, 'bell.log'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); };
  const signals = () => (fs.existsSync(env.bellDir) ? fs.readdirSync(env.bellDir, { recursive: true }).map(String).filter((f) => f.endsWith('.ring') && !f.startsWith('undelivered')) : []);
  const rowOf = async (id) => (await get('/api/actions?since=2000-01-01T00:00:00Z')).find((x) => x.id === id);
  // слово: действие yes/go/… по карточке с живым тредом; → тело ответа
  const word = async (action = 'yes', card = 'EXT-20', extra = {}) => (await press({ action, card, q: Q, ...extra })).json();
  return { app, server, press, get, lines, pl, setPlane, spawn, bellGet, bellLog, signals, rowOf, word, env };
}

export const cmds = (calls) => (calls ?? []).map((c) => c[0] + (c[0] === 'state' ? ` ${c[2]}` : ''));
export const stepsOf = (lines, id) => lines.filter((l) => l.id === id).map((l) => l.step);
