import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readRegistry } from '../lib/registry.mjs';
import { tmpDir } from './helpers.mjs';

function write(obj) {
  const f = path.join(tmpDir(), 'registry.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

const SAMPLE = {
  _comment: 'служебное',
  vault_root: 'C:\\Vault',
  board_shared_repos: { _comment: 'x', repos: ['C:\\Vault', 'C:\\Users\\u\\.claude'] },
  board_codes: {
    _comment: 'служебное',
    LEDGER: { projects: ['ledger-app'], project_cards: ['unorbis/ledger-app.md'], repos: ['C:\\projects\\ledger-read-api'] },
    CAR: { projects: ['unorbis-car-web'], project_cards: ['unorbis/unorbis-car-web.md', 'unorbis/orbis-car.md'], repos: [] },
    RADAR: { projects: [], project_cards: [], repos: [], note: 'кода нет' },
    _future: { projects: ['x'] },
  },
  projects: [{ name: 'orbis-astro', board: 'ASTRO' }],
};

test('реестр: коды в порядке ключей board_codes, служебные «_» пропущены', () => {
  const r = readRegistry(write(SAMPLE));
  assert.deepEqual(r.codes.map((c) => c.code), ['LEDGER', 'CAR', 'RADAR']);
});

test('реестр: поля кода — projects, projectCards, repos, note; пустой список остаётся пустым', () => {
  const r = readRegistry(write(SAMPLE));
  const car = r.codes.find((c) => c.code === 'CAR');
  assert.deepEqual(car.projectCards, ['unorbis/unorbis-car-web.md', 'unorbis/orbis-car.md']);
  assert.deepEqual(car.repos, []);
  assert.deepEqual(car.projects, ['unorbis-car-web']);
  assert.equal(r.codes.find((c) => c.code === 'RADAR').note, 'кода нет');
});

test('реестр: наследное поле board в projects[] не читается — ASTRO не появляется', () => {
  const r = readRegistry(write(SAMPLE));
  assert.equal(r.codes.some((c) => c.code === 'ASTRO'), false);
});

test('реестр: общие репозитории и корень Vault', () => {
  const r = readRegistry(write(SAMPLE));
  assert.deepEqual(r.sharedRepos, ['C:\\Vault', 'C:\\Users\\u\\.claude']);
  assert.equal(r.vaultRoot, 'C:\\Vault');
});

test('реестр без board_codes — пустой список кодов, не падение', () => {
  const r = readRegistry(write({ projects: [] }));
  assert.deepEqual(r.codes, []);
  assert.deepEqual(r.sharedRepos, []);
});
