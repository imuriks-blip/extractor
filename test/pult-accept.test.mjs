// Пульт ПТ3 (EXT-43; спека пульта §1.1 п.4–6, §1.2, таблица 1.3 «Принять»/«Вернуть», §3.1, §3.2, §3.4, строка ПТ3 §7):
// «Принять» и «Вернуть» на подменном plane.py (test/fake-plane.mjs: тот же вывод и коды, что у настоящего) и на
// временной доске. Настоящий plane.py и mirror.mjs не запускаются: python = node, planePy = копия подменного,
// запуск wscript — подменный spawn. Ожидаемые значения — из спеки и из того, что положено в тест.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead, checkArgs } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { normHead, localMarks, acceptState, B_HINT, createPlaneSpawn, createMergeCheck } from '../lib/pult/accept.mjs';
import { validQ } from '../lib/pult/actions.mjs';
import { restoreIntents } from '../lib/pult/routes.mjs';
import { localIso } from '../lib/pult/actions-log.mjs';
import { BOARD_LIB, tmpDir, makeBoard, writeCard, gitInitCommit, git, gitCommitAll, fakeGit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 100;
const nextIntent = () => uuid(++intents);

// запись-вопрос карточки в файлах зеркала: 03.10 12:00 по Риге = 09:00Z; тело — markdown, как его пишет зеркало
const Q_MD = '**Ветка** готова — `ext-7` можно принимать?';
const Q_HTML = '<p><strong>Ветка</strong> готова — <code>ext-7</code> можно принимать?</p>';
const Q_AT = '2026-10-03T09:00:00.000Z';
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;

// доска: EXT-7 обычная (ветки нет), EXT-8 — mark_b, EXT-9 — неслитая ветка, EXT-10 — слитая ветка, EXT-11 — без записей,
// EXT-12, EXT-13 — для отметки и дотяжки
const boardDir = makeBoard(tmpDir('acc-board-'), { codes: ['EXT', 'CAR'], cards: [
  { id: 'EXT-7', status: 'review', title: 'Семь' }, { id: 'EXT-8', status: 'review', markB: true }, { id: 'EXT-9', status: 'review' },
  { id: 'EXT-10', status: 'review' }, { id: 'EXT-11', status: 'review' }, { id: 'EXT-12', status: 'review' }, { id: 'EXT-13', status: 'review' },
  { id: 'EXT-14', status: 'review' },
] });
for (const id of ['EXT-7', 'EXT-8', 'EXT-9', 'EXT-10', 'EXT-12', 'EXT-13']) fs.writeFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), logWith(Q_MD));
fs.rmSync(path.join(boardDir, 'EXT', 'EXT-11.log.md'));
// EXT-14: две записи, последняя — длинная многострочная (head — первые 60 знаков тела)
const LONG = 'Готово: **ветка** `ext-14-x` слита, тесты 396/396, вердикт Голема без замечаний.\n\nСмотри?';
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-14.log.md'), logWith('старая запись') + `\n### 2026-10-03 12:30 +03:00 · plane · коммент\n\n${LONG}\n`);
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка: настоящий не запускается\n');

