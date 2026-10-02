// EXT-37: витрина в покое — нагрузка (А: карта UUID → номер; Б: git по подсказке наблюдателя; В: журналы — горячее
// раз в 2 с, полный обход раз в 30 с) и «ждёт ответа» без открытого вопроса (Г).
// Ожидаемое — из того, что положено в тест здесь же, а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRef } from '../lib/journal-parse.mjs';
import { waitingThreads } from '../lib/waiting.mjs';
import { createNotifier, createNotifyLoop, createWake, toastRows, createAskGate } from '../lib/notify.mjs';
import { tmpDir } from './helpers.mjs';

// ---------- А ----------

// cards под счётчиком перебора: сколько раз кто-то прошёл по ключам объекта
function countedCards(cards) {
  const n = { keys: 0 };
  const p = new Proxy(cards, { ownKeys(t) { n.keys++; return Reflect.ownKeys(t); } });
  return { cards: p, n };
}

test('А: UUID → номер — перебор карточек индекса один раз на объект индекса, не на каждую ссылку', () => {
  const { cards, n } = countedCards({ 'EXT-1': { uuid: 'u-1' }, 'EXT-2': { uuid: 'u-2' }, 'CAR-7': { uuid: 'u-7' } });
  const idx = { cards };
  for (let i = 0; i < 50; i++) {
    assert.equal(resolveRef('u-2', idx), 'EXT-2');
    assert.equal(resolveRef('u-7', idx), 'CAR-7');
    assert.equal(resolveRef('u-404', idx), null);
  }
  assert.equal(n.keys, 1, 'карта строится один раз');
  assert.equal(resolveRef('EXT-9', idx), 'EXT-9', 'номер — как есть');
  assert.equal(resolveRef('u-1', null), null, 'нет индекса — null');
});

test('А: новый объект индекса (зеркало переписало index.json) — новая карта и новый ответ', () => {
  const a = { cards: { 'EXT-1': { uuid: 'u-1' } } };
  assert.equal(resolveRef('u-1', a), 'EXT-1');
  assert.equal(resolveRef('u-2', a), null);
  const b = { cards: { 'EXT-5': { uuid: 'u-1' }, 'EXT-6': { uuid: 'u-2' } } };
  assert.equal(resolveRef('u-1', b), 'EXT-5');
  assert.equal(resolveRef('u-2', b), 'EXT-6');
  assert.equal(resolveRef('u-1', a), 'EXT-1', 'прежний объект — прежний ответ');
});

// ---------- Г ----------

const SID = 'ffffffff-0000-4000-8000-000000000037';
const S1 = '2026-10-02T10:00:00.000Z';
const S2 = '2026-10-02T10:05:00.000Z';
const OLD_ASK = { text: 'Старый вопрос, давно отвечен?', uuid: 'u-old', at: '2026-10-01T08:00:00.000Z' };
const NEW_ASK = { text: 'Какой вариант берём?', uuid: 'u-new', at: '2026-10-02T10:00:01.000Z' };
// тред стоит на «input needed» (реестр процессов: status waiting) — waitingKind askUserQuestion (threads.mjs)
const inputNeeded = (statusUpdatedAt) => ({ sessionId: SID, title: 'EXT · тред', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'askUserQuestion', statusUpdatedAt });
const T = Date.parse('2026-10-02T10:10:00.000Z');

test('Г: старый отвеченный AskUserQuestion + новое ожидание (план, иной вопрос) — строка без текста, ключ sessionId|statusUpdatedAt', () => {
  const [r] = waitingThreads({ threads: [inputNeeded(S1)], sessions: [{ sessionId: SID, thread: { askOpen: false, ask: OLD_ASK } }], now: T });
  assert.equal(r.text, null, 'текст старого вопроса не берётся');
  assert.equal(r.key, `${SID}|${S1}`);
  assert.equal(r.uuid, null);
  assert.equal(r.since, S1, 'с момента ожидания, не с давнего вопроса');
  assert.equal(r.askMissing, true);
});

test('Г: открытый AskUserQuestion — текст и ключ вопроса', () => {
  const [r] = waitingThreads({ threads: [inputNeeded(S1)], sessions: [{ sessionId: SID, thread: { askOpen: true, ask: NEW_ASK } }], now: T });
  assert.equal(r.text, 'Трурль: Какой вариант берём?');
  assert.equal(r.key, `${SID}|u-new`);
  assert.equal(r.uuid, 'u-new');
  assert.equal(r.since, NEW_ASK.at);
  assert.ok(!r.askMissing);
});

