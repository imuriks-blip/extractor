// EXT-83, ПТ8б: охрана копий — живой тред внутри (§1.5 п.5) и ссылка/junction внутри (грабля Windows). Временные репозитории.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './ext83-harness.mjs';
const { PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir } = H;
void [PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir, fs, path, assert, test];
// ---------- живой тред ----------
const board2 = { 'EXT-550': 'done' };
async function threadCase({ sessionFile, alive = (pid) => pid === process.pid, threads = [], cwdOf = (wt) => wt }) {
  const r = mkRepo();
  const wt = addWt(r, 'ext-550-th', { commits: 1, merge: true });
  const dir = emptySessions();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(sessionFile(cwdOf(wt))));
  const rows = await unit(r, { board: boardStub(board2), sessionsDir: dir, isAlive: alive, threadsNow: () => threads }).w.list();
  return rowOf(rows, wt);
}

test('живой тред: cwd внутри копии (другой регистр, обратные слэши, вложенная папка) — не кандидат; отрицательные контроли — мёртвый pid, чужая папка, сосед по префиксу', async () => {
  const winCase = (wt) => path.resolve(wt).replace(/\//g, '\\').toUpperCase();
  const hit = await threadCase({ sessionFile: (cwd) => ({ pid: process.pid, cwd }) });
  assert.equal(hit.eligible, false);
  assert.match(hit.reason, /живой тред/);
  assert.match((await threadCase({ sessionFile: (cwd) => ({ pid: process.pid, cwd }), cwdOf: winCase })).reason, /живой тред/, 'другой регистр и слэши');
  assert.match((await threadCase({ sessionFile: (cwd) => ({ cwd }), cwdOf: (wt) => path.join(wt, 'sub', 'dir') })).reason, /живой тред/, 'вложенная папка');
  assert.equal((await threadCase({ sessionFile: (cwd) => ({ cwd }), alive: () => false })).eligible, true, 'pid мёртв — не живой');
  assert.equal((await threadCase({ sessionFile: (cwd) => ({ cwd }), cwdOf: (wt) => `${wt}x` })).eligible, true, 'сосед по префиксу (…wt1-x и …wt1-xx) — не внутри');
  assert.equal((await threadCase({ sessionFile: (cwd) => ({ cwd }), cwdOf: (wt) => path.dirname(wt) })).eligible, true, 'cwd выше копии — копию не держит');
});

test('живой тред без cwd в файле: запасной путь — карточка живого треда совпала с номером ветки → не кандидат; не совпала → кандидат', async () => {
  const noCwd = () => ({ pid: process.pid });
  const hit = await threadCase({ sessionFile: noCwd, threads: [{ sessionId: 's', card: 'EXT-550' }] });
  assert.equal(hit.eligible, false);
  assert.match(hit.reason, /живой тред/);
  assert.equal((await threadCase({ sessionFile: noCwd, threads: [{ sessionId: 's', card: 'EXT-999' }] })).eligible, true);
  assert.equal((await threadCase({ sessionFile: noCwd, threads: [] })).eligible, true);
  // запасной путь включается только файлом без cwd: с cwd снаружи и совпавшей карточкой — по cwd решает путь
  assert.equal((await threadCase({ sessionFile: (cwd) => ({ cwd }), cwdOf: (wt) => path.dirname(wt), threads: [{ card: 'EXT-550' }] })).eligible, true);
});

test('папка сессий: читаются только <число>.json (*.key — никогда); пишется ничего; папка не читается — «не проверить», не кандидат', async () => {
  const r = mkRepo();
  const wt = addWt(r, 'ext-551-x', { commits: 1, merge: true });
  const dir = emptySessions();
  fs.writeFileSync(path.join(dir, '4242.key'), 'secret');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
  fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ cwd: path.dirname(wt) }));
  const read = [];
  const written = [];
  const spy = new Proxy(fs, { get: (t, k) => (k === 'readFileSync' ? (p, ...a) => { read.push(path.basename(String(p))); return t.readFileSync(p, ...a); }
    : /^(write|append|unlink|rm|rename|mkdir)/.test(String(k)) ? (...a) => { written.push([k, String(a[0])]); return t[k](...a); } : t[k]) });
  const rows = await unit(r, { board: boardStub({ 'EXT-551': 'done' }), sessionsDir: dir, fs: spy, isAlive: () => true }).w.list();
  assert.equal(rowOf(rows, wt).eligible, true);
  assert.deepEqual(read, ['4242.json']);
  assert.deepEqual(written.filter(([, p]) => p.includes(path.basename(dir))), [], 'в папку сессий ничего не пишется');
  const rows2 = await unit(r, { board: boardStub({ 'EXT-551': 'done' }), sessionsDir: path.join(dir, 'нет-такой') }).w.list();
  assert.match(rowOf(rows2, wt).reason, /^не проверить: ENOENT/);
  assert.equal(rowOf(rows2, wt).eligible, false);
  const rows3 = await unit(r, { board: boardStub({ 'EXT-551': 'done' }), sessionsDir: null }).w.list();
  assert.equal(rowOf(rows3, wt).eligible, false, 'папка сессий не задана — проверить нечем, не кандидат');
});