// репозиторий проекта EXT: main, ветка ext-9-x со своим коммитом (не слита), ext-10-y слита
const repo = tmpDir('acc-repo-');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
gitInitCommit(repo);
git(repo, 'branch', 'ext-10-y');
git(repo, 'checkout', '-q', '-b', 'ext-9-x');
fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
gitCommitAll(repo, 'ext-9');
git(repo, 'checkout', '-q', 'main');
const regFile = path.join(tmpDir('acc-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [repo] }, CAR: { repos: [] } } }));

const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ch = new EventEmitter();
    ch.pid = 9000 + calls.length;
    ch.unref = () => {};
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  fn.calls = calls;
  return fn;
}

// plane — начальное состояние подменного plane.py: карточка в Review, последний коммент — тот самый вопрос
// log — строки actions.log до старта (рестарт витрины посреди действия)
// planeSpawn — подменный spawn запуска plane.py (мелочь 3 Голема на В10): createPlaneSpawn с ним вместо настоящего
// mergeGit — git проверки слитости (EXT-57: устаревший итог прохода против свежей сверки нажатия)
// bell — флаг pult.bell (ПТ4а); bellDir — папка звонка; threads — живые треды (строки «Кто работает»); sessions — журналы
async function setup(plane = {}, { log = null, planeSpawn = null, mergeGit = null, bell = false, bellDir = null, threads = null, sessions = () => [], seams = {}, slog = null } = {}) {
  const data = tmpDir('acc-data-');
  const pdir = tmpDir('acc-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'Review', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z', ...plane }));
  const web = tmpDir('acc-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  if (log) fs.writeFileSync(actionsLog, log.map((l) => JSON.stringify(l) + '\n').join(''));
  const spawn = fakeSpawn();
  // слита ли ветка (В7) — считает проход читателя git (EXT-57): тест зовёт его сам (s.pass), ручки только читают
  const merge = createMergeCheck({ git: mergeGit ?? createGitRead(), registry, board });
  const bdir = bellDir ?? path.join(data, 'bell');
  const live = { cur: threads ?? [] };
  const threadsApi = { list: () => ({ threads: live.cur, subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: '2026-10-04T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions };
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, merge, threads: threadsApi, journals, ...(slog ? { log: slog } : {}),
    pult: { enabled: true, words: false, bell, bellDir: bdir, actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn, ...seams, ...(planeSpawn ? { planeRun: createPlaneSpawn({ python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs'), spawn: planeSpawn }) } : {}) } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const raw = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '');
  const lines = () => raw().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pl = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setPlane = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...pl(), ...patch }));
  return { app, press, get, lines, raw, pl, setPlane, spawn, data, pass: () => merge.refresh(), bellDir: bdir, live, actionsLog };
}

const Q = { at: Q_AT, head: Q_MD };
const cmds = (calls) => calls.map((c) => c[0] + (c[0] === 'state' ? ` ${c[2]}` : ''));
// время ДД.ММ ЧЧ:ММ по часам машины (витрина живёт там же, где Иван)
const p2 = (n) => String(n).padStart(2, '0');
const local = (iso) => { const d = new Date(iso); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

// ---------------- Review → Done, запись §1.2 ----------------

test('«Принять»: Review → Done, запись §1.2 — номер и метка в первом абзаце, «В ответ на», «Кто решил»; дотяжка --card', async () => {
  const s = await setup();
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'ok');
  assert.match(b.message, /^принято · Done в Plane \d\d:\d\d · зеркало: ждёт$/);
  const p = s.pl();
  assert.equal(p.status, 'Done');
  assert.deepEqual(cmds(p.calls), ['show', 'comment', 'state Done']);
  assert.deepEqual(p.calls[0], ['show', 'EXT-7', '--last']);
  assert.equal(p.comments.length, 2);
  const html = p.comments[1].html;
  assert.ok(html.startsWith(`<p><b>Слово Ивана · кнопка витрины · ${b.id}</b>: «принято»</p>`), html);
  assert.ok(html.includes(`<p>В ответ на: запись ${local(Q_AT)} «${Q_MD}»</p>`), html);
  assert.ok(html.endsWith(`<p>Кто решил: слово Ивана · кнопка витрины · ${b.id}</p>`), html);
  // номер — в 80 знаках show --last (§1.2): первые 80 знаков текста без тегов несут id
  assert.ok(html.replace(/<[^>]*>/g, '').slice(0, 80).includes(b.id));
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'fresh', 'plane', 'plane', 'done']);
  const fresh = s.lines()[1];
  assert.equal(fresh.fresh.status, 'Review');
  assert.equal(fresh.fresh.last.at, '2026-10-03T09:00:41.018934Z');
  assert.deepEqual(s.lines()[0].q, Q);
  // дотяжка: wscript mirror-hidden.js … --card EXT-7 --root <доска> --log …, отсоединённо и скрыто
  assert.equal(s.spawn.calls.length, 1);
  const a = s.spawn.calls[0].args;
  assert.deepEqual(a.slice(a.indexOf('--card'), a.indexOf('--card') + 4), ['--card', 'EXT-7', '--root', boardDir]);
  assert.ok(a.includes('--log'));
  assert.equal(s.spawn.calls[0].opts.detached, true);
  assert.equal(s.spawn.calls[0].opts.windowsHide, true);
});

test('«Вернуть»: причина обязательна и экранирована, Review → In Progress; pult.bell выключен — «звонок выключен: тред увидит на карточке», шагов ring-* нет', async () => {
  const s = await setup();
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста <b>"x" & y</b>' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'ok');
  assert.match(r.json().message, /^возвращено · In Progress в Plane \d\d:\d\d · звонок выключен: тред увидит на карточке$/);
  assert.ok(!s.lines().some((l) => String(l.step).startsWith('ring-')));
  const p = s.pl();
  assert.equal(p.status, 'In Progress');
  assert.deepEqual(cmds(p.calls), ['show', 'comment', 'state In Progress']);
  const html = p.comments[1].html;
  assert.ok(html.startsWith(`<p><b>Слово Ивана · кнопка витрины · ${r.json().id}</b>: «вернуть»</p>`));
  assert.ok(html.includes('<p>Причина: нет теста &lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;</p>'), html);
  assert.equal(s.lines()[0].text, 'нет теста <b>"x" & y</b>');
});

// ---------------- свежая сверка (§1.1 п.6) ----------------

test('свежая сверка: тред перевёл карточку в In Progress в Plane, зеркало старое → отказ stale-status «дотянуть», комментов не прибавилось', async () => {
  const s = await setup({ status: 'In Progress' });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /^в Plane сейчас In Progress; зеркало от \d\d\.\d\d \d\d:\d\d — дотянуть\?$/);
  assert.equal(r.json().pull, true);
  assert.equal(s.pl().comments.length, 1);
  assert.deepEqual(cmds(s.pl().calls), ['show']);
  assert.equal(s.lines().at(-1).refusal, 'stale-status');
  // исправный рядом: Review — прошло
  const ok = await setup();
  assert.equal((await ok.press({ action: 'accept', card: 'EXT-7', q: Q })).json().outcome, 'ok');
});

test('свежая сверка: в Plane коммент новее q (минута больше) → отказ new-question, коммента нет', async () => {
  const s = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41Z', html: Q_HTML }, { id: 'q2', created_at: '2026-10-03T09:05:02Z', html: '<p>Ещё вопрос: а тесты?</p>' }] });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /^на карточке новое сообщение от \d\d:\d\d — посмотри и ответь заново$/);
  assert.equal(r.json().pull, true);
  assert.equal(s.pl().comments.length, 2);
  assert.equal(s.lines().at(-1).refusal, 'new-question');
});

test('нормализация: та же минута и тот же текст (HTML в Plane, markdown в зеркале) — не «новый вопрос»; та же минута, другие слова — новый', async () => {
  const same = await setup();
  assert.equal((await same.press({ action: 'accept', card: 'EXT-7', q: Q })).json().outcome, 'ok');
  const other = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:59Z', html: '<p>Другой вопрос в ту же минуту?</p>' }] });
  const r = await other.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.json().outcome, 'refused');
  assert.equal(other.lines().at(-1).refusal, 'new-question');
  // одна функция для обеих сторон: HTML, markdown, экранирование, U+FE0F, пробелы
  assert.equal(normHead('<p>Готово&nbsp;✅\uFE0F <b>да</b></p><p>x &amp; y</p>'), normHead('Готово ✅ **да**\n\nx & y'));
  assert.equal(normHead('a\\_b \\*c\\* `код`'), normHead('<p>a_b *c* <code>код</code></p>'));
});

test('q.at = null: любой коммент в Plane, кроме записи пульта, → отказ; только запись пульта — прошло', async () => {
  const s = await setup({ comments: [{ id: 'z', created_at: '2026-10-03T09:00:00Z', html: '<p>Вопрос треда?</p>' }] });
  const r = await s.press({ action: 'accept', card: 'EXT-11', q: { at: null } });
  assert.equal(r.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'new-question');
  const ok = await setup({ comments: [{ id: 'z', created_at: '2026-10-03T09:00:00Z', html: '<p><b>Слово Ивана · кнопка витрины · W-261003-120000-ab12</b>: «да»</p>' }] });
  assert.equal((await ok.press({ action: 'accept', card: 'EXT-11', q: { at: null } })).json().outcome, 'ok');
  assert.ok(ok.pl().comments[1].html.includes('<p>В ответ на: записей не было</p>'));
  const none = await setup({ comments: [] });
  assert.equal((await none.press({ action: 'accept', card: 'EXT-11', q: { at: null } })).json().outcome, 'ok');
});

test('q обязателен у «Принять»/«Вернуть»; q.at — только ISO-время, а не любая строка Date.parse', async () => {
  const s = await setup();
  assert.equal((await s.press({ action: 'accept', card: 'EXT-7' })).statusCode, 400);
  assert.equal((await s.press({ action: 'accept', card: 'EXT-7', q: { at: 'October 3, 2026', head: 'x' } })).statusCode, 400);
  assert.equal(validQ({ at: '2026-10-03', head: 'x' }), null);
  assert.equal(validQ({ at: '1', head: 'x' }), null);
  assert.deepEqual(validQ({ at: '2026-10-02T19:40+03:00', head: 'x' }), { at: '2026-10-02T19:40+03:00', head: 'x' });
  assert.deepEqual(validQ({ at: '2026-10-03T09:00:41.018Z', head: 'x' }), { at: '2026-10-03T09:00:41.018Z', head: 'x' });
  assert.equal(s.pl().calls?.length ?? 0, 0);
});

// ---------------- готовый q в данных (для интерфейса) ----------------

test('q в данных: строки (б)/(в) /api/ceh и /api/project, pult.q карточки — {at, head} последней записи зеркала или {at: null}; отправленный как есть — проходит сверку', async () => {
  const s = await setup();
  const ceh = await s.get('/api/ceh');
  const row = (id) => ceh.waiting.review.find((x) => x.id === id) ?? ceh.waiting.yes.find((x) => x.id === id);
  // ожидаемое — из положенного в доску: заголовок 12:00 +03:00 = 09:00Z, тело Q_MD
  assert.deepEqual(row('EXT-7').q, { at: Q_AT, head: Q_MD });
  assert.deepEqual(row('EXT-8').q, { at: Q_AT, head: Q_MD }, 'строка (б) тоже несёт q');
  assert.deepEqual(row('EXT-11').q, { at: null }, 'записей нет — {at: null}');
  assert.deepEqual(row('EXT-14').q, { at: '2026-10-03T09:30:00.000Z', head: [...LONG].slice(0, 60).join('') }, 'последняя запись, первые 60 знаков тела');
  assert.equal([...row('EXT-14').q.head].length, 60);
  assert.deepEqual((await s.get('/api/card/EXT-7')).pult.q, { at: Q_AT, head: Q_MD });
  assert.deepEqual((await s.get('/api/card/EXT-11')).pult.q, { at: null });
  assert.deepEqual((await s.get('/api/project/EXT')).waiting.find((x) => x.id === 'EXT-14').q, row('EXT-14').q);
  // исправный случай: q из данных, отправленный как есть, — сверка пройдена
  const ok = await s.press({ action: 'accept', card: 'EXT-7', q: row('EXT-7').q });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().outcome, 'ok');
  assert.deepEqual(s.lines().find((l) => l.id === ok.json().id && l.step === 'asked').q, { at: Q_AT, head: Q_MD });
  // карточка с новой записью в Plane (новее записи зеркала) — тот же q → new-question, коммента нет
  const fresh = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41Z', html: Q_HTML }, { id: 'q2', created_at: '2026-10-03T09:12:00Z', html: '<p>А это проверил?</p>' }] });
  const q = (await fresh.get('/api/ceh')).waiting.review.find((x) => x.id === 'EXT-7').q;
  const r = await fresh.press({ action: 'accept', card: 'EXT-7', q });
  assert.equal(r.json().outcome, 'refused');
  assert.equal(fresh.lines().at(-1).refusal, 'new-question');
  assert.equal(fresh.pl().comments.length, 2);
  // и EXT-14: q из данных против того же текста в Plane (HTML) — проходит
  const long = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:30:12Z', html: '<p>Готово: <strong>ветка</strong> <code>ext-14-x</code> слита, тесты 396/396, вердикт Голема без замечаний.</p><p>Смотри?</p>' }] });
  const q14 = (await long.get('/api/ceh')).waiting.review.find((x) => x.id === 'EXT-14').q;
  assert.equal((await long.press({ action: 'return', card: 'EXT-14', q: q14, text: 'доделать' })).json().outcome, 'ok');
});

