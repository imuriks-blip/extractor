// EXT-129 (INFRA-113): строка для Ивана на сервере витрины — поле шапки карточки `brief` и строка `для Ивана:` в «Где стоим»
// карты проекта. Ручки: «Ждёт меня» (а), (б), (в); /api/card; /api/roadmap и /api/roadmap/<КОД> (карта и её карточки);
// строки «Проекты» на «Цехе». Маска brief — строгая сеть (IPTV), как прочие тексты карточки в этих ручках.
// Три случая на каждое: поле есть, поля нет, поле с тем, что режет только строгая сеть (id флоу рядом со словом-признаком:
// сеть проекта EXT его прощает). Плюс карта со строкой и без.
// Разбор — настоящая библиотека доски (boardLib, main доски с EXT-129 b62f084): header.mjs знает поле `brief: "<текст>"`
// сразу после `title`, roadmap.mjs кладёт `для Ивана:` в where.brief и убирает её из where.text. Связка «настоящая
// библиотека + витрина» на временной доске — Важно 1 Голема (дозапрос 1). Запасной путь витрины для библиотеки до EXT-129
// (строка — первой строкой where.text, поля brief нет) — отдельный тест на подменённой библиотеке старого вида.
// Ожидаемое — из положенного сюда (тексты карточек и карт), а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createRoadmapReader } from '../lib/roadmap.mjs';
import { maskDeep } from '../lib/mask.mjs';
import { BOARD_LIB, tmpDir, makeBoard, cardText, gitInitCommit } from './helpers.mjs';

const libUrl = (f) => new URL(`file:///${BOARD_LIB}/${f}`).href;
const { parseCard } = await import(libUrl('header.mjs'));
const { parseLog, latest } = await import(libUrl('log.mjs'));
const { scan } = await import(libUrl('secrets.mjs'));
const roadmapLib = await import(libUrl('roadmap.mjs'));
const scanT = (t, o = {}) => scan(t, { ...o, flowIds: new Set() });
const FLOW = 'Ab12Cd34Ef56Gh78'; // строгая сеть (IPTV) — класс 5 (скрыть), сеть EXT — класс 4 (прощает)


// ---------- доска ----------
const p2 = (n) => String(n).padStart(2, '0');
const boardTime = (ms) => { const d = new Date(ms + 3 * 3600000); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}+03:00`; };
const fresh = boardTime(Date.now() - 3600000); // (б) по mark_b — в пределах 14 дней
const B1 = 'Пароли засветились — надо сменить; нужно твоё «да»';
const B4 = 'Карточка ждёт решения: слить или подождать';
const B7 = 'Готово и проверено, смотреть нечего';
const BF = `Ход по флоу ${FLOW} — смотри сам`;
const MAP_BRIEF = 'Карта EXT: окно готово, дальше слияние';
const CARDS = [
  { id: 'EXT-1', status: 'review', title: 'Ревью со строкой', brief: B1 },
  { id: 'EXT-2', status: 'review', title: 'Ревью без строки' },
  { id: 'EXT-3', status: 'review', title: 'Ревью с флоу', brief: BF },
  { id: 'EXT-4', status: 'in-progress', title: 'Б со строкой', markB: true, updated: fresh, brief: B4 },
  { id: 'EXT-5', status: 'in-progress', title: 'Б без строки', markB: true, updated: fresh },
  { id: 'EXT-6', status: 'in-progress', title: 'Б с флоу', markB: true, updated: fresh, brief: BF },
  { id: 'EXT-7', status: 'done', title: 'Сделано со строкой', brief: B7 },
  { id: 'EXT-8', status: 'done', title: 'Сделано без строки' },
  { id: 'EXT-9', status: 'in-progress', title: 'Пустая строка', brief: '' },
];
const boardDir = makeBoard(tmpDir('b129-'), { codes: ['EXT', 'INFRA', 'CAR', 'BW'], cards: CARDS });
for (const c of CARDS) {
  if (c.brief === undefined) continue;
  const f = path.join(boardDir, 'EXT', `${c.id}.md`);
  fs.writeFileSync(f, cardText(c).replace(/^(title: .*)$/m, `$1\nbrief: ${JSON.stringify(c.brief)}`));
}
const mapText = (code, briefLine) => `# Карта ${code}
формат: 1

