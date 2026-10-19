// EXT-115: «Принять» у слитой Б-карточки (решение дирижёра 19.10 по слову Ивана 15.10 «(а) Кнопка после слияния»; правило
// цеха «Рабочий цикл» п.7 — Vault 855bc14; подсказка ручной выкатки — решение Цереброна по вердикту Голема, INFRA-100).
// Б-карточка (mark_b) в Review проходит ту же проверку слияния, что обычная: слита — «Принять» есть; не слита / не проверить —
// нет. Последняя запись — вопрос с меткой («развилка», «сливай», «выкатывай») — по-прежнему без кнопки. У слитой Б-карточки,
// чей репозиторий не из списка автовыкатки из main (протокол цеха, таблица «Слияние и выкатка»: ledger-read-api,
// orbis-car-backend, astro-app, makar-app, bodywork), — предупреждение warn. Ожидаемые значения — из ТЗ и из того, что
// положено в тест (репозитории — временные папки с теми же именами, git настоящий).
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
import { acceptState, needsGit, createMergeCheck, B_HINT } from '../lib/pult/accept.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git, gitCommitAll } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4365;
const SELF = `http://127.0.0.1:${PORT}`;
// текст предупреждения — из ТЗ EXT-115 п.2
const WARN = 'выкатка ещё не сделана? «Принять» её не снимает';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 500;
const nextIntent = () => uuid(++intents);

// ---------------- acceptState без git: формы итога проверки ----------------

const B = (last = null) => ({ status: 'review', markB: true, last });
const repoOk = (...names) => ({ state: 'ok', branch: null, repo: null, repos: names.map((n) => `C:\\projects\\${n}`) });

test('EXT-115: Б-карточке в Review нужна проверка ветки (needsGit), Б с вопросом-меткой последней записью — нет', () => {
  assert.equal(needsGit(B()), true);
  assert.equal(needsGit(B({ mark: 'развилка' })), false);
  assert.equal(needsGit(B({ askMark: 'сливай' })), false);
  assert.equal(needsGit({ status: 'review', markB: false, last: null }), true, 'обычная — как раньше');
  assert.equal(needsGit({ status: 'in-progress', markB: true, last: null }), false, 'не в Review — git не нужен');
});

test('EXT-115: Б слита (автовыкатка) → can true без предупреждения; ещё не посчитано → «проверяю»', () => {
  const st = acceptState(B(), repoOk('ledger-read-api'));
  assert.equal(st.can, true);
  assert.equal(st.why, null);
  assert.equal(st.warn ?? null, null);
  assert.equal(acceptState(B(), null).can, null);
  assert.equal(acceptState(B(), null).why, 'checking');
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
  // подсказка у Б с развилкой — как была (B_HINT, не FORK_HINT): ТЗ п.1 «по-прежнему без кнопки, как сейчас»
  for (const mk of ['развилка', 'сливай', 'выкатывай']) {
    const st = acceptState(B({ mark: mk }), repoOk('ledger-read-api'));
    assert.deepEqual([st.can, st.why, st.hint], [false, 'b-deal', B_HINT], mk);
  }
  // askMark читателя сильнее mark (запись пульта с Б)
  assert.equal(acceptState(B({ mark: null, askMark: 'сливай' }), repoOk('ledger-read-api')).can, false);
});

test('EXT-115: Б слита, репозиторий с ручной выкаткой → can true и warn; автовыкатка → без warn; репозиториев нет → warn', () => {
  for (const r of ['unorbis-car-web', 'extractor', 'unorbis-board']) {
    const st = acceptState(B(), repoOk(r));
    assert.equal(st.can, true, r);
    assert.equal(st.warn, WARN, r);
    assert.equal(st.hint, null, 'hint — только «почему нет кнопки»');
  }
  for (const r of ['ledger-read-api', 'orbis-car-backend', 'astro-app', 'makar-app', 'bodywork']) assert.equal(acceptState(B(), repoOk(r)).warn ?? null, null, r);
  // хоть один репозиторий не из списка — предупреждение (не доказано, что выкатка сама)
  assert.equal(acceptState(B(), repoOk('orbis-car-backend', 'unorbis-car-web')).warn, WARN);
  assert.equal(acceptState(B(), repoOk()).warn, WARN, 'репозиториев нет — не доказано');
  assert.equal(acceptState(B(), { state: 'ok', branch: null, repo: null }).warn, WARN, 'без git (repos не знаем) — не доказано');
  // путь с прямыми косыми и хвостовой косой
  assert.equal(acceptState(B(), { state: 'ok', branch: null, repo: null, repos: ['C:/projects/astro-app/'] }).warn ?? null, null);
});

test('EXT-115: обычная карточка — как раньше: слита в репозитории с ручной выкаткой → {can: true, …} без warn', () => {
  const card = { status: 'review', markB: false, last: null };
  assert.deepEqual(acceptState(card, repoOk('unorbis-car-web')), { can: true, why: null, hint: null, branch: null });
  assert.equal(acceptState(card, { state: 'not-merged', branch: 'car-1-a', repo: 'x' }).why, 'not-merged');
});

// ---------------- настоящий git, временная доска, ручки и POST ----------------