// ---------------- частичный и неясный исход (§3.1) ----------------

test('частичный: comment прошёл, state упал (трасса Python) → partial без трассы; повтор зовёт только state, коммент один', async () => {
  const s = await setup({ fail: { state: 'net' } });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'partial');
  assert.match(r.json().message, /^частично: запись есть, статус не сменился — повторить/);
  const part = s.lines().at(-1);
  assert.equal(part.step, 'partial');
  assert.equal(part.result.line, 'Traceback (most recent call last):');
  assert.ok(!s.raw().includes('board.example'), 'трасса в actions.log не кладётся');
  assert.equal(s.pl().status, 'Review');
  s.setPlane({ fail: {}, calls: [] });
  const r2 = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r2.json().outcome, 'ok');
  assert.deepEqual(cmds(s.pl().calls), ['show', 'state Done']);
  assert.equal(s.pl().comments.length, 2, 'коммент пульта один');
  assert.equal(s.pl().status, 'Done');
  assert.equal(s.lines().at(-1).result.record, r.json().id, 'на карточке — номер первого нажатия');
});

test('частичный: state — код 0 и «НЕ совпал» — тоже не успех', async () => {
  const s = await setup({ fail: { state: 'mismatch' } });
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'причина' });
  assert.equal(r.json().outcome, 'partial');
  assert.equal(s.lines().at(-1).step, 'partial');
});

test('неясный: comment лёг и вышел кодом 3 → show --last находит <id>, второго коммента нет, state идёт', async () => {
  const s = await setup({ fail: { comment: 'unclear-after' } });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.json().outcome, 'ok');
  assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', 'show', 'state Done']);
  assert.equal(s.pl().comments.length, 2);
  assert.equal(s.pl().status, 'Done');
});

test('неясный: comment не лёг (код 3) → show --last без <id> → «не записано», повтор пишет коммент один раз', async () => {
  const s = await setup({ fail: { comment: 'unclear-before' } });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.json().outcome, 'error');
  assert.match(r.json().message, /^не найдено в последнем комменте — проверь карточку \(неясный исход: таймаут\)$/);
  assert.equal(s.lines().at(-1).step, 'error');
  assert.equal(s.pl().comments.length, 1);
  s.setPlane({ fail: {}, calls: [] });
  assert.equal((await s.press({ action: 'accept', card: 'EXT-7', q: Q })).json().outcome, 'ok');
  assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', 'state Done']);
  assert.equal(s.pl().comments.length, 2);
});

test('отказ доски на comment (код 1, 429) → show --last, коммента нет → «не записано: Доска ответила 429…», state не зовётся', async () => {
  const s = await setup({ fail: { comment: 'refuse' } });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.json().outcome, 'error');
  assert.match(r.json().message, /^не найдено в последнем комменте — проверь карточку \(Доска ответила 429/);
  assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', 'show']);
});

// ---------------- секрет в причине (§1.1 п.4) ----------------

test('секрет в причине «Вернуть» (класс 2) → отказ secret, в Plane ничего, секрета нет в actions.log', async () => {
  const s = await setup();
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: `ключ ${SECRET}` });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /^похоже на секрет: .+ — на доску не пишется$/);
  assert.equal(s.lines().at(-1).refusal, 'secret');
  assert.ok(!s.raw().includes(SECRET));
  assert.equal(s.pl().calls?.length ?? 0, 0);
});