// цикл уведомлений как на сервере: строки (а) из waitingThreads над текущим журналом, ворота «3 цикла подряд»
function rig(initial) {
  let th = initial;
  const shown = [];
  const gate = createAskGate();
  const rowsOf = (opts) => {
    const w = { threads: waitingThreads({ threads: [th.thread], sessions: [{ sessionId: SID, thread: th.journal }], now: T }), yes: [] };
    return toastRows(w, { confirmed: gate.see(w), ...opts });
  };
  const c = { t: T };
  const loop = createNotifyLoop({
    notifier: createNotifier({ file: path.join(tmpDir('ext37-notified-'), 'notified.json'), show: (r) => shown.push(r) }),
    rows: rowsOf,
    readAll: async () => {},
    wake: createWake({ now: () => c.t, jumpMs: 90000 }),
  });
  return { set: (x) => { th = x; }, shown, loop, tick: async () => { c.t += 2000; await loop.tick(); } };
}
const idleThread = { ...inputNeeded(S1), state: 'idle', waitingKind: null };

test('Г: вопрос дописался в журнал на втором цикле — один тост, с текстом вопроса', async () => {
  const r = rig({ thread: idleThread, journal: { askOpen: false, ask: OLD_ASK } });
  await r.loop.start(Promise.resolve());
  r.set({ thread: inputNeeded(S1), journal: { askOpen: false, ask: OLD_ASK } }); // процесс уже ждёт, журнал ещё нет
  await r.tick();
  assert.equal(r.shown.length, 0, 'первый цикл без вопроса — тоста нет');
  r.set({ thread: inputNeeded(S1), journal: { askOpen: true, ask: NEW_ASK } });
  for (let i = 0; i < 5; i++) await r.tick();
  assert.deepEqual(r.shown.map((x) => [x.key, x.body]), [[`${SID}|u-new`, 'Трурль: Какой вариант берём?']]);
});

test('Г: открытого вопроса нет 3 цикла подряд при том же statusUpdatedAt — один тост без текста; новое ожидание — счёт заново', async () => {
  const r = rig({ thread: idleThread, journal: { askOpen: false, ask: OLD_ASK } });
  await r.loop.start(Promise.resolve());
  r.set({ thread: inputNeeded(S1), journal: { askOpen: false, ask: OLD_ASK } });
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 0, 'два цикла — ещё рано');
  await r.tick();
  assert.deepEqual(r.shown.map((x) => [x.key, x.title, x.body]), [[`${SID}|${S1}`, 'EXT · тред ждёт ответа', '']]);
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 1, 'тот же ключ второй раз не показывается');
  // ответил, тред поработал и снова встал — новый statusUpdatedAt; два цикла, потом вопрос открылся — тост вопроса
  r.set({ thread: inputNeeded(S2), journal: { askOpen: false, ask: OLD_ASK } });
  await r.tick(); await r.tick();
  assert.equal(r.shown.length, 1, 'новое ожидание: счёт с нуля');
  r.set({ thread: inputNeeded(S2), journal: { askOpen: true, ask: NEW_ASK } });
  await r.tick(); await r.tick(); await r.tick();
  assert.deepEqual(r.shown.map((x) => x.key), [`${SID}|${S1}`, `${SID}|u-new`]);
});

test('Г: прерванный счёт (цикл с открытым вопросом между) — не «подряд»; тихий первый цикл запоминает и строку без вопроса', async () => {
  const g = createAskGate();
  const row = { key: `${SID}|${S1}`, kind: 'askUserQuestion', askMissing: true, uuid: null, title: 'т', text: null };
  const w = (rows) => ({ threads: rows, yes: [] });
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([])).has(row.key), false, 'строка ушла — счёт сброшен');
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), false);
  assert.equal(g.see(w([row])).has(row.key), true, 'третий подряд');
  // тихий цикл (старт, пробуждение): строка без вопроса идёт в notified.json сразу — без лавины после старта
  assert.deepEqual(toastRows(w([row]), { silent: true }).map((x) => x.key), [row.key]);
  assert.deepEqual(toastRows(w([row])).map((x) => x.key), [], 'без подтверждения — не тост');
});

