// Живой запуск на временной доске (спека витрины 1.1, гейт п.1): слушает только 127.0.0.1, настоящий HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../lib/start.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

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
});
