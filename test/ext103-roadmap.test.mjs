// EXT-103 Т2: сервер витрины для дорожной карты (спека Vault extractor/SPEC-extractor-roadmap.md ред. 6, раздел 3, гейт Г2).
// Временная доска в живой форме, временные репозитории в реестре теста (папки «extractor» и «Obsidian Vault» — имена
// следа из таблицы 2.2), разбор — roadmap.mjs доски через boardLib. Ожидаемое — из положенного сюда (хеши, статусы
// карточек, строки карты), а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createTraceChecker } from '../lib/trace.mjs';
import { maskDeep } from '../lib/mask.mjs';
import { parseBoardWrite } from '../lib/journal-parse.mjs';
import { buildMarks } from '../lib/waiting.mjs';
import { cardRefs } from '../lib/threads.mjs';
import { startServer } from '../lib/start.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, gitCommitAll, git, onFreePort, untilAsync } from './helpers.mjs';

const libUrl = (f) => new URL(`file:///${BOARD_LIB}/${f}`).href;
const { parseCard } = await import(libUrl('header.mjs'));
const { parseLog, latest } = await import(libUrl('log.mjs'));
const { scan } = await import(libUrl('secrets.mjs'));
const roadmapLib = await import(libUrl('roadmap.mjs'));
// новый модуль витрины: на коде до Т2 его нет — каждый тест ниже падает сам, а не весь файл на импорте
const rm = await import('../lib/roadmap.mjs').catch(() => ({}));
const RULES = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).boardWriteTools;
// сеть доски без живого списка id флоу (data/ живой витрины не читается)
const scanT = (t, o = {}) => scan(t, { ...o, flowIds: new Set() });
const FLOW = 'Ab12Cd34Ef56Gh78'; // 16 знаков рядом со словом-признаком «флоу»: строгая сеть (IPTV) — класс 5, прочие — класс 4

// ---------- репозитории следа ----------
const extractor = path.join(tmpDir('rm-x-'), 'extractor');
fs.mkdirSync(extractor);
fs.writeFileSync(path.join(extractor, 'a.txt'), 'a');
gitInitCommit(extractor);
fs.writeFileSync(path.join(extractor, 'a.txt'), 'A');
const A = gitCommitAll(extractor, 'A'); // в main и origin/main
git(extractor, 'update-ref', 'refs/remotes/origin/main', A);
fs.writeFileSync(path.join(extractor, 'b.txt'), 'B');
const B = gitCommitAll(extractor, 'B'); // в main, не отправлен
git(extractor, 'checkout', '-q', '-b', 'ext-side');
fs.writeFileSync(path.join(extractor, 'c.txt'), 'C');
const C = gitCommitAll(extractor, 'C'); // только на ветке
git(extractor, 'checkout', '-q', 'main');
const vault = path.join(tmpDir('rm-v-'), 'Obsidian Vault');
fs.mkdirSync(vault);
fs.writeFileSync(path.join(vault, 'v.md'), 'v');
const V = gitInitCommit(vault);
git(vault, 'update-ref', 'refs/remotes/origin/main', V);
const h7 = (h) => h.slice(0, 7);

// корень Vault — и paths.vault, и vault_root, и повтор в общих репозиториях: одно имя «Vault» (Г2 п.3)
const regFile = path.join(tmpDir('rm-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ vault_root: vault,
  board_codes: { EXT: { projects: [], project_cards: [], repos: [extractor] }, INFRA: { projects: [], project_cards: [], repos: [] }, CAR: { projects: [], project_cards: ['car.md'], repos: [] } },
  board_shared_repos: { repos: [vault.toUpperCase()] } }));
const registry = createRegistryReader(regFile);