// ---------- В ----------
import nodeFs from 'node:fs';
import { createJournalReader } from '../lib/journal-reader.mjs';

// fs под счётчиком: какие пути трогали statSync и readdirSync
function countingFs() {
  const calls = { stat: [], readdir: [] };
  const f = Object.create(nodeFs);
  f.statSync = (p, ...a) => { calls.stat.push(path.resolve(String(p))); return nodeFs.statSync(p, ...a); };
  f.readdirSync = (p, ...a) => { calls.readdir.push(path.resolve(String(p))); return nodeFs.readdirSync(p, ...a); };
  f.reset = () => { calls.stat.length = 0; calls.readdir.length = 0; };
  return { fs: f, calls };
}
const LINE = (n) => `{"type":"zzz-ext37","n":${n}}\n`;

function journalsWorld() {
  const root = tmpDir('ext37-journals-');
  const P = path.join(root, 'C--proj');
  nodeFs.mkdirSync(P);
  const hot = path.join(P, 'hot-1.jsonl');
  const cold = path.join(P, 'cold-1.jsonl');
  const coldSub = path.join(P, 'cold-1', 'subagents');
  nodeFs.mkdirSync(coldSub, { recursive: true });
  nodeFs.mkdirSync(path.join(P, 'hot-1', 'subagents'), { recursive: true });
  nodeFs.writeFileSync(hot, LINE(1));
  nodeFs.writeFileSync(cold, LINE(1));
  const coldAgent = path.join(coldSub, 'agent-a1.jsonl');
  nodeFs.writeFileSync(coldAgent, LINE(1));
  const hourAgo = new Date(Date.now() - 60 * 60000);
  for (const f of [cold, coldAgent]) nodeFs.utimesSync(f, hourAgo, hourAgo);
  return { root, P, hot, cold, coldSub, coldAgent };
}

test('В: раз в 2 с — только горячее: stat журналов, менявшихся за 15 мин, readdir каталогов проектов, subagents горячих сессий', async () => {
  const W = journalsWorld();
  const { fs, calls } = countingFs();
  const clock = { t: Date.now() };
  const live = new Set();
  const r = createJournalReader({ root: W.root, indexDir: tmpDir('ext37-index-'), fs, now: () => new Date(clock.t), liveSessions: () => live });
  await r.refresh();
  assert.equal(r.state().files, 3);
  assert.ok(calls.stat.includes(path.resolve(W.cold)), 'первый проход — полный');

  fs.reset(); clock.t += 2000;
  await r.refresh();
  assert.ok(calls.stat.includes(path.resolve(W.hot)), 'горячий журнал — stat');
  assert.ok(!calls.stat.includes(path.resolve(W.cold)), 'холодный журнал — без stat');
  assert.ok(!calls.stat.includes(path.resolve(W.coldAgent)), 'холодный журнал субагента — без stat');
  assert.ok(calls.readdir.includes(path.resolve(W.P)), 'каталог проекта — readdir (новый .jsonl)');
  assert.ok(!calls.readdir.includes(path.resolve(W.coldSub)), 'subagents холодной сессии — без readdir');
  assert.ok(calls.readdir.includes(path.resolve(W.P, 'hot-1', 'subagents')), 'subagents горячей сессии — readdir');
  assert.ok(r.state().lastOkAt, 'горячий проход — удачное чтение');

  // хвост живого журнала, новый журнал сессии, новый журнал субагента горячей сессии — за один горячий проход
  const lines0 = r.state().lines;
  nodeFs.appendFileSync(W.hot, LINE(2));
  nodeFs.writeFileSync(path.join(W.P, 'new-1.jsonl'), LINE(1));
  nodeFs.writeFileSync(path.join(W.P, 'hot-1', 'subagents', 'agent-b2.jsonl'), LINE(1));
  clock.t += 2000;
  await r.refresh();
  assert.equal(r.state().files, 5, 'новый журнал сессии и новый журнал субагента найдены');
  assert.equal(r.state().lines, lines0 + 3, 'хвост дочитан');

  // холодный журнал живого треда (реестр процессов) — тоже горячий
  nodeFs.appendFileSync(W.cold, LINE(2));
  clock.t += 2000;
  await r.refresh();
  assert.equal(r.state().lines, lines0 + 3, 'холодный и не живой — ждёт полного обхода');
  live.add('cold-1');
  clock.t += 2000;
  await r.refresh();
  assert.equal(r.state().lines, lines0 + 4, 'живой тред — хвост за один горячий проход');

  // полный обход — раз в 30 с
  fs.reset(); clock.t += 30000;
  await r.refresh();
  assert.ok(calls.stat.includes(path.resolve(W.coldAgent)), 'через 30 с — полный обход');
  assert.ok(calls.readdir.includes(path.resolve(W.coldSub)));
});

