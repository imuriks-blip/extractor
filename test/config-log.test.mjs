// config.json (спека витрины 1.3, 2.8) и server.log (1.3, 6.3); путь вне корня доски у читателя.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { createServerLog } from '../lib/server-log.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { tmpDir, spyFs } from './helpers.mjs';

const DEFAULTS = { port: 4317, paths: { board: 'C:/b', registry: 'C:/r.json' }, thresholds: { taktYellowMin: 60, staleMin: 15 } };

test('config: файла нет — создаётся в dataDir из умолчаний', () => {
  const dir = path.join(tmpDir(), 'data', 'vitrina');
  const c = loadConfig({ dataDir: dir, defaults: DEFAULTS });
  assert.equal(c.port, 4317);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), DEFAULTS);
});

test('config: файл есть — его значения главнее, недостающие вложенные ключи — из умолчаний', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 5000, thresholds: { staleMin: 20 } }));
  const c = loadConfig({ dataDir: dir, defaults: DEFAULTS });
  assert.equal(c.port, 5000);
  assert.equal(c.thresholds.staleMin, 20);
  assert.equal(c.thresholds.taktYellowMin, 60);
  assert.equal(c.paths.board, 'C:/b');
});

test('config: порт вне 1..65535 — ошибка с понятным текстом', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 'x' }));
  assert.throws(() => loadConfig({ dataDir: dir, defaults: DEFAULTS }), /port/);
});

test('server.log: строка — время, событие, поля; текст (не идентификатор) не пишется', () => {
  const f = path.join(tmpDir(), 'server.log');
  const log = createServerLog(f);
  log.write('req', { route: '/api/card/:id', status: 200, ms: 3, id: 'EXT-6' });
  log.write('note', { text: 'сообщение Ивана с пробелами', path: 'C:\\x\\.env' });
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ req route=\/api\/card\/:id status=200 ms=3 id=EXT-6$/);
  assert.equal(lines[1].includes('Ивана'), false);
  assert.match(lines[1], / text=\? /);
});

test('server.log: держит последние N строк', () => {
  const f = path.join(tmpDir(), 'server.log');
  const log = createServerLog(f, { maxLines: 10, slack: 5 });
  for (let i = 0; i < 40; i++) log.write('tick', { i });
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.ok(lines.length <= 15, `строк ${lines.length}`);
  assert.match(lines[lines.length - 1], / i=39$/);
});

test('читатель: id с выходом из корня — исключение, чтения не было', () => {
  const spy = spyFs();
  const r = createBoardReader({ root: tmpDir(), git: async () => '', parseCard: () => ({}), fs: spy });
  assert.throws(() => r.readCard('..\\..\\.env'), /вне корня/);
  assert.deepEqual(spy.calls, []);
});