// ---------- доска ----------
const contractLog = `### 2026-10-04 11:00 +03:00 · plane · коммент

**Закрытие · контракт** (вердикт Голема)

-   **Что изменилось в системе:** x.
-   **Откат:** y.
-   **Остаточный риск:** z.
-   **Доставка:** extractor ${h7(A)}.
-   **Знание:** записи нет.

`;
const boardDir = makeBoard(tmpDir('rm-board-'), { codes: ['EXT', 'INFRA', 'CAR'], cards: [
  { id: 'EXT-98', status: 'done', title: 'Без контракта' },
  { id: 'EXT-99', status: 'done', title: 'Отправка доски' },
  { id: 'EXT-103', status: 'in-progress', title: 'Дорожная карта' },
  { id: 'EXT-104', status: 'done', title: 'Т1а', parent: 'EXT-103' },
  { id: 'EXT-105', status: 'in-progress', title: 'Т2', parent: 'EXT-103' },
  { id: 'EXT-106', status: 'cancelled', title: 'Т1в', parent: 'EXT-103' },
  { id: 'EXT-107', status: 'in-progress', title: 'Чужая в карте INFRA' },
  { id: 'INFRA-93', status: 'in-progress', title: 'Цех' },
  { id: 'CAR-1', status: 'backlog', title: 'Портал' },
] });
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-99.log.md'), contractLog);
const infraMap = `# Карта INFRA
формат: 1

## Где стоим
обновлено: 2026-10-15 21:40 · trurl:INFRA
фаза: цех пересобран, флоу ${FLOW}
следующий шаг: дорожная карта цеха
Текст про флоу ${FLOW} в абзаце.

## Ждёт Ивана
- q1 · открыт · 2026-10-15 · откуда: чат INFRA 15.10 · Общая карта — сразу?
- q2 · закрыт · 2026-10-12 · откуда: чат INFRA 12.10 · Карты в проектах? · ответ: да · кто решил: слово Ивана в чате 15.10

## Идеи
- i1 · обсуждаем · 2026-10-15 · откуда: чат INFRA 15.10 · Звонок между тредами
- i2 · стала карточкой · 2026-10-14 · откуда: чат INFRA 14.10 · Дорожная карта · → EXT-103
- i3 · отложена · 2026-10-14 · откуда: чат INFRA 14.10 · Потом

## Карточки
- EXT-103
- EXT-99
- INFRA-93
- EXT-107
`;
const infraPlan = `# План INFRA-93
формат: 1

- [x] 1 · Волна А · след: extractor@${h7(A)}, Vault@${h7(V)}
- [~] 2 · Волна Б
  - [x] 2.1 · не влито · след: extractor@${h7(C)}
  - [x] 2.2 · не отправлено · след: extractor@${h7(B)}
  - [x] 2.3 · чужое имя · след: foo@abc1234
  - [>] 2.4 · отдано · → EXT-105
  - [ ] 2.5 · предстоит
  - [-] 2.6 · снято · почему: лишнее
`;
const extMap = (ideas, where = 'фаза: витрина и карта.\nследующий шаг: сервер карты.') => `# Карта EXT
формат: 1

## Где стоим
обновлено: 2026-10-15 21:40 · trurl:EXT
${where}

## Ждёт Ивана

## Идеи
${ideas}

## Карточки
- EXT-103
- EXT-98
`;
const IDEA1 = '- i1 · обсуждаем · 2026-10-15 · откуда: чат EXT 15.10 · Окно карты';
fs.writeFileSync(path.join(boardDir, 'INFRA', 'INFRA.map.md'), infraMap);
fs.writeFileSync(path.join(boardDir, 'INFRA', 'INFRA-93.plan.md'), infraPlan);
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), extMap(IDEA1));
gitInitCommit(boardDir);

const gitR = createGitRead();
const reader = rm.createRoadmapReader?.({ root: boardDir, lib: roadmapLib, registry, vault });
const board = createBoardReader({ root: boardDir, git: gitR, parseCard, parseLog, latest, roadmap: reader });
await board.init();
const trace = createTraceChecker({ git: gitR, registry, board, vault, roadmap: reader });
await trace.refresh();
const projectCards = { get: (code) => ({ phase: `Vault ${code}.`, next: `Шаг Vault ${code}.`, readAt: null, failingSince: null }) };
const app = await buildApp({ port: 4317, board, registry, scan: scanT, trace, roadmap: reader, projectCards });
const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();

const findCard = (m, id) => [...m.cards.ahead, ...m.cards.done, ...m.cards.cancelled].find((c) => c.id === id);
const planItem = (m, num) => findCard(m, 'INFRA-93').plan.items.find((i) => i.num === num);

// ---------- Г2 п.1: поломка — шкала следа EXT-48 ----------

