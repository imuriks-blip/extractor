// EXT-83, ПТ8б: правки по вердикту Голема дирижёра на c051867 — ссылки в dist/.venv/__pycache__ и во вложенных node_modules,
// обе проверки живого треда, выбор копий галочками, полная повторная проверка перед remove, реестр, безопасный список путём целиком,
// настройки из config, NOT_CONNECTED без пишущей обёртки, подпись таймаута. Временные репозитории.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './ext83-harness.mjs';
const { DAY, fwd, mkRepo, addWt, listPaths, boardStub, emptySessions, rowOf, unit, harness, mkJunction, dropLink, findLink, tmpDir } = H;

const LINK = 'внутри ссылка — разбери руками';
const target = () => { const t = tmpDir('ext83-gtgt-'); fs.writeFileSync(path.join(t, 'marker.txt'), 'жив'); return t; };
const alive = (t) => fs.readFileSync(path.join(t, 'marker.txt'), 'utf8') === 'жив';

// ---------- 1. dist, .venv, __pycache__ ----------
test('ссылка внутри dist/, .venv/, .venv/Lib/, .venv/Scripts/, __pycache__/ — «внутри ссылка», git-write не звался, цель цела; настоящий dist/ без ссылок — годна', async () => {
  const t = target();
  const r = mkRepo();
  const mk = (b) => addWt(r, b, { commits: 1, merge: true });
  const c = { dist: mk('ext-601-dist'), venv: mk('ext-602-venv'), lib: mk('ext-603-lib'), scripts: mk('ext-604-scr'), pyc: mk('ext-605-pyc'), real: mk('ext-606-real'), deepDist: mk('ext-607-dd') };
  fs.mkdirSync(path.join(c.dist, 'dist'));
  mkJunction(t, path.join(c.dist, 'dist', 'x'));
  fs.mkdirSync(path.join(c.venv, '.venv'));
  fs.writeFileSync(path.join(c.venv, '.venv', 'pyvenv.cfg'), 'x'); // как у настоящей среды
  mkJunction(t, path.join(c.venv, '.venv', 'x'));
  fs.mkdirSync(path.join(c.lib, '.venv', 'Lib'), { recursive: true });
  mkJunction(t, path.join(c.lib, '.venv', 'Lib', 'x'));
  fs.mkdirSync(path.join(c.scripts, '.venv', 'Scripts'), { recursive: true });
  mkJunction(t, path.join(c.scripts, '.venv', 'Scripts', 'x'));
  fs.mkdirSync(path.join(c.pyc, '__pycache__'));
  mkJunction(t, path.join(c.pyc, '__pycache__', 'x'));
  fs.mkdirSync(path.join(c.real, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(c.real, 'dist', 'assets', 'a.js'), '1');
  fs.mkdirSync(path.join(c.real, '.venv', 'Lib', 'site-packages'), { recursive: true });
  fs.writeFileSync(path.join(c.real, '.venv', 'pyvenv.cfg'), 'x');
  fs.mkdirSync(path.join(c.deepDist, 'dist', 'assets', 'img'), { recursive: true });
  mkJunction(t, path.join(c.deepDist, 'dist', 'assets', 'img', 'x'));
  const status = Object.fromEntries(['601', '602', '603', '604', '605', '606', '607'].map((n) => [`EXT-${n}`, 'done']));
  const { w, writes } = unit(r, { board: boardStub(status) });
  const rows = await w.list();
  for (const k of ['dist', 'venv', 'lib', 'scripts', 'pyc', 'deepDist']) {
    assert.equal(rowOf(rows, c[k]).eligible, false, k);
    assert.ok(findLink(c[k])?.link, `${k}: обход видит ссылку`);
  }
  for (const k of ['dist', 'venv', 'lib', 'scripts', 'pyc', 'deepDist']) assert.equal(rowOf(rows, c[k]).reason, LINK, k);
  assert.equal(rowOf(rows, c.real).eligible, true, `контроль: настоящий dist/ и .venv/ без ссылок — годна (${rowOf(rows, c.real).reason})`);
  assert.equal(writes.length, 0);
  assert.ok(alive(t));
});

test('ссылка в dist/ — первый щелчок «убирать нечего», remove не звался, цель цела', async () => {
  const t = target();
  const h = await harness();
  fs.mkdirSync(path.join(h.wts.done, 'dist'));
  mkJunction(t, path.join(h.wts.done, 'dist', 'x'));
  const b = (await h.press({ project: 'EXT' })).json();
  assert.equal(b.outcome, 'ok');
  assert.match(b.message, /^убирать нечего \(1 пропущено: внутри ссылка/);
  assert.equal(h.removes().length, 0);
  assert.ok(alive(t));
  dropLink(path.join(h.wts.done, 'dist', 'x'));
});

// ---------- 2. вложенные node_modules и .pnpm ----------
test('node_modules: ссылка во вложенном node_modules/a/node_modules/b и в .pnpm/x/node_modules/y — ловится; вложенные без ссылок — годна; потолок записей общий', async () => {
  const t = target();
  const r = mkRepo();
  const nested = addWt(r, 'ext-611-nested', { commits: 1, merge: true });
  const pnpm = addWt(r, 'ext-612-pnpm', { commits: 1, merge: true });
  const scoped = addWt(r, 'ext-613-scoped', { commits: 1, merge: true });
  const clean = addWt(r, 'ext-614-clean', { commits: 1, merge: true });
  fs.mkdirSync(path.join(nested, 'node_modules', 'a', 'node_modules'), { recursive: true });
  mkJunction(t, path.join(nested, 'node_modules', 'a', 'node_modules', 'b'));
  fs.mkdirSync(path.join(pnpm, 'node_modules', '.pnpm', 'x@1.0.0', 'node_modules'), { recursive: true });
  mkJunction(t, path.join(pnpm, 'node_modules', '.pnpm', 'x@1.0.0', 'node_modules', 'y'));
  fs.mkdirSync(path.join(scoped, 'node_modules', '@sc', 'p', 'node_modules'), { recursive: true });
  mkJunction(t, path.join(scoped, 'node_modules', '@sc', 'p', 'node_modules', 'z'));
  fs.mkdirSync(path.join(clean, 'node_modules', 'a', 'node_modules', 'c', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(clean, 'node_modules', '.pnpm', 'x@1.0.0', 'node_modules', 'x'), { recursive: true });
  const { w, writes } = unit(r, { board: boardStub({ 'EXT-611': 'done', 'EXT-612': 'done', 'EXT-613': 'done', 'EXT-614': 'done' }) });
  const rows = await w.list();
  assert.equal(rowOf(rows, nested).reason, LINK);
  assert.equal(rowOf(rows, pnpm).reason, LINK);
  assert.equal(rowOf(rows, scoped).reason, LINK);
  assert.equal(rowOf(rows, clean).eligible, true, 'контроль: вложенные node_modules и .pnpm без ссылок');
  assert.equal(writes.length, 0);
  assert.deepEqual(findLink(clean, { max: 5 }), { big: true }, 'счётчик общий: вложенные записи считаются');
  assert.ok(alive(t));
});

// ---------- 3. живой тред: обе проверки всегда ----------
test('живой тред: cwd снаружи (Vault), а карточка живого треда совпала с номером ветки — не годна; карточка не совпала — годна', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-620-th', { commits: 1, merge: true });
  const dir = emptySessions();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ cwd: path.dirname(r.main) }));
  const run = async (threads) => rowOf(await unit(r, { board: boardStub({ 'EXT-620': 'done' }), sessionsDir: dir, isAlive: (p) => p === process.pid, threadsNow: () => threads }).w.list(), wt);
  const hit = await run([{ card: 'EXT-620' }]);
  assert.equal(hit.eligible, false);
  assert.match(hit.reason, /живой тред/);
  assert.equal((await run([{ card: 'EXT-621' }])).eligible, true);
});

