// EXT-57 (спека пульта, таблица 1.3 «Принять», хвост про В7; спека витрины В5): слита ли ветка карточки — считается
// проходом читателя git (createMergeCheck.refresh — тот же такт, что проверка следа §1.4а), ручки только читают.
// Пока не посчитано — accept.can: null («проверяю…»). Пересчёт — при смене вершины main или раз в ttl.
// git — настоящий (временный репозиторий) через обёртку чтения, обёрнутую счётчиком вызовов.
// Ожидаемые значения — из того, что положено в тест (ветки, слияние), не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createMergeCheck } from '../lib/pult/accept.mjs';
import { createGitPass } from '../lib/start.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git, gitCommitAll } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);

const PORT = 4357;
const H = { host: `127.0.0.1:${PORT}` };

// доска: EXT-1 — неслитая ветка ext-1-a, EXT-2 — слитая ext-2-b, EXT-3 — ветки нет, EXT-4 — mark_b (git не нужен)
const boardDir = makeBoard(tmpDir('e57-board-'), { codes: ['EXT'], cards: [
  { id: 'EXT-1', status: 'review' }, { id: 'EXT-2', status: 'review' }, { id: 'EXT-3', status: 'review' }, { id: 'EXT-4', status: 'review', markB: true },
] });
gitInitCommit(boardDir);
const repo = tmpDir('e57-repo-');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
gitInitCommit(repo);
git(repo, 'branch', 'ext-2-b');
git(repo, 'checkout', '-q', '-b', 'ext-1-a');
fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
gitCommitAll(repo, 'ext-1');
git(repo, 'checkout', '-q', 'main');
const regFile = path.join(tmpDir('e57-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [repo] } } }));

const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

// обёртка чтения git со счётчиком: сколько раз проверка ветки звала git
function countedGit(inner = createGitRead()) {
  const calls = [];
  const fn = (dir, args) => { calls.push(args.join(' ')); return inner(dir, args); };
  fn.calls = calls;
  return fn;
}

async function setup(gitFn, opts = {}) {
  const merge = createMergeCheck({ git: gitFn, registry, board, ...opts });
  const data = tmpDir('e57-data-');
  const app = await buildApp({ port: PORT, board, registry, scan, merge,
    pult: { enabled: true, words: false, actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), boardRoot: boardDir } });
  const get = async (url) => { const r = await app.inject({ method: 'GET', url, headers: H }); assert.equal(r.statusCode, 200, url); return r.json(); };
  // «Принять» по всем трём ручкам: карточка, строка (в) «Цеха», строка окна проекта
  const pages = async () => {
    const ceh = await get('/api/ceh');
    const proj = await get('/api/project/EXT');
    const out = {};
    for (const id of ['EXT-1', 'EXT-2', 'EXT-3', 'EXT-4']) {
      const row = ceh.waiting.review.find((x) => x.id === id) ?? ceh.waiting.yes.find((x) => x.id === id);
      out[id] = { card: (await get(`/api/card/${id}`)).pult.accept, ceh: row?.accept, proj: proj.waiting.find((x) => x.id === id)?.accept };
    }
    return out;
  };
  return { app, merge, pages };
}

const CHECKING = { can: null, why: 'checking', hint: 'проверяю, слита ли ветка карточки', branch: null };

test('EXT-57: запросы /api/ceh, /api/project, /api/card git не зовут; до прохода accept.can null, после — посчитан; main сдвинулся — следующий проход даёт can: true', async () => {
  const g = countedGit();
  const s = await setup(g);

  // до прохода: страницы git не зовут, у карточек, где решает ветка, — «проверяю»; Б-карточка — без git
  const before = await s.pages();
  assert.deepEqual(g.calls, [], 'запрос страницы не зовёт git');
  for (const id of ['EXT-1', 'EXT-2', 'EXT-3']) for (const where of ['card', 'ceh', 'proj']) assert.deepEqual(before[id][where], CHECKING, `${id} ${where}`);
  assert.equal(before['EXT-4'].card.why, 'b-deal');

  // проход: git зовётся здесь
  await s.merge.refresh();
  const afterPass = g.calls.length;
  assert.ok(afterPass > 0, 'проход зовёт git');
  const after = await s.pages();
  assert.equal(g.calls.length, afterPass, 'после прохода страницы git тоже не зовут');
  for (const where of ['card', 'ceh', 'proj']) {
    assert.equal(after['EXT-1'][where].can, false, `EXT-1 ${where}`);
    assert.equal(after['EXT-1'][where].why, 'not-merged');
    assert.equal(after['EXT-1'][where].branch, 'ext-1-a');
    assert.equal(after['EXT-2'][where].can, true, `EXT-2 ${where}`);
    assert.equal(after['EXT-3'][where].can, true, `EXT-3 ${where}`);
  }

  // вершины не менялись — повторный проход git не зовёт (нагрузка в покое, EXT-37)
  await s.merge.refresh();
  assert.equal(g.calls.length, afterPass, 'проход без смены вершин — без git');

  // ветка слилась (сдвиг main) → следующий проход пересчитывает
  git(repo, 'merge', '-q', '--ff-only', 'ext-1-a');
  assert.equal((await s.pages())['EXT-1'].card.can, false, 'до прохода — прежний итог');
  await s.merge.refresh();
  assert.ok(g.calls.length > afterPass, 'main сдвинулся — проход зовёт git');
  const merged = await s.pages();
  for (const where of ['card', 'ceh', 'proj']) assert.equal(merged['EXT-1'][where].can, true, `EXT-1 ${where} после слияния`);
  await s.app.close();
});

// исправный git — тест выше (EXT-2, EXT-3 — can: true)
test('EXT-57: git упал на проходе — «не проверить», не «слито»', async () => {
  const bad = countedGit(async () => { const e = new Error('git сломан'); e.code = 128; throw e; });
  const s = await setup(bad);
  await s.merge.refresh();
  assert.ok(bad.calls.length > 0);
  const p = await s.pages();
  for (const id of ['EXT-1', 'EXT-2', 'EXT-3']) {
    assert.equal(p[id].card.can, false, id);
    assert.equal(p[id].card.why, 'not-merged', id);
    assert.match(p[id].card.hint, /^не проверить, слита ли ветка карточки/, id);
  }
  await s.app.close();
});

// ---------- дозапрос (вердикт Голема): ключ пересчёта — вершины main и веток карточки файлами; ttl 30 мин ----------

test('EXT-57 (Важно 3): новая ветка карточки и новый коммит на ветке при неподвижном main — пересчёт; packed-refs; покой — 0 вызовов; ttl 30 мин — пересчёт', async () => {
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const g = countedGit();
  const s = await setup(g, { now: () => clock });
  await s.merge.refresh();
  const acc = async (id) => (await s.pages())[id].card;
  assert.equal((await acc('EXT-3')).can, true, 'EXT-3 — ветки нет');
  assert.equal((await acc('EXT-2')).can, true, 'EXT-2 — ветка слита');
  const mainBefore = git(repo, 'rev-parse', 'main').trim();

  // покой: ничего не менялось — проход git не зовёт
  let n = g.calls.length;
  await s.merge.refresh();
  assert.equal(g.calls.length, n, 'покой — 0 вызовов');

  // новая ветка ext-3-x со своим коммитом (main неподвижен) → пересчёт → не слита
  git(repo, 'checkout', '-q', '-b', 'ext-3-x');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
  gitCommitAll(repo, 'ext-3');
  git(repo, 'checkout', '-q', 'main');
  await s.merge.refresh();
  assert.ok(g.calls.length > n, 'новая ветка — проход зовёт git');
  assert.equal((await acc('EXT-3')).why, 'not-merged');
  assert.equal((await acc('EXT-3')).branch, 'ext-3-x');

  // новый коммит на слитой ветке ext-2-b (main неподвижен) → пересчёт → не слита
  git(repo, 'checkout', '-q', 'ext-2-b');
  fs.writeFileSync(path.join(repo, 'd.txt'), 'd');
  gitCommitAll(repo, 'ext-2 ещё');
  git(repo, 'checkout', '-q', 'main');
  assert.equal(git(repo, 'rev-parse', 'main').trim(), mainBefore, 'main не двигался');
  n = g.calls.length;
  await s.merge.refresh();
  assert.ok(g.calls.length > n, 'коммит на ветке — проход зовёт git');
  assert.equal((await acc('EXT-2')).why, 'not-merged');

  // ссылки упакованы (packed-refs) — вершины те же, ключ тот же: покой
  git(repo, 'pack-refs', '--all');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'ext-2-b')), 'ссылка ушла в packed-refs');
  n = g.calls.length;
  await s.merge.refresh();
  assert.equal(g.calls.length, n, 'packed-refs читается файлом — покой');

  // 29 мин — покой; 30 мин — страховочный пересчёт
  clock += 29 * 60000;
  await s.merge.refresh();
  assert.equal(g.calls.length, n, '29 мин — без git');
  clock += 60000;
  await s.merge.refresh();
  assert.ok(g.calls.length > n, '30 мин — пересчёт');
  await s.app.close();
});