test('Г2 п.1: след не из main — красный not-in-main; в main, не в origin — красный not-pushed; foo@… — жёлтый «не в реестре»', async () => {
  const m = (await get('/api/roadmap/INFRA')).map;
  const t = (num) => planItem(m, num).traces.map((x) => [x.part, x.state, x.reasons.map((r) => r.code)]);
  assert.deepEqual(t('2.1'), [[`extractor@${h7(C)}`, 'bad', ['not-in-main']]]);
  assert.deepEqual(t('2.2'), [[`extractor@${h7(B)}`, 'bad', ['not-pushed']]]);
  assert.deepEqual(t('2.3'), [['foo@abc1234', 'warn', ['not-in-registry']]]);
  assert.match(planItem(m, '2.3').traces[0].label, /не в реестре/);
});

// ---------- Г2 п.3: исправный (межпроектный) ----------

test('Г2 п.3: план INFRA-карточки — extractor@ и Vault@ из origin/main оба зелёные (имя по всему реестру, не reposOf(INFRA))', async () => {
  const m = (await get('/api/roadmap/INFRA')).map;
  assert.deepEqual(planItem(m, '1').traces.map((x) => [x.part, x.state, x.label]), [[`extractor@${h7(A)}`, 'ok', 'след проверен'], [`Vault@${h7(V)}`, 'ok', 'след проверен']]);
  assert.equal(planItem(m, '1').shownMark, 'x');
  // [>] — отметка с карточки: EXT-105 in-progress → «идёт»
  assert.deepEqual([planItem(m, '2.4').mark, planItem(m, '2.4').shownMark, planItem(m, '2.4').cardStatus], ['>', '~', 'in-progress']);
  // итог «сделано X из Y»: [x] 1, 2.1, 2.2, 2.3 — 4 из 7 пунктов; снятый 2.6 в Y не входит — как planTotals доски (ревью Голема Т3, Важно 2)
  assert.deepEqual(findCard(m, 'INFRA-93').plan.summary, { done: 4, total: 7 });
});

test('Г2 п.3: «Карточки» INFRA — деление по статусу доски; EXT-99 в done с контрактом → «Сделано», след как у «Принять»', async () => {
  const m = (await get('/api/roadmap/INFRA')).map;
  assert.deepEqual(m.cards.ahead.map((c) => c.id), ['EXT-103', 'INFRA-93', 'EXT-107']);
  assert.deepEqual(m.cards.done.map((c) => [c.id, c.trace.state, c.trace.label]), [['EXT-99', 'ok', 'след проверен']]);
  assert.deepEqual(m.cards.cancelled, []);
  // EXT-98 в карте EXT: done без контракта — красный no-contract (как «Принять»)
  const e = (await get('/api/roadmap/EXT')).map;
  assert.deepEqual(e.cards.done.map((c) => [c.id, c.trace.state, c.trace.reasons[0].code]), [['EXT-98', 'bad', 'no-contract']]);
  // идея со ссылкой на карточку — статус с карточки: EXT-103 in-progress → «в работе»; без карточки — из файла
  assert.deepEqual(m.ideas.map((i) => [i.n, i.status, i.shown]), [['i1', 'обсуждаем', 'обсуждаем'], ['i2', 'стала карточкой', 'в работе'], ['i3', 'отложена', 'отложена']]);
});

test('Г2 п.3: маленькие по parent — под большой; «закрыто X из Y» = подсчёт по файлам (done и cancelled — закрыты)', async () => {
  const big = findCard((await get('/api/roadmap/INFRA')).map, 'EXT-103');
  assert.deepEqual(big.children.map((c) => [c.id, c.status]), [['EXT-104', 'done'], ['EXT-105', 'in-progress'], ['EXT-106', 'cancelled']]);
  // по файлам: EXT-104 done, EXT-106 cancelled — закрыто 2 из 3; идёт — EXT-105; ждёт — никто
  assert.deepEqual(big.childrenSummary, { closed: 2, total: 3, active: 1, waiting: 0, label: 'закрыто 2 из 3 · идёт 1 · ждёт 0' });
});

