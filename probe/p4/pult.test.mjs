// Проба П.4 (EXT-33): защита пишущей ручки будущего пульта. Замысел — ТЗ дирижёра 02.10:
// (а) только POST + Content-Type application/json; (б) Origin только свой; (в) секрет страницы X-Vitrina-Token;
// (г) никаких Access-Control-Allow-*. Плюс Host (421) и «прочее — 405», как у витрины (спека 1.1).
// Каждый отказ — исправный запрос, в котором сломана ровно одна вещь; и каждый раз проверяется лог действий
// (файл на диске): действие не дошло. Отрицательный контроль: P4_OFF=a|b|c|d отключает одну проверку (blind.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPult } from './pult.mjs';

const PORT = 4399;
const SELF = `http://127.0.0.1:${PORT}`;
const EVIL = 'http://127.0.0.1:4398';
const off = (process.env.P4_OFF ?? '').split(',').filter(Boolean);

async function setup() {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-')), 'actions.log');
  const { app } = await buildPult({ port: PORT, logFile, off });
  const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
  return { app, lines };
}

// токен — так, как его возьмёт страница: из отданного HTML
async function pageToken(app, host = `127.0.0.1:${PORT}`) {
  const r = await app.inject({ method: 'GET', url: '/', headers: { host } });
  assert.equal(r.statusCode, 200);
  const m = r.body.match(/<meta name="vitrina-token" content="([^"]+)">/);
  assert.ok(m, 'на странице нет токена');
  return m[1];
}

// исправный запрос; over — что сломать
function act(app, token, over = {}) {
  const headers = { host: `127.0.0.1:${PORT}`, origin: SELF, 'content-type': 'application/json', 'x-vitrina-token': token, ...over.headers };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return app.inject({ method: over.method ?? 'POST', url: '/api/act', headers, payload: over.payload ?? JSON.stringify({ action: 'accept' }) });
}

// --- исправный случай ---

test('исправный: страница отдаёт токен, POST с ним проходит, действие в логе', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const r = await act(app, token);
  assert.equal(r.statusCode, 200);
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /accept/);
});

test('исправный: через localhost (Host и Origin localhost:4399) тоже проходит', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app, `localhost:${PORT}`);
  const r = await act(app, token, { headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` } });
  assert.equal(r.statusCode, 200);
  assert.equal(lines().length, 1);
});

test('токен не в куки и не в адресе: у страницы нет Set-Cookie', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(r.headers['set-cookie'], undefined);
});

// --- (в) секрет страницы ---

test('(в) без X-Vitrina-Token → 403, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, undefined, { headers: { 'x-vitrina-token': undefined } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('(в) чужой токен той же длины → 403, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const wrong = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  const r = await act(app, wrong);
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('(в) токен меняется при рестарте: старый на новом сервере → 403', async () => {
  const a = await setup();
  const old = await pageToken(a.app);
  const b = await setup();
  assert.notEqual(await pageToken(b.app), old);
  const r = await act(b.app, old);
  assert.equal(r.statusCode, 403);
  assert.equal(b.lines().length, 0);
});

// --- (б) Origin ---

test('(б) чужой Origin (127.0.0.1:4398) с верным токеном → 403, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: EVIL } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('(б) без Origin → 403, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: undefined } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

test('(б) Origin: null (файл, песочница iframe) → 403, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { origin: 'null' } });
  assert.equal(r.statusCode, 403);
  assert.equal(lines().length, 0);
});

// --- (а) тип тела ---

test('(а) text/plain с JSON в теле → 415, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'text/plain' } });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

test('(а) форма application/x-www-form-urlencoded → 415, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=accept' });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

test('(а) обманка «text/plain; application/json» → 415, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { headers: { 'content-type': 'text/plain; application/json' } });
  assert.equal(r.statusCode, 415);
  assert.equal(lines().length, 0);
});

// --- Host и метод (как у витрины) ---

test('Host: evil.example → 421 и на POST, и на странице с токеном', async () => {
  const { app, lines } = await setup();
  const token = await pageToken(app);
  const r = await act(app, token, { headers: { host: `evil.example:${PORT}` } });
  assert.equal(r.statusCode, 421);
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: `evil.example:${PORT}` } });
  assert.equal(page.statusCode, 421);
  assert.ok(!page.body.includes(token));
  assert.equal(lines().length, 0);
});

test('GET /api/act → 405, в лог не дошло', async () => {
  const { app, lines } = await setup();
  const r = await act(app, await pageToken(app), { method: 'GET', payload: '', headers: { 'content-type': undefined } });
  assert.equal(r.statusCode, 405);
  assert.equal(lines().length, 0);
});

// --- (г) без CORS ---

test('(г) ни предварительный запрос, ни страница не отдают Access-Control-Allow-*', async () => {
  const { app } = await setup();
  const pre = await app.inject({ method: 'OPTIONS', url: '/api/act', headers: { host: `127.0.0.1:${PORT}`, origin: EVIL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-vitrina-token' } });
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}`, origin: EVIL } });
  const cors = (h) => Object.keys(h).filter((k) => k.startsWith('access-control-allow'));
  assert.deepEqual(cors(pre.headers), []);
  assert.deepEqual(cors(page.headers), []);
  assert.notEqual(pre.statusCode, 204);
});