test('В: удалённый горячий журнал — не ошибка горячего прохода; полный обход убирает его из индекса', async () => {
  const W = journalsWorld();
  const clock = { t: Date.now() };
  const r = createJournalReader({ root: W.root, indexDir: tmpDir('ext37-index-'), now: () => new Date(clock.t) });
  await r.refresh();
  nodeFs.unlinkSync(W.hot);
  clock.t += 2000;
  await r.refresh();
  assert.equal(r.state().errors, 0);
  assert.equal(r.state().failingSince, null);
  clock.t += 30000;
  await r.refresh();
  assert.equal(r.state().files, 2);
});

// ---------- Б ----------
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createGitReader } from '../lib/git-reader.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { BOARD_LIB, makeBoard, writeCard, git, gitInitCommit, gitCommitAll } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);

function gitWorld() {
  const root = tmpDir('ext37-git-');
  const mk = (n) => { const d = path.join(root, n); nodeFs.mkdirSync(d); nodeFs.writeFileSync(path.join(d, 'a.txt'), n); gitInitCommit(d); return d; };
  const A = mk('proj-a');
  const C = mk('proj-c');
  const S = mk('shared-s');
  const WT = path.join(root, 'proj-a-wt');
  git(A, 'worktree', 'add', '-q', '-b', 'ext-37-wt', WT);
  const reg = path.join(root, 'registry.json');
  nodeFs.writeFileSync(reg, JSON.stringify({
    vault_root: root,
    board_codes: { EXT: { projects: [], project_cards: [], repos: [A] }, CAR: { projects: [], project_cards: [], repos: [C] } },
    board_shared_repos: { repos: [S] },
  }));
  return { root, A, C, S, WT, registry: createRegistryReader(reg) };
}

// подменный наблюдатель: тест сам шлёт события (имя файла от корня наблюдения) и сбои
function fakeWatch() {
  const list = [];
  const watch = (dir, { onEvent, onFail }) => {
    const w = { dir: path.resolve(dir), onEvent, onFail, closed: false, close() { w.closed = true; } };
    list.push(w);
    return w;
  };
  const at = (dir) => list.filter((w) => !w.closed && w.dir.toLowerCase() === path.resolve(dir).toLowerCase());
  return { watch, list, emit: (dir, name) => at(dir).forEach((w) => w.onEvent(name)), fail: (dir) => at(dir).forEach((w) => w.onFail(new Error('EPERM'))) };
}

// тесты событий — с полным чтением раз в час: фазы 5-минутной страховки (Важно 2) не вмешиваются; страховка — свои тесты
const HOUR = 60 * 60000;
function gitRig(W, opts = {}) {
  const calls = [];
  const clock = { t: Date.parse('2026-10-02T10:00:00Z') };
  const r = createGitReader({ git: createGitRead({ onCall: (p) => calls.push(path.resolve(p).toLowerCase()) }), registry: W.registry, boardRoot: null, now: () => clock.t, fullEveryMs: HOUR, ...opts });
  const take = () => calls.splice(0);
  return { r, take, clock };
}
const key = (p) => path.resolve(p).toLowerCase();
// первый проход ставит наблюдатели; новый наблюдатель — флаг «грязно» (правка между status и постановкой наблюдателя,
// вердикт Голема на EXT-37, Важно 1), поэтому второй проход перечитывает; тишина — с третьего
async function settle(r, clock, take) { await r.refresh(); clock.t += 30000; await r.refresh(); take(); }