test('Г2 п.3: текст карты с id флоу — строгой сетью (сеть INFRA его бы пропустила); Vault — одно имя, без «имя неоднозначно»', async () => {
  const where = (await get('/api/roadmap/INFRA')).map.where;
  // контроль: сеть проекта карты (INFRA) id флоу по слову-признаку прощает — ослабила бы маску
  assert.ok(maskDeep(`флоу ${FLOW}`, scanT, { project: 'INFRA' }).includes(FLOW));
  assert.ok(!where.phase.includes(FLOW) && where.phase.includes('[скрыто:'), where.phase);
  assert.ok(!where.text.join('\n').includes(FLOW));
  const h = await get('/api/health');
  assert.deepEqual(h.readers.roadmap.repoNameClashes, []);
  assert.deepEqual([h.readers.roadmap.maps, h.readers.roadmap.plans, h.readers.roadmap.parseErrors], [2, 1, 0]);
});

test('таблица имён следа: два пути с одним именем — в health, след с ним жёлтый «имя неоднозначно»; путь корня Vault в любом регистре — «Vault»', () => {
  const t = rm.repoNames({ codes: [{ code: 'A', repos: ['C:/x/dup', 'C:/x/one'] }, { code: 'B', repos: ['C:/y/dup'] }], sharedRepos: ['C:/V/Obsidian Vault'], vaultRoot: 'c:/v/obsidian vault' }, null);
  assert.deepEqual(t.clashes, ['dup']);
  assert.equal(t.byName.get('Vault').length, 1);
  assert.equal(t.byName.get('one').length, 1);
  assert.equal(t.byName.has('Obsidian Vault'), false);
});

test('имя следа с двумя путями в реестре теста — readers.roadmap.repoNameClashes и жёлтый ambiguous у следа', async () => {
  const reg2File = path.join(tmpDir('rm-reg2-'), 'registry.json');
  fs.writeFileSync(reg2File, JSON.stringify({ vault_root: vault, board_codes: { EXT: { repos: [extractor] }, CAR: { repos: [path.join(tmpDir('rm-dup-'), 'extractor')] } } }));
  const reg2 = createRegistryReader(reg2File);
  assert.deepEqual(rm.createRoadmapReader({ root: boardDir, lib: roadmapLib, registry: reg2, vault }).state().repoNameClashes, ['extractor']);
  const t2 = createTraceChecker({ git: gitR, registry: reg2, board, vault, roadmap: reader });
  await t2.refresh();
  const x = t2.peekRoad(`extractor@${h7(A)}`);
  assert.deepEqual([x.state, x.reasons.map((r) => r.code)], ['warn', ['ambiguous']]);
  assert.match(x.label, /неоднозначно/);
});

// ---------- Г2 п.5: счётчик «впереди» без двойного счёта ----------

test('Г2 п.5: EXT-103 в карте EXT и в карте INFRA — «впереди» у EXT, у INFRA нет; итог по цеху — разные номера', async () => {
  const r = await get('/api/roadmap');
  assert.equal(r.available, true);
  const c = Object.fromEntries(r.projects.map((p) => [p.code, p.counts]));
  // EXT: EXT-103 (EXT-98 — done); INFRA: INFRA-93 и EXT-107 (её нет в карте EXT); CAR — карты нет
  assert.deepEqual(c.EXT, { askOpen: 0, ideasDiscuss: 1, ahead: 1 });
  assert.deepEqual(c.INFRA, { askOpen: 1, ideasDiscuss: 1, ahead: 2 });
  assert.deepEqual([r.projects.find((p) => p.code === 'CAR').hasMap, c.CAR], [false, null]);
  assert.equal(r.total.ahead, 3);
});

// ---------- Г2 п.4: Р-10 (а) — фаза и шаг «Цеха» из карты ----------

test('Г2 п.4: фаза и шаг «Цеха» — из карты строгой маской; проект без карты — из Vault', async () => {
  const p = Object.fromEntries((await get('/api/ceh')).projects.map((x) => [x.code, x]));
  assert.equal(p.INFRA.phaseFrom, 'map');
  assert.ok(!p.INFRA.phase.full.includes(FLOW) && p.INFRA.phase.full.startsWith('цех пересобран'), p.INFRA.phase.full);
  assert.equal(p.INFRA.next.short, 'дорожная карта цеха');
  assert.deepEqual([p.EXT.phaseFrom, p.EXT.phase.short, p.EXT.next.short, p.EXT.phaseError], ['map', 'витрина и карта.', 'сервер карты.', null]);
  assert.deepEqual([p.CAR.phaseFrom, p.CAR.phase.short, p.CAR.next.short], ['vault', 'Vault CAR.', 'Шаг Vault CAR.']);
});