test('findLink: настоящий junction ловится lstat (факт Windows); обычные каталоги — нет; внутрь node_modules/.git не заходим; глубина ≤ 6; потолок записей', () => {
  const root = tmpDir('ext83-link-');
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'marker.txt'), 'm');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
  assert.equal(findLink(tree), null, 'без ссылок — null');
  mkJunction(target, path.join(tree, 'a', 'b', 'lnk'));
  assert.equal(fs.lstatSync(path.join(tree, 'a', 'b', 'lnk')).isSymbolicLink(), true, 'lstat видит junction как ссылку');
  assert.equal(findLink(tree).link, path.join(tree, 'a', 'b', 'lnk'));
  dropLink(path.join(tree, 'a', 'b', 'lnk'));
  assert.equal(findLink(tree), null);
  // сам node_modules — junction: ловится (сам каталог lstat'им); ссылка В ГЛУБИНЕ node_modules — принятое ограничение, не ловится
  mkJunction(target, path.join(tree, 'node_modules'));
  assert.equal(findLink(tree).link, path.join(tree, 'node_modules'));
  dropLink(path.join(tree, 'node_modules'));
  fs.mkdirSync(path.join(tree, 'node_modules', 'pkg'), { recursive: true });
  mkJunction(target, path.join(tree, 'node_modules', 'pkg', 'deep'));
  assert.equal(findLink(tree), null, 'ограничение: ссылка внутри node_modules обходом не ловится');
  dropLink(path.join(tree, 'node_modules', 'pkg', 'deep'));
  // глубина: ссылка на глубине 6 — ловится, на глубине 7 — нет
  const deep = (n) => path.join(tree, ...Array.from({ length: n }, (_, i) => `d${i}`));
  fs.mkdirSync(deep(7), { recursive: true });
  mkJunction(target, path.join(deep(6), 'lnk6'));
  assert.ok(findLink(tree)?.link, 'на глубине 6 — ловится');
  dropLink(path.join(deep(6), 'lnk6'));
  mkJunction(target, path.join(deep(7), 'lnk7'));
  assert.deepEqual(findLink(tree), { deep: true }, 'глубже 6 не ходим — и «ссылок нет» не утверждаем: {deep}');
  dropLink(path.join(deep(7), 'lnk7'));
  // потолок записей
  const many = path.join(root, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(many, `f${i}`), '');
  assert.deepEqual(findLink(many, { max: 20 }), { big: true });
  assert.equal(findLink(many, { max: 30 }), null);
  // ошибка lstat — не «чисто»
  const brokenFs = { ...fs, lstatSync: () => { const e = new Error('x'); e.code = 'EPERM'; throw e; }, readdirSync: fs.readdirSync };
  assert.deepEqual(findLink(many, { fs: brokenFs }), { error: 'EPERM' });
  assert.ok(fs.existsSync(path.join(target, 'marker.txt')), 'цель ссылок цела');
});

test('копия с junction node_modules на основной клон — не кандидат («внутри ссылка»); без ссылки с настоящим node_modules — кандидат; цель цела', async () => {
  const r = mkRepo();
  fs.mkdirSync(path.join(r.main, 'node_modules'));
  fs.writeFileSync(path.join(r.main, 'node_modules', 'marker.txt'), 'm');
  const linked = addWt(r, 'ext-560-linked', { commits: 1, merge: true });
  const plain = addWt(r, 'ext-561-plain', { commits: 1, merge: true });
  mkJunction(path.join(r.main, 'node_modules'), path.join(linked, 'node_modules'));
  fs.mkdirSync(path.join(plain, 'node_modules'));
  fs.writeFileSync(path.join(plain, 'node_modules', 'x.js'), '1');
  const { w } = unit(r, { board: boardStub({ 'EXT-560': 'done', 'EXT-561': 'done' }) });
  const rows = await w.list();
  assert.equal(rowOf(rows, linked).eligible, false);
  assert.equal(rowOf(rows, linked).reason, 'внутри ссылка — разбери руками');
  assert.equal(rowOf(rows, plain).eligible, true, 'контроль: настоящий node_modules (игнорируемый безопасный) — не мешает');
  dropLink(path.join(linked, 'node_modules'));
  assert.ok(fs.existsSync(path.join(r.main, 'node_modules', 'marker.txt')));
});