// git с заслонкой: вызовы merge-base ждут release()
function heldGit(inner = createGitRead()) {
  let open;
  let gate = new Promise((r) => { open = r; });
  const fn = async (dir, args) => { if (args[0] === 'merge-base') await gate; return inner(dir, args); };
  fn.release = () => open();
  fn.hold = () => { gate = new Promise((r) => { open = r; }); };
  return fn;
}

test('EXT-57 (Важно 1): проход git для readAll кончается после следа, не дожидаясь слитости; слитость идёт сама, сбой — в server.log', async () => {
  const g = heldGit();
  const merge = createMergeCheck({ git: g, registry, board });
  const lines = [];
  const log = { write: (kind, f) => lines.push({ kind, ...f }) };
  let traced = false;
  const pass = createGitPass({ gitReader: { refresh: async () => {} }, trace: { refresh: async () => { traced = true; } }, merge, log });
  const done = await Promise.race([pass().then(() => 'pass'), new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.equal(done, 'pass', 'readAll не ждёт слитость');
  assert.ok(traced, 'след — в ожидаемом промисе');
  assert.equal(merge.peek('EXT-1'), null, 'слитость ещё считается (git задержан)');
  g.release();
  await merge.refresh();
  assert.notEqual(merge.peek('EXT-1'), null, 'после git — посчитано');
  // сбой прохода слитости — строкой error route=merge, промис прохода git не падает
  const broken = { refresh: async () => { throw new Error('x'); }, peek: () => null };
  await createGitPass({ gitReader: { refresh: async () => {} }, trace: { refresh: async () => {} }, merge: broken, log })();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lines.some((l) => l.kind === 'error' && l.route === 'merge' && l.code === 'PASS'));
});

test('EXT-57 (Мелочь 2): итог с более ранним началом не затирает более поздний (проход против нажатия)', async () => {
  // merge-base подменён и не зависит от состояния репозитория: проход начинается раньше, висит на заслонке и отвечает
  // «предок» (слита); нажатие начинается позже и отвечает «не предок» (код 1). Часы — счётчик: начала различимы
  let clock = 1000;
  let open;
  const gate = new Promise((r) => { open = r; });
  const real = createGitRead();
  const mode = { press: false };
  const gitFn = async (dir, args) => {
    if (args[0] !== 'merge-base') return real(dir, args);
    if (mode.press) { const e = new Error('не предок'); e.code = 1; throw e; }
    await gate;
    return '';
  };
  // ветка нужна, чтобы merge-base вызывался: EXT-1 — ext-1-a есть в репозитории всегда
  const merge = createMergeCheck({ git: gitFn, registry, board, now: () => ++clock });
  const p = merge.refresh();
  await new Promise((r) => setTimeout(r, 300));
  mode.press = true;
  const pressed = await merge.check('EXT-1');
  assert.equal(pressed.state, 'not-merged');
  mode.press = false;
  open();
  await p;
  assert.equal(merge.peek('EXT-1').state, 'not-merged', 'поздний итог (нажатие) не затёрт ранним (проход)');
});