// ---------- Г2 п.2: ещё поломка ----------

test('Г2 п.2: запись map idea / plan mark в журнале субагента — запись в доску (map: project, без номера); map show — не запись', () => {
  const call = (command) => parseBoardWrite({ type: 'tool_use', name: 'Bash', input: { command } }, RULES);
  const idea = call('node C:/projects/unorbis-board/tools/board.mjs --as trurl:EXT map idea EXT "Окно агенты" --from "чат EXT 15.10"');
  assert.deepEqual([idea?.refs, idea?.project], [[], 'EXT']);
  const mark = call('node C:/projects/unorbis-board/tools/board.mjs --as trurl:INFRA plan mark INFRA-93 2.1 сделано --trace "extractor@abc1234"');
  assert.deepEqual(mark?.refs, ['INFRA-93']);
  assert.equal(call('node C:/projects/unorbis-board/tools/board.mjs map show EXT'), null);
  assert.equal(call('node C:/projects/unorbis-board/tools/board.mjs plan show INFRA-93'), null);
  for (const v of ['import', 'where', 'idea-set', 'ask', 'answer', 'card']) assert.equal(call(`node board.mjs --as trurl:EXT map ${v} EXT x`)?.project, 'EXT', v);
  for (const v of ['import', 'add', 'edit', 'give']) assert.deepEqual(call(`node board.mjs --as trurl:EXT plan ${v} EXT-1 x`)?.refs, ['EXT-1'], v);
});

test('Г2 п.2: успешная запись map idea субагентом — красная пометка «запись субагента в доску» под тредом; в cardRefs не входит', () => {
  const T0 = Date.parse('2026-10-17T10:00:00Z');
  const SID = '11111111-0000-4000-8000-0000000000aa';
  const w = { at: new Date(T0 - 5 * 60000).toISOString(), refs: [], project: 'EXT', firstLine: '' };
  const run = { agentId: 'a1', agentType: 'terminus', cards: [], starts: [], alive: true, boardWrites: [w] };
  const stub = { hasCard: () => false, card: () => null, hasCode: (c) => c === 'EXT' };
  const m = buildMarks({ procs: [{ sessionId: SID, live: true, startedAt: T0 - 3600000 }], sessions: [{ sessionId: SID, ivan: { cards: {} }, runs: [run], partials: [], boardWrites: [], thread: {} }], board: stub, now: T0, thresholds: {} });
  assert.deepEqual((m.bySession[SID] ?? []).map((x) => [x.kind, x.who, x.card, x.project]), [['subagentWrite', 'Терминус', null, 'EXT']]);
  assert.deepEqual(cardRefs({ boardWrites: [w] }, stub, null), []);
});

test('Г2 п.2: удачная карта, затем коммит битой (идея без статуса) — прежнее дерево и признак ошибки, parseErrors вырос', async () => {
  const before = (await get('/api/health')).readers.roadmap.parseErrors;
  fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), extMap(`${IDEA1}\n- i2 · 2026-10-16 · откуда: чат EXT 16.10 · без статуса`));
  gitCommitAll(boardDir, 'EXT map broken');
  await board.refresh();
  const r = await get('/api/roadmap/EXT');
  assert.deepEqual(r.map.ideas.map((i) => i.n), ['i1'], 'прежнее дерево, не пустота');
  assert.equal(r.broken.errors.length, 1);
  assert.equal(r.broken.errors[0].line, 13);
  assert.equal((await get('/api/health')).readers.roadmap.parseErrors, before + 1);
  assert.ok((await get('/api/roadmap')).projects.find((p) => p.code === 'EXT').broken);
});

test('Г2 п.4: карта без «фаза:» (битая) — фаза «Цеха» прежняя из карты и ошибка разбора, не откат на Vault', async () => {
  fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), extMap(IDEA1, 'следующий шаг: другой шаг.'));
  gitCommitAll(boardDir, 'EXT map without phase');
  await board.refresh();
  const p = (await get('/api/ceh')).projects.find((x) => x.code === 'EXT');
  assert.deepEqual([p.phaseFrom, p.phase.short, p.next.short], ['map', 'витрина и карта.', 'сервер карты.']);
  assert.match(p.phaseError, /фаза/);
});

