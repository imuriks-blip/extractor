// EXT-115: «Принять» у слитой Б-карточки (решение дирижёра 19.10 по слову Ивана 15.10 «(а) Кнопка после слияния»; правило
// цеха «Рабочий цикл» п.7 — Vault 855bc14; подсказка ручной выкатки — решение Цереброна по вердикту Голема, INFRA-100;
// дозапрос 1 — решение дирижёра по Критично 1 и Важно 2–4 Голема).
// Б-карточка (mark_b) в Review «слита» — только по положительному следу в репозиториях проекта: (а) ветка карточки найдена и
// слита в main или (б) в main есть коммит, в сообщении которого номер карточки отдельным словом. Ни того ни другого — кнопки
// нет («не вижу слияния карточки — прими словом в чате»). Ветка найдена, не слита — как у обычной. Последняя запись — вопрос
// с меткой («развилка», «сливай», «выкатывай») — без кнопки. warn у слитой Б — по репозиториям со следом: null, только если
// все они из списка автовыкатки (протокол цеха, «Слияние и выкатка») и след есть в origin/main. Без git у Б кнопки нет.
// Ожидаемые значения — из ТЗ и из того, что положено в тест (репозитории — временные папки с теми же именами, git настоящий).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { buildThreads } from '../lib/threads.mjs';
import { acceptState, needsGit, createMergeCheck, B_HINT, FORK_HINT } from '../lib/pult/accept.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git, gitCommitAll } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4365;
const SELF = `http://127.0.0.1:${PORT}`;
// тексты — из ТЗ EXT-115 (п.2 первого ТЗ; п.1 дозапроса 1)
const WARN = 'выкатка ещё не сделана? «Принять» её не снимает';
const NO_TRACE = 'не вижу слияния карточки — прими словом в чате';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 500;
const nextIntent = () => uuid(++intents);

// ---------------- acceptState без git: формы итога проверки ----------------

const B = (last = null) => ({ status: 'review', markB: true, last });
// итог проверки Б-карточки со следом: репозитории следа и «след в origin/main»
const traced = (names, pushed = true) => ({ state: 'ok', branch: null, repo: null, trace: true, repos: names.map((n) => `C:\\projects\\${n}`), pushed });

test('EXT-115: Б-карточке в Review нужна проверка ветки (needsGit), Б с вопросом-меткой последней записью — нет', () => {
  assert.equal(needsGit(B()), true);
  assert.equal(needsGit(B({ mark: 'развилка' })), false);
  assert.equal(needsGit(B({ askMark: 'сливай' })), false);
  assert.equal(needsGit({ status: 'review', markB: false, last: null }), true, 'обычная — как раньше');
  assert.equal(needsGit({ status: 'in-progress', markB: true, last: null }), false, 'не в Review — git не нужен');
});

test('EXT-115: Б со следом (автовыкатка, отправлено) → can true без предупреждения; ещё не посчитано → «проверяю»', () => {
  const st = acceptState(B(), traced(['ledger-read-api']));
  assert.equal(st.can, true);
  assert.equal(st.why, null);
  assert.equal(st.warn, null);
  assert.equal(acceptState(B(), null).can, null);
  assert.equal(acceptState(B(), null).why, 'checking');
});

test('EXT-115: Б без следа слияния (итог ok без trace — нет веток и коммита; без git) → кнопки нет, why not-merged, «прими словом в чате»', () => {
  for (const m of [{ state: 'ok', branch: null, repo: null }, { state: 'no-trace', branch: null, repo: null }]) {
    const st = acceptState(B(), m);
    assert.deepEqual([st.can, st.why, st.hint], [false, 'not-merged', NO_TRACE], JSON.stringify(m));
  }
  // обычная с тем же итогом — как раньше: кнопка есть
  assert.equal(acceptState({ status: 'review', markB: false, last: null }, { state: 'ok', branch: null, repo: null }).can, true);
});

test('EXT-115: Б не слита или не проверить → кнопки нет, подсказка «Б-карточка ждёт слияния: «сливай» или «выкатывай»»', () => {
  const nm = acceptState(B(), { state: 'not-merged', branch: 'ledger-9-x', repo: 'C:\\projects\\ledger-read-api' });
  assert.equal(nm.can, false);
  assert.ok(nm.hint.includes(B_HINT), nm.hint);
  assert.ok(nm.hint.includes('ledger-9-x'), nm.hint);
  assert.equal(nm.branch, 'ledger-9-x');
  const un = acceptState(B(), { state: 'unknown', branch: null, repo: 'C:\\projects\\ledger-read-api' });
  assert.equal(un.can, false);
  assert.ok(un.hint.includes(B_HINT), un.hint);
});

