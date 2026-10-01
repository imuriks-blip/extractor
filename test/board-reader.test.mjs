// Читатель доски (спека витрины 1.2): шапки <КОД>/<ID>.md, projects.md; rev-parse HEAD → перечитать
// только файлы из diff --name-only. Доска — временная копия в живой форме, никогда не C:\projects\unorbis-board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoardReader, parseProjectsMd } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { BOARD_LIB, tmpDir, makeBoard, writeCard, gitInitCommit, gitCommitAll, spyFs, fakeGit, projectsMd } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);

const CARDS = [
  { id: 'CAR-1', status: 'in-progress' }, { id: 'CAR-2', status: 'in-progress' }, { id: 'CAR-3', status: 'ready' },
  { id: 'CAR-4', status: 'review' }, { id: 'CAR-5', status: 'review' }, { id: 'CAR-6', status: 'review' },
  { id: 'CAR-7', status: 'done' }, { id: 'CAR-8', status: 'backlog' }, { id: 'CAR-9', status: 'cancelled' },
  { id: 'EXT-6', status: 'review' },
];

function fixture() {
  const dir = makeBoard(tmpDir('board-'), { codes: ['CAR', 'EXT', 'RADAR'], cards: CARDS });
  // не шапка карточки — не считается, хотя строка «status: review» в нём есть
  fs.writeFileSync(path.join(dir, 'CAR', 'notes.md'), 'status: review\n');
  return dir;
}

test('projects.md: коды из таблицы проектов, таблица лейблов не в счёт', () => {
  const p = parseProjectsMd(projectsMd(['CAR', 'EXT']));
  assert.deepEqual(p.map((x) => x.code), ['CAR', 'EXT']);
  assert.equal(p[0].name, 'имя-car');
  assert.equal(p[0].status, 'active');
});

test('читатель: числа в работе / в очереди / Review по коду из шапок', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await r.init();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 1, review: 3 });
  assert.deepEqual(r.counts('EXT'), { inProgress: 0, ready: 0, review: 1 });
  assert.deepEqual(r.counts('RADAR'), { inProgress: 0, ready: 0, review: 0 });
  assert.deepEqual(r.codes().map((c) => c.code), ['CAR', 'EXT', 'RADAR']);
  assert.equal(r.state().errors, 0);
  assert.ok(r.state().lastOkAt);
});

test('читатель: новый коммит — перечитаны только файлы из diff, числа обновились', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  const spy = spyFs();
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard, fs: spy });
  await r.init();
  writeCard(dir, { id: 'CAR-3', status: 'review' });
  gitCommitAll(dir);
  spy.calls.length = 0;
  await r.refresh();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 0, review: 4 });
  const reads = spy.calls.filter((c) => c.name === 'readFileSync').map((c) => path.basename(c.path));
  assert.deepEqual(reads, ['CAR-3.md']);
});

test('читатель: HEAD не сменился — ни одного чтения файлов', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  const spy = spyFs();
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard, fs: spy });
  await r.init();
  spy.calls.length = 0;
  await r.refresh();
  assert.deepEqual(spy.calls, []);
});

test('читатель: битая шапка — счётчик ошибок, остальные посчитаны, не падение', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'CAR', 'CAR-10.md'), 'не шапка\n');
  gitInitCommit(dir);
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await r.init();
  assert.equal(r.state().errors, 1);
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 1, review: 3 });
});

test('читатель: git недоступен при опросе — прежние числа, ошибка в счётчике', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  const real = createGitRead();
  let broken = false;
  const git = (repo, args) => (broken ? Promise.reject(new Error('git упал')) : real(repo, args));
  const r = createBoardReader({ root: dir, git, parseCard });
  await r.init();
  const okAt = r.state().lastOkAt;
  broken = true;
  await r.refresh();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 1, review: 3 });
  assert.equal(r.state().errors, 1);
  assert.equal(r.state().lastOkAt, okAt);
});

test('читатель: readCard — шапка и тело карточки', async () => {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'backlog', title: 'Спека витрины', body: 'Тело карточки.' }] });
  gitInitCommit(dir);
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await r.init();
  const c = r.readCard('EXT-6');
  assert.equal(c.header.title, 'Спека витрины');
  assert.equal(c.body.trim(), 'Тело карточки.');
  assert.equal(r.readCard('EXT-99'), null);
});

// Гейт п.7: за полный прогон читателя (старт + опрос с новым HEAD) каждый вызов git несёт
// --no-optional-locks первым и команду из белого списка.
test('гейт 7: все вызовы git читателя доски — через обёртку, --no-optional-locks, белый список', async () => {
  const dir = fixture();
  const f = fakeGit();
  const r = createBoardReader({ root: dir, git: f.make(), parseCard });
  await r.init();
  f.setHead('b'.repeat(40));
  f.setDiff(['CAR/CAR-3.md']);
  await r.refresh();
  const calls = f.calls();
  assert.ok(calls.length >= 3, `вызовов ${calls.length}`);
  const WHITE = ['status', 'rev-parse', 'log', 'diff', 'show', 'worktree'];
  for (const c of calls) {
    assert.equal(c[0], '--no-optional-locks', JSON.stringify(c));
    assert.equal(c[1], '-C');
    assert.ok(WHITE.includes(c[3]), JSON.stringify(c));
  }
  assert.ok(calls.some((c) => c[3] === 'diff' && c.includes('--name-only')));
});
