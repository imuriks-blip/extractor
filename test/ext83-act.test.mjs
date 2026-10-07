// EXT-83, ПТ8б: ручка GET /api/worktrees и действие cleanup — второй щелчок, уборка git worktree remove без силы. Временные репозитории.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './ext83-harness.mjs';
const { PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir } = H;
void [PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir, fs, path, assert, test];
test('GET /api/worktrees: форма строк, project — только репозитории проекта, без project — все проекты, неверный project — 400', async () => {
  const h = await harness({ all: true, withCar: true });
  const all = (await h.get('/api/worktrees')).json();
  assert.equal(all.length, 4, 'три копии EXT и одна CAR');
  for (const row of all) assert.deepEqual(Object.keys(row).sort(), ['branch', 'card', 'eligible', 'ignored', 'path', 'reason', 'repo']);
  const ext = (await h.get('/api/worktrees?project=EXT')).json();
  assert.equal(ext.length, 3);
  assert.ok(!ext.some((x) => x.card === 'CAR-1'));
  const car = (await h.get('/api/worktrees?project=CAR')).json();
  assert.deepEqual(car.map((x) => [x.card, x.eligible]), [['CAR-1', true]]);
  assert.equal((await h.get('/api/worktrees?project=XX9')).statusCode, 400);
  assert.equal((await h.get('/api/worktrees?project=ZZZ')).statusCode, 400);
});

test('первый щелчок ничего не убирает: need-confirm с what/follows/mirrorAt/candidates; второй щелчок убирает ровно первую копию, ветки и основная копия целы', async () => {
  const h = await harness({ all: true });
  const before = listPaths(h.r.main);
  assert.equal(before.length, 4);
  const branchesBefore = branchesOf(h.r.main);
  const r1 = await h.press({ project: 'EXT' });
  assert.equal(r1.statusCode, 200, r1.body);
  const b1 = r1.json();
  assert.equal(b1.outcome, 'need-confirm');
  assert.equal(b1.confirm.what, '«Прибери отслужившие рабочие копии» · EXT');
  assert.equal(b1.confirm.follows, `уберу 1 копию: ${path.basename(h.wts.done)}; ветки остаются`);
  assert.ok('mirrorAt' in b1.confirm);
  assert.deepEqual(b1.confirm.candidates.map((c) => [fwd(c.repo), fwd(c.path), c.branch, c.card]), [[fwd(h.r.main), fwd(h.wts.done), 'ext-501-done', 'EXT-501']]);
  assert.deepEqual(listPaths(h.r.main), before, 'до второго щелчка список копий тот же');
  assert.equal(h.writes.length, 0, 'git-write не звался');
  assert.deepEqual(h.lines().map((l) => l.step), ['asked', 'need-confirm']);
  const r2 = await h.press({ project: 'EXT', confirm: b1.id });
  const b2 = r2.json();
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(b2.outcome, 'ok');
  assert.match(b2.message, /^убрано 1, пропущено 0/);
  const after = listPaths(h.r.main);
  assert.deepEqual(before.filter((p) => !after.includes(p)), [fwd(h.wts.done)], 'убрана ровно первая');
  assert.equal(after.length, 3);
  assert.equal(fs.existsSync(h.wts.done), false);
  for (const k of ['fresh', 'dirty']) assert.ok(fs.existsSync(h.wts[k]), `${k} на месте`);
  assert.deepEqual(branchesOf(h.r.main), branchesBefore, 'ветки остались все (в том числе убранной)');
  assert.ok(fs.existsSync(path.join(h.r.main, 'a.txt')), 'основная копия цела');
  // вызовы git-write: ровно remove без силы + prune; ничего с --force
  assert.deepEqual(h.writes, [[fwd(h.r.main), 'worktree', 'remove', fwd(h.wts.done)], [fwd(h.r.main), 'worktree', 'prune']]);
  assert.ok(!JSON.stringify(h.writes).includes('force') && !JSON.stringify(h.writes).includes('-f'));
  const steps = h.lines().filter((l) => l.id === b1.id).map((l) => l.step);
  assert.deepEqual(steps, ['asked', 'need-confirm']);
  assert.deepEqual(h.lines().filter((l) => l.id === b2.id).map((l) => l.step), ['asked', 'confirmed', 'worktree-remove', 'worktree-prune', 'done']);
});