test('EXT-115: Б слита, но последняя запись — «развилка» / «сливай» / «выкатывай» → кнопки нет (как раньше)', () => {
  // подсказка: «развилка» — FORK_HINT (сначала ответ на развилку; правка дирижёра), «сливай»/«выкатывай» — B_HINT
  for (const mk of ['развилка', 'сливай', 'выкатывай']) {
    const st = acceptState(B({ mark: mk }), traced(['ledger-read-api']));
    assert.deepEqual([st.can, st.why, st.hint], [false, 'b-deal', mk === 'развилка' ? FORK_HINT : B_HINT], mk);
  }
  // askMark читателя сильнее mark (запись пульта с Б)
  assert.equal(acceptState(B({ mark: null, askMark: 'сливай' }), traced(['ledger-read-api'])).can, false);
});

test('EXT-115: Б со следом — warn: ручная выкатка → да; автовыкатка и отправлено → нет; не отправлено или не сверить → да', () => {
  for (const r of ['unorbis-car-web', 'extractor', 'unorbis-board']) {
    const st = acceptState(B(), traced([r]));
    assert.equal(st.can, true, r);
    assert.equal(st.warn, WARN, r);
    assert.equal(st.hint, null, 'hint — только «почему нет кнопки»');
  }
  for (const r of ['ledger-read-api', 'orbis-car-backend', 'astro-app', 'makar-app', 'bodywork']) assert.equal(acceptState(B(), traced([r])).warn, null, r);
  // хоть один репозиторий следа не из списка — предупреждение
  assert.equal(acceptState(B(), traced(['orbis-car-backend', 'unorbis-car-web'])).warn, WARN);
  // у автовыкатки «слито = выкачено» только после отправки
  assert.equal(acceptState(B(), traced(['ledger-read-api'], false)).warn, WARN, 'в origin/main следа нет');
  assert.equal(acceptState(B(), traced(['ledger-read-api'], null)).warn, WARN, 'origin/main не сверить');
  // путь с прямыми косыми и хвостовой косой
  assert.equal(acceptState(B(), { ...traced([]), repos: ['C:/projects/astro-app/'] }).warn, null);
});

test('EXT-115: обычная карточка — как раньше: слита в репозитории с ручной выкаткой → {can: true, …} без warn', () => {
  const card = { status: 'review', markB: false, last: null };
  assert.deepEqual(acceptState(card, { state: 'ok', branch: null, repo: null }), { can: true, why: null, hint: null, branch: null });
  assert.equal(acceptState(card, { state: 'not-merged', branch: 'car-1-a', repo: 'x' }).why, 'not-merged');
});

// ---------------- настоящий git, временная доска, ручки и POST ----------------

