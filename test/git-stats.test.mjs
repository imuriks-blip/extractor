// Счёт вызовов git по репозиториям (Г3: пик в минуту) и его строка в server.log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGitStats } from '../lib/git-stats.mjs';
import { createServerLog } from '../lib/server-log.mjs';
import { tmpDir } from './helpers.mjs';

test('git-stats: всего и пик за календарную минуту, ключ — полный путь в нижнем регистре (Г3)', () => {
  let now = Date.parse('2026-10-01T12:00:05Z');
  const s = createGitStats(() => now);
  const A = 'C:\\Users\\imuri\\Documents\\Obsidian Vault';
  for (let i = 0; i < 3; i++) s.onCall(A);
  now = Date.parse('2026-10-01T12:01:10Z');
  s.onCall(A);
  s.onCall('C:\\projects\\unorbis-board');
  assert.deepEqual(s.snapshot(), {
    'c:\\users\\imuri\\documents\\obsidian vault': { total: 4, peakPerMin: 3 },
    'c:\\projects\\unorbis-board': { total: 1, peakPerMin: 1 },
  });
});

test('server.log: поле-объект с числами пишется JSON одной лексемой (путь с пробелом цел), текст — нет', () => {
  const f = path.join(tmpDir(), 'server.log');
  const log = createServerLog(f);
  log.write('stats', { rss: 5, git: { 'C:\\Obsidian Vault': { total: 4, peakPerMin: 3 } } });
  log.write('stats', { git: { 'C:\\x': { note: 'текст треда' } } });
  const [l1, l2] = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.match(l1, / stats rss=5 git=\{"C:\\\\Obsidian Vault":\{"total":4,"peakPerMin":3\}\}$/);
  assert.equal(l2.includes('текст'), false);
});
