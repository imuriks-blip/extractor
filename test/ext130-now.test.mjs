// EXT-130 такт 2: «Сейчас» карты проекта — поле now в GET /api/roadmap/<КОД>. Живые карточки проекта (in-progress и review):
// карточки с кодом проекта и карточки из списка «Карточки» карты проекта, без повторов. Элемент — { id, title, status, brief,
// owner, updated }: brief — строка для Ивана (EXT-129, строгая маска; нет строки — null), updated — давность карточки,
// max(updated шапки, последняя запись журнала). Порядок: review выше in-progress, внутри — свежие сверху.
// Карты нет — now всё равно; модуль карты недоступен — now: []. Старая библиотека доски (без brief) — brief: null.
// Разбор — настоящая библиотека доски (boardLib), как в test/ext129-brief.test.mjs. Ожидаемое — из положенного сюда
// (шапки, журналы, карты), а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createRoadmapReader } from '../lib/roadmap.mjs';
import { BOARD_LIB, tmpDir, makeBoard, cardText, gitInitCommit } from './helpers.mjs';

const libUrl = (f) => new URL(`file:///${BOARD_LIB}/${f}`).href;
const { parseCard } = await import(libUrl('header.mjs'));
const { parseLog, latest } = await import(libUrl('log.mjs'));
const { scan } = await import(libUrl('secrets.mjs'));
const roadmapLib = await import(libUrl('roadmap.mjs'));
const scanT = (t, o = {}) => scan(t, { ...o, flowIds: new Set() });
const FLOW = 'Ab12Cd34Ef56Gh78'; // строгая сеть (IPTV) его скрывает, сеть EXT по слову-признаку прощает

const B1 = 'Ревью ждёт твоего взгляда';
const BF = `Ход по флоу ${FLOW} — смотри сам`;
// шапка: updated; журнал: одна запись (writeCard кладёт 2026-09-25 14:03 +03:00) или своя, свежее шапки
const CARDS = [
  { id: 'EXT-1', status: 'review', title: 'Ревью старое', updated: '2026-10-02T12:00+03:00', brief: B1, owner: 'trurl:EXT' },
  { id: 'EXT-2', status: 'in-progress', title: 'Работа с пробелами', updated: '2026-10-03T12:00+03:00', brief: '   ' },
  { id: 'EXT-3', status: 'in-progress', title: 'Работа, журнал свежее шапки', updated: '2026-10-01T12:00+03:00', log: '### 2026-10-10 12:00 +03:00 · trurl:EXT · коммент\n\nсвежая запись\n\n' },
  { id: 'EXT-4', status: 'done', title: 'Сделано', updated: '2026-10-09T12:00+03:00' },
  { id: 'EXT-5', status: 'backlog', title: 'Бэклог', updated: '2026-10-09T12:00+03:00' },
  { id: 'EXT-6', status: 'ready', title: 'В очереди', updated: '2026-10-09T12:00+03:00' },
  { id: 'EXT-7', status: 'cancelled', title: 'Снято', updated: '2026-10-09T12:00+03:00' },
  { id: 'EXT-8', status: 'review', title: 'Ревью свежее', updated: '2026-10-07T12:00+03:00' },
  { id: 'EXT-9', status: 'in-progress', title: 'Работа с флоу', updated: '2026-10-06T12:00+03:00', brief: BF },
  { id: 'INFRA-1', status: 'in-progress', title: 'Чужая из карты EXT', updated: '2026-10-04T12:00+03:00', owner: 'cerebron:INFRA' },
  { id: 'INFRA-2', status: 'in-progress', title: 'Чужая не из карты', updated: '2026-10-08T12:00+03:00' },
  { id: 'INFRA-3', status: 'done', title: 'Чужая сделанная из карты', updated: '2026-10-08T12:00+03:00' },
  { id: 'BW-1', status: 'review', title: 'Без карты', updated: '2026-10-05T12:00+03:00' },
  { id: 'BW-2', status: 'backlog', title: 'Без карты, бэклог', updated: '2026-10-05T12:00+03:00' },
  // равная давность — порядок по номеру числом (IPTV-9 раньше IPTV-10; строкой было бы наоборот)
  { id: 'IPTV-10', status: 'in-progress', title: 'Десятая', updated: '2026-10-05T12:00+03:00' },
  { id: 'IPTV-9', status: 'in-progress', title: 'Девятая', updated: '2026-10-05T12:00+03:00' },
];
const boardDir = makeBoard(tmpDir('b130-'), { codes: ['EXT', 'INFRA', 'CAR', 'BW', 'IPTV'], cards: CARDS });
for (const c of CARDS) {
  const dir = path.join(boardDir, c.id.split('-')[0]);
  let t = cardText(c);
  if (c.brief !== undefined) t = t.replace(/^(title: .*)$/m, `$1\nbrief: ${JSON.stringify(c.brief)}`);
  if (c.owner) t = t.replace(/^owner: ""$/m, `owner: ${JSON.stringify(c.owner)}`);
  fs.writeFileSync(path.join(dir, `${c.id}.md`), t);
  if (c.log) fs.writeFileSync(path.join(dir, `${c.id}.log.md`), c.log);
}
const mapText = (code, cards) => `# Карта ${code}
формат: 1

## Где стоим
обновлено: 2026-10-18 19:00 · trurl:${code}
фаза: Фаза ${code}.
следующий шаг: Шаг ${code}.

## Ждёт Ивана

## Идеи

## Карточки
${cards.map((id) => `- ${id}`).join('\n')}
`;
// карта EXT: своя живая (EXT-1, EXT-3 — и по коду, и по списку: повтор), своя сделанная, чужие живая и сделанная
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), mapText('EXT', ['EXT-1', 'EXT-3', 'EXT-4', 'INFRA-1', 'INFRA-3']));
fs.writeFileSync(path.join(boardDir, 'CAR', 'CAR.map.md'), mapText('CAR', []));
gitInitCommit(boardDir);