// ---------- 4. выбор копий ----------
test('выбор: убирается пересечение выбранного со списком первого щелчка; снятая галочка не тронута; путь вне списка первого щелчка — игнорируется', async () => {
  const h = await harness({ all: true });
  h.birth.set(fwd(h.wts.fresh), Date.now() - 15 * DAY);
  const b1 = (await h.press({ project: 'EXT' })).json();
  assert.deepEqual(b1.confirm.candidates.map((c) => c.branch).sort(), ['ext-501-done', 'ext-502-fresh']);
  const late = addWt(h.r, 'ext-596-late');
  h.birth.set(fwd(late), Date.now() - 20 * DAY); // годна, но в списке первого щелчка её не было
  const pick = b1.confirm.candidates.find((c) => c.branch === 'ext-501-done').path;
  const r2 = await h.press({ project: 'EXT', confirm: b1.id, paths: [pick, late] });
  assert.equal(r2.statusCode, 200, r2.body);
  const b2 = r2.json();
  assert.match(b2.message, /^убрано 1, пропущено 0/);
  assert.match(b2.message, /не выбрано 1 — не трогал/);
  assert.match(b2.message, /новых кандидатов 1 не трогал/, 'снятая галочка — не «новый кандидат»: новый только late');
  assert.equal(h.removes().length, 1);
  assert.equal(fwd(h.removes()[0][3]), fwd(h.wts.done));
  assert.ok(fs.existsSync(h.wts.fresh), 'снятая галочка — копия на месте');
  assert.ok(fs.existsSync(late), 'путь вне списка первого щелчка — не тронут');
  assert.ok(listPaths(h.r.main).includes(fwd(late)));
});

