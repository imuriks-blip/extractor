// Пульт ПТ1 (EXT-39; спека пульта §1.1, §1.7, §3.1, §3.4, §4): каркас записи — POST /api/act с защитой §4.1,
// словарь действий (пустышки + ping), intentId, actions.log, очередь записей в Plane, ручки §1.7, токен в index.html.
// Пятнадцать тестов пробы П.4 (probe/p4/pult.test.mjs) — здесь на настоящем сервере (buildApp).
// Метка [<проверка>] в имени — какой тест должен покраснеть, если проверку выключить: PULT_OFF=<имя> подменяет набор
// проверок в этом файле (test/pult-blind.mjs прогоняет все по одной). Ожидаемые значения — из спеки и из того,
// что положено в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import Fastify from 'fastify';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { CHECKS } from '../lib/pult/guard.mjs';
import { ACTIONS } from '../lib/pult/actions.mjs';
import { createPlaneQueue } from '../lib/pult/queue.mjs';
import { withToken } from '../lib/web-static.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const EVIL = 'http://127.0.0.1:4398';
const OFF = (process.env.PULT_OFF ?? '').split(',').filter(Boolean);
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 0;
const nextIntent = () => uuid(++intents);

// одна доска и реестр на файл — их только читают
const boardDir = makeBoard(tmpDir('board-'), { codes: ['EXT', 'CAR'], cards: [{ id: 'EXT-6', status: 'review' }, { id: 'CAR-1', status: 'review' }] });
gitInitCommit(boardDir);
const regFile = path.join(tmpDir('reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard });
await board.init();
const registry = createRegistryReader(regFile);

// собранный интерфейс: оболочка с заглушкой токена, как её выдаёт сборка Vite (web/index.html)
const STUB = '<!doctype html><html><head><meta charset="utf-8"><meta name="vitrina-token" content="__VITRINA_TOKEN__"><title>t</title></head><body></body></html>';

async function setup({ off = OFF, enabled = true, words = true, bell = true, handlers, now, mirrorDir, html = STUB, checks, planeRun, data = tmpDir('pult-'), boardRoot = boardDir, spawn = fakeSpawn() } = {}) {
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), html);
  const actionsLog = path.join(data, 'actions.log');
  const logLines = [];
  const app = await buildApp({
    port: PORT, board, registry, scan, webDir: web,
    log: { write: (ev, f) => logLines.push({ ev, ...f }) },
    // флаги и пути — как из config.json; подмены для тестов — отдельным параметром (конфиг защиту не выключит)
    // звонок (ПТ4а) включён: ручка ждущего отвечает (pult.bell = false — 503, свой тест в pult-accept)
    pult: { enabled, words, bell, bellDir: path.join(data, 'bell'), actionsLog, mirrorDir: mirrorDir ?? tmpDir('mirror-'), lock: lockLib, boardRoot },
    pultSeams: { checks: checks ?? CHECKS.filter((c) => !off.includes(c.name)), handlers, now, planeRun, spawn },
  });
  const raw = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '');
  const lines = () => raw().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { app, lines, raw, actionsLog, logLines, data };
}

// подменный запуск процесса (EXT-42): ни один тест не запускает настоящий wscript/mirror.mjs. fail — код ошибки
// запуска (событие error, как у spawn при ненайденном файле); throwSync — исключение из самого вызова
function fakeSpawn({ fail, throwSync, exitCode } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const c = { cmd, args, opts, unref: 0 };
    calls.push(c);
    if (throwSync) throw Object.assign(new Error('spawn'), { code: throwSync });
    const ch = new EventEmitter();
    ch.pid = fail ? undefined : 7000 + calls.length;
    ch.unref = () => { c.unref++; };
    process.nextTick(() => (fail ? ch.emit('error', Object.assign(new Error(`spawn ${cmd} ${fail}`), { code: fail })) : ch.emit('spawn')));
    // exitCode — wscript вышел сразу после запуска (node не стартовал — 9009, mirror.mjs остановился до замка — 1/2)
    if (exitCode !== undefined && !fail) setTimeout(() => ch.emit('exit', exitCode, null), 5);
    return ch;
  };
  fn.calls = calls;
  return fn;
}

// токен — так, как его возьмёт страница: из отданного HTML
async function pageToken(app, host = `127.0.0.1:${PORT}`) {
  const r = await app.inject({ method: 'GET', url: '/', headers: { host } });
  assert.equal(r.statusCode, 200);
  const m = r.body.match(/<meta name="vitrina-token" content="([^"]+)">/);
  assert.ok(m, 'на странице нет токена');
  return m[1];
}

// исправный запрос браузера со своей страницы; over — что сломать
function act(app, token, over = {}) {
  const headers = { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token, ...over.headers };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  const payload = over.payload ?? JSON.stringify(over.body ?? { action: 'ping', intentId: nextIntent() });
  return app.inject({ method: over.method ?? 'POST', url: over.url ?? '/api/act', headers, payload });
}
const steps = (lines) => lines.map((l) => l.step);

// ---------------- 15 тестов П.4 на настоящем сервере ----------------

test('исправный: страница отдаёт токен, POST ping с ним проходит, в actions.log — asked и done', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'ok');
  assert.deepEqual(steps(lines()), ['asked', 'done']);
  assert.ok(lines().every((l) => l.action === 'ping' && l.id === r.json().id));
});

test('исправный: через localhost (Host и Origin localhost:<порт>) тоже проходит', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app, `localhost:${PORT}`);
  const r = await act(app, token, { headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(steps(lines()), ['asked', 'done']);
});

test('токен не в куки и не в адресе: у страницы нет Set-Cookie', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(r.headers['set-cookie'], undefined);
});

test('[token] без X-Vitrina-Token → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, undefined, { headers: { 'x-vitrina-token': undefined } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

// EXT-47: «Отложить до …» и «Вернуть сейчас» идут через ту же защиту — без токена 403, в actions.log не дошло
test('[token] defer и undefer без X-Vitrina-Token → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  for (const body of [{ action: 'defer', intentId: nextIntent(), rowKey: 'EXT-6|x', until: '1h' }, { action: 'undefer', intentId: nextIntent(), rowKey: 'EXT-6|x' }]) {
    const r = await act(app, undefined, { headers: { 'x-vitrina-token': undefined }, body });
    assert.equal(r.statusCode, 403, body.action);
  }
  assert.equal(lines().length, 0);
});

test('[token] чужой токен той же длины → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const wrong = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  const r = await act(app, wrong);
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('[token] токен меняется при рестарте: старый на новом сервере → 403', async () => {
  const a = await setup();
  const old = await pageToken(a.app);
  const b = await setup();
  assert.notEqual(await pageToken(b.app), old);
  const r = await act(b.app, old);
  assert.equal(r.statusCode, 403);
  assert.equal(b.lines().length, 0);
});

test('[origin] чужой Origin (127.0.0.1:4398) с верным токеном → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: EVIL } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('[origin] без Origin → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: undefined } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('[origin] Origin: null (файл, песочница iframe) → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: 'null' } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('[content-type] text/plain с JSON в теле → 415, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'text/plain' } });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

test('[content-type] форма application/x-www-form-urlencoded → 415, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=ping' });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

test('[content-type] обманка «text/plain; application/json» → 415, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'text/plain; application/json' } });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

test('[host] Host evil.example → 421 и на POST, и на странице с токеном', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const r = await act(app, token, { headers: { host: `evil.example:${PORT}` } });
  assert.equal(r.statusCode, 421);
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: `evil.example:${PORT}` } });
  assert.equal(page.statusCode, 421);
  assert.ok(!page.body.includes(token));
  assert.equal(lines().length, 0);
});

test('[method] GET /api/act → 405, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { method: 'GET', payload: '', headers: { 'content-type': undefined } });
  assert.equal(r.statusCode, 405);
  assert.equal(lines().length, 0);
});