const regFile = path.join(tmpDir('r130-'), 'registry.json');
const reg0 = { projects: [], project_cards: [], repos: [] };
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: reg0, INFRA: reg0, CAR: reg0, BW: reg0, IPTV: reg0 }, board_shared_repos: { repos: [] } }));
const registry = createRegistryReader(regFile);

async function start({ lib = roadmapLib, parse = parseCard } = {}) {
  const roadmap = createRoadmapReader({ root: boardDir, lib, registry });
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard: parse, parseLog, latest, roadmap });
  await board.init();
  const app = await buildApp({ port: 4317, board, registry, scan: scanT, roadmap });
  return async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
}
const get = await start();
const ext = await get('/api/roadmap/EXT');
const by = (list, id) => list.find((x) => x.id === id);

test('now: живые карточки проекта и из списка карты — in-progress и review; done, backlog, ready, cancelled и чужие не из карты — нет', () => {
  assert.ok(Array.isArray(ext.now));
  assert.deepEqual(ext.now.map((x) => x.id).sort(), ['EXT-1', 'EXT-2', 'EXT-3', 'EXT-8', 'EXT-9', 'INFRA-1']);
});

test('now: карточка чужого проекта из списка карты попадает (INFRA-1), статус и владелец — с её шапки', () => {
  const x = by(ext.now, 'INFRA-1');
  assert.deepEqual([x.status, x.title, x.owner], ['in-progress', 'Чужая из карты EXT', 'cerebron:INFRA']);
});

test('now: повторов нет — карточка и своего кода, и из списка карты (EXT-1, EXT-3) — один раз', () => {
  const ids = ext.now.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('now: порядок — review выше in-progress, внутри свежие сверху (давность — max(шапка, журнал))', () => {
  assert.deepEqual(ext.now.map((x) => x.id), ['EXT-8', 'EXT-1', 'EXT-3', 'EXT-9', 'INFRA-1', 'EXT-2']);
});

test('now: updated — время последней записи журнала, если она свежее шапки; иначе updated шапки', () => {
  assert.equal(by(ext.now, 'EXT-3').updated, '2026-10-10T09:00:00.000Z');
  assert.equal(by(ext.now, 'EXT-8').updated, '2026-10-07T09:00:00.000Z');
});

test('now: brief — есть; из пробелов — null; нет поля — null; с флоу — строгой сетью', () => {
  assert.equal(by(ext.now, 'EXT-1').brief, B1);
  assert.equal(by(ext.now, 'EXT-2').brief, null);
  assert.equal(by(ext.now, 'EXT-8').brief, null);
  const f = by(ext.now, 'EXT-9').brief;
  assert.ok(typeof f === 'string' && !f.includes(FLOW) && f.includes('[скрыто:'), f);
});

test('now: owner — из шапки; пусто — null', () => {
  assert.equal(by(ext.now, 'EXT-1').owner, 'trurl:EXT');
  assert.equal(by(ext.now, 'EXT-2').owner, null);
});

test('маска ответа: у элемента now только id, title, status, brief, owner, updated — прочие поля карточки читателя срезаны', () => {
  for (const x of ext.now) assert.deepEqual(Object.keys(x).sort(), ['brief', 'id', 'owner', 'status', 'title', 'updated'], x.id);
  // рядом — прежние поля ответа, как были
  assert.ok(ext.map && ext.counts && ext.hasMap === true);
});

test('проект без карты: now всё равно отдаётся — живые карточки по коду', async () => {
  const bw = await get('/api/roadmap/BW');
  assert.equal(bw.hasMap, false);
  assert.equal(bw.map, null);
  assert.deepEqual(bw.now.map((x) => [x.id, x.status, x.updated]), [['BW-1', 'review', '2026-10-05T09:00:00.000Z']]);
});

test('now: равная давность — порядок по номеру числом (IPTV-9 раньше IPTV-10)', async () => {
  assert.deepEqual((await get('/api/roadmap/IPTV')).now.map((x) => x.id), ['IPTV-9', 'IPTV-10']);
});

test('проект с картой без живых карточек: now — пустой список', async () => {
  assert.deepEqual((await get('/api/roadmap/CAR')).now, []);
});

test('модуль карты недоступен: now — пустой список, «карта недоступна» как прежде', async () => {
  const off = await (await start({ lib: null }))('/api/roadmap/EXT');
  assert.equal(off.available, false);
  assert.deepEqual(off.now, []);
});

test('старая библиотека доски (шапка без brief): brief — null, прочие поля — как с новой', async () => {
  // header.mjs до EXT-129 поля brief не знал: в разобранной шапке ключа нет
  const oldParse = (t) => { const r = parseCard(t); const { brief, ...header } = r.header; return { ...r, header }; };
  const old = await (await start({ parse: oldParse }))('/api/roadmap/EXT');
  assert.deepEqual(old.now.map((x) => x.id), ['EXT-8', 'EXT-1', 'EXT-3', 'EXT-9', 'INFRA-1', 'EXT-2']);
  for (const x of old.now) assert.equal(x.brief, null, x.id);
  assert.equal(by(old.now, 'EXT-1').owner, 'trurl:EXT');
});