// ---------------- скрытие «Принять» (В7) ----------------

test('В7: Б-карточка и карточка с неслитой веткой — «Принять» скрыта в карточке и в строке (в), POST → отказ; слитая и без ветки — можно', async () => {
  const s = await setup();
  await s.pass(); // EXT-57: ветки считает проход читателя git, не запрос страницы
  const acc = async (id) => (await s.get(`/api/card/${id}`)).pult.accept;
  assert.deepEqual(await acc('EXT-8'), { can: false, why: 'b-deal', hint: 'Б-карточка ждёт слияния: «сливай» или «выкатывай»', branch: null });
  const nm = await acc('EXT-9');
  assert.equal(nm.can, false);
  assert.equal(nm.why, 'not-merged');
  assert.equal(nm.branch, 'ext-9-x');
  assert.equal((await acc('EXT-10')).can, true);
  assert.equal((await acc('EXT-7')).can, true);
  const ceh = await s.get('/api/ceh');
  const row = (id) => ceh.waiting.review.find((x) => x.id === id) ?? ceh.waiting.yes.find((x) => x.id === id);
  assert.equal(row('EXT-9').accept.why, 'not-merged');
  assert.equal(row('EXT-10').accept.can, true);
  assert.equal(row('EXT-8').mark, 'Б', 'метка строки (б) не затёрта местной отметкой (у той — pultMark)');
  assert.equal(row('EXT-8').accept.why, 'b-deal');
  const proj = await s.get('/api/project/EXT');
  assert.equal(proj.waiting.find((x) => x.id === 'EXT-9').accept.why, 'not-merged');
  const b = await s.press({ action: 'accept', card: 'EXT-8', q: Q });
  assert.equal(b.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'b-deal');
  const m = await s.press({ action: 'accept', card: 'EXT-9', q: Q });
  assert.equal(m.json().outcome, 'refused');
  assert.match(m.json().message, /ext-9-x/);
  assert.equal(s.lines().at(-1).refusal, 'not-merged');
  assert.equal(s.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  // «Вернуть» по Б-карточке не держится
  assert.equal((await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'не то' })).json().outcome, 'ok');
});

// EXT-57 (Важно 2 Голема): итог прохода устарел, а ключ (вершины ссылок файлами) не сменился — страница ещё даёт
// can: true; нажатие сверяет git заново → отказ not-merged, коммента в Plane нет. Устаревание сделано git-обёрткой,
// которая на проходе отвечает «предок» (merge-base, код 0) для неслитой ext-9-x, а к нажатию говорит правду.
test('EXT-57: страница по устаревшему итогу показывает «Принять», нажатие сверяет ветку заново — отказ not-merged, в Plane ничего', async () => {
  const real = createGitRead();
  const stale = { on: true };
  const mergeGit = (dir, args) => (stale.on && args[0] === 'merge-base' ? Promise.resolve('') : real(dir, args));
  const s = await setup({}, { mergeGit });
  await s.pass();
  stale.on = false;
  assert.equal((await s.get('/api/card/EXT-9')).pult.accept.can, true, 'страница — по итогу прохода');
  const m = await s.press({ action: 'accept', card: 'EXT-9', q: Q });
  assert.equal(m.json().outcome, 'refused');
  assert.match(m.json().message, /ext-9-x/);
  assert.equal(s.lines().at(-1).refusal, 'not-merged');
  assert.equal(s.pl().calls?.length ?? 0, 0, 'в Plane ни одного вызова');
  assert.equal(s.pl().comments.length, 1, 'коммента не прибавилось');
  assert.equal((await s.get('/api/card/EXT-9')).pult.accept.why, 'not-merged', 'итог нажатия лёг для ручек');
});

test('обёртка чтения git по форме вызова (§0, Н5): branch --list и merge-base --is-ancestor проходят; branch -D, branch <имя>, merge-base без --is-ancestor — исключение, git не запускался', async () => {
  const fg = fakeGit();
  const g = fg.make();
  for (const bad of [['branch', '-D', 'x'], ['branch', 'newname'], ['branch'], ['branch', '--list', 'x', '--delete'], ['branch', '--list', '-D'],
    ['branch', '--list', 'x', '--format=%(refname)', 'y'], ['merge-base', 'a', 'b'], ['merge-base', '--is-ancestor', 'a'],
    ['merge-base', '--is-ancestor', 'a', 'b', 'c'], ['merge-base', '--is-ancestor', '--output=x', 'b'], ['merge-base', '--octopus', 'a', 'b']]) {
    await assert.rejects(g('C:/x', bad), /git-read/, JSON.stringify(bad));
  }
  assert.equal(fg.calls().length, 0, 'подменный git не запускался');
  checkArgs(['branch', '--list', 'ext-*', '--format=%(refname:short)']);
  checkArgs(['branch', '--list', 'ext-9-*']);
  checkArgs(['merge-base', '--is-ancestor', 'ext-9-x', 'main']);
  await g('C:/x', ['merge-base', '--is-ancestor', 'a', 'main']);
  assert.equal(fg.calls().length, 1);
});

// ---------------- местная отметка, дотяжка, снятие (§3.2) ----------------

test('местная отметка: после «Принять» — в карточке и строке (в) «принято · Done в Plane ЧЧ:ММ · зеркало ещё не видело», строка вне счётчика; проход без записи → красная «зеркало не видит»; запись в файлах → отметка снята', async () => {
  const s = await setup();
  const before = (await s.get('/api/ceh')).waiting;
  const r = await s.press({ action: 'accept', card: 'EXT-12', q: Q });
  const id = r.json().id;
  const card = await s.get('/api/card/EXT-12');
  assert.match(card.pult.mark.text, /^принято · Done в Plane \d\d:\d\d · зеркало ещё не видело$/);
  assert.equal(card.pult.mark.missing, false);
  assert.equal(card.pult.mark.id, id);
  const w = (await s.get('/api/ceh')).waiting;
  const row = w.review.find((x) => x.id === 'EXT-12');
  assert.equal(row.answered, true);
  assert.equal(row.pultMark.id, id);
  assert.equal(w.more, before.more - 1, 'строка «отвечено, ждёт зеркала» не входит в счётчик');
  const proj = await s.get('/api/project/EXT');
  assert.equal(proj.waitingCount.more, before.review.filter((x) => x.project === 'EXT').length - 1);
  // проход зеркала начался и кончился после действия, а записи с <id> в файлах нет → красная пометка
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const t = Date.now();
  fs.writeFileSync(runs, `${new Date(t + 1000).toISOString()} · начало · card · pid 1\n${new Date(t + 2000).toISOString()} · конец · card · pid 1 · код 0 · 1 с · запросов 3\n`);
  const red = (await s.get('/api/card/EXT-12')).pult.mark;
  assert.equal(red.missing, true);
  assert.equal(red.text, `зеркало не видит запись ${id}`);
  await s.app.pult.tick();
  assert.equal(s.lines().filter((l) => l.id === id && l.step === 'mirror-missing').length, 1);
  // зеркало дотянуло запись — отметка снята по файлам доски
  fs.appendFileSync(path.join(boardDir, 'EXT', 'EXT-12.log.md'), `\n### 2026-10-03 12:10 +03:00 · plane · коммент\n\n**Слово Ивана · кнопка витрины · ${id}**: «принято»\n`);
  assert.equal((await s.get('/api/card/EXT-12')).pult.mark, null);
  assert.equal((await s.get('/api/ceh')).waiting.review.find((x) => x.id === 'EXT-12')?.pultMark ?? null, null);
  await s.app.pult.tick();
  await s.app.pult.tick();
  assert.equal(s.lines().filter((l) => l.id === id && l.step === 'mirror-seen').length, 1);
  fs.rmSync(runs);
});

