// Образцы ответов для вёрстки (web/fixtures, спека 1.6) не расходятся с ключами настоящих ручек.
// Заготовки В1 (null / пустой список) явно перечислены в PENDING с тактом, который их наполняет:
// у них образец показывает целевую форму, а настоящая ручка — пока пустоту. Ключи с «_» в образце — пояснения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const PENDING = {
  ceh: { 'waiting.threads': 'В4', 'waiting.yes': 'В4', 'waiting.review': 'В4', 'workers.threads': 'В3', 'projects.phase': 'В5', 'projects.next': 'В5', 'freshness.journals': 'В2', 'freshness.mirror': 'В4' },
  project: { beacon: 'В5', waiting: 'В4', 'workers.threads': 'В3', 'workers.closed': 'В4', 'board.inProgress': 'В5', 'board.ready': 'В5', 'board.review': 'В5', 'board.backlog': 'В5', 'board.done': 'В5', 'board.counts': 'В5', 'freshness.journals': 'В2', 'freshness.mirror': 'В4' },
  card: { links: 'В5', feed: 'В5' },
  health: {},
};

// словари с ключом-путём (не фиксированные ключи) — сверяется только, что это объект
const DICT = ['gitCalls'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
const empty = (v) => v === null || (Array.isArray(v) && v.length === 0);

// Сверка: ключи объекта равны; заготовка — у ручки пусто; иначе — вглубь (у массивов — первый элемент).
function compare(fx, real, pending, at = '') {
  assert.deepEqual(keys(fx), keys(real), `ключи ${at || 'верхнего уровня'}`);
  for (const k of keys(fx)) {
    const p = at ? `${at}.${k}` : k;
    if (DICT.includes(p)) { assert.ok(isObj(fx[k]) && isObj(real[k]), p); continue; }
    if (pending[p]) { assert.ok(empty(real[k]), `${p}: заготовка (наполняет ${pending[p]}) должна быть пустой`); continue; }
    if (isObj(fx[k]) && isObj(real[k])) compare(fx[k], real[k], pending, p);
    else if (Array.isArray(fx[k]) && isObj(fx[k][0]) && isObj(real[k]?.[0])) compare(fx[k][0], real[k][0], pending, p);
  }
}

async function realResponses() {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека', body: 'Тело.' }] });
  gitInitCommit(dir);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await board.init();
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(reg), scan: () => [] });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { ceh: await get('/api/ceh'), project: await get('/api/project/EXT'), card: await get('/api/card/EXT-6'), health: await get('/api/health') };
}
const real = await realResponses();

test('образцы: все файлы — JSON', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) assert.doesNotThrow(() => load(f), f);
});

for (const [name, file] of [['ceh', 'ceh.json'], ['project', 'project-EXT.json'], ['card', 'card-EXT-6.json'], ['health', 'health.json']]) {
  test(`образец ${file}: ключи как у настоящей ручки, заготовки помечены тактом`, () => {
    compare(load(file), real[name], PENDING[name]);
  });
}

test('образец ceh.json: порядок проектов — решение Ивана 5; состояния тредов — один словарь §2.1, каждое есть', () => {
  const fx = load('ceh.json');
  assert.deepEqual(fx.projects.map((p) => p.code), ['CAR', 'LEDGER', 'MAKAR', 'ASTRO', 'BW', 'INFRA', 'EXT', 'RADAR', 'IPTV']);
  const STATES = ['waiting', 'busy', 'idle', 'stale'];
  const seen = fx.workers.threads.map((t) => t.state);
  for (const s of seen) assert.ok(STATES.includes(s), s);
  for (const s of STATES) assert.ok(seen.includes(s), `нет образца состояния ${s}`);
  for (const t of fx.workers.threads.filter((x) => x.state === 'stale')) assert.ok(STATES.includes(t.lastState), 'устарело: lastState — вычисленное состояние');
  assert.equal(fx.projects.find((p) => p.code === 'EXT').name, 'Экстрактор');
  assert.equal(load('project-EXT.json').name, 'Экстрактор');
  assert.ok(!JSON.stringify(fx).includes('"lastOk"'));
});
