// Сервер (спека витрины 1.1, 1.6, 6; гейт п.1 и п.2): Host, только GET, проверка параметров до чтения диска,
// маска на выходе, /api/ceh → projects[], /api/health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, spyFs } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const PORT = 4317;
const H = { host: `127.0.0.1:${PORT}` };

async function setup({ scanFn = scan } = {}) {
  const dir = makeBoard(tmpDir('board-'), {
    codes: ['CAR', 'EXT', 'RADAR'],
    cards: [
      { id: 'CAR-1', status: 'in-progress' }, { id: 'CAR-2', status: 'review' }, { id: 'CAR-3', status: 'ready' },
      { id: 'EXT-6', status: 'backlog', title: 'Этап 1 · спека витрины', body: 'Спека витрины: сервер на 127.0.0.1.' },
      { id: 'EXT-7', status: 'review', title: 'Карточка с секретом', body: `Строка до.\nключ к гиту ${SECRET} — убрать.\n` },
    ],
  });
  gitInitCommit(dir);
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({
    board_codes: { _comment: 'x', EXT: { projects: [], project_cards: [], repos: [] }, CAR: { projects: [], project_cards: [], repos: [] }, NOPE: { projects: [] } },
  }));
  const spy = spyFs();
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, fs: spy });
  await board.init();
  const lines = [];
  const app = await buildApp({ port: PORT, board, registry: createRegistryReader(regFile), scan: scanFn, log: { write: (ev, f) => lines.push({ ev, ...f }) } });
  spy.calls.length = 0;
  return { app, spy, lines, dir };
}

test('Host: 127.0.0.1:<порт> и localhost:<порт> → 200, иное → 421 без тела', async () => {
  const { app } = await setup();
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    assert.equal(r.statusCode, 200, host);
  }
  for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:9999', `LOCALHOST:${PORT}x`, '127.0.0.1']) {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    assert.equal(r.statusCode, 421, host);
    assert.equal(r.body, '', host);
  }
});

test('гейт 1: любой метод, кроме GET → 405 (и на несуществующий путь)', async () => {
  const { app } = await setup();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    for (const url of ['/api/health', '/api/ceh', '/nope']) {
      const r = await app.inject({ method, url, headers: H, payload: method === 'POST' ? '{}' : undefined });
      assert.equal(r.statusCode, 405, `${method} ${url}`);
    }
  }
});

test('гейт 1: нет CORS-заголовков', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/health', headers: { ...H, origin: 'https://evil.example' } });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

for (const url of ['/api/card/..%5C..%5C.env', '/api/card/car-1', '/api/card/ZZZ-1', '/api/card/EXT-6.md', '/api/card/EXT-',
  '/api/project/ZZZ', '/api/project/ext', '/api/project/..%5C..', '/api/card/..%2F..%2Fprojects.md']) {
  test(`гейт 1: ${url} → 404 без тела, чтения файла не было`, async () => {
    const { app, spy } = await setup();
    const r = await app.inject({ method: 'GET', url, headers: H });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, '');
    assert.deepEqual(spy.calls, []);
  });
}

test('гейт 1: исправный случай — /api/card/EXT-6 → 200, шапка и тело', async () => {
  const { app, spy } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/card/EXT-6', headers: H });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.header.id, 'EXT-6');
  assert.equal(j.header.title, 'Этап 1 · спека витрины');
  assert.match(j.body, /Спека витрины/);
  assert.ok(spy.calls.some((c) => c.path.endsWith(path.join('EXT', 'EXT-6.md'))));
});

test('карточки нет на диске (код в словаре) → 404', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/card/EXT-999', headers: H });
  assert.equal(r.statusCode, 404);
});

test('исправный случай — /api/project/EXT → 200', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/project/EXT', headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().code, 'EXT');
});

test('гейт 2: секрет класса 2 в теле карточки → маска, значения в ответе нет', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/card/EXT-7', headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.split(SECRET).length - 1, 0);
  assert.match(r.json().body, /\[скрыто: [^\]]+\]/);
  assert.match(r.json().body, /Строка до\./);
});

test('гейт 2: отрицательный контроль — сеть выключена → значение в ответе есть (тест зрячий)', async () => {
  const { app } = await setup({ scanFn: () => [] });
  const r = await app.inject({ method: 'GET', url: '/api/card/EXT-7', headers: H });
  assert.equal(r.body.split(SECRET).length - 1, 1);
});

test('/api/ceh: projects[] в порядке board_codes, затем коды доски без записи в реестре; числа по шапкам', async () => {
  const { app } = await setup();
  const r = await app.inject({ method: 'GET', url: '/api/ceh', headers: H });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.deepEqual(j.projects.map((p) => p.code), ['EXT', 'CAR', 'RADAR']);
  const car = j.projects.find((p) => p.code === 'CAR');
  assert.deepEqual([car.inProgress, car.ready, car.review], [1, 1, 1]);
  const ext = j.projects.find((p) => p.code === 'EXT');
  assert.deepEqual([ext.inProgress, ext.ready, ext.review], [0, 0, 1]);
  assert.equal(ext.inRegistry, true);
  assert.equal(j.projects.find((p) => p.code === 'RADAR').inRegistry, false);
  assert.deepEqual(j.waiting, { threads: [], yes: [], review: [] });
  assert.deepEqual(j.workers, { threads: [], subagentsCount: 0, marksCount: 0 });
  assert.ok(j.freshness.board.lastOkAt);
});

test('/api/health: читатели с временем удачного чтения и ошибками, RSS', async () => {
  const { app } = await setup();
  const j = (await app.inject({ method: 'GET', url: '/api/health', headers: H })).json();
  assert.equal(j.ok, true);
  assert.ok(j.readers.board.lastOkAt);
  assert.equal(j.readers.board.errors, 0);
  assert.equal(typeof j.rss, 'number');
});

test('server.log: запрос пишется маршрутом и кодом, без параметров и текстов', async () => {
  const { app, lines } = await setup();
  await app.inject({ method: 'GET', url: '/api/card/EXT-7', headers: H });
  await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } });
  const req = lines.filter((l) => l.ev === 'req');
  assert.deepEqual(req.map((l) => [l.route, l.status]), [['/api/card/:id', 200], ['/api/health', 421]]);
  assert.equal(JSON.stringify(lines).includes('EXT-7'), false);
});