test('дотяжка: run.lock занят (проход идёт) → --card не запускается сразу; после «конец» в runs.log — один раз', async () => {
  const s = await setup();
  const st = path.join(boardDir, '.mirror', 'status.json');
  const keep = fs.readFileSync(st, 'utf8');
  fs.writeFileSync(st, JSON.stringify({ lastOk: '2026-10-03T09:30:00.000Z', progress: { at: new Date().toISOString(), started_at: new Date().toISOString() } }));
  const r = await s.press({ action: 'accept', card: 'EXT-13', q: Q });
  assert.equal(r.json().outcome, 'ok');
  assert.equal(s.spawn.calls.length, 0);
  assert.equal(s.lines().at(-1).result.pull, 'queued');
  await s.app.pult.tick();
  assert.equal(s.spawn.calls.length, 0, 'проход не кончился — ждём');
  fs.writeFileSync(st, keep);
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  fs.writeFileSync(runs, `${new Date(Date.now() + 1000).toISOString()} · конец · changed · pid 2 · код 0 · 9 с · запросов 3\n`);
  await s.app.pult.tick();
  await s.app.pult.tick();
  assert.equal(s.spawn.calls.length, 1);
  assert.ok(s.spawn.calls[0].args.includes('EXT-13'));
  fs.rmSync(runs);
});

// ---------------- ревью Голема на ПТ3 ----------------

// Критично 1: незавершённое старое нажатие не подставляется в новое, если последний коммент в Plane — не его запись
const Q2_AT = '2026-10-03T09:40:00.000Z';
const Q2 = 'Тред вернул: поправил тесты, принимай?';
for (const [action, extra] of [['accept', {}], ['return', { text: 'вторая причина' }]]) {
  test(`Критично 1 (${action}): partial → тред вернул и снова Review с новым вопросом Q2 → новое нажатие пишет новую запись с новым номером, не берёт старый`, async () => {
    const s = await setup({ fail: { state: 'net' } });
    const r1 = await s.press({ action, card: 'EXT-7', q: Q, ...(action === 'return' ? { text: 'первая причина' } : {}) });
    assert.equal(r1.json().outcome, 'partial');
    s.setPlane({ fail: {}, calls: [], clock: '2026-10-03T09:50:00.123456Z',
      comments: [...s.pl().comments, { id: 'q2', created_at: '2026-10-03T09:40:12Z', html: `<p>${Q2}</p>` }] });
    const r2 = await s.press({ action, card: 'EXT-7', q: { at: Q2_AT, head: Q2 }, ...extra });
    assert.equal(r2.json().outcome, 'ok');
    assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', `state ${action === 'accept' ? 'Done' : 'In Progress'}`]);
    const html = s.pl().comments.at(-1).html;
    assert.ok(html.startsWith(`<p><b>Слово Ивана · кнопка витрины · ${r2.json().id}</b>`), html);
    assert.ok(html.includes(`«${Q2}»`), 'запись отвечает на Q2');
    if (action === 'return') assert.ok(html.includes('<p>Причина: вторая причина</p>'), html);
    assert.equal(s.lines().at(-1).result.record, r2.json().id);
  });
}

// Важно 2: красная — только от проходов changed/full (не dry) и своего --card
test('Важно 2: «зеркало не видит» — не от assets, dry и чужого --card; от changed/full и своего --card — да', () => {
  const T = Date.parse('2026-10-03T10:00:00Z');
  const lines = [{ id: 'W-261003-130000-aaaa', step: 'done', at: '2026-10-03T13:00:00+03:00', action: 'accept', card: 'EXT-7',
    result: { outcome: 'ok', record: 'W-261003-130000-aaaa', state: 'Done', planeAt: new Date(T).toISOString(), pull: 'launched' } }];
  const run = (kind, startS, endS = startS + 5) => ({ kind, start: T + startS * 1000, end: T + endS * 1000, code: 0 });
  const mk = (runs, launches = new Map([['EXT-7', [T]]])) => localMarks({ lines, readLog: () => ({ entries: [] }), runs, now: T + 3600000, launches }).get('EXT-7');
  assert.equal(mk([run('assets', 10)]).missing, false, 'assets');
  assert.equal(mk([run('changed · dry', 10)]).missing, false, 'dry');
  assert.equal(mk([run('card', 600)]).missing, false, 'чужой --card: начался через 10 мин после запуска');
  assert.equal(mk([run('card', 2)], new Map()).missing, false, 'запуска не было — --card не свой');
  assert.equal(mk([run('card', 2)]).missing, true, 'свой --card без записи');
  assert.equal(mk([run('changed', 10)]).missing, true);
  assert.equal(mk([run('full', 10)]).missing, true);
  assert.equal(mk([{ ...run('changed', 10), code: 1 }]).missing, false, 'неудачный проход не в счёт');
});

test('Важно 2: проход assets после действия — ни красной, ни строки mirror-missing', async () => {
  const s = await setup();
  const r = await s.press({ action: 'accept', card: 'EXT-13', q: Q });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  const t = Date.now();
  fs.writeFileSync(runs, `${new Date(t + 1000).toISOString()} · начало · assets · pid 7\n${new Date(t + 2000).toISOString()} · конец · assets · pid 7 · код 0 · 1 с · запросов 3\n`);
  assert.equal((await s.get('/api/card/EXT-13')).pult.mark.missing, false);
  await s.app.pult.tick();
  assert.equal(s.lines().filter((l) => l.id === r.json().id && l.step === 'mirror-missing').length, 0);
  fs.rmSync(runs);
});