test('node_modules: junction — прямой ребёнок и ребёнок @scope — ловится, копия не кандидат, git-write не звался, ссылка и цель целы; контроль без ссылок — кандидат; глубже (внук) — принятое ограничение', async () => {
  const target = tmpDir('ext83-nmtgt-');
  fs.writeFileSync(path.join(target, 'marker.txt'), 'm');
  const r = mkRepo();
  const direct = addWt(r, 'ext-571-direct', { commits: 1, merge: true });
  const scoped = addWt(r, 'ext-572-scoped', { commits: 1, merge: true });
  const clean = addWt(r, 'ext-573-clean', { commits: 1, merge: true });
  const deep = addWt(r, 'ext-574-deep', { commits: 1, merge: true });
  for (const wt of [direct, scoped, clean, deep]) fs.mkdirSync(path.join(wt, 'node_modules', '@sc', 'real'), { recursive: true });
  fs.mkdirSync(path.join(clean, 'node_modules', 'plain'));
  mkJunction(target, path.join(direct, 'node_modules', 'lnk'));
  mkJunction(target, path.join(scoped, 'node_modules', '@sc', 'lnk'));
  mkJunction(target, path.join(deep, 'node_modules', '@sc', 'real', 'inner'));
  const { w, writes } = unit(r, { board: boardStub({ 'EXT-571': 'done', 'EXT-572': 'done', 'EXT-573': 'done', 'EXT-574': 'done' }) });
  const rows = await w.list();
  assert.equal(rowOf(rows, direct).reason, 'внутри ссылка — разбери руками');
  assert.equal(rowOf(rows, scoped).reason, 'внутри ссылка — разбери руками');
  assert.equal(rowOf(rows, clean).eligible, true, 'контроль: node_modules без ссылок — кандидат');
  assert.equal(rowOf(rows, deep).eligible, true, 'ограничение: ссылка глубже детей @scope не ловится');
  assert.equal(writes.length, 0);
  assert.ok(fs.lstatSync(path.join(direct, 'node_modules', 'lnk')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(target, 'marker.txt')));
  assert.deepEqual(findLink(path.join(scoped), { max: 1 }), { big: true }, 'потолок записей общий');
  for (const l of [path.join(direct, 'node_modules', 'lnk'), path.join(scoped, 'node_modules', '@sc', 'lnk'), path.join(deep, 'node_modules', '@sc', 'real', 'inner')]) dropLink(l);
});

test('копия глубже предела обхода — не кандидат «слишком глубокая»; junction на глубине >6 тоже не кандидат; мелкая копия — кандидат', async () => {
  const target = tmpDir('ext83-deeptgt-');
  fs.writeFileSync(path.join(target, 'marker.txt'), 'm');
  const r = mkRepo();
  const shallow = addWt(r, 'ext-575-shallow', { commits: 1, merge: true });
  const deepWt = addWt(r, 'ext-576-deep', { commits: 1, merge: true });
  const linked = addWt(r, 'ext-577-deeplink', { commits: 1, merge: true });
  const segs = (wt, n) => path.join(wt, ...Array.from({ length: n }, (_, i) => `s${i}`));
  fs.mkdirSync(segs(deepWt, 8), { recursive: true });
  fs.mkdirSync(segs(linked, 8), { recursive: true });
  mkJunction(target, path.join(segs(linked, 8), 'lnk'));
  const { w, writes } = unit(r, { board: boardStub({ 'EXT-575': 'done', 'EXT-576': 'done', 'EXT-577': 'done' }) });
  // пустые каталоги git не показывает — копии «чистые»; решает только обход
  const rows = await w.list();
  assert.equal(rowOf(rows, shallow).eligible, true);
  assert.equal(rowOf(rows, deepWt).reason, 'слишком глубокая — разбери руками');
  // git видит неотслеживаемую ссылку и сам делает копию «не чистой»; в любом случае — не кандидат
  assert.equal(rowOf(rows, linked).eligible, false);
  assert.match(rowOf(rows, linked).reason, /^(не чистая|слишком глубокая)/);
  assert.equal(writes.length, 0);
  assert.ok(fs.existsSync(path.join(target, 'marker.txt')));
  dropLink(path.join(segs(linked, 8), 'lnk'));
});