// репозитории проектов: имена папок — как в реестре цеха (по ним список автовыкатки)
const base = tmpDir('e115-repos-');
const mkRepo = (name) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.txt'), name); gitInitCommit(d); return d; };
const carWeb = mkRepo('unorbis-car-web');
const carBack = mkRepo('orbis-car-backend');
const ledger = mkRepo('ledger-read-api');
// CAR-1 (Б): ветка слита в orbis-car-backend (автовыкатка); CAR-2 (Б): слита в unorbis-car-web (ручная);
// CAR-3 (Б): ветки нет нигде (удалена после слияния) — какой репозиторий, не знаем; CAR-4 — обычная, слита в unorbis-car-web;
// CAR-5 (Б): ветка не слита в orbis-car-backend; CAR-7 (Б): слита, но последняя запись — «развилка»;
// LEDGER-6 (Б): ветки нет, у проекта один репозиторий с автовыкаткой
git(carBack, 'branch', 'car-1-a');
git(carWeb, 'branch', 'car-2-a');
git(carWeb, 'branch', 'car-4-a');
git(carBack, 'branch', 'car-7-a');
git(carBack, 'checkout', '-q', '-b', 'car-5-x');
fs.writeFileSync(path.join(carBack, 'b.txt'), 'b');
gitCommitAll(carBack, 'car-5');
git(carBack, 'checkout', '-q', 'main');

const Q_MD = 'Готово, ветка слита и выкачена — принимай?';
const Q_HTML = '<p>Готово, ветка слита и выкачена — принимай?</p>';
const Q_AT = '2026-10-03T09:00:00.000Z';
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;
const boardDir = makeBoard(tmpDir('e115-board-'), { codes: ['CAR', 'LEDGER'], cards: [
  { id: 'CAR-1', status: 'review', markB: true }, { id: 'CAR-2', status: 'review', markB: true }, { id: 'CAR-3', status: 'review', markB: true },
  { id: 'CAR-4', status: 'review' }, { id: 'CAR-5', status: 'review', markB: true }, { id: 'CAR-7', status: 'review', markB: true },
  { id: 'LEDGER-6', status: 'review', markB: true },
] });
for (const id of ['CAR-1', 'CAR-2', 'CAR-3', 'CAR-4', 'CAR-5', 'LEDGER-6']) fs.writeFileSync(path.join(boardDir, id.split('-')[0], `${id}.log.md`), logWith(Q_MD));
fs.writeFileSync(path.join(boardDir, 'CAR', 'CAR-7.log.md'), logWith('Слито. Открыта развилка: катить сейчас или после праздника?'));
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка: настоящий не запускается\n');
const regFile = path.join(tmpDir('e115-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { CAR: { repos: [carWeb, carBack] }, LEDGER: { repos: [ledger] } } }));

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
async function setup({ mergeGit = null } = {}) {
  const data = tmpDir('e115-data-');
  const pdir = tmpDir('e115-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'Review', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z' }));
  const web = tmpDir('e115-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const merge = createMergeCheck({ git: mergeGit ?? createGitRead(), registry, board });
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

test('EXT-115: ручки после прохода git — Б слита → «Принять»; ручная выкатка или репозиторий неизвестен → warn; не слита, развилка → нет; обычная — как раньше', async () => {
  const s = await setup();
  const acc = async (id) => (await s.get(`/api/card/${id}`)).pult.accept;
  assert.equal((await acc('CAR-1')).can, null, 'до прохода — «проверяю»: ветку Б-карточки считает проход');
  await s.pass();
  const c1 = await acc('CAR-1');
  assert.equal(c1.can, true, 'слита в orbis-car-backend');
  assert.equal(c1.warn ?? null, null, 'автовыкатка — без предупреждения');
  const c2 = await acc('CAR-2');
  assert.equal(c2.can, true);
  assert.equal(c2.warn, WARN, 'слита в unorbis-car-web — ручная выкатка');
  const c3 = await acc('CAR-3');
  assert.equal(c3.can, true);
  assert.equal(c3.warn, WARN, 'ветки нет, у проекта есть репозиторий с ручной выкаткой — не доказано');
  assert.deepEqual(await acc('CAR-4'), { can: true, why: null, hint: null, branch: null }, 'обычная — без изменений');
  const c5 = await acc('CAR-5');
  assert.equal(c5.can, false);
  assert.equal(c5.branch, 'car-5-x');
  assert.ok(c5.hint.includes(B_HINT), c5.hint);
  const c7 = await acc('CAR-7');
  assert.deepEqual([c7.can, c7.why, c7.hint], [false, 'b-deal', B_HINT]);
  const l6 = await acc('LEDGER-6');
  assert.equal(l6.can, true);
  assert.equal(l6.warn ?? null, null, 'у проекта один репозиторий, с автовыкаткой');
  // строка (в) «Цеха» — тот же итог
  const ceh = await s.get('/api/ceh');
  const row = (id) => ceh.waiting.review.find((x) => x.id === id) ?? ceh.waiting.yes.find((x) => x.id === id);
  assert.equal(row('CAR-2').accept.can, true);
  assert.equal(row('CAR-2').accept.warn, WARN);
  assert.equal(row('CAR-5').accept.can, false);
  await s.app.close();
});

test('EXT-115: POST «Принять» у слитой Б-карточки — та же запись и Done, что у обычной; у неслитой — отказ, в Plane ничего', async () => {
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
  assert.equal(s3.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  // развилка — отказ b-deal
  const f = await s3.press({ action: 'accept', card: 'CAR-7', q: Q });
  assert.equal(f.json().outcome, 'refused');
  assert.equal(s3.lines().at(-1).refusal, 'b-deal');
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
