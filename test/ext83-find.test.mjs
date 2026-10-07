// EXT-83, ПТ8б: поиск кандидатов на уборку (спека пульта §1.5) — условия 1–4, возраст по времени создания, кэш, реестр. Временные репозитории.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './ext83-harness.mjs';
const { PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir } = H;
void [PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir, fs, path, assert, test];
// ---------- чистые разборщики ----------
test('разборщики: reflog (свои коммиты — запись, начинающаяся с «commit», после самой старой), ветка → карточка, status --ignored, группировка причин', () => {
  const out = ['bbb2222 x@{0}: commit (amend): m', 'aaa1111 x@{1}: commit: m', 'ccc0000 x@{2}: branch: Created from HEAD'].join('\n');
  assert.deepEqual(reflogMessages(out), ['commit (amend): m', 'commit: m', 'branch: Created from HEAD']);
  assert.equal(hasOwnCommits(reflogMessages(out)), true);
  assert.equal(hasOwnCommits(['commit (amend): m', 'branch: Created from HEAD']), true, 'единственный коммит — amend: считается');
  assert.equal(hasOwnCommits(['commit (merge): m', 'branch: Created from HEAD']), true);
  assert.equal(hasOwnCommits(['branch: Created from HEAD']), false, 'свежая ветка без коммитов');
  assert.equal(hasOwnCommits(['reset: moving to x', 'merge main: Fast-forward', 'branch: Created from HEAD']), false, 'не «commit…» — не коммит');
  assert.equal(hasOwnCommits(['commit (initial): first']), false, 'единственная (самая старая) запись — не «после первой»');
  assert.equal(hasOwnCommits([]), false);
  assert.equal(cardOfBranch('ext-83-worktree-cleanup'), 'EXT-83');
  assert.equal(cardOfBranch('car-235-x'), 'CAR-235');
  assert.equal(cardOfBranch('feature-x'), null);
  assert.equal(cardOfBranch('ext-83'), null);
  assert.deepEqual(parseStatus('?? new.txt\n M a.txt\n!! node_modules/\n!! .env\n'), { dirty: ['new.txt', 'a.txt'], ignored: ['node_modules/', '.env'] });
  assert.equal(groupReasons(['не чистая: 3 изм.', 'не чистая: 1 изм.', 'ветка не слита в main']), '2× не чистая, ветка не слита в main');
});

test('шесть копий: годна ровно первая (слитая, с коммитами, карточка закрыта); у остальных причины словами', async () => {
  const { r, wts, status } = await six();
  const { w, writes } = unit(r, { board: boardStub(status) });
  const rows = await w.list();
  assert.equal(rows.length, 6, 'основной клон в список не идёт');
  assert.deepEqual(rows.filter((x) => x.eligible).map((x) => path.basename(x.path)), [path.basename(wts.done)]);
  const why = (k) => rowOf(rows, wts[k]).reason;
  assert.match(why('fresh'), /свежая ветка без своих коммитов/);
  assert.match(why('dirty'), /^не чистая: 1/);
  assert.match(why('unmerged'), /не слита/);
  assert.match(why('env'), /есть игнорируемые: \.env — разбери руками/);
  assert.deepEqual(rowOf(rows, wts.env).ignored, ['.env']);
  assert.match(why('locked'), /заперта/);
  const d = rowOf(rows, wts.done);
  assert.deepEqual({ repo: fwd(d.repo), branch: d.branch, card: d.card, ignored: d.ignored }, { repo: fwd(r.main), branch: 'ext-501-done', card: 'EXT-501', ignored: [] });
  assert.equal(writes.length, 0, 'поиск ничего не пишет');
});

test('отрицательный контроль: закрытая карточка нужна — карточка в работе или неизвестная → копия не годна; amend считается коммитом', async () => {
  const r = mkRepo();
  const a = addWt(r, 'ext-510-open', { commits: 1, merge: true });
  const b = addWt(r, 'ext-511-nocard', { commits: 1, merge: true });
  const c = addWt(r, 'ext-512-amend', { amend: true, merge: true });
  assert.match(G(r.main, 'reflog', 'show', 'ext-512-amend'), /commit \(amend\)/, 'в reflog ветки именно «commit (amend)»');
  const { w } = unit(r, { board: boardStub({ 'EXT-510': 'in-progress', 'EXT-512': 'done' }) });
  const rows = await w.list();
  assert.equal(rowOf(rows, a).eligible, false);
  assert.match(rowOf(rows, a).reason, /карточка EXT-510 не закрыта \(in-progress\)/);
  assert.equal(rowOf(rows, b).eligible, false);
  assert.match(rowOf(rows, b).reason, /не закрыта/);
  assert.equal(rowOf(rows, c).eligible, true, 'единственный коммит — amend, карточка done: годна');
});