test('Б: без событий наблюдателя второй проход не зовёт git; readAt свежий; пропуски по тишине — в state', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  const { r, take, clock } = gitRig(W, { watch: fw.watch });
  await r.refresh();
  assert.ok(take().length >= 5, 'первый проход — полный');
  assert.deepEqual(fw.list.map((w) => w.dir.toLowerCase()).sort(), [key(W.A), key(W.WT), key(W.C), key(path.join(W.S, '.git'))].sort(),
    'наблюдатели: корни рабочих копий проектов, .git общего репозитория');
  clock.t += 30000; await r.refresh();
  assert.ok(take().length >= 5, 'второй проход — перечитка после постановки наблюдателей');
  assert.equal(fw.list.length, 4, 'живые наблюдатели не пересоздаются');
  clock.t += 30000;
  await r.refresh();
  assert.deepEqual(take(), [], 'тишина — ни одного запуска git');
  assert.equal(r.quiet().quietSkips, 3, 'третий проход — все три по тишине');
  assert.equal(r.beacon('EXT').readAt, new Date(clock.t).toISOString(), 'пропуск по тишине — тоже удачное наблюдение (серая строка 2.7 не встаёт)');
});

test('Б: правка в рабочей копии — status только этой копии; событие в .git (не objects) — полный проход репозитория; .git/objects — тишина', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  const { r, take, clock } = gitRig(W, { watch: fw.watch });
  await settle(r, clock, take);
  const dirtyOf = (p) => r.beacon('EXT').repos.find((x) => key(x.path) === key(p)).dirty;
  assert.equal(dirtyOf(W.WT), 0);
  nodeFs.writeFileSync(path.join(W.WT, 'new.txt'), 'x');
  fw.emit(W.WT, 'new.txt');
  clock.t += 30000; await r.refresh();
  assert.deepEqual(take(), [key(W.WT)], 'один status рабочей копии');
  assert.equal(dirtyOf(W.WT), 1, 'новое число незакоммиченных');
  fw.emit(W.A, path.join('.git', 'objects', 'ab', 'cdef'));
  fw.emit(path.join(W.S, '.git'), path.join('objects', 'pack', 'x.pack'));
  clock.t += 30000; await r.refresh();
  assert.deepEqual(take(), [], '.git/objects — не повод');
  nodeFs.writeFileSync(path.join(W.C, 'c.txt'), 'c');
  gitCommitAll(W.C, 'feat: CAR-37 коммит');
  fw.emit(W.C, path.join('.git', 'refs', 'heads', 'main'));
  clock.t += 30000; await r.refresh();
  const c = take();
  assert.ok(c.length >= 3 && c.every((p) => p === key(W.C)), 'полный проход только C: worktree list, status, rev-parse, log');
  assert.ok(r.commitsFor('CAR-37').commits.some((x) => x.subject === 'feat: CAR-37 коммит'));
});

test('Б: наблюдатель упал — репозиторий опрашивается по-старому каждый проход; раз в fullEveryMs — полный проход всех', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  const { r, take, clock } = gitRig(W, { watch: fw.watch });
  await settle(r, clock, take);
  fw.fail(W.C);
  for (let i = 0; i < 2; i++) {
    clock.t += 30000; await r.refresh();
    const c = take();
    assert.ok(c.length >= 3 && c.every((p) => p === key(W.C)), `проход ${i + 1}: опрос только C`);
  }
  assert.ok(r.quiet().watchFailed >= 1);
  clock.t += HOUR; await r.refresh();
  const all = new Set(take());
  for (const p of [W.A, W.WT, W.C, W.S]) assert.ok(all.has(key(p)), `5 минут — полный проход: ${p}`);
});

test('Б (живой fs.watch): свои запуски git не будят наблюдателя — второй проход подряд пропускает все; правка файла — видна', async () => {
  const W = gitWorld();
  const { r, take } = gitRig(W);
  await r.refresh(); await r.refresh(); take(); // второй — перечитка после постановки наблюдателей
  // свои запуски: проходы подряд в течение ~1,5 с (события fs.watch приходят с задержкой) — ни одного git
  for (let i = 0; i < 6; i++) { await new Promise((res) => setTimeout(res, 250)); await r.refresh(); assert.deepEqual(take(), [], `проход ${i + 3} без внешних изменений — без git`); }
  nodeFs.writeFileSync(path.join(W.A, 'b.txt'), 'x');
  let seen = [];
  for (const t0 = Date.now(); Date.now() - t0 < 5000 && seen.length === 0;) { await new Promise((res) => setTimeout(res, 100)); await r.refresh(); seen = take(); }
  assert.deepEqual(seen, [key(W.A)], 'правка видна (опрос до 5 с)');
  assert.equal(r.beacon('EXT').repos.find((x) => key(x.path) === key(W.A)).dirty, 1);
  r.close();
});