// Важно 3: рестарт посреди действия (comment лёг, исхода нет)
test('Важно 3: рестарт после comment (код 0) без исхода — тот же intentId → «исход неизвестен», Plane не зовётся; новый → только state, коммент один', async () => {
  const W = 'W-261003-121500-beef';
  const intent = uuid(9001);
  const at = localIso(new Date(Date.now() - 60000));
  const base = { id: W, at, action: 'accept', card: 'EXT-7', project: 'EXT', mode: 'mirror' };
  const log = [
    { ...base, step: 'asked', q: Q, client: { intentId: intent } },
    { ...base, step: 'fresh', fresh: { status: 'Review', last: null }, result: { code: 0 } },
    { ...base, step: 'plane', cmd: 'comment', result: { code: 0, line: `EXT-7 · коммент c9 · 2026-10-03T09:10:00Z` } },
  ];
  const s = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41Z', html: Q_HTML },
    { id: 'c9', created_at: '2026-10-03T09:10:00Z', html: `<p><b>Слово Ивана · кнопка витрины · ${W}</b>: «принято»</p>` }] }, { log });
  const same = await s.press({ action: 'accept', card: 'EXT-7', q: Q, intentId: intent });
  assert.match(same.json().message, /исход неизвестен/);
  assert.equal(s.pl().calls?.length ?? 0, 0, 'тот же intentId — в Plane ни одного вызова');
  const again = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(again.json().outcome, 'ok');
  assert.deepEqual(cmds(s.pl().calls), ['show', 'state Done']);
  assert.equal(s.pl().comments.length, 2, 'коммент один');
  assert.equal(s.lines().at(-1).result.record, W);
});

test('Важно 3, мелочь 5: restoreIntents — partial, error (не записано) и error UNCLEAR («исход неясен»)', () => {
  const now = Date.now();
  const at = localIso(new Date(now - 60000));
  const one = (id, intent, last) => [{ id, at, step: 'asked', action: 'accept', client: { intentId: intent } }, { id, at, action: 'accept', ...last }];
  const m = restoreIntents([
    ...one('W-261003-120000-0001', uuid(9101), { step: 'partial', result: { outcome: 'partial', record: 'W-261003-120000-0001' } }),
    ...one('W-261003-120000-0002', uuid(9102), { step: 'error', result: { outcome: 'error', code: 'NOT_WRITTEN' } }),
    ...one('W-261003-120000-0003', uuid(9103), { step: 'error', result: { outcome: 'error', code: 'UNCLEAR' } }),
  ], now);
  return Promise.all([uuid(9101), uuid(9102), uuid(9103)].map((k) => m.get(k).promise)).then(([p, e, u]) => {
    assert.equal(p.code, 200); assert.equal(p.body.outcome, 'partial');
    assert.equal(e.code, 200); assert.equal(e.body.outcome, 'error'); assert.doesNotMatch(e.body.message, /неясен/);
    assert.equal(u.body.outcome, 'error'); assert.match(u.body.message, /исход неясен/);
  });
});

// мелочь 7: отложенная дотяжка переживает рестарт
test('мелочь 7: дотяжка в очереди (queued) до рестарта — после рестарта и «конец» в runs.log запускается один раз', async () => {
  const W = 'W-261003-121600-cafe';
  const at = localIso(new Date(Date.now() - 30000));
  const log = [
    { id: W, at, step: 'asked', action: 'accept', card: 'EXT-13', project: 'EXT', mode: 'mirror', q: Q, client: { intentId: uuid(9201) } },
    { id: W, at, step: 'done', action: 'accept', card: 'EXT-13', mode: 'mirror', result: { outcome: 'ok', record: W, state: 'Done', planeAt: new Date(Date.now() - 30000).toISOString(), pull: 'queued' } },
  ];
  const s = await setup({}, { log });
  const runs = path.join(boardDir, '.mirror', 'runs.log');
  fs.writeFileSync(runs, `${new Date(Date.now() - 5000).toISOString()} · конец · changed · pid 3 · код 0 · 9 с · запросов 3\n`);
  await s.app.pult.tick();
  await s.app.pult.tick();
  assert.equal(s.spawn.calls.length, 1);
  assert.ok(s.spawn.calls[0].args.includes('EXT-13'));
  fs.rmSync(runs);
});

// мелочь 8: развилка — своя подсказка
test('мелочь 8: карточка с открытой развилкой — подсказка про развилку, не «ждёт слияния»', () => {
  const st = acceptState({ status: 'review', last: { mark: 'развилка' } }, null);
  assert.equal(st.can, false);
  assert.notEqual(st.hint, B_HINT);
  assert.match(st.hint, /развилк/);
  assert.equal(acceptState({ status: 'review', last: { mark: 'сливай' } }, null).hint, B_HINT);
});

// мелочь 3 Голема на В10 (EXT-53, такт 2): spawn бросил синхронно (EPERM, EINVAL) — понятный отказ, а не 500
test('мелочь 3 (В10): запуск plane.py бросил синхронно — createPlaneSpawn отвечает code null и spawnError, не исключением', async () => {
  const thrower = () => { throw Object.assign(new Error('spawn'), { code: 'EPERM' }); };
  const run = createPlaneSpawn({ planePy: 'x.py', spawn: thrower });
  const r = await run(['show', 'EXT-7', '--last']);
  assert.deepEqual({ code: r.code, spawnError: r.spawnError }, { code: null, spawnError: 'EPERM' });
});

test('мелочь 3 (В10): «Принять», plane.py не запустился синхронно — 200, outcome error «свежая сверка не удалась: EPERM», строки asked/fresh/error в actions.log', async () => {
  const s = await setup({}, { planeSpawn: () => { throw Object.assign(new Error('spawn'), { code: 'EPERM' }); } });
  const r = await s.press({ action: 'accept', card: 'EXT-7', q: Q });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.outcome, 'error');
  assert.equal(b.message, 'свежая сверка не удалась: EPERM');
  assert.match(b.id, /^W-\d{6}-\d{6}-[0-9a-f]{4}$/);
  const steps = s.lines().map((l) => l.step);
  assert.deepEqual(steps, ['asked', 'fresh', 'error']);
  assert.deepEqual(s.lines()[1].result.line, 'EPERM');
  assert.equal(s.pl().calls, undefined, 'настоящий plane.py не звался');
});

// ---------------- ПТ4а (EXT-63): звонок у «Вернуть», GET /api/bell/:sid, статусы слова 2.8 ----------------

