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

// Вердикт Голема, Важно 1: первое чтение упало — HEAD не запоминается, время удачного чтения не двигается,
// следующий опрос (тот же HEAD) читает доску целиком.
test('читатель: первое чтение projects.md упало — опрос с тем же HEAD дочитывает, время до того не двигается', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  let fail = true;
  const flaky = { ...fs, readFileSync: (p, ...a) => {
    if (fail && String(p).endsWith('projects.md')) { const e = new Error('заперт'); e.code = 'EBUSY'; throw e; }
    return fs.readFileSync(p, ...a);
  } };
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard, fs: flaky });
  await r.init();
  assert.equal(r.state().lastOkAt, null);
  assert.equal(r.state().errors, 1);
  fail = false;
  await r.refresh();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 1, review: 3 });
  assert.ok(r.state().lastOkAt);
});

test('читатель: сбой посреди полного чтения — прежние карточки целы (новый Map подменяется при успехе)', async () => {
  const dir = fixture();
  gitInitCommit(dir);
  let failDir = false;
  const flaky = { ...fs, readdirSync: (p, ...a) => {
    if (failDir && String(p).endsWith('EXT')) { const e = new Error('заперт'); e.code = 'EBUSY'; throw e; }
    return fs.readdirSync(p, ...a);
  } };
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard, fs: flaky });
  await r.init();
  fs.writeFileSync(path.join(dir, 'projects.md'), projectsMd(['CAR', 'EXT', 'RADAR']) + '\n');
  gitCommitAll(dir);
  failDir = true;
  await r.refresh();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 1, review: 3 });
  assert.deepEqual(r.counts('EXT'), { inProgress: 0, ready: 0, review: 1 });
});

test('читатель: diff упал — откат к полному чтению; diff зовётся с --no-renames', async () => {
  const dir = fixture();
  const head1 = gitInitCommit(dir);
  const real = createGitRead();
  const seen = [];
  const git = (repo, args) => { seen.push(args); return args[0] === 'diff' ? Promise.reject(new Error('diff упал')) : real(repo, args); };
  const r = createBoardReader({ root: dir, git, parseCard });
  await r.init();
  writeCard(dir, { id: 'CAR-3', status: 'review' });
  const head2 = gitCommitAll(dir);
  await r.refresh();
  assert.deepEqual(r.counts('CAR'), { inProgress: 2, ready: 0, review: 4 });
  assert.equal(r.state().head, head2);
  assert.ok(head1 !== head2);
  assert.deepEqual(seen.find((a) => a[0] === 'diff'), ['diff', '--name-only', '--no-renames', `${head1}..${head2}`]);
});

test('читатель: битые шапки — отдельным числом; readCard на битой — {header:null, error}', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'CAR', 'CAR-10.md'), 'не шапка\n');
  gitInitCommit(dir);
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await r.init();
  assert.equal(r.state().badHeaders, 1);
  const c = r.readCard('CAR-10');
  assert.equal(c.header, null);
  assert.equal(c.error, 'шапка');
});

test('читатель: активность проекта — самое свежее updated среди его карточек', async () => {
  const dir = makeBoard(tmpDir('board-'), { codes: ['CAR', 'RADAR'], cards: [
    { id: 'CAR-1', updated: '2026-09-20T10:00+03:00' },
    { id: 'CAR-2', updated: '2026-09-30T23:30+02:00' },
    { id: 'CAR-3', updated: '2026-10-01T00:10+03:00' },
  ] });
  gitInitCommit(dir);
  const r = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await r.init();
  // 30.09 23:30 +02:00 = 01.10 00:30 +03:00 — свежее, чем 01.10 00:10 +03:00
  assert.equal(r.activity('CAR'), '2026-09-30T23:30+02:00');
  assert.equal(r.activity('RADAR'), null);
});