test('[method] предварительный запрос OPTIONS → 405; ни он, ни страница не отдают Access-Control-Allow-*', async () => {
  const { app } = await setup();
  const pre = await app.inject({ method: 'OPTIONS', url: '/api/act', headers: { host: `127.0.0.1:${PORT}`, origin: EVIL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-vitrina-token' } });
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}`, origin: EVIL } });
  const cors = (h) => Object.keys(h).filter((k) => k.startsWith('access-control-allow'));
  assert.deepEqual(cors(pre.headers), []);
  assert.deepEqual(cors(page.headers), []);
  assert.equal(pre.statusCode, 405);
});

// ---------------- Sec-Fetch-Site (в пробе не было) ----------------

test('[sec-fetch-site] cross-site, same-site, none и без заголовка → 403, в actions.log не дошло', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  for (const v of ['cross-site', 'same-site', 'none', undefined]) {
    const r = await act(app, token, { headers: { 'sec-fetch-site': v } });
    assert.equal(r.statusCode, 403, String(v));
  }
  assert.equal(lines().length, 0);
});

// ---------------- отрицательный контроль: каждая проверка зрячая ----------------
// Сервер без одной проверки пропускает запрос, сломанный ровно по ней: значит, отказ в тестах выше дала она.

const BROKEN = {
  host: { headers: { host: `evil.example:${PORT}` } },
  method: { method: 'PUT' },
  'content-type': { headers: { 'content-type': 'text/plain' } },
  origin: { headers: { origin: EVIL } },
  'sec-fetch-site': { headers: { 'sec-fetch-site': 'cross-site' } },
  token: { headers: { 'x-vitrina-token': 'x'.repeat(43) } },
};

test('отрицательный контроль: запрос, сломанный по одной проверке, отбит ею; без неё — проходит дальше', async () => {
  for (const [name, over] of Object.entries(BROKEN)) {
    const full = await setup({ off: [] });
    const refused = await act(full.app, await pageToken(full.app), over);
    const code = CHECKS.find((c) => c.name === name).code;
    assert.equal(refused.statusCode, code, `${name}: с проверкой`);
    const blind = await setup({ off: [name] });
    const passed = await act(blind.app, await pageToken(blind.app), over);
    assert.notEqual(passed.statusCode, code, `${name}: без проверки отказ ${code} не должен случиться`);
  }
});

test('отрицательный контроль Sec-Fetch-Site: без этой проверки cross-site доходит до actions.log, с ней — нет', async () => {
  const over = { headers: { 'sec-fetch-site': 'cross-site' } };
  const blind = await setup({ off: ['sec-fetch-site'] });
  const r = await act(blind.app, await pageToken(blind.app), over);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(steps(blind.lines()), ['asked', 'done']);
  const full = await setup({ off: [] });
  assert.equal((await act(full.app, await pageToken(full.app), over)).statusCode, 403);
  assert.equal(full.lines().length, 0);
});

test('порядок проверок §4.1: чиним по одной — код идёт 421 → 405 → 415 → 403 (Origin) → 403 (Sec-Fetch-Site) → 403 (токен) → 200', async () => {
  const { app, logLines } = await setup();
  const token = await pageToken(app);
  const all = { host: 'evil.example', origin: EVIL, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain', 'x-vitrina-token': 'bad' };
  const seq = [];
  let h = { ...all };
  const fixes = [['host', `127.0.0.1:${PORT}`], ['method'], ['content-type', 'application/json'], ['origin', SELF], ['sec-fetch-site', 'same-origin'], ['x-vitrina-token', token]];
  let method = 'PUT';
  for (const [k, v] of [[null], ...fixes]) {
    if (k === 'method') method = 'POST'; else if (k) h = { ...h, [k]: v };
    seq.push((await act(app, token, { method, headers: h })).statusCode);
  }
  assert.deepEqual(seq, [421, 405, 415, 403, 403, 403, 200]);
  // server.log: код и имя проверки, ни текста, ни токена
  const denies = logLines.filter((l) => l.ev === 'req' && l.status >= 400).map((l) => [l.status, l.deny]);
  assert.deepEqual(denies, [[421, 'host'], [405, 'method'], [415, 'content-type'], [403, 'origin'], [403, 'sec-fetch-site'], [403, 'token']]);
  assert.ok(!JSON.stringify(logLines).includes(token));
});

// ---------------- общий хук: POST только на /api/act ----------------

test('[method] POST на иные пути, PUT и DELETE на /api/act, OPTIONS на / → 405', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  for (const url of ['/api/health', '/api/ceh', '/', '/api/act/']) assert.equal((await act(app, token, { url })).statusCode, 405, url);
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await act(app, token, { method })).statusCode, 405, method);
  assert.equal((await app.inject({ method: 'OPTIONS', url: '/', headers: { host: `127.0.0.1:${PORT}` } })).statusCode, 405);
  assert.equal(lines().length, 0);
});

// ---------------- сторож парсеров форм (§4.2) ----------------

const formParsers = (app) => ['application/x-www-form-urlencoded', 'multipart/form-data', 'multipart/mixed'].filter((t) => app.hasContentTypeParser(t));

test('сторож: в сервере нет парсера форм (urlencoded, multipart); сторож зрячий — на сервере с парсером видит его', async () => {
  const { app } = await setup();
  assert.deepEqual(formParsers(app), []);
  const control = Fastify();
  control.addContentTypeParser('application/x-www-form-urlencoded', (req, body, done) => done(null, {}));
  assert.deepEqual(formParsers(control), ['application/x-www-form-urlencoded']);
});

// ---------------- токен страницы (§4.1 п.6) ----------------

test('токен: 32 байта, в <meta> оболочки при отдаче сервером, оболочка no-store; сборка Vite несёт заглушку', async () => {
  const { app } = await setup();
  const token = await pageToken(app);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!r.body.includes('__VITRINA_TOKEN__'));
  const idx = await app.inject({ method: 'GET', url: '/index.html', headers: { host: `127.0.0.1:${PORT}` } });
  assert.ok(idx.body.includes(token));
  const src = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(src, /<meta name="vitrina-token" content="__VITRINA_TOKEN__">/);
});

test('токен: оболочка без заглушки (старая сборка) — <meta> вписывается сервером в <head>', async () => {
  const { app } = await setup({ html: '<!doctype html><html><head><title>t</title></head><body></body></html>' });
  const token = await pageToken(app);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
});

// ---------------- флаги (§4.3) ----------------

test('pult.enabled = false: после защиты — 503, в actions.log ничего; защита по-прежнему первая', async () => {
  const { app, lines } = await setup({ enabled: false });
  const token = await pageToken(app);
  assert.equal((await act(app, token)).statusCode, 503);
  assert.equal((await act(app, token, { headers: { origin: EVIL } })).statusCode, 403);
  assert.equal(lines().length, 0);
});

test('pult.words = false: слово («да») → 503 без записи; ping и «Принять» не держатся этим флагом', async () => {
  const { app, lines } = await setup({ words: false });
  const token = await pageToken(app);
  const yes = await act(app, token, { body: { action: 'yes', intentId: nextIntent(), card: 'EXT-6' } });
  assert.equal(yes.statusCode, 503);
  assert.match(yes.json().message, /после правки правил/);
  assert.equal(lines().length, 0);
  // «Принять» флагом слов не держится: без q — 400 по форме (ПТ3), не 503
  assert.equal((await act(app, token, { body: { action: 'accept', intentId: nextIntent(), card: 'EXT-6' } })).statusCode, 400);
  assert.equal((await act(app, token)).statusCode, 200);
});

test('config.default.json: pult.enabled, pult.words и pult.bell — false; папка звонка — data/vitrina/bell/ (§4.3, ПТ4а)', () => {
  const d = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8'));
  assert.deepEqual(d.pult, { enabled: false, words: false, bell: false, bellDir: 'data/vitrina/bell/' });
});

// ---------------- словарь и параметры (§1.1 п.2, §1.3) ----------------

// «Принять» и «Вернуть» подключены в ПТ3 — их проверки в test/pult-accept.test.mjs; слова (да, го, сливай, выкатывай, нет, ответ) — в ПТ6,
// проверки в test/pult-words.test.mjs: здесь 501 только у ещё не подключённых
test('словарь §1.3: шестнадцать действий таблицы (с defer и undefer, EXT-47, и reread, EXT-65) и ping; не подключённые — 501 «ещё не подключено» без строки в actions.log', async () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['accept', 'cleanup', 'defer', 'deploy', 'go', 'merge', 'mirror', 'new-card', 'no', 'ping', 'reindex', 'reply', 'reread', 'return', 'take', 'undefer', 'yes'].sort());
  assert.deepEqual(Object.values(ACTIONS).filter((a) => a.word).map((a) => a.label).sort(), ['да', 'выкатывай', 'го', 'нет', 'ответ треду', 'сливай'].sort());
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const body = { take: { card: 'EXT-6' }, cleanup: {}, reindex: {}, 'new-card': { project: 'EXT', title: 'мысль' } };
  for (const [action, extra] of Object.entries(body)) {
    const r = await act(app, token, { body: { action, intentId: nextIntent(), ...extra } });
    assert.equal(r.statusCode, 501, action);
    assert.match(r.json().message, /ещё не подключено/);
  }
  assert.equal(lines().length, 0);
});

test('параметры: незнакомое действие, карточка не по шаблону или чужого кода, лишнее поле, нет intentId → 400 без записи', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const bad = [
    { action: 'drop-table', intentId: nextIntent() },
    { action: 'accept', intentId: nextIntent(), card: 'ext-6' },
    { action: 'accept', intentId: nextIntent(), card: 'NOPE-1' },
    { action: 'accept', intentId: nextIntent() },
    { action: 'ping', intentId: nextIntent(), extra: 1 },
    { action: 'ping' },
    { action: 'ping', intentId: 'not-a-uuid' },
    { action: 'ping', intentId: nextIntent(), session: '../x' },
    { action: 'ping', intentId: nextIntent(), card: 'EXT-6', text: 'нельзя: у ping нет текста' },
  ];
  for (const b of bad) assert.equal((await act(app, token, { body: b })).statusCode, 400, JSON.stringify(b));
  assert.equal((await act(app, token, { payload: '{"action":' })).statusCode, 400, 'битый JSON');
  assert.equal((await act(app, token, { payload: '[1]' })).statusCode, 400, 'не объект');
  assert.equal(lines().length, 0);
});

test('параметры: пределы текстов по таблице (нет — 300, ответ и «Вернуть» — 500, заголовок — 120, текст карточки — 2000), после снятия управляющих', async () => {
  const { app } = await setup();
  const token = await pageToken(app);
  const code = async (b) => (await act(app, token, { body: { intentId: nextIntent(), ...b } })).statusCode;
  // «нет» подключено (ПТ6): проходит проверку параметров (не 400) и идёт к обработчику; plane.py тут не задан — не предмет теста
  assert.notEqual(await code({ action: 'no', card: 'EXT-6', q: { at: null }, text: 'я'.repeat(300) }), 400);
  assert.equal(await code({ action: 'no', card: 'EXT-6', q: { at: null }, text: 'я'.repeat(301) }), 400);
  assert.notEqual(await code({ action: 'no', card: 'EXT-6', q: { at: null }, text: 'я'.repeat(300) + '\u0007\u0000' }), 400);
  assert.equal(await code({ action: 'reply', card: 'EXT-6', text: 'я'.repeat(501) }), 400);
  assert.equal(await code({ action: 'return', card: 'EXT-6', text: 'я'.repeat(501) }), 400);
  assert.equal(await code({ action: 'return', card: 'EXT-6' }), 400, 'причина «Вернуть» обязательна');
  assert.equal(await code({ action: 'return', card: 'EXT-6', text: '\u0001\u0002' }), 400, 'одни управляющие — пусто');
  assert.equal(await code({ action: 'new-card', project: 'EXT', title: 'я'.repeat(121) }), 400);
  assert.equal(await code({ action: 'new-card', project: 'EXT', title: 'т', text: 'я'.repeat(2001) }), 400);
  assert.equal(await code({ action: 'new-card', project: 'EXT', title: 'т', text: 'я'.repeat(2000) }), 501);
  assert.equal(await code({ action: 'new-card', project: 'NOPE', title: 'т' }), 400);
});

test('тело больше 8 КБ → 400, в actions.log ничего', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const payload = JSON.stringify({ action: 'ping', intentId: nextIntent(), pad: 'x'.repeat(8200) });
  assert.equal((await act(app, token, { payload })).statusCode, 400);
  assert.equal(lines().length, 0);
});

// ---------------- intentId (§1.1 п.3) ----------------

test('intentId: тот же ключ за 10 мин — прежний исход, второго действия нет; через 10 мин и другой ключ — новое', async () => {
  let t = Date.parse('2026-10-02T12:00:00Z');
  const { app, lines } = await setup({ now: () => t });
  const token = await pageToken(app);
  const intentId = nextIntent();
  const a = await act(app, token, { body: { action: 'ping', intentId } });
  t += 9 * 60000;
  const b = await act(app, token, { body: { action: 'ping', intentId } });
  assert.equal(b.statusCode, a.statusCode);
  assert.deepEqual(b.json(), a.json());
  assert.deepEqual(steps(lines()), ['asked', 'done']);
  const c = await act(app, token);
  assert.notEqual(c.json().id, a.json().id);
  t += 2 * 60000;
  const d = await act(app, token, { body: { action: 'ping', intentId } });
  assert.notEqual(d.json().id, a.json().id);
  assert.equal(lines().filter((l) => l.step === 'asked').length, 3);
});

test('intentId: повтор, пока первое ещё идёт, — тот же исход, обработчик вызван один раз', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { app, lines } = await setup({ handlers: { ping: async () => { calls++; await gate; return { outcome: 'ok', message: 'pong' }; } } });
  const token = await pageToken(app);
  const intentId = nextIntent();
  const p1 = act(app, token, { body: { action: 'ping', intentId } });
  const p2 = act(app, token, { body: { action: 'ping', intentId } });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.deepEqual(a.json(), b.json());
  assert.equal(lines().filter((l) => l.step === 'asked').length, 1);
});

// ---------------- лимиты (§4.3) ----------------

test('лимит: 31-е действие за минуту — отказ rate-limit (429, строка refused); через минуту — снова можно', async () => {
  let t = Date.parse('2026-10-02T12:00:00Z');
  const { app, lines } = await setup({ now: () => t });
  const token = await pageToken(app);
  for (let i = 0; i < 30; i++) assert.equal((await act(app, token)).statusCode, 200, String(i));
  const r = await act(app, token);
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().outcome, 'refused');
  const last = lines().at(-1);
  assert.equal(last.step, 'refused');
  assert.equal(last.refusal, 'rate-limit');
  t += 61000;
  assert.equal((await act(app, token)).statusCode, 200);
});

test('лимит: одно действие на карточку за раз — второе на ту же карточку «предыдущее ещё идёт» (409), на другую — проходит', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { app, lines } = await setup({ handlers: { ping: async (ctx) => { if (ctx.card === 'EXT-6') await gate; return { outcome: 'ok', message: 'pong' }; } } });
  const token = await pageToken(app);
  const first = act(app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } });
  await new Promise((r) => setTimeout(r, 50));
  const second = await act(app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } });
  assert.equal(second.statusCode, 409);
  assert.match(second.json().message, /предыдущее ещё идёт/);
  assert.equal((await act(app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'CAR-1' } })).statusCode, 200);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal((await act(app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } })).statusCode, 200, 'после конца — снова можно');
  assert.equal(lines().find((l) => l.step === 'refused').refusal, 'card-busy');
});

// ---------------- actions.log (§3.4) ----------------

test('actions.log: id W-ГГММДД-ЧЧММСС-4hex, местное время с поясом, client {intentId, origin, secFetchSite}; токена нет', async () => {
  const { app, lines, raw } = await setup();
  const token = await pageToken(app);
  const intentId = nextIntent();
  await act(app, token, { body: { action: 'ping', intentId, card: 'EXT-6' } });
  const [asked, done] = lines();
  assert.match(asked.id, /^W-\d{6}-\d{6}-[0-9a-f]{4}$/);
  assert.match(asked.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  const off = -new Date(Date.parse(asked.at)).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  assert.ok(asked.at.endsWith(`${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`), 'пояс машины');
  assert.equal(asked.id.slice(2, 8), asked.at.slice(2, 10).replaceAll('-', ''), 'дата в id — местная');
  assert.deepEqual({ card: asked.card, project: asked.project, action: asked.action }, { card: 'EXT-6', project: 'EXT', action: 'ping' });
  assert.deepEqual(asked.client, { intentId, origin: SELF, secFetchSite: 'same-origin' });
  assert.equal(done.id, asked.id);
  assert.equal(done.step, 'done');
  assert.ok(!raw().includes(token));
});

// ---------------- очередь записей в Plane (§3.1) ----------------

test('очередь Plane: один исполнитель за раз, по порядку; упавший не держит очередь; state — идёт и ждут', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const q = createPlaneQueue({ run: async (args) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; order.push(args[0]); if (args[0] === 'boom') throw new Error('x'); return { code: 0, args }; } });
  const ps = ['a', 'boom', 'b', 'c'].map((x) => q.push([x]));
  assert.deepEqual(q.state(), { running: 1, queued: 3 });
  const res = await Promise.allSettled(ps);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['a', 'boom', 'b', 'c']);
  assert.deepEqual(res.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(q.state(), { running: 0, queued: 0 });
});

test('очередь Plane: обработчик получает очередь сервера — подменный исполнитель вызван; без подмены исполнитель отказывает, ничего не запуская', async () => {
  const seen = [];
  const handlers = { ping: async (ctx) => ({ outcome: 'ok', message: 'pong', result: await ctx.plane.push(['show', ctx.card]) }) };
  const fake = await setup({ handlers, planeRun: async (args) => { seen.push(args); return { code: 0 }; } });
  const r = await act(fake.app, await pageToken(fake.app), { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(seen, [['show', 'EXT-6']]);
  assert.deepEqual(steps(fake.lines()), ['asked', 'done']);
  // в ПТ1 очередь по умолчанию не подключена (plane.py — ПТ3): действие кончается error, строки asked и error
  const real = await setup({ handlers });
  const e = await act(real.app, await pageToken(real.app), { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } });
  assert.equal(e.statusCode, 500);
  assert.equal(e.json().outcome, 'error');
  assert.deepEqual(steps(real.lines()), ['asked', 'error']);
});

// ---------------- ручки §1.7 ----------------

test('GET /api/actions: строки по действию (последний шаг — статус), фильтры, текст по маске, без client', async () => {
  const { app, actionsLog } = await setup();
  const at = (m) => `2026-10-02T1${m}:00:00+03:00`;
  const rows = [
    { id: 'W-261002-100000-aaaa', step: 'asked', at: at(0), action: 'no', card: 'EXT-6', project: 'EXT', text: `ключ ${SECRET}`, client: { intentId: uuid(1) } },
    { id: 'W-261002-100000-aaaa', step: 'done', at: at(0), action: 'no', card: 'EXT-6', project: 'EXT' },
    { id: 'W-261002-110000-bbbb', step: 'asked', at: at(1), action: 'accept', card: 'CAR-1', project: 'CAR', client: { intentId: uuid(2) } },
  ];
  fs.writeFileSync(actionsLog, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const get = async (q) => app.inject({ method: 'GET', url: `/api/actions${q}`, headers: { host: `127.0.0.1:${PORT}` } });
  const all = (await get('?since=2026-10-01T00:00:00Z')).json();
  assert.deepEqual(all.map((r) => [r.id, r.status]), [['W-261002-110000-bbbb', 'asked'], ['W-261002-100000-aaaa', 'done']]);
  assert.ok(!JSON.stringify(all).includes(SECRET));
  assert.match(all[1].text, /\[скрыто/);
  assert.deepEqual(Object.keys(all[0]).sort(), ['action', 'at', 'card', 'id', 'project', 'ring', 'ringAt', 'source', 'status', 'text']);
  assert.equal(all[0].ringAt, null, 'доставки нет (EXT-65)');
  assert.equal(all[0].ring, null, 'звонка у действия нет');
  assert.equal(all[0].source, null, 'источник — ПТ1б');
  assert.deepEqual((await get('?since=2026-10-01T00:00:00Z&card=EXT-6')).json().map((r) => r.id), ['W-261002-100000-aaaa']);
  assert.deepEqual((await get('?since=2026-10-01T00:00:00Z&project=CAR')).json().map((r) => r.id), ['W-261002-110000-bbbb']);
  assert.deepEqual((await get('?since=2026-10-02T10:30:00%2B03:00')).json().map((r) => r.id), ['W-261002-110000-bbbb']);
  for (const q of ['?card=ext-6', '?project=NOPE', '?since=вчера', '?session=../x']) assert.equal((await get(q)).statusCode, 400, q);
});

test('GET /api/mirror: из status.json и run.lock, running по правилу пульса (progress моложе 5 мин или живой run.lock)', async () => {
  const dir = tmpDir('mirror-');
  const st = (o) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(o));
  const lock = (o) => fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify(o));
  const { app } = await setup({ mirrorDir: dir });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();
  const KEYS = ['at', 'cardsDone', 'cardsTotal', 'kind', 'lastError', 'lastFullOk', 'lastOk', 'phase', 'requests', 'rpm', 'running', 'startedAt'];
  const none = await get();
  assert.deepEqual(Object.keys(none).sort(), KEYS);
  assert.equal(none.running, false);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  st({ at: iso(now - 60000), kind: 'full', lastOk: '2026-10-01T10:00:00.000Z', lastFullOk: '2026-09-30T10:00:00.000Z', progress: { phase: 'cards', cards_done: 5, cards_total: 700, requests: 40, rpm: 23, at: iso(now - 60000), started_at: iso(now - 600000) } });
  const live = await get();
  assert.deepEqual([live.running, live.kind, live.phase, live.cardsDone, live.cardsTotal, live.requests, live.rpm, live.startedAt, live.lastOk, live.lastFullOk], [true, 'full', 'cards', 5, 700, 40, 23, iso(now - 600000), '2026-10-01T10:00:00.000Z', '2026-09-30T10:00:00.000Z']);
  st({ at: iso(now - 6 * 60000), kind: 'full', progress: { phase: 'cards', at: iso(now - 6 * 60000), started_at: iso(now - 600000) }, lastError: 'проход красный — см. last-report.txt\nвторая' });
  const stale = await get();
  assert.equal(stale.running, false, 'пульс старше 5 мин, замка нет');
  assert.equal(stale.lastError, 'проход красный — см. last-report.txt', 'первая строка');
  lock({ pid: process.pid, kind: 'changed', at: iso(now), boot: lockLib.bootTime() });
  assert.equal((await get()).running, true, 'живой run.lock (pid жив, та же загрузка)');
  lock({ pid: process.pid, kind: 'changed', at: iso(now), boot: lockLib.bootTime() - 3600000 });
  assert.equal((await get()).running, false, 'run.lock другой загрузки — мёртвый');
  lock({ pid: 0x7ffffff0, kind: 'changed', at: iso(now), boot: lockLib.bootTime() });
  assert.equal((await get()).running, false, 'run.lock с мёртвым pid');
});

test('GET /api/worktrees: заглушка формы — пустой список; проект не по словарю → 400', async () => {
  const { app } = await setup();
  const get = (q) => app.inject({ method: 'GET', url: `/api/worktrees${q}`, headers: { host: `127.0.0.1:${PORT}` } });
  assert.deepEqual((await get('')).json(), []);
  assert.deepEqual((await get('?project=EXT')).json(), []);
  assert.equal((await get('?project=NOPE')).statusCode, 400);
});

test('[bell-browser] GET /api/bell/:sid: без Origin и Sec-Fetch-Site — ответ без слов; с любым из них — 403; sid не UUID — 404', async () => {
  const { app } = await setup();
  const get = (sid, h = {}) => app.inject({ method: 'GET', url: `/api/bell/${sid}`, headers: { host: `127.0.0.1:${PORT}`, ...h } });
  const ok = await get(uuid(7));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ids: [], text: null });
  assert.equal((await get(uuid(7), { origin: SELF })).statusCode, 403);
  assert.equal((await get(uuid(7), { 'sec-fetch-site': 'same-origin' })).statusCode, 403);
  assert.equal((await get(uuid(7), { 'sec-fetch-site': 'none' })).statusCode, 403);
  assert.equal((await get('x')).statusCode, 404);
});

test('сторож GET: каждая ручка пульта дважды подряд — одинаковый ответ, actions.log не меняется', async () => {
  const dir = tmpDir('mirror-');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: '2026-10-02T10:00:00.000Z', kind: 'changed', lastOk: '2026-10-02T10:00:00.000Z' }));
  const { app, raw } = await setup({ mirrorDir: dir });
  await act(app, await pageToken(app));
  const before = raw();
  assert.ok(before.length > 0);
  for (const url of ['/api/actions', '/api/actions?card=EXT-6', '/api/mirror', '/api/worktrees', `/api/bell/${uuid(9)}`]) {
    const a = await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } });
    const b = await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } });
    assert.equal(a.statusCode, 200, url);
    assert.equal(b.body, a.body, url);
  }
  assert.equal(raw(), before);
});

// ---------------- образцы ответов для вёрстки (web/fixtures) ----------------

test('образцы web/fixtures пульта: ключи как у настоящих ручек', async () => {
  const dir = tmpDir('mirror-');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: '2026-10-02T10:00:00.000Z', kind: 'changed', lastOk: '2026-10-02T10:00:00.000Z' }));
  const { app } = await setup({ mirrorDir: dir });
  const fx = (f) => JSON.parse(fs.readFileSync(new URL(`../web/fixtures/${f}`, import.meta.url), 'utf8'));
  const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
  const ok = (await act(app, await pageToken(app))).json();
  assert.deepEqual(keys(fx('act.json').ok), Object.keys(ok).sort());
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const plain = fx('actions.json').find((x) => x.action === 'ping');
  assert.deepEqual(keys(plain), Object.keys((await get('/api/actions'))[0]).sort());
  assert.deepEqual(keys(fx('actions.json').find((x) => x.action === 'reread')), [...Object.keys((await get('/api/actions'))[0]), 'session'].sort(), 'у reread — ещё session (EXT-65)');
  assert.deepEqual(keys(fx('mirror.json')), Object.keys(await get('/api/mirror')).sort());
  assert.deepEqual(keys(fx('worktrees.json')[0]), ['branch', 'card', 'eligible', 'ignored', 'path', 'reason', 'repo'], 'форма §1.7; ручка пока пустая (ПТ8б)');
  assert.deepEqual(await get('/api/worktrees'), []);
});

// ---------------- дозапрос после ревью Голема (EXT-39) ----------------

test('[bell-browser] обход кодировкой: GET /api/b%65ll/<uuid> с Origin → 403, без заголовков → 200', async () => {
  const { app } = await setup();
  const get = (h = {}) => app.inject({ method: 'GET', url: `/api/b%65ll/${uuid(7)}`, headers: { host: `127.0.0.1:${PORT}`, ...h } });
  assert.equal((await get({ origin: EVIL })).statusCode, 403);
  assert.equal((await get({ 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  const ok = await get();
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ids: [], text: null });
});

test('отрицательный контроль bell-browser: без проверки GET /api/bell/<uuid> с Origin отвечает 200, с ней — 403', async () => {
  const blind = await setup({ off: ['bell-browser'] });
  const full = await setup({ off: [] });
  const get = (app) => app.inject({ method: 'GET', url: `/api/bell/${uuid(7)}`, headers: { host: `127.0.0.1:${PORT}`, origin: SELF } });
  assert.equal((await get(blind.app)).statusCode, 200);
  assert.equal((await get(full.app)).statusCode, 403);
});

test('[method] варианты пути /api/act без маршрута (/API/act, /api/act/, //api/act, /api%2Fact, /api/act;x) → 405, в actions.log ничего', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  for (const url of ['/API/act', '/api/act/', '//api/act', '/api%2Fact', '/api/act;x']) assert.equal((await act(app, token, { url })).statusCode, 405, url);
  assert.equal(lines().length, 0);
});

test('[origin] варианты пути на маршрут /api/act (/api/%61ct, /api/act?x) — та же защита: чужой Origin → 403, GET отбит, исправный → 200', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  for (const url of ['/api/%61ct', '/api/act?x']) {
    assert.equal((await act(app, token, { url, headers: { origin: EVIL } })).statusCode, 403, url);
    // GET: /api/act?x — 405 (метод); /api/%61ct — GET-маршрута нет, ловит статика: 404 без тела (ничего не пишет)
    assert.equal((await act(app, token, { url, method: 'GET', payload: '', headers: { 'content-type': undefined } })).statusCode, url.includes('%') ? 404 : 405, `${url} GET`);
  }
  assert.equal(lines().length, 0);
  for (const url of ['/api/%61ct', '/api/act?x']) assert.equal((await act(app, token, { url })).statusCode, 200, url);
});

test('Content-Type: application/json; charset=utf-8 — проходит', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(steps(lines()), ['asked', 'done']);
});

// по факту: без проверки типа (выключена подменой) форма и multipart упираются в отсутствие парсера — 415
async function formFact(app, token) {
  const out = [];
  for (const [ct, payload] of [['application/x-www-form-urlencoded', 'action=ping'], ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="action"\r\n\r\nping\r\n--x--\r\n']]) {
    out.push((await act(app, token, { headers: { 'content-type': ct }, payload })).statusCode);
  }
  return out;
}

test('сторож парсеров по факту: без проверки типа форма и multipart → 415, обработчик не вызван; сторож зрячий — парсер «*» на контрольном сервере пропускает', async () => {
  let calls = 0;
  const { app, lines } = await setup({ off: ['content-type'], handlers: { ping: async () => { calls++; return { outcome: 'ok', message: 'pong' }; } } });
  assert.deepEqual(await formFact(app, await pageToken(app)), [415, 415]);
  assert.equal(calls, 0);
  assert.equal(lines().length, 0);
  const control = Fastify();
  control.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => done(null, body));
  control.post('/api/act', async () => ({ ok: true }));
  assert.deepEqual(await formFact(control, 't'), [200, 200]);
});

test('q: ровно {at, head} (at — время или null, head ≤ 60) или {uuid, at}; иное — 400; head в asked — по маске', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const code = async (q) => (await act(app, token, { body: { action: 'ping', intentId: nextIntent(), q } })).statusCode;
  for (const q of [{ at: '2026-10-02T19:40+03:00', head: 'Ветка готова — сливать?' }, { at: null }, { at: null, head: '' }, { uuid: uuid(3), at: '2026-10-02T19:40:00Z' }, { at: '2026-10-02T19:40+03:00', head: 'я'.repeat(60) + '\u0007' }]) {
    assert.equal(await code(q), 200, JSON.stringify(q));
  }
  for (const q of [{}, { head: 'x' }, { at: 'вчера', head: 'x' }, { at: 5, head: 'x' }, { at: '2026-10-02T19:40+03:00' }, { at: null, head: 'я'.repeat(61) }, { at: null, head: 5 },
    { uuid: 'x', at: null }, { uuid: uuid(3) }, { uuid: uuid(3), at: null, head: 'x' }, { at: null, head: 'x', extra: 1 }, [], 'q']) {
    assert.equal(await code(q), 400, JSON.stringify(q));
  }
  await act(app, token, { body: { action: 'ping', intentId: nextIntent(), q: { at: null, head: `ключ ${SECRET}` } } });
  const asked = lines().filter((l) => l.step === 'asked').at(-1);
  assert.ok(!JSON.stringify(asked).includes(SECRET));
  assert.match(asked.q.head, /\[скрыто/);
});

test('intentId после рестарта: ключи последних 10 мин восстанавливаются из actions.log — прежний исход, обработчик не вызван', async () => {
  const data = tmpDir('pult-');
  const first = await setup({ data });
  const intentId = nextIntent();
  const a = await act(first.app, await pageToken(first.app), { body: { action: 'ping', intentId, card: 'EXT-6' } });
  assert.equal(a.statusCode, 200);
  let calls = 0;
  const handlers = { ping: async () => { calls++; return { outcome: 'ok', message: 'pong' }; } };
  const second = await setup({ data, handlers });
  const b = await act(second.app, await pageToken(second.app), { body: { action: 'ping', intentId, card: 'EXT-6' } });
  assert.equal(b.statusCode, 200);
  assert.deepEqual([b.json().id, b.json().step, b.json().outcome], [a.json().id, 'done', 'ok']);
  assert.equal(calls, 0);
  assert.equal(second.lines().filter((l) => l.step === 'asked').length, 1);
  // действие, оборванное рестартом (asked без исхода), не повторяется: исход неизвестен
  const cut = nextIntent();
  fs.appendFileSync(path.join(data, 'actions.log'), JSON.stringify({ id: 'W-261002-120000-abcd', step: 'asked', at: new Date().toISOString(), action: 'ping', client: { intentId: cut } }) + '\n');
  const third = await setup({ data, handlers });
  const c = await act(third.app, await pageToken(third.app), { body: { action: 'ping', intentId: cut } });
  assert.equal(c.json().id, 'W-261002-120000-abcd');
  assert.equal(c.json().outcome, 'error');
  assert.equal(calls, 0);
  // старше 10 мин — ключ не держится
  const old = nextIntent();
  fs.appendFileSync(path.join(data, 'actions.log'), JSON.stringify({ id: 'W-261002-090000-dcba', step: 'asked', at: new Date(Date.now() - 11 * 60000).toISOString(), action: 'ping', client: { intentId: old } }) + '\n');
  const fourth = await setup({ data, handlers });
  assert.notEqual((await act(fourth.app, await pageToken(fourth.app), { body: { action: 'ping', intentId: old } })).json().id, 'W-261002-090000-dcba');
  assert.equal(calls, 1);
});

test('конфиг не выключает защиту: checks и handlers внутри pult (как из config.json) не действуют — чужой Origin → 403', async () => {
  const data = tmpDir('pult-');
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), STUB);
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, pult: { enabled: true, words: true, actionsLog: path.join(data, 'actions.log'), checks: [], handlers: { yes: async () => ({ outcome: 'ok' }) } } });
  const token = await pageToken(app);
  assert.equal((await act(app, token, { headers: { origin: EVIL } })).statusCode, 403);
  // «да» с ПТ6 подключено настоящим обработчиком; подставной из конфига не действует: «ok» от него не приходит (plane.py не задан — не ok)
  const yes = await act(app, token, { body: { action: 'yes', intentId: nextIntent(), card: 'EXT-6', q: { at: null } } });
  assert.equal(yes.json().outcome, 'error');
  assert.equal(yes.json().message, 'ошибка: NOT_CONNECTED'); // очередь Plane не подключена (planePy не задан)
});

test('withToken: без <head> — после <html …> или после <!doctype>, <header> не принимается за <head>', () => {
  const m = '<meta name="vitrina-token" content="T">';
  assert.equal(withToken('<!doctype html><head><title>t</title></head>', 'T'), `<!doctype html><head>${m}<title>t</title></head>`);
  assert.equal(withToken('<!doctype html><HEAD lang="ru"></HEAD>', 'T'), `<!doctype html><HEAD lang="ru">${m}</HEAD>`);
  assert.equal(withToken('<!doctype html><html lang="ru"><body><header>x</header></body></html>', 'T'), `<!doctype html><html lang="ru">${m}<body><header>x</header></body></html>`);
  assert.equal(withToken('<!doctype html><header>x</header>', 'T'), `<!doctype html>${m}<header>x</header>`);
  assert.equal(withToken('<p>x</p>', 'T'), `${m}<p>x</p>`);
  assert.equal(withToken('<head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head>', 'T'), `<head>${m}</head>`);
});

test('сбой записи done/error после обработчика: исход Ивану — по обработчику, сбой журнала — в server.log кодом', async () => {
  let file;
  const handlers = {
    ping: async (ctx) => { fs.chmodSync(file, 0o444); if (ctx.card === 'CAR-1') throw Object.assign(new Error('x'), { code: 'BOOM' }); return { outcome: 'ok', message: 'pong' }; },
  };
  const s = await setup({ handlers });
  file = s.actionsLog;
  const token = await pageToken(s.app);
  try {
    const ok = await act(s.app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'EXT-6' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().outcome, 'ok');
    fs.chmodSync(file, 0o666);
    const err = await act(s.app, token, { body: { action: 'ping', intentId: nextIntent(), card: 'CAR-1' } });
    assert.equal(err.statusCode, 500);
    assert.equal(err.json().message, 'ошибка: BOOM');
  } finally { fs.chmodSync(file, 0o666); }
  const fails = s.logLines.filter((l) => l.ev === 'error' && l.route === 'actions.log');
  assert.equal(fails.length, 2);
  assert.ok(fails.every((l) => /^E[A-Z]+$/.test(l.code)), JSON.stringify(fails));
  assert.deepEqual(steps(s.lines()), ['asked', 'asked']);
});

test('mode в строках actions.log — из board.config.json доски; нет файла или режима — mirror', async () => {
  const live = tmpDir('board-');
  fs.writeFileSync(path.join(live, 'board.config.json'), '{"mode":"live"}');
  for (const [root, want] of [[boardDir, 'mirror'], [live, 'live'], [tmpDir('board-'), 'mirror']]) {
    const s = await setup({ boardRoot: root });
    await act(s.app, await pageToken(s.app));
    assert.deepEqual(s.lines().map((l) => l.mode), [want, want], root);
  }
});

test('GET /api/mirror, правило 4 §5 доски: живой pid той же загрузки, но пульс старше 5 мин — замок мёртвый, running false', async () => {
  const dir = tmpDir('mirror-');
  const { app } = await setup({ mirrorDir: dir });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const st = (o) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(o));
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, kind: 'full', at: iso(now - 10 * 60000), boot: lockLib.bootTime() }));
  st({ at: iso(now - 6 * 60000), kind: 'full', progress: { phase: 'cards', at: iso(now - 6 * 60000), started_at: iso(now - 10 * 60000) } });
  assert.equal((await get()).running, false, 'пульс прохода стоит больше 5 мин');
  st({ at: iso(now - 60000), kind: 'full' });
  assert.equal((await get()).running, false, 'progress нет — пульс от at замка (10 мин)');
  st({ at: iso(now - 60000), kind: 'full', progress: { phase: 'cards', at: iso(now - 60000), started_at: iso(now - 10 * 60000) } });
  assert.equal((await get()).running, true, 'пульс свежий');
});

// ---------------- EXT-42: «Прогони зеркало» — действие mirror (обычный проход) ----------------
// Запуск — подменный (fakeSpawn): настоящий mirror.mjs тесты не запускают никогда.

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// доска с обёрткой скрытого запуска: файл только лежит, его никто не исполняет
function launcherBoard() {
  const root = tmpDir('mboard-');
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'tools', 'mirror-hidden.js'), '// заглушка: тесты её не запускают\n');
  return root;
}
const mirrorBody = (extra = {}) => ({ body: { action: 'mirror', intentId: nextIntent(), ...extra } });
const getMirror = async (app) => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();

test('mirror: запуск — wscript //B //Nologo //E:JScript <доска>\\tools\\mirror-hidden.js <node> --changed --root <доска> --log <data>\\mirror-run.log; отсоединённо, без окна, unref', async () => {
  const root = launcherBoard();
  const spawn = fakeSpawn();
  const { app, data } = await setup({ boardRoot: root, spawn });
  const r = await act(app, await pageToken(app), mirrorBody());
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().step, r.json().outcome, r.json().message], ['done', 'ok', 'зеркало запущено']);
  assert.match(r.json().id, /^W-\d{6}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(spawn.calls.length, 1);
  const [c] = spawn.calls;
  assert.equal(path.basename(c.cmd).toLowerCase(), 'wscript.exe');
  assert.ok(path.isAbsolute(c.cmd), 'wscript — полным путём, не поиском по PATH');
  // --root — корень доски явно (как install-mirror-task.ps1): BOARD_ROOT окружения витрины проход не уводит
  assert.deepEqual(c.args, ['//B', '//Nologo', '//E:JScript', path.join(root, 'tools', 'mirror-hidden.js'), process.execPath, '--changed', '--root', root, '--log', path.join(data, 'mirror-run.log')]);
  assert.ok(!c.args.includes('--exit-with-parent'), 'проход живёт после рестарта витрины');
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.windowsHide, true);
  assert.equal(c.opts.stdio, 'ignore');
  assert.equal(c.unref, 1);
});

test('mirror: kind — только changed (по умолчанию); full — 501 «ещё не подключено» без записи и запуска; иное — 400', async () => {
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn });
  const token = await pageToken(app);
  const full = await act(app, token, mirrorBody({ kind: 'full' }));
  assert.equal(full.statusCode, 501);
  assert.match(full.json().message, /полный.*ещё не подключено/);
  for (const kind of ['bogus', 1, '', 'card']) assert.equal((await act(app, token, mirrorBody({ kind }))).statusCode, 400, String(kind));
  assert.equal((await act(app, token, { body: { action: 'ping', intentId: nextIntent(), kind: 'changed' } })).statusCode, 400, 'kind — только у mirror');
  assert.equal(spawn.calls.length, 0);
  assert.equal(lines().length, 0);
  assert.equal((await act(app, token, mirrorBody({ kind: 'changed' }))).statusCode, 200);
  assert.deepEqual(spawn.calls[0].args.slice(5, 6), ['--changed']);
});

test('mirror: actions.log — asked (kind changed), затем done с result {outcome, pid wscript, ms}', async () => {
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn });
  const r = await act(app, await pageToken(app), mirrorBody());
  const ls = lines();
  assert.deepEqual(steps(ls), ['asked', 'done']);
  assert.ok(ls.every((l) => l.id === r.json().id && l.action === 'mirror' && l.mode === 'mirror'));
  assert.equal(ls[0].kind, 'changed');
  assert.equal(ls[1].result.outcome, 'ok');
  assert.equal(ls[1].result.pid, 7001, 'pid подменного запуска');
  assert.ok(Number.isInteger(ls[1].result.ms) && ls[1].result.ms >= 0);
});

test('mirror: уже идёт по пульсу (progress моложе 5 мин) — refused mirror-running, «зеркало уже идёт (<вид> с ЧЧ:ММ)», запуска нет', async () => {
  const dir = tmpDir('mirror-');
  const t = Date.now();
  const started = t - 7 * 60000;
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(t - 30000).toISOString(), kind: 'full', progress: { phase: 'cards', cards_done: 3, cards_total: 9, at: new Date(t - 30000).toISOString(), started_at: new Date(started).toISOString() } }));
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn, mirrorDir: dir });
  const r = await act(app, await pageToken(app), mirrorBody());
  assert.equal(r.statusCode, 409);
  assert.deepEqual([r.json().step, r.json().outcome, r.json().message], ['refused', 'refused', `зеркало уже идёт (full с ${hhmm(started)})`]);
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual(steps(lines()), ['asked', 'refused']);
  assert.equal(lines()[1].refusal, 'mirror-running');
});

test('mirror: уже идёт по живому run.lock (pid жив, та же загрузка) без пульса — refused, запуска нет; мёртвый pid — запуск идёт', async () => {
  const dir = tmpDir('mirror-');
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, kind: 'changed', at: new Date(at).toISOString(), boot: lockLib.bootTime() }));
  const spawn = fakeSpawn();
  const { app } = await setup({ boardRoot: launcherBoard(), spawn, mirrorDir: dir });
  const token = await pageToken(app);
  const r = await act(app, token, mirrorBody());
  assert.equal(r.json().message, `зеркало уже идёт (changed с ${hhmm(at)})`);
  assert.equal(spawn.calls.length, 0);
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 0x7ffffff0, kind: 'changed', at: new Date(at).toISOString(), boot: lockLib.bootTime() }));
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'ok');
  assert.equal(spawn.calls.length, 1);
});

test('mirror: своя память «запущено в …» — второе нажатие сразу (пульс ещё пуст) → «уже идёт», один запуск; через 60 с — снова можно', async () => {
  let t = Date.parse('2026-10-03T12:00:00+03:00');
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn, now: () => t });
  const token = await pageToken(app);
  const [a, b] = await Promise.all([act(app, token, mirrorBody()), act(app, token, mirrorBody())]);
  assert.deepEqual([a.json().outcome, b.json().outcome].sort(), ['ok', 'refused']);
  assert.equal([a, b].find((r) => r.json().outcome === 'refused').json().message, `зеркало уже идёт (changed с ${hhmm(t)})`);
  assert.equal(spawn.calls.length, 1, 'два wscript подряд не пошли');
  t += 59000;
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'refused');
  assert.equal(spawn.calls.length, 1);
  t += 2000;
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'ok', 'память — 60 с');
  assert.equal(spawn.calls.length, 2);
  assert.equal(lines().filter((l) => l.refusal === 'mirror-running').length, 2);
});

test('mirror: своя память снимается, когда запущенный проход уже отметился в status.json (быстрый проход кончился раньше 60 с)', async () => {
  const dir = tmpDir('mirror-');
  const spawn = fakeSpawn();
  const { app } = await setup({ boardRoot: launcherBoard(), spawn, mirrorDir: dir });
  const token = await pageToken(app);
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'ok');
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'refused');
  // проход отработал: пульс снят, итог записан — at позже запуска
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), kind: 'changed', lastOk: new Date(Date.now() + 1000).toISOString() }));
  assert.equal((await act(app, token, mirrorBody())).json().outcome, 'ok');
  assert.equal(spawn.calls.length, 2);
});

test('mirror: сбой запуска (wscript не нашёлся — событие error; исключение из spawn; нет mirror-hidden.js) — error с кодом словом, память не держит', async () => {
  for (const [opts, code] of [[{ fail: 'ENOENT' }, 'ENOENT'], [{ throwSync: 'EPERM' }, 'EPERM']]) {
    const spawn = fakeSpawn(opts);
    const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn });
    const token = await pageToken(app);
    const r = await act(app, token, mirrorBody());
    assert.equal(r.statusCode, 500, code);
    assert.deepEqual([r.json().step, r.json().outcome, r.json().message], ['error', 'error', `ошибка: ${code}`]);
    assert.deepEqual(steps(lines()), ['asked', 'error']);
    assert.equal(lines()[1].result.code, code);
    assert.equal(spawn.calls.length, 1);
    assert.equal((await act(app, token, mirrorBody())).json().outcome, 'error', 'после сбоя — новая попытка, а не «уже идёт»');
    assert.equal(spawn.calls.length, 2);
  }
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: tmpDir('noboard-'), spawn });
  const r = await act(app, await pageToken(app), mirrorBody());
  assert.equal(r.json().message, 'ошибка: NO_LAUNCHER');
  assert.equal(lines()[1].result.code, 'NO_LAUNCHER');
  assert.equal(spawn.calls.length, 0, 'без обёртки wscript не запускается');
});

test('mirror: флаги — pult.enabled = false → 503 без записи и запуска; pult.words = false действие не держит', async () => {
  const spawn = fakeSpawn();
  const off = await setup({ boardRoot: launcherBoard(), spawn, enabled: false });
  assert.equal((await act(off.app, await pageToken(off.app), mirrorBody())).statusCode, 503);
  assert.equal(off.lines().length, 0);
  assert.equal(spawn.calls.length, 0);
  const noWords = await setup({ boardRoot: launcherBoard(), spawn, words: false });
  assert.equal((await act(noWords.app, await pageToken(noWords.app), mirrorBody())).statusCode, 200);
  assert.equal(spawn.calls.length, 1);
});

test('[token] mirror без токена → 403: ни строки, ни запуска', async () => {
  const spawn = fakeSpawn();
  const { app, lines } = await setup({ boardRoot: launcherBoard(), spawn });
  const r = await act(app, undefined, { headers: { 'x-vitrina-token': undefined }, ...mirrorBody() });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
  assert.equal(spawn.calls.length, 0);
});

test('mirror: тот же intentId — прежний исход, второго запуска нет (и после рестарта витрины)', async () => {
  const data = tmpDir('pult-');
  const root = launcherBoard();
  const spawn = fakeSpawn();
  const first = await setup({ boardRoot: root, spawn, data });
  const body = mirrorBody();
  const a = await act(first.app, await pageToken(first.app), body);
  const b = await act(first.app, await pageToken(first.app), body);
  assert.equal(b.json().id, a.json().id);
  const second = await setup({ boardRoot: root, spawn, data });
  const c = await act(second.app, await pageToken(second.app), body);
  assert.deepEqual([c.json().id, c.json().outcome], [a.json().id, 'ok']);
  assert.equal(spawn.calls.length, 1);
});

test('GET /api/mirror: пока своя память держит запуск — running, kind changed, startedAt — время запуска; поля прохода пусты', async () => {
  const t = Date.parse('2026-10-03T12:00:00+03:00');
  const { app } = await setup({ boardRoot: launcherBoard(), now: () => t });
  assert.equal((await getMirror(app)).running, false);
  await act(app, await pageToken(app), mirrorBody());
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.kind, m.startedAt, m.phase, m.cardsDone, m.cardsTotal], [true, 'changed', new Date(t).toISOString(), null, null, null]);
});

test('GET /api/mirror: живой замок нового прохода и progress прошлого (убитого) — числа прошлого не выдаются, startedAt — от замка', async () => {
  const dir = tmpDir('mirror-');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, kind: 'changed', at: iso(now - 5000), boot: lockLib.bootTime() }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: iso(now - 60000), kind: 'full', progress: { phase: 'comments', cards_done: 500, cards_total: 700, requests: 900, rpm: 23, at: iso(now - 60000), started_at: iso(now - 3600000) } }));
  const { app } = await setup({ mirrorDir: dir });
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.kind, m.phase, m.cardsDone, m.cardsTotal, m.requests, m.rpm, m.startedAt], [true, 'changed', null, null, null, null, null, iso(now - 5000)]);
});

// ---------------- EXT-42, дозапрос после Голема: тихий сбой до замка (Важно 1), числа своего прохода (Важно 2) ----------------

test('mirror: node не стартовал (9009, строка в журнале задачи) — до 60 с «идёт», потом /api/mirror.lastError «проход не стартовал: <строка>»; следующее нажатие пишет error прежнему id', async () => {
  let t = Date.parse('2026-10-03T12:00:00+03:00');
  const spawn = fakeSpawn();
  const { app, lines, data } = await setup({ boardRoot: launcherBoard(), spawn, now: () => t });
  const token = await pageToken(app);
  const first = (await act(app, token, mirrorBody())).json();
  fs.writeFileSync(path.join(data, 'mirror-run.log'), '\r\nmirror-hidden: node did not start: no such file: node-x.exe\r\n');
  t += 59000;
  assert.deepEqual([(await getMirror(app)).running, (await getMirror(app)).lastError], [true, null]);
  t += 2000;
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.lastError], [false, 'проход не стартовал: mirror-hidden: node did not start: no such file: node-x.exe']);
  assert.equal((await getMirror(app)).lastError, m.lastError, 'держится до следующего нажатия');
  assert.deepEqual(steps(lines()), ['asked', 'done'], 'GET ничего не пишет');
  const second = (await act(app, token, mirrorBody())).json();
  assert.equal(second.outcome, 'ok');
  const err = lines().filter((l) => l.id === first.id && l.step === 'error');
  assert.equal(err.length, 1);
  assert.equal(err[0].result.code, 'NOT_STARTED');
  assert.equal(spawn.calls.length, 2);
  assert.equal((await getMirror(app)).lastError, null, 'новый запуск — прежний сбой не показывается');
});

test('mirror: wscript вышел сразу (mirror.mjs остановился до замка), журнал пуст — сбой виден без ожидания 60 с, «проход не стартовал — см. data/vitrina/mirror-run.log»', async () => {
  const spawn = fakeSpawn({ exitCode: 2 });
  const { app } = await setup({ boardRoot: launcherBoard(), spawn });
  await act(app, await pageToken(app), mirrorBody());
  await new Promise((r) => setTimeout(r, 30));
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.lastError], [false, 'проход не стартовал — см. data/vitrina/mirror-run.log']);
});

test('mirror: проход отметился в status.json после запуска — сбоя нет, lastError из status.json', async () => {
  const dir = tmpDir('mirror-');
  const spawn = fakeSpawn({ exitCode: 0 });
  const { app, data } = await setup({ boardRoot: launcherBoard(), spawn, mirrorDir: dir });
  await act(app, await pageToken(app), mirrorBody());
  fs.writeFileSync(path.join(data, 'mirror-run.log'), 'итог ✅\n');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), kind: 'changed', lastOk: new Date(Date.now() + 1000).toISOString() }));
  await new Promise((r) => setTimeout(r, 30));
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.lastError], [false, null]);
});

test('mirror: строка журнала задачи в lastError — до 200 знаков и по маске (секрет не выходит)', async () => {
  const spawn = fakeSpawn({ exitCode: 1 });
  const { app, data } = await setup({ boardRoot: launcherBoard(), spawn });
  await act(app, await pageToken(app), mirrorBody());
  fs.writeFileSync(path.join(data, 'mirror-run.log'), `mirror: ключ ${SECRET} ${'я'.repeat(300)}\n`);
  await new Promise((r) => setTimeout(r, 30));
  const e = (await getMirror(app)).lastError;
  assert.ok(e.startsWith('проход не стартовал: mirror: ключ '), e);
  assert.ok(!e.includes(SECRET), 'секрет по маске');
  assert.ok([...e.slice('проход не стартовал: '.length)].length <= 200, 'не длиннее 200 знаков');
});

test('mirror: сбой до замка переживает рестарт витрины — запуск восстанавливается из actions.log', async () => {
  const data = tmpDir('pult-');
  const root = launcherBoard();
  let t = Date.parse('2026-10-03T12:00:00+03:00');
  const first = await setup({ boardRoot: root, data, now: () => t });
  await act(first.app, await pageToken(first.app), mirrorBody());
  fs.writeFileSync(path.join(data, 'mirror-run.log'), 'mirror: нет board.config.json\n');
  t += 61000;
  const second = await setup({ boardRoot: root, data, now: () => t });
  assert.equal((await getMirror(second.app)).lastError, 'проход не стартовал: mirror: нет board.config.json');
});

test('GET /api/mirror: живой замок и progress этого прохода (started_at ≥ at замка) — phase, cardsDone, cardsTotal, requests, rpm выдаются', async () => {
  const dir = tmpDir('mirror-');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, kind: 'changed', at: iso(now - 90000), boot: lockLib.bootTime() }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: iso(now - 20000), kind: 'changed', progress: { phase: 'comments', cards_done: 12, cards_total: 55, requests: 40, rpm: 23, at: iso(now - 20000), started_at: iso(now - 89000) } }));
  const { app } = await setup({ mirrorDir: dir });
  const m = await getMirror(app);
  assert.deepEqual([m.running, m.kind, m.phase, m.cardsDone, m.cardsTotal, m.requests, m.rpm, m.startedAt], [true, 'changed', 'comments', 12, 55, 40, 23, iso(now - 89000)]);
});

// мелочь 2 Голема на В10 (EXT-53, такт 2): lastError прохода зеркала — текст mirror.mjs, источник «неизвестный»
// (спека витрины 6.2) — строгой сетью. Id флоу по слову-признаку строгая сеть (IPTV) закрывает, мягкая — нет.
test('GET /api/mirror: lastError — строгой маской: id флоу по признаку закрыт, ghp_ закрыт, обычный текст цел', async () => {
  const FLOW_ID = '1a2b3c4d5e6f7g8h';
  const dir = tmpDir('mirror-');
  const st = (lastError) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date(Date.now() - 6 * 60000).toISOString(), kind: 'changed', lastError }));
  const { app } = await setup({ mirrorDir: dir });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();
  st(`проход красный: flow id ${FLOW_ID}`);
  const flow = (await get()).lastError;
  assert.ok(!flow.includes(FLOW_ID), flow);
  assert.match(flow, /^проход красный: flow id \[скрыто: [^\]]+\]$/);
  st(`проход красный: ключ ${SECRET}`);
  const gh = (await get()).lastError;
  assert.ok(!gh.includes(SECRET), gh);
  st('проход красный — см. last-report.txt');
  assert.equal((await get()).lastError, 'проход красный — см. last-report.txt');
});