test('возраст — по времени СОЗДАНИЯ папки (шов birthOf): старше 14 дней — годна без закрытой карточки и без коммитов, моложе — нет; mtime папки ничего не решает', async () => {
  const r = mkRepo();
  const old = addWt(r, 'ext-520-old'); // без коммитов, карточки нет
  const young = addWt(r, 'ext-521-young');
  const oldOpen = addWt(r, 'ext-522-oldopen', { commits: 1, merge: true });
  const now = Date.now();
  const birth = new Map([[fwd(old), now - 15 * DAY], [fwd(young), now - 13 * DAY], [fwd(oldOpen), now - 20 * DAY]]);
  const birthOf = (p) => birth.get(fwd(p)) ?? now;
  const { w } = unit(r, { board: boardStub({ 'EXT-522': 'in-progress' }), birthOf, now: () => now });
  const rows = await w.list();
  assert.equal(rowOf(rows, old).eligible, true, '15 дней, свежая ветка без коммитов — уходит по возрасту');
  assert.equal(rowOf(rows, young).eligible, false, '13 дней — нет');
  assert.equal(rowOf(rows, oldOpen).eligible, true, 'карточка не закрыта, но копии 20 дней');
  // mtime старый, создание свежее (реальный fs) → не годна
  const r2 = mkRepo();
  const touched = addWt(r2, 'ext-523-touched');
  const past = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(touched, past, past);
  const rows2 = await unit(r2).w.list();
  assert.equal(rowOf(rows2, touched).eligible, false, 'mtime 30 дней назад, а создана только что — не годна');
  // порог — настройка
  const rows3 = await unit(r, { board: boardStub({}), birthOf, now: () => now, maxAgeDays: 10 }).w.list();
  assert.equal(rowOf(rows3, young).eligible, true, 'порог 10 дней — 13 дней уже много');
});

test('основной клон, отсоединённый HEAD, папки нет: не кандидаты; «папки нет» показана строкой; ошибка merge-base — «не проверить», остальные идут', async () => {
  const r = mkRepo();
  const det = addWt(r, 'ext-530-det', { commits: 1, merge: true });
  G(det, 'checkout', '-q', '--detach');
  const gone = addWt(r, 'ext-531-gone', { commits: 1, merge: true });
  fs.rmSync(gone, { recursive: true, force: true });
  const ok = addWt(r, 'ext-532-ok', { commits: 1, merge: true });
  const broken = addWt(r, 'ext-533-broken', { commits: 1, merge: true });
  const real = createGitRead();
  const git = (repo, args) => (args[0] === 'merge-base' && args.some((a) => a.endsWith('ext-533-broken')) ? Promise.reject(Object.assign(new Error('x'), { code: 128 })) : real(repo, args));
  const { w } = unit(r, { git, board: boardStub({ 'EXT-532': 'done', 'EXT-533': 'done', 'EXT-531': 'done', 'EXT-530': 'done' }) });
  const rows = await w.list();
  assert.ok(!rows.some((x) => fwd(x.path) === fwd(r.main)), 'основной клон — не строка');
  assert.match(rowOf(rows, det).reason, /HEAD отсоединён/);
  assert.match(rowOf(rows, gone).reason, /папки нет/);
  assert.equal(rowOf(rows, gone).eligible, false);
  assert.equal(rowOf(rows, broken).reason, 'не проверить: 128');
  assert.equal(rowOf(rows, ok).eligible, true, 'сбой у соседа остальных не останавливает');
  // код 1 — «не слита», иной — «не проверить» (как createMergeCheck)
  const git1 = (repo, args) => (args[0] === 'merge-base' ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : real(repo, args));
  assert.match(rowOf(await unit(r, { git: git1 }).w.list(), ok).reason, /не слита/);
});

test('сбой git на одной копии (status) — строка «не проверить: <код>», остальные идут', async () => {
  const r = mkRepo();
  const bad = addWt(r, 'ext-540-bad', { commits: 1, merge: true });
  const ok = addWt(r, 'ext-541-ok', { commits: 1, merge: true });
  const real = createGitRead();
  const git = (repo, args) => (args[0] === 'status' && path.resolve(repo) === path.resolve(bad) ? Promise.reject(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })) : real(repo, args));
  const rows = await unit(r, { git, board: boardStub({ 'EXT-540': 'done', 'EXT-541': 'done' }) }).w.list();
  assert.equal(rowOf(rows, bad).reason, 'не проверить: ETIMEDOUT');
  assert.equal(rowOf(rows, ok).eligible, true);
  // сбой самого репозитория (worktree list) — строка репозитория, не исключение
  const failList = (repo, args) => (args[0] === 'worktree' ? Promise.reject(Object.assign(new Error('x'), { code: 128 })) : real(repo, args));
  const rows2 = await unit(r, { git: failList }).w.list();
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].reason, 'не проверить: 128');
});