test('Б: опрос доски — HEAD из файлов .git (ссылка, packed-refs), без запуска git; новый коммит — diff', async () => {
  const dir = makeBoard(tmpDir('ext37-board-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', title: 'Первая' }] });
  gitInitCommit(dir);
  const calls = [];
  const b = createBoardReader({ root: dir, git: createGitRead({ onCall: () => calls.push(1) }), parseCard });
  await b.init();
  calls.length = 0;
  for (let i = 0; i < 3; i++) await b.refresh();
  assert.equal(calls.length, 0, 'HEAD не сменился — ни одного git');
  assert.equal(b.state().head, git(dir, 'rev-parse', 'HEAD').trim());
  writeCard(dir, { id: 'EXT-1', title: 'Переименована' });
  const h2 = gitCommitAll(dir, 'mirror');
  await b.refresh();
  assert.equal(calls.length, 1, 'один diff --name-only');
  assert.equal(b.card('EXT-1').title, 'Переименована');
  assert.equal(b.state().head, h2);
  git(dir, 'pack-refs', '--all');
  assert.ok(!nodeFs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'main')), 'ссылка ушла в packed-refs');
  await b.refresh();
  assert.equal(b.state().head, h2);
  assert.equal(calls.length, 1, 'packed-refs — тоже файлом');
});

test('Б: свои записи витрины (data/vitrina своего корня) наблюдателя не будят; соседние файлы — будят', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  const own = path.join(W.A, 'data', 'vitrina');
  const { r, take, clock } = gitRig(W, { watch: fw.watch, ignore: [own] });
  await settle(r, clock, take);
  fw.emit(W.A, path.join('data', 'vitrina', 'server.log'));
  fw.emit(W.A, path.join('data', 'vitrina', 'index', 'journals.json.123.tmp'));
  clock.t += 30000; await r.refresh();
  assert.deepEqual(take(), [], 'свой server.log и индекс — тишина');
  fw.emit(W.A, path.join('data', 'other.txt'));
  clock.t += 30000; await r.refresh();
  assert.deepEqual(take(), [key(W.A)]);
});

test('Б (Важно 1): правка копии между её status и постановкой наблюдателя — видна на следующем проходе', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  let edited = false;
  // правка «в щели»: status копии уже прошёл, наблюдатель ещё не стоит — событие наблюдатель не увидит никогда
  const watch = (dir, h) => { if (!edited && key(dir) === key(W.WT)) { edited = true; nodeFs.writeFileSync(path.join(W.WT, 'gap.txt'), 'x'); } return fw.watch(dir, h); };
  const { r, take, clock } = gitRig(W, { watch });
  await r.refresh(); take();
  const dirtyOf = () => r.beacon('EXT').repos.find((x) => key(x.path) === key(W.WT)).dirty;
  assert.equal(dirtyOf(), 0, 'status был до правки');
  clock.t += 30000; await r.refresh();
  assert.ok(take().includes(key(W.WT)), 'новый наблюдатель — копия перечитана');
  assert.equal(dirtyOf(), 1);
  // переставленный после падения наблюдатель — тоже «грязно»
  fw.fail(W.WT);
  clock.t += HOUR; await r.refresh(); take();
  nodeFs.writeFileSync(path.join(W.WT, 'gap2.txt'), 'x'); // правка после прохода, до которого наблюдатель снова встал
  clock.t += 30000; await r.refresh();
  assert.equal(dirtyOf(), 2, 'после пересоздания наблюдателя копия перечитана');
});

// реестр-подмена: n репозиториев проекта, git-подмена (одна копия, чисто), наблюдатель-подмена без событий
function manyRepos(n) {
  const repos = Array.from({ length: n }, (_, i) => `C:/fake/repo-${String(i).padStart(2, '0')}`);
  const reg = { codes: [{ code: 'EXT', repos }], sharedRepos: [] };
  return { repos, registry: { get: () => reg }, reg };
}
const stubGit = (log) => async (repo, args) => {
  log.push([key(repo), args[0]]);
  if (args[0] === 'worktree') return `worktree ${repo}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n`;
  if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
  return '';
};