test('отказы второго щелчка — git remove не звался: без confirm (первый щелчок), чужой confirm, другой проект, просроченный, потраченный', async () => {
  const h = await harness({ all: true });
  const b1 = (await h.press({ project: 'EXT' })).json();
  // без confirm — снова первый щелчок, ничего не убрано
  assert.equal((await h.press({ project: 'EXT' })).json().outcome, 'need-confirm');
  assert.equal(h.removes().length, 0);
  // чужой confirm: номер другого действия (ping) и несуществующий
  const ping = (await h.press({}, 'ping')).json();
  const alien = await h.press({ project: 'EXT', confirm: ping.id });
  assert.equal(alien.json().refusal, 'bad-confirm');
  assert.equal((await h.press({ project: 'EXT', confirm: 'W-261007-000000-0000' })).json().refusal, 'bad-confirm');
  // подтверждение первого щелчка по EXT не годится для CAR и для «всех проектов»
  assert.equal((await h.press({ project: 'CAR', confirm: b1.id })).json().refusal, 'bad-confirm');
  assert.equal((await h.press({ confirm: b1.id })).json().refusal, 'bad-confirm');
  assert.equal(h.removes().length, 0, 'ни одного remove за все отказы');
  // просроченный: 5 минут и секунда
  h.clock.t += 5 * 60000 + 1000;
  const late = await h.press({ project: 'EXT', confirm: b1.id });
  assert.equal(late.json().refusal, 'confirm-expired');
  assert.equal(h.removes().length, 0);
  // свежий первый щелчок, второй проходит, третий с тем же confirm — потрачен
  const b3 = (await h.press({ project: 'EXT' })).json();
  assert.equal((await h.press({ project: 'EXT', confirm: b3.id })).json().outcome, 'ok');
  assert.equal(h.removes().length, 1);
  const spent = await h.press({ project: 'EXT', confirm: b3.id });
  assert.equal(spent.json().refusal, 'bad-confirm');
  assert.equal(h.removes().length, 1, 'потраченный confirm второго remove не дал');
  // нет кандидатов — ok без второго щелчка
  const none = (await h.press({ project: 'EXT' })).json();
  assert.equal(none.outcome, 'ok');
  assert.match(none.message, /^убирать нечего \(2 пропущено: /);
  assert.ok(!('confirm' in none));
});

test('кандидат, ставший грязным между щелчками, пропущен с причиной; новая годная копия, не бывшая в списке первого щелчка, не трогается и не теряется', async () => {
  const h = await harness();
  const b1 = (await h.press({ project: 'EXT' })).json();
  assert.deepEqual(b1.confirm.candidates.map((c) => c.branch), ['ext-501-done']);
  // между щелчками: первая стала грязной, а ещё одна копия стала годной (старше 14 дней по созданию папки)
  fs.writeFileSync(path.join(h.wts.done, 'late.txt'), 'x');
  const newer = addWt(h.r, 'ext-508-newer');
  h.birth.set(fwd(newer), Date.now() - 15 * DAY);
  h.clock.t += 1000;
  const b2 = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.equal(h.removes().length, 0, 'грязную не убрали, новую не тронули');
  assert.ok(fs.existsSync(h.wts.done) && fs.existsSync(newer));
  assert.equal(b2.outcome, 'ok');
  assert.match(b2.message, /^убрано 0, пропущено 1 \(почему: не чистая\)/);
  assert.match(b2.message, /новых кандидатов 1 не трогал/);
  // новая копия не потеряна: новое нажатие предлагает её (грязная — нет)
  const b3 = (await h.press({ project: 'EXT' })).json();
  assert.deepEqual(b3.confirm.candidates.map((c) => c.branch), ['ext-508-newer']);
});

test('второй щелчок убирает только список первого: годная копия, появившаяся после, остаётся на месте', async () => {
  const h = await harness();
  const b1 = (await h.press({ project: 'EXT' })).json();
  const newer = addWt(h.r, 'ext-509-newer');
  h.birth.set(fwd(newer), Date.now() - 15 * DAY);
  const b2 = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.match(b2.message, /^убрано 1, пропущено 0; новых кандидатов 1 не трогал/);
  assert.ok(!fs.existsSync(h.wts.done), 'копия из списка убрана');
  assert.ok(fs.existsSync(newer), 'новая копия цела');
  assert.deepEqual(h.removes().map((w) => w[3]), [fwd(h.wts.done)]);
});

test('ошибка git у одной копии — строка с ошибкой и дальше; prune на каждый затронутый репозиторий; outcome partial; ветки на месте', async () => {
  const failFor = new Set();
  const h = await harness({ withCar: true, gw: (base) => async (repo, args) => {
    if (args[1] === 'remove' && failFor.has(fwd(args[2]))) throw Object.assign(new Error('fatal: cannot remove'), { code: 128, stderr: 'fatal: cannot remove: Permission denied' });
    return base(repo, args);
  } });
  failFor.add(fwd(h.wts.done));
  const b1 = (await h.press({})).json(); // все проекты: EXT-501 и CAR-1
  assert.deepEqual(b1.confirm.candidates.map((c) => c.card).sort(), ['CAR-1', 'EXT-501']);
  const b2 = (await h.press({ confirm: b1.id })).json();
  assert.equal(b2.outcome, 'partial');
  assert.match(b2.message, /^убрано 1, пропущено 0; ошибок 1: /);
  assert.match(b2.message, /Permission denied/);
  assert.ok(fs.existsSync(h.wts.done), 'копия с ошибкой на месте');
  assert.ok(!fs.existsSync(h.carWt), 'следующая убрана несмотря на ошибку');
  const prunes = h.writes.filter((w) => w[2] === 'prune').map((w) => w[0]).sort();
  assert.deepEqual(prunes, [fwd(h.r.main), fwd(h.car.main)].sort(), 'prune — на каждый затронутый репозиторий, по разу');
  assert.ok(branchesOf(h.car.main).includes('car-1-done'));
  assert.equal(h.lines().filter((l) => l.id === b2.id).at(-1).step, 'partial');
});

test('пока идёт уборка — второй щелчок и новое нажатие: отказ cleanup-running (409); после конца уборки снова можно', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let entered;
  const inside = new Promise((res) => { entered = res; });
  const h = await harness({ gw: (base) => async (repo, args) => { if (args[1] === 'remove') { entered(); await gate; } return base(repo, args); } });
  const b1 = (await h.press({ project: 'EXT' })).json();
  const slow = h.press({ project: 'EXT', confirm: b1.id });
  await inside;
  const again = await h.press({ project: 'EXT', confirm: b1.id });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().refusal, 'cleanup-running');
  const fresh = await h.press({ project: 'EXT' });
  assert.equal(fresh.statusCode, 409);
  assert.equal(fresh.json().refusal, 'cleanup-running');
  release();
  const done = await slow;
  assert.equal(done.json().outcome, 'ok');
  assert.equal(h.removes().length, 1, 'remove один раз');
  assert.equal((await h.press({ project: 'EXT' })).json().outcome, 'ok', 'после конца — снова можно (убирать нечего)');
});