// ---------- кэш ----------
test('кэш GET: два запроса разом — один обход; в течение 30 с git не зовётся; через 30 с — заново', async () => {
  const r = mkRepo();
  addWt(r, 'ext-570-a', { commits: 1, merge: true });
  const real = createGitRead();
  let lists = 0;
  const git = (repo, args) => { if (args[0] === 'worktree') lists++; return real(repo, args); };
  const clock = { t: Date.now() };
  const { w } = unit(r, { git, now: () => clock.t });
  const [a, b] = await Promise.all([w.list(), w.list()]);
  assert.equal(lists, 1, 'идущее вычисление общее');
  assert.strictEqual(a, b);
  await w.list();
  assert.equal(lists, 1, 'в пределах 30 с — из кэша');
  clock.t += 29000;
  await w.list();
  assert.equal(lists, 1);
  clock.t += 2000;
  await w.list();
  assert.equal(lists, 2, 'после 30 с — заново');
  await w.list('EXT');
  assert.equal(lists, 3, 'ключ кэша — проект');
});

test('реестр: без дублей по нормализованному пути (тот же клон другим написанием и копия в списке репозиториев)', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-580-a', { commits: 1, merge: true });
  const same = r.main.replace(/\\/g, '/').toUpperCase();
  const reg = { get: () => ({ codes: [{ code: 'EXT', repos: [r.main, same + '/'] }, { code: 'CAR', repos: [r.main, wt] }] }) };
  const rows = await unit(r, { registry: reg, board: boardStub({ 'EXT-580': 'done' }) }).w.list();
  assert.equal(rows.length, 1, 'одна копия — одна строка');
});


test('status.showUntrackedFiles=no в конфиге: неотслеживаемый файл в копии всё равно делает её не чистой (флаг --untracked-files=normal); без флага — копия «чистая» (тест зрячий)', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-600-untracked', { commits: 1, merge: true });
  G(r.main, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(wt, 'precious.txt'), 'не терять');
  const board = boardStub({ 'EXT-600': 'done' });
  const rows = await unit(r, { board }).w.list();
  assert.equal(rowOf(rows, wt).eligible, false);
  assert.match(rowOf(rows, wt).reason, /^не чистая: 1/);
  // мутант: git без флага (флаг снят на входе) — конфиг прячет файл, копия «годна»
  const real = createGitRead();
  const noFlag = (repo, args) => real(repo, args[0] === 'status' ? args.filter((a) => a !== '--untracked-files=normal') : args);
  const rows2 = await unit(r, { board, git: noFlag }).w.list();
  assert.equal(rowOf(rows2, wt).eligible, true, 'без флага конфиг скрывает файл — потому флаг нужен');
});

test('тег с именем ветки не подменяет ветку: ветка не слита, тег на слитом коммите — суждение по ветке (refs/heads/…)', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-601-tagged', { commits: 1 }); // не слита
  G(r.main, 'tag', 'ext-601-tagged', 'main'); // тег того же имени — на слитом коммите
  const rows = await unit(r, { board: boardStub({ 'EXT-601': 'done' }) }).w.list();
  assert.equal(rowOf(rows, wt).eligible, false);
  assert.match(rowOf(rows, wt).reason, /не слита/);
});

test('время создания папки ≤ 0 или не число — «не проверить», не кандидат (даже когда по возрасту ушла бы)', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-602-birth');
  for (const bad of [0, -5, NaN, Infinity, undefined]) {
    const row = rowOf(await unit(r, { birthOf: () => bad }).w.list(), wt);
    assert.equal(row.eligible, false, String(bad));
    assert.match(row.reason, /^не проверить: время создания папки/, String(bad));
  }
  const ok = rowOf(await unit(r, { birthOf: () => Date.now() - 20 * DAY }).w.list(), wt);
  assert.equal(ok.eligible, true, 'контроль: нормальное старое время — годна');
});

test('запасной путь без cwd: живой тред без cwd, а у ветки нет номера карточки — «не проверить», не годна; с номером и без совпадения — годна', async () => {
  const r = mkRepo();
  const named = addWt(r, 'feature-no-card', { commits: 1, merge: true });
  const carded = addWt(r, 'ext-603-card', { commits: 1, merge: true });
  const dir = emptySessions();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid }));
  const rows = await unit(r, { board: boardStub({ 'EXT-603': 'done' }), sessionsDir: dir, isAlive: (p) => p === process.pid, birthOf: () => Date.now() - 20 * DAY }).w.list();
  assert.equal(rowOf(rows, named).eligible, false);
  assert.match(rowOf(rows, named).reason, /^не проверить: ветка без номера карточки/);
  assert.equal(rowOf(rows, carded).eligible, true);
  // контроль: живых без cwd нет — ветка без карточки годна по возрасту
  const rows2 = await unit(r, { board: boardStub({}), sessionsDir: emptySessions(), birthOf: () => Date.now() - 20 * DAY }).w.list();
  assert.equal(rowOf(rows2, named).eligible, true);
});