const SID = uuid(501);
const SID2 = uuid(502);
const thread = (sid, o = {}) => ({ sessionId: sid, title: `тред ${sid.slice(-3)}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), ...o });
const bellGet = (app, sid, h = {}) => app.inject({ method: 'GET', url: `/api/bell/${sid}`, headers: { host: `127.0.0.1:${PORT}`, ...h } });
const bellLog = (s, o) => { fs.mkdirSync(s.bellDir, { recursive: true }); fs.appendFileSync(path.join(s.bellDir, 'bell.log'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); };
const ringOf = async (s, id) => (await s.get('/api/actions')).find((r) => r.id === id)?.ring;

test('ПТ4а: «Вернуть» при pult.bell — после записи и смены статуса слово в очередь треда карточки: шаг ring-queued, сигнал, «положено»', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID2), thread(SID, { card: 'EXT-7' })] });
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' });
  const b = r.json();
  assert.equal(b.outcome, 'ok');
  assert.match(b.message, /^возвращено · In Progress в Plane \d\d:\d\d · тред «тред 501»: положено — тред услышит, когда закончит ход$/);
  // порядок 1.1 п.9: запись → статус → звонок → исход
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'fresh', 'plane', 'plane', 'ring-queued', 'done']);
  const rq = s.lines()[4];
  assert.deepEqual([rq.id, rq.card, rq.target.sessionId, rq.target.by], [b.id, 'EXT-7', SID, 'card']);
  assert.deepEqual(fs.readdirSync(path.join(s.bellDir, SID)), [`${b.id}.ring`]);
  assert.equal(await ringOf(s, b.id), 'положено');
  // ответ ждущему: слово с текстом звонка 2.6 — «<ID> возвращена Иваном: <причина>»
  const g = await bellGet(s.app, SID);
  assert.equal(g.statusCode, 200);
  const body = g.json();
  assert.deepEqual(body.ids, [b.id]);
  assert.ok(body.text.startsWith('Слово Ивана · кнопка витрины. '));
  assert.ok(body.text.split('\n')[1].startsWith(`${b.id} · `));
  assert.ok(body.text.endsWith(` · «вернуть» · в ответ на: ${local(Q_AT)} «${Q_MD}» · EXT-7 возвращена Иваном: нет теста`), body.text);
  assert.deepEqual((await bellGet(s.app, SID2)).json(), { ids: [], text: null }, 'чужой тред слова не получает');
});

test('ПТ4а: не легла запись (Plane отказал) — звонка нет; статус не сменился (partial) — звонка нет', async () => {
  for (const fail of [{ comment: 'refuse' }, { state: 'net' }]) {
    const s = await setup({ fail }, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
    const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' });
    assert.notEqual(r.json().outcome, 'ok', JSON.stringify(fail));
    assert.ok(!s.lines().some((l) => l.step === 'ring-queued'), JSON.stringify(fail));
    assert.deepEqual((await bellGet(s.app, SID)).json().ids, []);
    assert.ok(!fs.existsSync(path.join(s.bellDir, SID)));
  }
});

test('ПТ4а: звонить некому — «нет живого треда EXT; карточка в работе, тред увидит при открытии»; несколько — отказ звонка с перечнем', async () => {
  const none = await setup({}, { bell: true, threads: [thread(SID, { project: 'CAR' })] });
  const r0 = await none.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' });
  assert.equal(r0.json().outcome, 'ok');
  assert.match(r0.json().message, / · нет живого треда EXT; карточка в работе, тред увидит при открытии$/);
  assert.ok(!none.lines().some((l) => l.step === 'ring-queued'));
  const many = await setup({}, { bell: true, threads: [thread(SID), thread(SID2, { projectBy: 'cards' })] });
  const r2 = await many.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' });
  assert.equal(r2.json().outcome, 'ok');
  assert.match(r2.json().message, / · живых тредов EXT несколько: «тред 501», «тред 502» \(по карточкам\) — звонка нет/);
  assert.ok(!many.lines().some((l) => l.step === 'ring-queued'));
  assert.deepEqual(many.lines().at(-1).result.ring, { state: 'many', candidates: [SID, SID2] });
});

test('ПТ4а: два слова до доставки — один ответ с двумя id; GET дважды подряд — тот же ответ, actions.log и bell.log не изменились', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'первая' })).json();
  s.setPlane({ status: 'Review' });
  const b = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'вторая' })).json();
  assert.equal(b.outcome, 'ok', b.message);
  bellLog(s, { sid: SID, event: 'start' });
  const before = [s.raw(), fs.readFileSync(path.join(s.bellDir, 'bell.log'), 'utf8')];
  const g1 = await bellGet(s.app, SID);
  const g2 = await bellGet(s.app, SID);
  assert.equal(g2.body, g1.body);
  assert.deepEqual(g1.json().ids, [a.id, b.id]);
  assert.equal(g1.json().text.split('\n').length, 3);
  assert.deepEqual([s.raw(), fs.readFileSync(path.join(s.bellDir, 'bell.log'), 'utf8')], before);
  // браузеру ручка закрыта (§4.1, Н3); слово не тронуто
  assert.equal((await bellGet(s.app, SID, { origin: SELF })).statusCode, 403);
  assert.equal((await bellGet(s.app, SID, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.deepEqual((await bellGet(s.app, SID)).json().ids, [a.id, b.id]);
});

test('ПТ4а: подделанный сигнал (файл с выдуманным id) сервер не отдаёт; исправное слово рядом — отдаёт', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  fs.mkdirSync(path.join(s.bellDir, SID), { recursive: true });
  fs.writeFileSync(path.join(s.bellDir, SID, 'W-261004-120000-dead.ring'), '');
  assert.deepEqual((await bellGet(s.app, SID)).json(), { ids: [], text: null });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' })).json();
  assert.deepEqual((await bellGet(s.app, SID)).json().ids, [a.id]);
});

test('ПТ4а, 2.8: строка ring в bell.log — «доставлено» и шаг ring-delivered на такте; без формы звонка в журнале треда «прочитано» нет; с ней — есть', async () => {
  const rings = {};
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })], sessions: () => [{ sessionId: SID, rings }, { sessionId: SID2, rings: {} }] });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' })).json();
  // поддельная строка ring (Write мимо сервера) — слово заглушено, не создано
  bellLog(s, { sid: SID, event: 'ring', ids: [a.id] });
  assert.deepEqual((await bellGet(s.app, SID)).json().ids, []);
  assert.equal(await ringOf(s, a.id), 'доставлено');
  assert.ok(!s.lines().some((l) => l.step === 'ring-delivered'), 'чтение (GET) шагов не пишет — пишет такт');
  await s.app.pult.tick();
  await s.app.pult.tick();
  assert.equal(s.lines().filter((l) => l.step === 'ring-delivered' && l.id === a.id).length, 1);
  assert.equal(await ringOf(s, a.id), 'доставлено', 'в журнале треда звонка нет — не «прочитано»');
  rings[a.id] = new Date().toISOString();
  assert.equal(await ringOf(s, a.id), 'прочитано');
});

test('ПТ4а: рестарт — сигналы удалены, withdrawn: restart, «сброшено перезапуском»; тред умер — «не доставлено: тред закрыт»', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' })).json();
  s.live.cur = [];
  await s.app.pult.tick();
  assert.equal(await ringOf(s, a.id), 'не доставлено: тред закрыт');
  // новый запуск сервера на тех же данных
  const s2 = await setup({}, { bell: true, log: s.lines(), bellDir: s.bellDir, threads: [thread(SID, { card: 'EXT-7' })] });
  assert.deepEqual(s2.lines().filter((l) => l.id === a.id && l.step === 'withdrawn').map((l) => l.reason), ['restart']);
  assert.deepEqual(fs.readdirSync(path.join(s.bellDir, SID)), []);
  assert.equal(await ringOf(s2, a.id), 'сброшено перезапуском');
  assert.deepEqual((await bellGet(s2.app, SID)).json().ids, []);
});

test('ПТ4а, §4.3: pult.bell=false — GET /api/bell/:sid → 503, сигналов нет; /api/health → bell {on, waiters, queued}', async () => {
  const off = await setup({}, { threads: [thread(SID, { card: 'EXT-7' })] });
  assert.equal((await bellGet(off.app, SID)).statusCode, 503);
  assert.equal((await off.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' })).json().outcome, 'ok');
  assert.ok(!fs.existsSync(path.join(off.bellDir, SID)));
  assert.equal((await off.get('/api/actions'))[0].ring, 'звонок выключен');
  assert.deepEqual((await off.get('/api/health')).bell, { on: false, waiters: null, queued: 0 });
  const on = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  await on.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста' });
  assert.deepEqual((await on.get('/api/health')).bell, { on: true, waiters: null, queued: 1 });
});

// ---------------- вердикт Голема на ПТ4а (EXT-63): исход действия, номер в звонке, сбой выбора треда, forged, waiters ----------------

test('Важно 1: «Вернуть» → ring-delivered → второе «Вернуть» при последнем комменте = прежняя запись пульта → новый коммент с новым номером; status первого — done', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'первая' })).json();
  assert.equal(a.outcome, 'ok');
  bellLog(s, { sid: SID, event: 'ring', ids: [a.id] });
  await s.app.pult.tick();
  assert.equal(s.lines().at(-1).step, 'ring-delivered');
  assert.equal((await s.get('/api/actions')).find((r) => r.id === a.id).status, 'done', 'хвостовой шаг исход не меняет');
  assert.ok(s.pl().comments.at(-1).html.includes(a.id));
  s.setPlane({ status: 'Review', calls: [] });
  const b = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'вторая' })).json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', 'state In Progress']);
  assert.ok(s.pl().comments.at(-1).html.includes(b.id));
  assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'done').result.record, b.id);
});

test('Важно 1: тот же intentId после рестарта при последней строке ring-delivered / withdrawn — «уже исполнено», не 500', async () => {
  const at = new Date().toISOString();
  for (const tail of [{ step: 'ring-delivered' }, { step: 'withdrawn', reason: 'restart' }, { step: 'mirror-seen' }]) {
    const id = 'W-261004-120000-abcd';
    const lines = [{ id, step: 'asked', at, action: 'return', card: 'EXT-7', client: { intentId: uuid(777) } }, { id, step: 'ring-queued', at }, { id, step: 'done', at, result: { outcome: 'ok', record: id } }, { id, at, ...tail }];
    const r = await restoreIntents(lines, Date.now()).get(uuid(777)).promise;
    assert.equal(r.code, 200, JSON.stringify(tail));
    assert.equal(r.body.message, 'уже исполнено (по журналу)');
  }
});

test('мелочь (а): повтор частичного «Вернуть» — номер в строке звонка = прежний record (тот, что в «Кто решил»); статус слова — по нему', async () => {
  const rings = {};
  const s = await setup({ fail: { state: 'net' } }, { bell: true, threads: [thread(SID, { card: 'EXT-7' })], sessions: () => [{ sessionId: SID, rings }] });
  const a = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'причина' })).json();
  assert.equal(a.outcome, 'partial');
  s.setPlane({ fail: {}, status: 'Review' });
  const b = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'причина' })).json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'done').result.record, a.id);
  const g = (await bellGet(s.app, SID)).json();
  assert.deepEqual(g.ids, [a.id]);
  assert.ok(g.text.split('\n')[1].startsWith(`${a.id} · `), g.text);
  assert.deepEqual(fs.readdirSync(path.join(s.bellDir, SID)), [`${a.id}.ring`]);
  assert.equal(s.lines().find((l) => l.step === 'ring-queued').id, b.id, 'шаг — у действия');
  assert.equal(await ringOf(s, b.id), 'положено');
  bellLog(s, { sid: SID, event: 'ring', ids: [a.id] });
  await s.app.pult.tick();
  assert.ok(s.lines().some((l) => l.id === b.id && l.step === 'ring-delivered'), 'ring-delivered — у действия');
  assert.equal(await ringOf(s, b.id), 'доставлено');
  rings[a.id] = new Date().toISOString();
  assert.equal(await ringOf(s, b.id), 'прочитано');
});

test('мелочь (в): сбой выбора треда — действие ok (карточка уже вернулась), звонок — состояние error', async () => {
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  Object.defineProperty(s.live, 'cur', { get() { throw new Error('реестр упал'); } });
  const r = (await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'причина' })).json();
  assert.equal(r.outcome, 'ok', r.message);
  assert.equal(s.lines().at(-1).step, 'done');
  assert.equal(s.lines().at(-1).result.ring.state, 'error');
});

test('мелочь (г): forged в server.log — с sid и id', async () => {
  const sl = [];
  const s = await setup({}, { bell: true, threads: [thread(SID, { card: 'EXT-7' })], slog: { write: (event, f = {}) => sl.push([event, f]) } });
  bellLog(s, { sid: SID, event: 'forged', ids: ['W-261004-120000-dead'] });
  await bellGet(s.app, SID);
  assert.deepEqual(sl.filter(([e]) => e === 'bell'), [['bell', { event: 'forged', sid: SID, id: 'W-261004-120000-dead' }]]);
});

test('мелочь (д): /api/health → bell.waiters — счёт живых замков на такте, кэшем; до первого такта null', async () => {
  let n = 3;
  const s = await setup({}, { bell: true, seams: { countWaiters: async ({ dir }) => { assert.equal(dir, s.bellDir); return n; } } });
  assert.equal((await s.get('/api/health')).bell.waiters, null);
  await s.app.pult.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.get('/api/health')).bell.waiters, 3);
  n = 0;
  await s.app.pult.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.get('/api/health')).bell.waiters, 0);
});