// репозитории проектов: имена папок — как в реестре цеха (по ним список автовыкатки)
const base = tmpDir('e115-repos-');
const mkRepo = (name) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.txt'), name); gitInitCommit(d); return d; };
const commit = (repo, msg) => { fs.appendFileSync(path.join(repo, 'a.txt'), `${msg}\n`); gitCommitAll(repo, msg); };
const pushed = (repo) => git(repo, 'update-ref', 'refs/remotes/origin/main', 'main'); // origin/main = main (как после push)
const carWeb = mkRepo('unorbis-car-web');
const carBack = mkRepo('orbis-car-backend');
const ledger = mkRepo('ledger-read-api');
// CAR-1 (Б): ветка слита в orbis-car-backend (автовыкатка), отправлено; CAR-2 (Б): слита в unorbis-car-web (ручная);
// CAR-3 (Б): ни ветки, ни коммита с номером; CAR-4 — обычная, слита в unorbis-car-web; CAR-5 (Б): ветка не слита;
// CAR-7 (Б): слита, но последняя запись — «развилка»
git(carBack, 'branch', 'car-1-a');
git(carWeb, 'branch', 'car-2-a');
git(carWeb, 'branch', 'car-4-a');
git(carBack, 'branch', 'car-7-a');
git(carBack, 'checkout', '-q', '-b', 'car-5-x');
fs.writeFileSync(path.join(carBack, 'b.txt'), 'b');
gitCommitAll(carBack, 'car-5');
git(carBack, 'checkout', '-q', 'main');
pushed(carBack);
// коммит слияния ветки в текущую (--no-ff): msgs — абзацы сообщения (первый — тема); ветка после слияния удалена, как у нас
const T = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const mergeIn = (repo, branch, ...msgs) => {
  const into = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(repo, 'checkout', '-q', '-b', branch);
  commit(repo, `${branch}: работа`);
  git(repo, 'checkout', '-q', into);
  git(repo, ...T, 'merge', '--no-ff', '-q', ...msgs.flatMap((m) => ['-m', m]), branch);
  git(repo, 'branch', '-D', branch);
};
// ledger-read-api (автовыкатка), веток карточек нет — след только слиянием (б): коммит слияния на first-parent main, номер в теме.
// LEDGER-6 (Б): следа нет; LEDGER-8 (Б): «Merge … (LEDGER-8)» в main и origin/main; LEDGER-10, LEDGER-11 (Б): одно слияние
// ветки на две карточки, отправлено; LEDGER-12 (Б): в теме слияния только «LEDGER-120» и «LEDGER-12б» — не след;
// LEDGER-13 (Б): номер в ёлочках рядом с кириллицей — след; LEDGER-15 (Б): «выкатывай?», потом запись без метки, следа нет;
// LEDGER-18 (Б): обычный коммит main «… до LEDGER-18 (Б, миграция)» — упоминание, не слияние; LEDGER-19 (Б): слияние с номером
// в ветку side (side потом влита в main без номера) — не first-parent main; LEDGER-20 (Б): номер в теле слияния, не в теме;
// LEDGER-21 (Б): «Merge ledger-21-x (LEDGER-21): …» в main и origin; LEDGER-22 (Б): старое упоминание отправлено, а слияние
// только локально; LEDGER-9 (Б): слияние только в локальном main (origin позади)
mergeIn(ledger, 'work-8', 'Merge work-8 (LEDGER-8): очередь голоса');
mergeIn(ledger, 'ledger-10-11-x', 'Merge LEDGER-10, LEDGER-11 (ветка ledger-10-11-x): две карточки одним заходом');
mergeIn(ledger, 'work-12', 'Merge work-12: LEDGER-120 готово; LEDGER-12б черновик');
mergeIn(ledger, 'work-13', 'Слито «LEDGER-13» в main');
commit(ledger, 'Деньги: схема до LEDGER-18 (Б, миграция)');
git(ledger, 'checkout', '-q', '-b', 'side');
commit(ledger, 'side: своё');
mergeIn(ledger, 'feat-19', 'Merge feat-19 (LEDGER-19) в side');
git(ledger, 'checkout', '-q', 'main');
git(ledger, ...T, 'merge', '--no-ff', '-q', '-m', 'merge: side', 'side');
git(ledger, 'branch', '-D', 'side');
mergeIn(ledger, 'work-20', 'Merge work-20: деньги', 'Закрывает LEDGER-20.');
mergeIn(ledger, 'ledger-21-x', 'Merge ledger-21-x (LEDGER-21): миграция');
commit(ledger, 'LEDGER-22: черновик схемы');
pushed(ledger);
mergeIn(ledger, 'ledger-22-x', 'Merge ledger-22-x (LEDGER-22): схема');
mergeIn(ledger, 'work-9', 'Merge work-9 (LEDGER-9) — ещё не отправлено');
// репозиторий доски (registry board.repo) среди репозиториев проекта: каждая запись доски — коммит main «<НОМЕР>: log …»; там же
// слияние с номером в теме и слитая ветка карточки — из поиска следа Б доска исключена целиком.
// LEDGER-16 (Б): только запись доски; LEDGER-17 (Б): ветка ledger-17-x и «Merge ledger-17-x (LEDGER-17)» — только в доске
const boardRepo = mkRepo('unorbis-board');
commit(boardRepo, 'LEDGER-16: log ▶');
git(boardRepo, 'checkout', '-q', '-b', 'ledger-17-x');
commit(boardRepo, 'ledger-17-x: работа');
git(boardRepo, 'checkout', '-q', 'main');
git(boardRepo, ...T, 'merge', '--no-ff', '-q', '-m', 'Merge ledger-17-x (LEDGER-17)', 'ledger-17-x');
pushed(boardRepo);

