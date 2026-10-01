// Образцы ответов для вёрстки (web/fixtures, спека 1.6) не расходятся с ключами настоящих ручек.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCeh } from '../lib/ceh.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('образцы: все файлы — JSON', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) assert.doesNotThrow(() => load(f), f);
});

test('образец ceh.json: ключи верхнего уровня и строки проекта — как у /api/ceh', () => {
  const board = { codes: () => [{ code: 'EXT', name: '—' }], counts: () => ({ inProgress: 0, ready: 0, review: 0 }) };
  const real = buildCeh({ board, registry: { codes: [{ code: 'EXT' }] }, freshness: {} });
  const fx = load('ceh.json');
  assert.deepEqual(Object.keys(fx).sort(), Object.keys(real).sort());
  assert.deepEqual(Object.keys(fx.waiting).sort(), Object.keys(real.waiting).sort());
  assert.deepEqual(Object.keys(fx.workers).sort(), Object.keys(real.workers).sort());
  assert.deepEqual(Object.keys(fx.projects[0]).sort(), Object.keys(real.projects[0]).sort());
  assert.deepEqual(fx.projects.map((p) => p.code), ['CAR', 'LEDGER', 'MAKAR', 'ASTRO', 'BW', 'INFRA', 'EXT', 'RADAR', 'IPTV']);
});