test('живой тред в копии между щелчками: копия пропущена, remove не звался', async () => {
  const sessions = emptySessions();
  const h = await harness({ sessions, isAlive: (pid) => pid === process.pid });
  const b1 = (await h.press({ project: 'EXT' })).json();
  assert.equal(b1.confirm.candidates.length, 1);
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ cwd: path.join(h.wts.done, 'web') }));
  const b2 = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.match(b2.message, /убрано 0, пропущено 1 \(почему: в ней стоит живой тред\)/);
  assert.equal(h.removes().length, 0);
  assert.ok(fs.existsSync(h.wts.done));
});

test('копия с junction node_modules на запрос и при второй проверке — не убирается; цель junction цела', async () => {
  const sessions = emptySessions();
  const h = await harness({ sessions });
  const target = tmpDir('ext83-tgt-');
  fs.writeFileSync(path.join(target, 'marker.txt'), 'm');
  const b1 = (await h.press({ project: 'EXT' })).json();
  mkJunction(target, path.join(h.wts.done, 'node_modules')); // junction появился после первого щелчка
  const b2 = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.match(b2.message, /убрано 0, пропущено 1 \(почему: внутри ссылка/);
  assert.equal(h.removes().length, 0);
  assert.ok(fs.existsSync(path.join(target, 'marker.txt')));
  dropLink(path.join(h.wts.done, 'node_modules'));
});

test('копия старше 14 дней (birthOf) проходит весь путь щелчков и убирается вместе со слитой; моложе — остаётся', async () => {
  const h = await harness({ all: true });
  h.birth.set(fwd(h.wts.fresh), Date.now() - 15 * DAY);
  const young = addWt(h.r, 'ext-595-young');
  h.birth.set(fwd(young), Date.now() - 13 * DAY);
  const b1 = (await h.press({ project: 'EXT' })).json();
  assert.deepEqual(b1.confirm.candidates.map((c) => c.branch).sort(), ['ext-501-done', 'ext-502-fresh']);
  const b2 = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.match(b2.message, /^убрано 2, пропущено 0/);
  assert.ok(!fs.existsSync(h.wts.fresh));
  assert.ok(fs.existsSync(young));
});