test('выбор: пустой список, не массив, не строки, путь без подтверждения, paths у другого действия — 400, remove не звался', async () => {
  const h = await harness();
  const b1 = (await h.press({ project: 'EXT' })).json();
  for (const paths of [[], 'C:/x', [1], [''], ['a\u0000b']]) {
    const r = await h.press({ project: 'EXT', confirm: b1.id, paths });
    assert.equal(r.statusCode, 400, JSON.stringify(paths));
  }
  assert.equal((await h.press({ project: 'EXT', paths: [h.wts.done] })).statusCode, 400, 'выбор — только со вторым щелчком');
  assert.equal((await h.press({ paths: ['x'] }, 'ping')).statusCode, 400);
  assert.equal(h.removes().length, 0);
  // без paths — весь список первого щелчка (окно по умолчанию — все галочки стоят)
  const ok = (await h.press({ project: 'EXT', confirm: b1.id })).json();
  assert.match(ok.message, /^убрано 1, пропущено 0/);
});

// ---------- 5. перед каждым remove — judge целиком ----------
test('перед каждым remove — полная проверка: новый .env и вошедший живой тред между щелчками (после первого remove) — копия пропущена с причиной', async () => {
  for (const kind of ['env', 'thread']) {
    const sessions = emptySessions();
    let hook = null;
    const h = await harness({ withCar: true, sessions, isAlive: (p) => p === process.pid, gw: (base) => async (repo, args) => {
      const out = await base(repo, args);
      if (args[1] === 'remove') hook?.();
      return out;
    } });
    const b1 = (await h.press({})).json();
    assert.deepEqual(b1.confirm.candidates.map((c) => c.card), ['EXT-501', 'CAR-1']);
    hook = () => {
      hook = null;
      if (kind === 'env') fs.writeFileSync(path.join(h.carWt, '.env'), 'X=1');
      else fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ cwd: h.carWt }));
    };
    const b2 = (await h.press({ confirm: b1.id })).json();
    assert.match(b2.message, kind === 'env' ? /^убрано 1, пропущено 1 \(почему: есть игнорируемые/ : /^убрано 1, пропущено 1 \(почему: в ней стоит живой тред/, kind);
    assert.equal(h.removes().length, 1, kind);
    assert.ok(fs.existsSync(h.carWt), kind);
  }
});

// ---------- 6. реестр ----------
test('путь из реестра (основной клон проекта) в кандидаты не идёт, даже если он — копия другого репозитория', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-630-reg', { commits: 1, merge: true });
  const reg = { get: () => ({ codes: [{ code: 'EXT', repos: [r.main] }, { code: 'CAR', repos: [wt.replace(/\\/g, '/').toUpperCase()] }] }) };
  const rows = await unit(r, { registry: reg, board: boardStub({ 'EXT-630': 'done' }) }).w.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eligible, false);
  assert.match(rows[0].reason, /реестр/);
  // и по проекту EXT (копия — основной клон CAR) — тоже не годна
  const ext = await unit(r, { registry: reg, board: boardStub({ 'EXT-630': 'done' }) }).w.list('EXT');
  assert.equal(rowOf(ext, wt).eligible, false);
});