## Где стоим
обновлено: 2026-10-18 19:00 · trurl:${code}
фаза: Фаза ${code}.
следующий шаг: Шаг ${code}.
${briefLine ? `${briefLine}\n` : ''}Абзац ${code}.

## Ждёт Ивана

## Идеи

## Карточки
${code === 'EXT' ? ['EXT-1', 'EXT-2', 'EXT-3', 'EXT-7', 'EXT-8'].map((id) => `- ${id}`).join('\n') : ''}
`;
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), mapText('EXT', `для Ивана: ${MAP_BRIEF}`));
fs.writeFileSync(path.join(boardDir, 'INFRA', 'INFRA.map.md'), mapText('INFRA', null));
fs.writeFileSync(path.join(boardDir, 'CAR', 'CAR.map.md'), mapText('CAR', `для Ивана: ${BF}`));
gitInitCommit(boardDir);

const regFile = path.join(tmpDir('r129-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, INFRA: { projects: [], project_cards: [], repos: [] }, CAR: { projects: [], project_cards: [], repos: [] }, BW: { projects: [], project_cards: [], repos: [] } }, board_shared_repos: { repos: [] } }));
const registry = createRegistryReader(regFile);

// строки (а): тред EXT ждёт ответа на вопрос с одним номером карточки (EXT-70: поле card) — и тред без номера
const since = new Date(Date.now() - 600000).toISOString();
const rowA = (n, refs) => ({ cardRefs: refs, sessionId: `00000000-0000-4000-8000-00000000000${n}`, title: `EXT · тред ${n}`, project: 'EXT', projectBy: 'title', kind: 'question', text: `Трурль: вопрос ${n}`, since, overDay: false, key: `s${n}|u${n}`, uuid: `u${n}` });
const threads = {
  list: () => ({ threads: [], subagentsCount: 0, unknownStatus: {}, closed: [], waiting: [rowA(1, ['EXT-1']), rowA(2, ['EXT-2']), rowA(3, ['EXT-3']), rowA(4, [])] }),
  rulesNote: () => null,
  state: () => ({ processes: null, desktop: null }),
};

async function start(lib = roadmapLib) {
  const roadmap = createRoadmapReader({ root: boardDir, lib, registry });
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest, roadmap });
  await board.init();
  const app = await buildApp({ port: 4317, board, registry, threads, scan: scanT, projectCards: { get: () => ({ phase: 'Фаза Vault.', next: 'Шаг Vault.' }) }, roadmap });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { get, board, roadmap };
}
const S = await start();
const masked = (s) => typeof s === 'string' && !s.includes(FLOW) && s.includes('[скрыто:');

test('контроль: сеть проекта EXT id флоу по слову-признаку прощает — маску brief держит только строгая сеть', () => {
  assert.ok(maskDeep(BF, scanT, { project: 'EXT' }).includes(FLOW));
  assert.ok(!maskDeep(BF, scanT, { project: 'IPTV' }).includes(FLOW));
});

test('читатель доски: brief из шапки; поля нет или пустое — null; старая карточка — настоящим header.mjs, как прежде', () => {
  assert.equal(S.board.card('EXT-1').brief, B1);
  assert.equal(S.board.card('EXT-2').brief, null);
  assert.equal(S.board.card('EXT-9').brief, null);
  assert.equal(S.board.state().badHeaders, 0);
  assert.equal(S.board.card('EXT-2').title, 'Ревью без строки');
});

test('«Ждёт меня» (в): brief у строки — есть, нет (null), с флоу — строгой сетью', async () => {
  const rv = (await S.get('/api/ceh')).waiting.review;
  const by = (id) => rv.find((r) => r.id === id);
  assert.equal(by('EXT-1').brief, B1);
  assert.equal(by('EXT-2').brief, null);
  assert.ok(masked(by('EXT-3').brief), by('EXT-3').brief);
});

test('«Ждёт меня» (б): brief у строки — есть, нет (null), с флоу — строгой сетью', async () => {
  const yes = (await S.get('/api/ceh')).waiting.yes;
  const by = (id) => yes.find((r) => r.id === id);
  assert.deepEqual(yes.map((r) => r.id).sort(), ['EXT-4', 'EXT-5', 'EXT-6']);
  assert.equal(by('EXT-4').brief, B4);
  assert.equal(by('EXT-5').brief, null);
  assert.ok(masked(by('EXT-6').brief), by('EXT-6').brief);
});

test('«Ждёт меня» (а): brief карточки строки (поле card) — есть, нет (null), с флоу — строгой сетью; без карточки — null', async () => {
  const th = (await S.get('/api/ceh')).waiting.threads;
  const by = (n) => th.find((r) => r.key === `s${n}|u${n}`);
  assert.deepEqual([by(1).card, by(1).brief], ['EXT-1', B1]);
  assert.deepEqual([by(2).card, by(2).brief], ['EXT-2', null]);
  assert.equal(by(3).card, 'EXT-3');
  assert.ok(masked(by(3).brief), by(3).brief);
  assert.equal(by(4).card, undefined);
  assert.equal(by(4).brief, null);
});

test('окно проекта: «Ждёт меня по EXT» — те же строки с brief', async () => {
  const w = (await S.get('/api/project/EXT')).waiting;
  assert.equal(w.find((r) => r.group === 'review' && r.id === 'EXT-1').brief, B1);
  assert.ok(masked(w.find((r) => r.group === 'yes' && r.id === 'EXT-6').brief));
});

test('/api/card: header.brief — есть, нет (null), с флоу — строгой сетью (сеть проекта карточки его бы пропустила)', async () => {
  assert.equal((await S.get('/api/card/EXT-1')).header.brief, B1);
  assert.equal((await S.get('/api/card/EXT-2')).header.brief, null);
  assert.equal((await S.get('/api/card/EXT-9')).header.brief, null);
  const c3 = await S.get('/api/card/EXT-3');
  assert.ok(masked(c3.header.brief), c3.header.brief);
  assert.equal(c3.header.title, 'Ревью с флоу');
});

test('карта: строка «для Ивана:» — where.brief, из свободного текста убрана; карты без строки — null; с флоу — строгой сетью', async () => {
  const ext = (await S.get('/api/roadmap/EXT')).map.where;
  assert.equal(ext.brief, MAP_BRIEF);
  assert.deepEqual(ext.text, ['Абзац EXT.']);
  const infra = (await S.get('/api/roadmap/INFRA')).map.where;
  assert.equal(infra.brief, null);
  assert.deepEqual(infra.text, ['Абзац INFRA.']);
  const car = await S.get('/api/roadmap/CAR');
  assert.equal(car.broken, null);
  assert.ok(masked(car.map.where.brief), car.map.where.brief);
  assert.equal(S.roadmap.state().parseErrors, 0);
});

test('/api/roadmap: where.brief у строк проектов с картой', async () => {
  const ps = (await S.get('/api/roadmap')).projects;
  const by = (c) => ps.find((p) => p.code === c);
  assert.equal(by('EXT').where.brief, MAP_BRIEF);
  assert.equal(by('INFRA').where.brief, null);
  assert.ok(masked(by('CAR').where.brief));
  assert.equal(by('BW').where, null);
});

test('/api/roadmap/EXT: brief карточек «Впереди» и «Сделано» — есть, нет (null), с флоу — строгой сетью', async () => {
  const cards = (await S.get('/api/roadmap/EXT')).map.cards;
  const all = [...cards.ahead, ...cards.done];
  const by = (id) => all.find((c) => c.id === id);
  assert.deepEqual(cards.ahead.map((c) => c.id), ['EXT-1', 'EXT-2', 'EXT-3']);
  assert.deepEqual(cards.done.map((c) => c.id), ['EXT-7', 'EXT-8']);
  assert.equal(by('EXT-1').brief, B1);
  assert.equal(by('EXT-2').brief, null);
  assert.ok(masked(by('EXT-3').brief));
  assert.equal(by('EXT-7').brief, B7);
  assert.equal(by('EXT-8').brief, null);
});

test('«Цех», строки «Проекты»: brief из карты проекта — есть, нет строки (null), с флоу — строгой сетью; карты нет — null', async () => {
  const ps = (await S.get('/api/ceh')).projects;
  const by = (c) => ps.find((p) => p.code === c);
  assert.equal(by('EXT').brief, MAP_BRIEF);
  assert.equal(by('INFRA').brief, null);
  assert.ok(masked(by('CAR').brief), by('CAR').brief);
  assert.equal(by('BW').brief, null);
  assert.equal(by('BW').phaseFrom, 'vault');
});

test('Важно 1 Голема: настоящая библиотека доски (header.mjs, roadmap.mjs с EXT-129) + витрина — brief карточки и карты в ручках', async () => {
  // библиотека та, что с EXT-129: шапка с brief разбирается, «для Ивана:» — в where.brief, не в where.text
  const card = parseCard(fs.readFileSync(path.join(boardDir, 'EXT', 'EXT-1.md'), 'utf8').replace(/\r\n/g, '\n')).header;
  assert.equal(card.brief, B1);
  const m = roadmapLib.parseMap(fs.readFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), 'utf8'), { code: 'EXT' });
  assert.deepEqual(m.errors, []);
  assert.deepEqual([m.map.where.brief, m.map.where.text], [MAP_BRIEF, ['Абзац EXT.']]);
  // ручки на той же временной доске — без повтора строки в абзаце
  assert.equal((await S.get('/api/card/EXT-1')).header.brief, B1);
  assert.equal((await S.get('/api/ceh')).waiting.review.find((r) => r.id === 'EXT-1').brief, B1);
  const ext = (await S.get('/api/roadmap/EXT')).map;
  assert.deepEqual([ext.where.brief, ext.where.text], [MAP_BRIEF, ['Абзац EXT.']]);
  assert.equal(ext.cards.ahead.find((c) => c.id === 'EXT-1').brief, B1);
  assert.equal((await S.get('/api/ceh')).projects.find((p) => p.code === 'EXT').brief, MAP_BRIEF);
  assert.equal(S.board.state().badHeaders, 0);
});

test('запасной путь: библиотека доски до EXT-129 (поля where.brief нет, строка — первой в where.text) — brief из строки, в тексте её нет', async () => {
  // подменённая библиотека старого вида — не обёртка над живой: разбор карты возвращает «Где стоим» так, как его отдавал
  // roadmap.mjs до EXT-129 (строка «для Ивана:» — свободный текст); карточек в карте нет, планов нет
  const oldWhere = (code, line) => ({ updated: '2026-10-18 19:00', by: `trurl:${code}`, phase: `Фаза ${code}.`, next: `Шаг ${code}.`, text: [...(line ? [line] : []), `Абзац ${code}.`] });
  const LINES = { EXT: `для Ивана: ${MAP_BRIEF}`, INFRA: null, CAR: `Абзац с для Ивана: не первой строкой` };
  const oldLib = {
    roadmapFile: (code, name) => (name === `${code}.map.md` ? { kind: 'map', code } : null),
    parseMap: (text, { code }) => ({ map: { code, where: oldWhere(code, LINES[code]), questions: [], ideas: [], cards: [] }, errors: [], warnings: [], refs: [] }),
    parsePlan: (text, { id }) => ({ plan: { id, items: [] }, errors: [], warnings: [] }),
  };
  const O = await start(oldLib);
  const ext = (await O.get('/api/roadmap/EXT')).map.where;
  assert.deepEqual([ext.brief, ext.text], [MAP_BRIEF, ['Абзац EXT.']]);
  const infra = (await O.get('/api/roadmap/INFRA')).map.where;
  assert.deepEqual([infra.brief, infra.text], [null, ['Абзац INFRA.']]);
  // «для Ивана:» не в начале строки — обычный текст, не brief
  const car = (await O.get('/api/roadmap/CAR')).map.where;
  assert.deepEqual([car.brief, car.text], [null, ['Абзац с для Ивана: не первой строкой', 'Абзац CAR.']]);
  assert.equal((await O.get('/api/ceh')).projects.find((p) => p.code === 'EXT').brief, MAP_BRIEF);
});