test('Б (Важно 2): полные проходы разнесены — у репозитория своя фаза в 5 минутах; за 30 с — около 1/10 репозиториев', async () => {
  const N = 20;
  const M = manyRepos(N);
  const log = [];
  const fw = fakeWatch();
  const clock = { t: Date.parse('2026-10-02T10:00:07Z') };
  const r = createGitReader({ git: stubGit(log), registry: M.registry, boardRoot: null, now: () => clock.t, watch: fw.watch });
  await r.refresh(); clock.t += 30000; await r.refresh(); log.length = 0; // старт и перечитка после наблюдателей
  const perPass = [];
  const perRepo = new Map();
  for (let i = 0; i < 20; i++) { // 10 минут
    clock.t += 30000;
    await r.refresh();
    const full = log.filter(([, sub]) => sub === 'worktree').map(([p]) => p);
    perPass.push(full.length);
    for (const p of full) perRepo.set(p, (perRepo.get(p) ?? 0) + 1);
    log.length = 0;
  }
  assert.ok(Math.max(...perPass) <= 3, `полных за проход не больше 3 из ${N}: ${perPass.join(' ')}`);
  assert.equal(perPass.reduce((a, b) => a + b, 0), 2 * N, 'за 10 минут каждый — дважды');
  for (const p of M.repos) assert.equal(perRepo.get(key(p)), 2, p);
});

test('Б: после close() проход наблюдателей не ставит; ушедший из реестра репозиторий — не «без наблюдателя»', async () => {
  const M = manyRepos(3);
  const fw = fakeWatch();
  const clock = { t: Date.parse('2026-10-02T10:00:00Z') };
  const r = createGitReader({ git: stubGit([]), registry: M.registry, boardRoot: null, now: () => clock.t, watch: fw.watch });
  await r.refresh();
  assert.equal(fw.list.length, 3);
  M.reg.codes[0].repos = M.repos.slice(0, 2);
  clock.t += 30000; await r.refresh();
  assert.equal(r.quiet().watchFailed, 0, 'ушедший из реестра не считается упавшим');
  r.close();
  clock.t += 30000; await r.refresh();
  assert.ok(fw.list.every((w) => w.closed), 'после close() новых живых наблюдателей нет');
});

test('Б: события .git по смыслу — index и служебные файлы чужого `git status` — только status копии; HEAD, refs, packed-refs, worktrees — полное чтение', async () => {
  const W = gitWorld();
  const fw = fakeWatch();
  const { r, take, clock } = gitRig(W, { watch: fw.watch });
  await settle(r, clock, take);
  const pass = async () => { clock.t += 30000; await r.refresh(); return take(); };
  const subs = [];
  const win = (s) => s.split('/').join(path.sep); // имена событий fs.watch на Windows — с «\»
  // чужой `git status` без --no-optional-locks: index.lock → index, каталог .git; плюс прочие служебные файлы (Windows: «\»)
  for (const n of [win('.git/index.lock'), '.git', win('.git/index'), win('.git/ORIG_HEAD'), win('.git/FETCH_HEAD'), win('.git/logs/HEAD'), win('.git/config'), win('.git/COMMIT_EDITMSG'), win('.git/refs/heads/main.lock')]) fw.emit(W.A, n);
  assert.deepEqual(await pass(), [key(W.A)], 'index основной копии — один status её');
  fw.emit(W.A, win('.git/worktrees/proj-a-wt/index'));
  fw.emit(W.A, win('.git/worktrees/proj-a-wt/index.lock'));
  assert.deepEqual(await pass(), [key(W.WT)], 'index рабочей копии — status только её');
  fw.emit(path.join(W.S, '.git'), 'index');
  fw.emit(path.join(W.S, '.git'), win('logs/HEAD'));
  assert.deepEqual(await pass(), [], 'общий репозиторий: index и логи — ничего (его status не нужен)');
  for (const n of [win('.git/HEAD'), win('.git/packed-refs'), win('.git/refs/heads/x'), win('.git/worktrees/proj-a-wt/HEAD'), win('.git/worktrees/new-wt')]) {
    fw.emit(W.A, n);
    const c = await pass();
    subs.push(n);
    assert.ok(c.length >= 3 && c.every((p) => p === key(W.A) || p === key(W.WT)), `${n} — полное чтение A: ${c.join(',')}`);
  }
  fw.emit(path.join(W.S, '.git'), win('refs/heads/main'));
  assert.deepEqual(await pass(), [key(W.S)], 'общий: ссылка — rev-parse');
});