const Q_MD = 'Готово, ветка слита и выкачена — принимай?';
const Q_HTML = '<p>Готово, ветка слита и выкачена — принимай?</p>';
const Q_AT = '2026-10-03T09:00:00.000Z';
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;
const LEDGER_B = ['LEDGER-6', 'LEDGER-8', 'LEDGER-9', 'LEDGER-10', 'LEDGER-11', 'LEDGER-12', 'LEDGER-13', 'LEDGER-15', 'LEDGER-16', 'LEDGER-17',
  'LEDGER-18', 'LEDGER-19', 'LEDGER-20', 'LEDGER-21', 'LEDGER-22'];
const boardDir = makeBoard(tmpDir('e115-board-'), { codes: ['CAR', 'LEDGER'], cards: [
  { id: 'CAR-1', status: 'review', markB: true }, { id: 'CAR-2', status: 'review', markB: true }, { id: 'CAR-3', status: 'review', markB: true },
  { id: 'CAR-4', status: 'review' }, { id: 'CAR-5', status: 'review', markB: true }, { id: 'CAR-7', status: 'review', markB: true },
  ...LEDGER_B.map((id) => ({ id, status: 'review', markB: true })),
] });
for (const id of ['CAR-1', 'CAR-2', 'CAR-3', 'CAR-4', 'CAR-5', ...LEDGER_B]) fs.writeFileSync(path.join(boardDir, id.split('-')[0], `${id}.log.md`), logWith(Q_MD));
fs.writeFileSync(path.join(boardDir, 'CAR', 'CAR-7.log.md'), logWith('Слито. Открыта развилка: катить сейчас или после праздника?'));
fs.writeFileSync(path.join(boardDir, 'LEDGER', 'LEDGER-15.log.md'), logWith('Готово — выкатывай?') + '\n### 2026-10-03 12:30 +03:00 · plane · коммент\n\nСделано, смотри на телефоне.\n');
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка: настоящий не запускается\n');
const regFile = path.join(tmpDir('e115-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board: { repo: boardRepo }, board_codes: { CAR: { repos: [carWeb, carBack] }, LEDGER: { repos: [ledger, boardRepo] } } }));

const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ch = new EventEmitter();
    ch.pid = 9500 + calls.length;
    ch.unref = () => {};
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  fn.calls = calls;
  return fn;
}

// подменный plane.py (test/fake-plane.mjs) — карточка в Review, последний коммент — тот самый вопрос
// noGit — запасная проверка без git (как в routes.mjs: createMergeCheck({ git: null }))
async function setup({ mergeGit = null, noGit = false } = {}) {
  const data = tmpDir('e115-data-');
  const pdir = tmpDir('e115-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'Review', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z' }));
  const web = tmpDir('e115-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const merge = createMergeCheck({ git: noGit ? null : mergeGit ?? createGitRead(), registry, board });
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, merge,
    pult: { enabled: true, words: false, actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: fakeSpawn() } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pl = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { app, press, get, lines, pl, pass: () => merge.refresh() };
}

const Q = { at: Q_AT, head: Q_MD };

test('EXT-115: ручки после прохода git — след веткой (а): слита → «Принять», ручная выкатка → warn; нет следа, не слита, развилка → нет; обычная — как раньше', async () => {
  const s = await setup();
  const acc = async (id) => (await s.get(`/api/card/${id}`)).pult.accept;
  assert.equal((await acc('CAR-1')).can, null, 'до прохода — «проверяю»: ветку Б-карточки считает проход');
  await s.pass();
  const c1 = await acc('CAR-1');
  assert.equal(c1.can, true, 'слита в orbis-car-backend');
  assert.equal(c1.warn, null, 'автовыкатка, отправлено — без предупреждения');
  const c2 = await acc('CAR-2');
  assert.equal(c2.can, true);
  assert.equal(c2.warn, WARN, 'слита в unorbis-car-web — ручная выкатка');
  assert.deepEqual(await acc('CAR-3'), { can: false, why: 'not-merged', hint: NO_TRACE, branch: null }, 'ни ветки, ни коммита с номером');
  assert.deepEqual(await acc('CAR-4'), { can: true, why: null, hint: null, branch: null }, 'обычная — без изменений');
  const c5 = await acc('CAR-5');
  assert.equal(c5.can, false);
  assert.equal(c5.branch, 'car-5-x');
  assert.ok(c5.hint.includes(B_HINT), c5.hint);
  const c7 = await acc('CAR-7');
  assert.deepEqual([c7.can, c7.why, c7.hint], [false, 'b-deal', FORK_HINT]);
  // строка (в) «Цеха» — тот же итог
  const ceh = await s.get('/api/ceh');
  const row = (id) => ceh.waiting.review.find((x) => x.id === id) ?? ceh.waiting.yes.find((x) => x.id === id);
  assert.equal(row('CAR-2').accept.can, true);
  assert.equal(row('CAR-2').accept.warn, WARN);
  assert.equal(row('CAR-5').accept.can, false);
  assert.equal(row('CAR-3').accept.can, false);
  await s.app.close();
});