// ---------- дозапрос 1 по ревью Голема ----------

test('Важно 2: маячок окна проекта — у проекта с картой фаза и шаг из карты (строгая маска), без карты — из Vault, битая — прежнее и ошибка', async () => {
  const b = async (code) => (await get(`/api/project/${code}`)).beacon;
  const infra = await b('INFRA');
  assert.equal(infra.phaseFrom, 'map');
  assert.ok(infra.phase.startsWith('цех пересобран') && !infra.phase.includes(FLOW) && infra.phase.includes('[скрыто:'), infra.phase);
  assert.deepEqual([infra.next, infra.phaseError], ['дорожная карта цеха', null]);
  const car = await b('CAR');
  assert.deepEqual([car.phaseFrom, car.phase, car.next, car.phaseError], ['vault', 'Vault CAR.', 'Шаг Vault CAR.', null]);
  // EXT — карта без «фаза:» с прошлого теста: прежние фаза и шаг удачного разбора и ошибка, не Vault
  const ext = await b('EXT');
  assert.deepEqual([ext.phaseFrom, ext.phase, ext.next], ['map', 'витрина и карта.', 'сервер карты.']);
  assert.match(ext.phaseError, /фаза/);
});

test('Важно 1: /api/health → readers.roadmap строгой сетью — id флоу из заголовка битой карты замаскирован (мягкая сеть его пропустила бы)', async () => {
  fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT.map.md'), extMap(IDEA1).replace('## Карточки', `## флоу ${FLOW}\n\n## Карточки`));
  gitCommitAll(boardDir, 'EXT map with flow section');
  await board.refresh();
  const raw = reader.state().lastError;
  assert.ok(raw.includes(FLOW), raw);
  assert.ok(maskDeep(raw, scanT, { project: '' }).includes(FLOW), 'контроль: мягкая сеть id флоу по слову-признаку прощает');
  const h = (await get('/api/health')).readers.roadmap;
  assert.ok(!JSON.stringify(h).includes(FLOW), h.lastError);
  assert.match(h.lastError, /\[скрыто:/);
});

test('Мелочь 2: state() читателя карты не строит таблицу имён на каждый вызов — при том же реестре та же таблица', () => {
  assert.equal(reader.state().repoNameClashes, reader.state().repoNameClashes);
});

test('Мелочь 3: изменённый файл карты кода не из projects.md — не читается (как при полном чтении)', async () => {
  fs.mkdirSync(path.join(boardDir, 'ZZ'), { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'ZZ', 'ZZ.map.md'), extMap(IDEA1).replace('# Карта EXT', '# Карта ZZ').replace(/- EXT-\d+\n/g, ''));
  gitCommitAll(boardDir, 'ZZ map outside projects.md');
  await board.refresh();
  assert.ok(!reader.mapCodes().includes('ZZ'), JSON.stringify(reader.mapCodes()));
  assert.equal(reader.state().maps, 2);
});

test('Мелочь 1: сбой git по следу карты (репозитория нет) не замораживает свежесть проверки Review — у второго входа свой учёт', async () => {
  const b3 = makeBoard(tmpDir('rm-board3-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review', title: 'На ревью' }] });
  fs.writeFileSync(path.join(b3, 'EXT', 'EXT-1.log.md'), contractLog);
  fs.writeFileSync(path.join(b3, 'EXT', 'EXT-1.plan.md'), '# План EXT-1\nформат: 1\n\n- [x] 1 · Шаг · след: gone@abc1234\n');
  gitInitCommit(b3);
  const reg3File = path.join(tmpDir('rm-reg3-'), 'registry.json');
  fs.writeFileSync(reg3File, JSON.stringify({ board_codes: { EXT: { repos: [extractor, path.join(tmpDir('rm-gone-'), 'gone')] } } }));
  const reg3 = createRegistryReader(reg3File);
  const r3 = rm.createRoadmapReader({ root: b3, lib: roadmapLib, registry: reg3 });
  const bd3 = createBoardReader({ root: b3, git: gitR, parseCard, parseLog, latest, roadmap: r3 });
  await bd3.init();
  const t3 = createTraceChecker({ git: gitR, registry: reg3, board: bd3, roadmap: r3 });
  await t3.refresh();
  assert.equal(t3.peek('EXT-1').state, 'ok', 'Review: контракт с отправленным коммитом extractor');
  assert.deepEqual(t3.peekRoad('gone@abc1234').reasons.map((x) => x.code), ['git-error']);
  const s = t3.state();
  assert.ok(s.lastOkAt, 'свежесть Review двигается');
  assert.deepEqual([s.errors, s.lastError], [0, null]);
  assert.ok(s.roadmap.errors >= 1 && s.roadmap.lastOkAt === null, JSON.stringify(s.roadmap));
});

