// EXT-132, EXT-90, EXT-117 (витрина; ветка ext-132-90-117). Ожидаемое — литералами из ТЗ такта и карточек, не из кода под
// тестом. EXT-132 — слитая Б-карточка в Review (тот же итог, что «Принять»: acceptState(card, merge.peek(id)).can === true)
// идёт в «Готово, посмотри» (review), а не в «Нужно твоё «да»» (yes); EXT-90 — подпись действия measure в «Моих словах»;
// EXT-117 — /api/glossary строгой сетью (Vault — общий репозиторий, §6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { buildWaiting } from '../lib/waiting.mjs';
import { acceptState } from '../lib/pult/accept.mjs';
import { maskDeep } from '../lib/mask.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const libUrl = (f) => new URL(`file:///${BOARD_LIB}/${f}`).href;
const { parseCard } = await import(libUrl('header.mjs'));
const { parseLog, latest } = await import(libUrl('log.mjs'));
const { scan } = await import(libUrl('secrets.mjs'));
// сеть доски без живого списка id флоу (data/ живой витрины не читается)
const scanT = (t, o = {}) => scan(t, { ...o, flowIds: new Set() });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-10-21T10:00:00Z');
const MIN = 60000;
const WARN = 'выкатка ещё не сделана? «Принять» её не снимает';
const entry = (ms, kind, body) => {
  const d = new Date(ms + 3 * 3600000).toISOString();
  return `### ${d.slice(0, 10)} ${d.slice(11, 16)} +03:00 · plane · ${kind}\n\n${body}\n\n`;
};
// итоги прохода проверки слияния (createMergeCheck.peek) — формы из спеки пульта / EXT-115
const traced = (names, pushed = true) => ({ state: 'ok', branch: null, repo: null, trace: true, repos: names.map((n) => `C:\\projects\\${n}`), pushed });
const NO_TRACE = { state: 'no-trace', branch: null, repo: null };
const NOT_MERGED = { state: 'not-merged', branch: 'ext-5-x', repo: 'C:\\projects\\extractor' };

// EXT-1 — Б, Review, след есть (ручная выкатка); EXT-2 — Б, Review, проверка не готова (peek null); EXT-3 — Б, Review, следа нет;
// EXT-4 — Б, Review, след есть, но последняя запись — вопрос «сливай»; EXT-5 — Б, Review, ветка не слита; EXT-6 — обычная Review;
// EXT-7 — Б не в Review (in-progress) со следом; EXT-8 — Б, Review, след с автовыкаткой и отправлен (warn null)
const CARDS = [
  { id: 'EXT-1', status: 'review', markB: true, title: 'Б слита' },
  { id: 'EXT-2', status: 'review', markB: true, title: 'Б проверяю' },
  { id: 'EXT-3', status: 'review', markB: true, title: 'Б без следа' },
  { id: 'EXT-4', status: 'review', markB: true, title: 'Б со «сливай»' },
  { id: 'EXT-5', status: 'review', markB: true, title: 'Б не слита' },
  { id: 'EXT-6', status: 'review', title: 'Обычная' },
  { id: 'EXT-7', status: 'in-progress', markB: true, title: 'Б в работе' },
  { id: 'EXT-8', status: 'review', markB: true, title: 'Б автовыкатка' },
];
const PEEK = { 'EXT-1': traced(['unorbis-car-web']), 'EXT-2': null, 'EXT-3': NO_TRACE, 'EXT-4': traced(['unorbis-car-web']), 'EXT-5': NOT_MERGED,
  'EXT-6': { state: 'ok', branch: null, repo: null }, 'EXT-7': traced(['unorbis-car-web']), 'EXT-8': traced(['ledger-read-api']) };

async function boardOf() {
  const dir = makeBoard(tmpDir('e132-'), { codes: ['EXT'], cards: CARDS });
  for (const c of CARDS) {
    const body = c.id === 'EXT-4' ? 'Ветка готова. Ждёт «сливай».' : 'Готово, проверено.';
    fs.writeFileSync(path.join(dir, 'EXT', `${c.id}.log.md`), entry(T0 - 30 * MIN, 'коммент', body));
  }
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  return { dir, board };
}

/* ---------------- EXT-132: buildWaiting ---------------- */

test('EXT-132: Б-карточка в Review со следом слияния — в «Готово, посмотри», не в «Нужно твоё «да»»; без следа, «проверяю», не слита, вопрос-метка — в «да»', async () => {
  const { board } = await boardOf();
  const mergedB = (c) => acceptState(c, PEEK[c.id] ?? null).can === true;
  const w = buildWaiting({ threads: [], board, now: T0, mergedB });
  const yes = w.yes.map((r) => r.id).sort();
  const review = w.review.map((r) => r.id).sort();
  assert.deepEqual(yes, ['EXT-2', 'EXT-3', 'EXT-4', 'EXT-5', 'EXT-7'], 'неслитые, непроверенные, с вопросом и не в Review — как прежде, в «да»');
  assert.deepEqual(review, ['EXT-1', 'EXT-6', 'EXT-8'], 'слитые Б (ручная и автовыкатка) и обычная — в «посмотри»');
  assert.equal(w.yes.find((r) => r.id === 'EXT-4').mark, 'Б', 'Б с вопросом — метка Б, как было');
  assert.equal(w.count, 5, 'крупное число — без слитых Б');
  assert.equal(w.more, 3);
  const r1 = w.review.find((r) => r.id === 'EXT-1');
  assert.equal(r1.key.startsWith('EXT-1|'), true, 'ключ строки — как у прочих строк (в)');
  assert.equal(r1.project, 'EXT');
});