test('EXT-115: след слиянием (б) — коммит слияния на first-parent main, номер отдельным словом в теме; origin/main решает warn у автовыкатки', async () => {
  const s = await setup();
  await s.pass();
  const acc = async (id) => (await s.get(`/api/card/${id}`)).pult.accept;
  assert.deepEqual(await acc('LEDGER-6'), { can: false, why: 'not-merged', hint: NO_TRACE, branch: null }, 'ни ветки, ни коммита');
  const l8 = await acc('LEDGER-8');
  assert.deepEqual([l8.can, l8.warn], [true, null], '«Merge LEDGER-8 …» в main и origin/main');
  const l9 = await acc('LEDGER-9');
  assert.deepEqual([l9.can, l9.warn], [true, WARN], 'коммит только в локальном main — не отправлено');
  for (const id of ['LEDGER-10', 'LEDGER-11']) assert.deepEqual([(await acc(id)).can, (await acc(id)).warn], [true, null], `${id}: слияние ветки на две карточки`);
  assert.equal((await acc('LEDGER-12')).can, false, '«LEDGER-120» и «LEDGER-12б» — не номер LEDGER-12');
  assert.equal((await acc('LEDGER-13')).can, true, '«LEDGER-13» в ёлочках рядом с кириллицей — номер');
  assert.deepEqual(await acc('LEDGER-15'), { can: false, why: 'not-merged', hint: NO_TRACE, branch: null }, '«выкатывай?», потом запись без метки, следа нет');
  const none = { can: false, why: 'not-merged', hint: NO_TRACE, branch: null };
  assert.deepEqual(await acc('LEDGER-16'), none, 'запись доски «LEDGER-16: log ▶» — не след');
  assert.deepEqual(await acc('LEDGER-17'), none, 'ветка и слияние только в репозитории доски — не след');
  assert.deepEqual(await acc('LEDGER-18'), none, 'обычный коммит «до LEDGER-18» — упоминание, не слияние');
  assert.deepEqual(await acc('LEDGER-19'), none, 'слияние в ветку side — не first-parent main');
  assert.deepEqual(await acc('LEDGER-20'), none, 'номер в теле слияния, не в теме');
  const l21 = await acc('LEDGER-21');
  assert.deepEqual([l21.can, l21.warn], [true, null], '«Merge ledger-21-x (LEDGER-21)» в main и origin/main');
  const l22 = await acc('LEDGER-22');
  assert.deepEqual([l22.can, l22.warn], [true, WARN], 'старое упоминание отправлено, слияние только локально');
  // отправили (origin/main догнал main) — следующий проход снимает warn
  pushed(ledger);
  await s.pass();
  assert.equal((await acc('LEDGER-9')).warn, null, 'после push — без предупреждения');
  await s.app.close();
});

