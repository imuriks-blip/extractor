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
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildThreads } from '../lib/threads.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const PENDING = {
  ceh: { 'waiting.threads': 'В4', 'waiting.yes': 'В4', 'waiting.review': 'В4', 'workers.threads.marks': 'В4', 'projects.phase': 'В5', 'projects.next': 'В5', 'freshness.mirror': 'В4' },
  project: { beacon: 'В5', waiting: 'В4', 'workers.threads.marks': 'В4', 'workers.threads.rulesFresh': 'В4', 'workers.closed': 'В4', 'board.inProgress': 'В5', 'board.ready': 'В5', 'board.review': 'В5', 'board.backlog': 'В5', 'board.done': 'В5', 'board.counts': 'В5', 'freshness.mirror': 'В4' },
  card: { links: 'В5', feed: 'В5' },
  health: {},
};

// словари с ключом-путём (не фиксированные ключи) — сверяется только, что это объект
const DICT = ['gitCalls', 'readers.journals.unknown', 'readers.processes.unknownStatus'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
const empty = (v) => v === null || (Array.isArray(v) && v.length === 0);
const kind = (v) => (Array.isArray(v) ? 'array' : typeof v);
// Образец массива объектов: первый элемент, а пустые у него поля — из следующих элементов (у первого треда образца
// субагентов нет, у третьего есть — сверяется и их форма).
function template(arr) {
  const t = { ...arr[0] };
  for (const k of Object.keys(t)) if (empty(t[k])) t[k] = arr.map((x) => x?.[k]).find((v) => !empty(v)) ?? t[k];
  return t;
}

// Сверка: ключи объекта равны; заготовка — у ручки пусто; непустой массив образца без пометки — у ручки непустой;
// типы листьев равны (null с любой стороны не сверяется); вглубь — у массивов первый элемент ручки против образца.
function compare(fx, real, pending, at = '') {
  assert.deepEqual(keys(fx), keys(real), `ключи ${at || 'верхнего уровня'}`);
  for (const k of keys(fx)) {
    const p = at ? `${at}.${k}` : k;
    if (DICT.includes(p)) { assert.ok(isObj(fx[k]) && isObj(real[k]), p); continue; }
    if (pending[p]) { assert.ok(empty(real[k]), `${p}: заготовка (наполняет ${pending[p]}) должна быть пустой`); continue; }
    if (fx[k] !== null && real[k] !== null) assert.equal(kind(real[k]), kind(fx[k]), `${p}: тип`);
    if (Array.isArray(fx[k]) && fx[k].length > 0) assert.ok(Array.isArray(real[k]) && real[k].length > 0, `${p}: в образце непусто, пометки нет — у ручки должно быть непусто`);
    if (isObj(fx[k]) && isObj(real[k])) compare(fx[k], real[k], pending, p);
    else if (Array.isArray(fx[k]) && isObj(fx[k][0]) && isObj(real[k]?.[0])) compare(template(fx[k]), real[k][0], pending, p);
  }
}

async function realResponses() {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека', body: 'Тело.' }] });
  gitInitCommit(dir);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await board.init();
  const journals = createJournalReader({ root: tmpDir('jr-'), indexDir: tmpDir('ji-') });
  await journals.refresh();
  // живой тред EXT с живым субагентом (В3) — данные выжимок читателей, собранные строками «Кто работает»
  const now = Date.now();
  const sid = '00000000-0000-4000-8000-000000000003';
  const procs = [{ pid: 101, sessionId: sid, hostSessionId: 'local_x', name: null, status: 'busy', startedAt: now - 3600000, statusUpdatedAt: now, observedAt: now, live: true }];
  const at = new Date(now - 600000).toISOString();
  const sessions = [{ sessionId: sid, ivan: { cards: { 'EXT-6': { n: 1, firstAt: at, lastAt: at } } }, boardWrites: [], thread: { askOpen: false, endTurnQ: null, lastAt: at },
    runs: [{ agentId: 'a1', agentType: 'terminus', description: 'EXT-6 В3', target: 60, alive: true, lastEndAt: null, currentZakhod: 3, lastAt: at }] }];
  const threads = {
    list: () => buildThreads({ procs, desktop: () => ({ title: 'EXT · витрина' }), sessions, board, maxTurns: () => 90, now }),
    state: () => ({ processes: { lastOkAt: at, errors: 0, lastError: null, files: 1, live: 1 }, desktop: { lastOkAt: at, errors: 0, lastError: null, files: 1 } }),
  };
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(reg), journals, threads, scan: () => [] });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { ceh: await get('/api/ceh'), project: await get('/api/project/EXT'), card: await get('/api/card/EXT-6'), health: await get('/api/health') };
}
const real = await realResponses();

test('свежесть журналов (В2) — время последнего удачного прохода читателя, в «Цехе» и окне проекта', () => {
  assert.match(real.ceh.freshness.journals.lastOkAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(real.project.freshness.journals.lastOkAt, real.ceh.freshness.journals.lastOkAt);
});

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