// ---------- 7, 8. безопасный список — путь целиком, из config ----------
test('безопасный список — путь целиком: web/dist/ — безопасно, sub/dist/ — нет; список и порог — из настроек', async () => {
  const r = mkRepo();
  // web/ и sub/ — отслеживаемые (как в настоящем репозитории): иначе git свернёт неотслеживаемый каталог в «web/»
  for (const d of ['web', 'sub']) { fs.mkdirSync(path.join(r.main, d)); fs.writeFileSync(path.join(r.main, d, 'k.txt'), 'k'); }
  H.G(r.main, 'add', '.');
  H.G(r.main, 'commit', '-q', '-m', 'web sub');
  const web = addWt(r, 'ext-640-web', { commits: 1, merge: true });
  const sub = addWt(r, 'ext-641-sub', { commits: 1, merge: true });
  fs.mkdirSync(path.join(web, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(web, 'web', 'dist', 'a.js'), '1');
  fs.mkdirSync(path.join(sub, 'sub', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'sub', 'dist', 'a.js'), '1');
  const board = boardStub({ 'EXT-640': 'done', 'EXT-641': 'done' });
  const rows = await unit(r, { board }).w.list();
  assert.equal(rowOf(rows, web).eligible, true, rowOf(rows, web).reason);
  assert.equal(rowOf(rows, sub).reason, 'есть игнорируемые: sub/dist/ — разбери руками');
  const rows2 = await unit(r, { board, safeIgnored: ['sub/dist/'] }).w.list();
  assert.equal(rowOf(rows2, sub).eligible, true, 'настройка: свой список');
  assert.match(rowOf(rows2, web).reason, /есть игнорируемые: web\/dist\//, 'список настройки заменяет умолчание');
});

test('config pult.cleanup: maxAgeDays и safeIgnored доходят до уборки через buildApp; кривые значения — умолчания', async () => {
  const h = await harness({ all: true, cleanup: { maxAgeDays: 1, safeIgnored: ['node_modules/', 'dist/', 'data/'] } });
  h.birth.set(fwd(h.wts.fresh), Date.now() - 2 * DAY);
  fs.mkdirSync(path.join(h.wts.done, 'data'));
  fs.writeFileSync(path.join(h.wts.done, 'data', 'x.json'), '{}');
  const rows = (await h.get('/api/worktrees?project=EXT')).json();
  assert.equal(rowOf(rows, h.wts.fresh).eligible, true, 'порог 1 день из настройки');
  assert.equal(rowOf(rows, h.wts.done).eligible, true, 'data/ — в списке настройки');
  const d = await harness({ all: true, cleanup: { maxAgeDays: -3, safeIgnored: 'data/' } });
  d.birth.set(fwd(d.wts.fresh), Date.now() - 2 * DAY);
  fs.mkdirSync(path.join(d.wts.done, 'data'));
  fs.writeFileSync(path.join(d.wts.done, 'data', 'x.json'), '{}');
  const rows2 = (await d.get('/api/worktrees?project=EXT')).json();
  assert.equal(rowOf(rows2, d.wts.fresh).eligible, false, 'кривой порог — 14 дней');
  assert.match(rowOf(rows2, d.wts.done).reason, /есть игнорируемые: data\//, 'кривой список — список спеки');
});

// ---------- 9. NOT_CONNECTED ----------
test('без переданной пишущей обёртки — честный отказ NOT_CONNECTED, настоящая не подставляется, копия на месте', async () => {
  const h = await harness({ gw: () => null });
  const r = await h.press({ project: 'EXT' });
  assert.equal(r.json().outcome, 'error');
  assert.match(r.body, /NOT_CONNECTED|не подключена/);
  assert.ok(fs.existsSync(h.wts.done));
});

// ---------- 10. таймаут ----------
test('remove убит по таймауту (e.killed, code null) — подпись «таймаут 180 с»', async () => {
  const h = await harness({ gw: (base) => async (repo, args) => {
    if (args[1] === 'remove') throw Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM', stderr: '' });
    return base(repo, args);
  } });
  const b1 = (await h.press({})).json();
  const b2 = (await h.press({ confirm: b1.id })).json();
  assert.equal(b2.outcome, 'partial');
  assert.match(b2.message, /таймаут 180 с/);
  assert.doesNotMatch(b2.message, /Error/);
});