test('EXT-132: без проверки слияния (параметра нет) — всё как раньше: каждая незакрытая Б — в «да»', async () => {
  const { board } = await boardOf();
  const w = buildWaiting({ threads: [], board, now: T0 });
  assert.deepEqual(w.yes.map((r) => r.id).sort(), ['EXT-1', 'EXT-2', 'EXT-3', 'EXT-4', 'EXT-5', 'EXT-7', 'EXT-8']);
  assert.deepEqual(w.review.map((r) => r.id), ['EXT-6']);
});

/* ---------------- EXT-132: /api/ceh — та же проверка, что у «Принять», warn до строки ---------------- */

async function appOf({ glossary } = {}) {
  const { board } = await boardOf();
  const regFile = path.join(tmpDir('e132-reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  // проверка слияния — подмена с итогами прохода; git не зовётся (peek), нажатий в тесте нет
  const merge = { peek: (id) => PEEK[id] ?? null, check: async (id) => PEEK[id] ?? null, refresh: async () => {} };
  const actionsLog = path.join(tmpDir('e132-data-'), 'actions.log');
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(regFile), scan: scanT, merge,
    pult: { enabled: true, words: false, actionsLog }, ...(glossary ? { glossary } : {}) });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } }));
  return { app, get };
}

test('EXT-132: /api/ceh — слитая Б в waiting.review с «Принять» (accept.can true) и warn; неслитые Б — в waiting.yes; окно проекта — group review', async () => {
  const { app, get } = await appOf();
  const ceh = (await get('/api/ceh')).json();
  const rv = (id) => ceh.waiting.review.find((r) => r.id === id);
  assert.deepEqual(ceh.waiting.yes.map((r) => r.id).sort(), ['EXT-2', 'EXT-3', 'EXT-4', 'EXT-5', 'EXT-7']);
  assert.deepEqual(ceh.waiting.review.map((r) => r.id).sort(), ['EXT-1', 'EXT-6', 'EXT-8']);
  assert.equal(rv('EXT-1').accept.can, true);
  assert.equal(rv('EXT-1').accept.warn, WARN, 'ручная выкатка — предупреждение у строки «посмотри»');
  assert.equal(rv('EXT-8').accept.can, true);
  assert.equal(rv('EXT-8').accept.warn, null, 'автовыкатка, отправлено — без предупреждения');
  assert.equal('warn' in rv('EXT-6').accept, false, 'обычная — поля warn нет, как было');
  assert.equal(ceh.waiting.yes.find((r) => r.id === 'EXT-2').accept.can, null, '«проверяю» — в «да», как сейчас');
  const p = (await get('/api/project/EXT')).json();
  assert.equal(p.waiting.find((r) => r.id === 'EXT-1').group, 'review');
  assert.equal(p.waiting.find((r) => r.id === 'EXT-3').group, 'yes');
  await app.close();
});

/* ---------------- EXT-90: подпись measure ---------------- */

test('EXT-90: «Мои слова» — у действия measure подпись «замерить остаток» в словаре LABEL (не служебное measure)', () => {
  const w = fs.readFileSync(path.join(HERE, '..', 'web', 'src', 'Words.jsx'), 'utf8');
  const label = w.match(/^const LABEL = \{(.*)\};$/m);
  assert.ok(label, 'словарь LABEL одной строкой');
  assert.match(label[1], /(^|[ ,])measure: 'замерить остаток'(,| |$)/);
  assert.match(w, /<b>«\{LABEL\[r\.action\] \?\? r\.action\}»<\/b>/, 'подпись выводится в ёлочках');
});

/* ---------------- EXT-117: словарь строгой сетью ---------------- */

const FLOW = 'Ab12Cd34Ef56Gh78'; // 16 знаков рядом со словом-признаком «флоу»: строгая сеть (IPTV) скрывает, мягкая прощает
const glossaryOf = (text) => ({ get: () => ({ sections: [{ title: 'Цех', rows: [['флоу', text]] }], error: null, updatedAt: null }) });

test('EXT-117: /api/glossary — id флоу у слова-признака (мягкая сеть пропускает) скрыт строгой сетью', async () => {
  const text = `флоу ${FLOW} — пример`;
  assert.ok(maskDeep(text, scanT, { project: '' }).includes(FLOW), 'контроль: мягкая сеть id флоу прощает');
  assert.ok(!maskDeep(text, scanT, { project: 'IPTV' }).includes(FLOW), 'контроль: строгая сеть скрывает');
  const { app, get } = await appOf({ glossary: glossaryOf(text) });
  const r = await get('/api/glossary');
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes(FLOW), r.body);
  assert.match(r.json().sections[0].rows[0][1], /^флоу \[скрыто: [^\]]+\] — пример$/);
  await app.close();
});

test('EXT-117: /api/glossary — чистый текст словаря строгая сеть не трогает (замен 0)', async () => {
  const text = 'Терминус — рабочий робот цеха, чинит и паяет';
  const { app, get } = await appOf({ glossary: glossaryOf(text) });
  const r = await get('/api/glossary');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), glossaryOf(text).get());
  await app.close();
});
