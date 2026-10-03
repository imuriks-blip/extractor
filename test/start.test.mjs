// Живой запуск на временной доске (спека витрины 1.1, гейт п.1): слушает только 127.0.0.1, настоящий HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startServer } from '../lib/start.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function get(port, url, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('старт: слушает 127.0.0.1, Host проверяется, server.log пишется, стоп чистый', async () => {
  const board = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
  gitInitCommit(board);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  // доска — и репозиторий проекта: HEAD доски читается файлами (EXT-37), git по ней зовёт читатель git (строка stats)
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [board] } } }));
  const dataDir = tmpDir('data-');
  const port = 43000 + Math.floor(Math.random() * 2000);
  const config = { port, paths: { board, boardLib: BOARD_LIB, registry: reg }, pollMs: { board: 60000 }, statsEveryMin: 10 };
  const s = await startServer({ config, dataDir });
  try {
    assert.equal(s.app.server.address().address, '127.0.0.1');
    const ok = await get(port, '/api/ceh', `127.0.0.1:${port}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).projects.map((p) => [p.code, p.review]), [['EXT', 1]]);
    assert.equal((await get(port, '/api/health', `localhost:${port}`)).status, 200);
    assert.equal((await get(port, '/api/health', 'evil.example')).status, 421);
  } finally {
    await s.stop();
  }
  const log = fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8');
  assert.match(log, / start port=\d+/);
  assert.match(log, / req route=\/api\/ceh status=200/);
  assert.match(log, / stop/);
  // строка stats: ключ — полный путь доски в нижнем регистре, есть пик за минуту (Г3)
  const st = log.split('\n').find((l) => / stats /.test(l));
  const git = JSON.parse(st.match(/ git=(\{.*\})$/)[1]);
  assert.ok(git[path.resolve(board).toLowerCase()], JSON.stringify(git));
  assert.ok(git[path.resolve(board).toLowerCase()].peakPerMin >= 1);
  // EXT-53: в строке stats — uuidKeys, runsLive, runsSilent (git= — по-прежнему последним); та же строка — в stats.log
  assert.match(st, / uuidKeys=\d+ /);
  assert.match(st, / rss=\d+ heapUsed=\d+ external=\d+ /, 'память по частям (Мелочь 6 ревью EXT-53)');
  assert.match(st, / runsLive=\d+ runsSilent=\d+ /);
  assert.match(st, / git=\{.*\}$/);
  const statsLog = fs.readFileSync(path.join(dataDir, 'stats.log'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(statsLog, [st]);
});

// ---------- мелочь 4 Голема на В10 (EXT-53, такт 2): пути python и git — config.json → paths.python, paths.git ----------

function setupStart() {
  const board = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
  gitInitCommit(board);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [board] } } }));
  return { board, reg };
}
const healthGit = async (port) => JSON.parse((await get(port, '/api/health', `127.0.0.1:${port}`)).body).readers.git;
async function gitAfterPass(port) {
  for (let i = 0; i < 100; i++) {
    const g = await healthGit(port);
    if (g?.passes >= 1) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('читатель git не прошёл ни разу за 10 с');
}

test('мелочь 4 (В10): paths.git доходит до запуска git — несуществующий путь даёт ENOENT; полный путь и умолчание (PATH) читают', async () => {
  const { board, reg } = setupStart();
  const whereGit = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim())).trim();
  const run = async (git) => {
    const port = 43000 + Math.floor(Math.random() * 2000);
    const paths = { board, boardLib: BOARD_LIB, registry: reg, ...(git === undefined ? {} : { git }) };
    const s = await startServer({ config: { port, paths, pollMs: { board: 60000 }, toasts: false }, dataDir: tmpDir('data-') });
    try { return await gitAfterPass(port); } finally { await s.stop(); }
  };
  const nope = await run(path.join(tmpDir('nogit-'), 'git.exe'));
  assert.match(String(nope.lastError), /ENOENT/, JSON.stringify(nope));
  assert.equal(nope.failing, 1);
  const full = await run(whereGit);
  assert.deepEqual([full.lastError, full.failing], [null, 0], JSON.stringify(full));
  const dflt = await run(undefined);
  assert.deepEqual([dflt.lastError, dflt.failing], [null, 0], JSON.stringify(dflt));
});

test('мелочь 4 (В10): paths.python доходит до запуска plane.py — «Принять» зовёт его (node + подменный plane.py); несуществующий — ENOENT', async () => {
  const { board, reg } = setupStart();
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const run = async (python) => {
    const pdir = tmpDir('plane-');
    fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
    const stateFile = path.join(pdir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ status: 'In Progress', comments: [] }));
    const port = 43000 + Math.floor(Math.random() * 2000);
    const config = { port, paths: { board, boardLib: BOARD_LIB, registry: reg, python }, pollMs: { board: 60000 }, toasts: false,
      pult: { enabled: true, planePy: path.join(pdir, 'fake-plane.mjs') } };
    const s = await startServer({ config, dataDir: tmpDir('data-'), webDir: web });
    try {
      const host = `127.0.0.1:${port}`;
      const page = await s.app.inject({ method: 'GET', url: '/', headers: { host } });
      const token = page.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
      const r = await s.app.inject({ method: 'POST', url: '/api/act', headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token },
        payload: JSON.stringify({ action: 'accept', card: 'EXT-6', q: { at: null }, intentId: '00000000-0000-4000-8000-000000000001' }) });
      return { body: r.json(), calls: JSON.parse(fs.readFileSync(stateFile, 'utf8')).calls ?? [] };
    } finally { await s.stop(); }
  };
  const node = await run(process.execPath);
  assert.deepEqual(node.calls[0], ['show', 'EXT-6', '--last'], JSON.stringify(node));
  assert.equal(node.body.outcome, 'refused', 'подменный plane.py: в Plane не Review — отказ stale-status');
  const nope = await run(path.join(tmpDir('nopy-'), 'python.exe'));
  assert.deepEqual(nope.calls, []);
  assert.equal(nope.body.message, 'свежая сверка не удалась: ENOENT');
});