// ---------- живой сервер: запасной импорт и перечитка ----------

const startOn = (board0, boardLib, poll = 60000) => onFreePort((port) => startServer({ config: { port, toasts: false, paths: { board: board0, boardLib, registry: regFile, vault }, pollMs: { board: poll, journals: 60000, git: 60000 }, statsEveryMin: 10 }, dataDir: tmpDir('rm-data-') }));
const fetchJson = async (port, url) => { const r = await fetch(`http://127.0.0.1:${port}${url}`); return { status: r.status, body: await r.json() }; };

test('Г2 п.2: roadmap.mjs убран из boardLib — витрина стартует, /api/roadmap «карта недоступна», прочие ручки живы', async () => {
  const lib = tmpDir('rm-lib-');
  for (const f of fs.readdirSync(BOARD_LIB)) if (f.endsWith('.mjs') && f !== 'roadmap.mjs') fs.copyFileSync(path.join(BOARD_LIB, f), path.join(lib, f));
  const { port, s } = await startOn(boardDir, lib);
  try {
    const r = await fetchJson(port, '/api/roadmap');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.available, r.body.projects], [false, []]);
    assert.match(r.body.error, /карта недоступна: модуль доски не найден/);
    // образец web/fixtures/roadmap-off.json — ключи настоящего ответа
    const off = JSON.parse(fs.readFileSync(new URL('../web/fixtures/roadmap-off.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(off).filter((k) => !k.startsWith('_')).sort(), Object.keys(r.body).sort());
    assert.equal((await fetchJson(port, '/api/roadmap/EXT')).body.available, false);
    const ceh = await fetchJson(port, '/api/ceh');
    assert.equal(ceh.status, 200);
    // без модуля — фаза «Цеха» как сейчас, из Vault (у проекта в реестре)
    assert.equal(ceh.body.projects.find((x) => x.code === 'CAR').phaseFrom, 'vault');
    const h = await fetchJson(port, '/api/health');
    assert.equal(h.status, 200);
    assert.match(h.body.readers.roadmap.lastError, /модуль доски не найден/);
  } finally { await s.stop(); }
});

test('Г2 п.3: правка карты коммитом доски видна в ручке за ≤ 10 с без перезапуска', async () => {
  const b2 = makeBoard(tmpDir('rm-board2-'), { codes: ['EXT'], cards: [{ id: 'EXT-103', status: 'in-progress' }, { id: 'EXT-98', status: 'done' }] });
  fs.writeFileSync(path.join(b2, 'EXT', 'EXT.map.md'), extMap(IDEA1));
  gitInitCommit(b2);
  const { port, s } = await startOn(b2, BOARD_LIB, 5000);
  try {
    assert.deepEqual((await fetchJson(port, '/api/roadmap/EXT')).body.map.ideas.map((i) => i.n), ['i1']);
    fs.writeFileSync(path.join(b2, 'EXT', 'EXT.map.md'), extMap(`${IDEA1}\n- i2 · обсуждаем · 2026-10-17 · откуда: чат EXT 17.10 · Новая`));
    gitCommitAll(b2, 'EXT: map idea i2');
    const t0 = Date.now();
    const seen = await untilAsync(async () => (await fetchJson(port, '/api/roadmap/EXT')).body.map.ideas.length === 2, 10000, 200);
    assert.ok(seen, 'за 10 с новая идея не видна');
    assert.ok(Date.now() - t0 <= 10000);
  } finally { await s.stop(); }
});