test('EXT-115: без git (запасная проверка) — у Б-карточки кнопки нет (not-merged), у обычной — как было', async () => {
  const s = await setup({ noGit: true });
  const acc = async (id) => (await s.get(`/api/card/${id}`)).pult.accept;
  for (const id of ['CAR-1', 'CAR-2', 'LEDGER-8']) assert.deepEqual(await acc(id), { can: false, why: 'not-merged', hint: NO_TRACE, branch: null }, id);
  assert.equal((await acc('CAR-4')).can, true, 'обычная без git — как было');
  const m = await s.press({ action: 'accept', card: 'LEDGER-8', q: Q });
  assert.equal(m.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'not-merged');
  assert.equal(s.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  await s.app.close();
});

test('EXT-115: POST «Принять» у слитой Б-карточки — та же запись и Done, что у обычной; без следа и у неслитой — отказ, в Plane ничего', async () => {
  const s = await setup();
  await s.pass();
  const b = await s.press({ action: 'accept', card: 'CAR-2', q: Q });
  assert.equal(b.json().outcome, 'ok', b.json().message);
  const pb = s.pl();
  assert.equal(pb.status, 'Done');
  const bCalls = pb.calls.map((c) => c[0]);
  const bHtml = pb.comments.at(-1).html.replaceAll(b.json().id, '<id>');
  // обычная на том же исходном состоянии Plane
  const s2 = await setup();
  await s2.pass();
  const o = await s2.press({ action: 'accept', card: 'CAR-4', q: Q });
  assert.equal(o.json().outcome, 'ok', o.json().message);
  assert.deepEqual(bCalls, s2.pl().calls.map((c) => c[0]), 'те же вызовы plane.py');
  assert.equal(bHtml, s2.pl().comments.at(-1).html.replaceAll(o.json().id, '<id>'), 'та же запись');
  assert.ok(!bHtml.includes('Б — ждёт'), 'приписки Б-дела нет');
  // неслитая Б — отказ, Plane не тронут
  const s3 = await setup();
  await s3.pass();
  const m = await s3.press({ action: 'accept', card: 'CAR-5', q: Q });
  assert.equal(m.json().outcome, 'refused');
  assert.match(m.json().message, /car-5-x/);
  assert.equal(s3.lines().at(-1).refusal, 'not-merged');
  // без следа — отказ с подсказкой «прими словом в чате»
  const n = await s3.press({ action: 'accept', card: 'LEDGER-6', q: Q });
  assert.equal(n.json().outcome, 'refused');
  assert.ok(n.json().message.includes(NO_TRACE), n.json().message);
  assert.equal(s3.lines().at(-1).refusal, 'not-merged');
  // развилка — отказ b-deal
  const f = await s3.press({ action: 'accept', card: 'CAR-7', q: Q });
  assert.equal(f.json().outcome, 'refused');
  assert.equal(s3.lines().at(-1).refusal, 'b-deal');
  assert.equal(s3.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  for (const x of [s, s2, s3]) await x.app.close();
});

test('EXT-115: POST сверяет слияние Б-карточки заново — по устаревшему итогу прохода страница даёт «Принять», нажатие → отказ not-merged', async () => {
  const real = createGitRead();
  const stale = { on: true };
  const mergeGit = (dir, args) => (stale.on && args[0] === 'merge-base' ? Promise.resolve('') : real(dir, args));
  const s = await setup({ mergeGit });
  await s.pass();
  stale.on = false;
  assert.equal((await s.get('/api/card/CAR-5')).pult.accept.can, true, 'страница — по итогу прохода');
  const m = await s.press({ action: 'accept', card: 'CAR-5', q: Q });
  assert.equal(m.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'not-merged');
  assert.equal(s.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  await s.app.close();
});

// ---------------- EXT-126 (сервер): пометка oldRules тред не поднимает ----------------

test('EXT-126: тред с пометкой «старые правила» не встаёт первым — стоит по своему состоянию; красный такт по-прежнему поднимает', () => {
  const NOW = Date.parse('2026-10-19T12:00:00.000Z');
  const tboard = { hasCard: () => false, hasCode: (c) => c === 'EXT', cardsList: () => [], card: () => null };
  const proc = (sid, status, at) => ({ live: true, sessionId: sid, status, statusUpdatedAt: at, startedAt: '2026-10-19T10:00:00.000Z', observedAt: NOW, name: 'EXT · тред' });
  const procs = [proc('busy-1', 'busy', '2026-10-19T11:00:00.000Z'), proc('idle-old', 'idle', '2026-10-19T11:50:00.000Z')];
  const order = (marks) => buildThreads({ procs, sessions: [], board: tboard, now: NOW, marks }).threads.map((t) => t.sessionId);
  assert.deepEqual(order({}), ['busy-1', 'idle-old'], 'исправный: работает выше свободного');
  const old = order({ 'idle-old': [{ kind: 'oldRules', rulesUpdatedAt: '2026-10-19T09:00:00.000Z' }] });
  assert.deepEqual(old, ['busy-1', 'idle-old'], 'oldRules не поднимает');
  assert.deepEqual(order({ 'idle-old': [{ kind: 'takt', level: 'red' }] }), ['idle-old', 'busy-1'], 'красный такт поднимает, как раньше');
});
