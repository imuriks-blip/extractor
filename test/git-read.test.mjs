// Гейт п.7: обёртка git — только читающие команды, всегда --no-optional-locks, проверка до запуска процесса.
// Отрицательный контроль «обёртка с выключенной проверкой → тест красный» снят руками при написании
// (проверка белого списка закомментирована → тесты отказа краснеют) — см. отчёт такта EXT-25.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGit } from './helpers.mjs';

test('обёртка: вызов несёт --no-optional-locks первым и -C <путь>', async () => {
  const f = fakeGit();
  const out = await f.make()('C:/some/repo', ['rev-parse', 'HEAD']);
  assert.equal(out.trim(), 'a'.repeat(40));
  assert.deepEqual(f.calls(), [['--no-optional-locks', '-C', 'C:/some/repo', 'rev-parse', 'HEAD']]);
});

test('обёртка: белый список читающих команд проходит', async () => {
  const f = fakeGit();
  const git = f.make();
  const ok = [['status', '--porcelain'], ['rev-parse', 'HEAD'], ['log', '-1', '--format=%H'],
    ['diff', '--name-only', 'a..b'], ['show', 'HEAD:projects.md'], ['worktree', 'list', '--porcelain']];
  for (const args of ok) await git('C:/r', args);
  // log и show — с принудительными --no-textconv --no-ext-diff сразу после подкоманды
  const NOEXT = ["--no-textconv", "--no-ext-diff"];
  const expected = ok.map(([sub, ...rest]) => (["log", "show"].includes(sub) ? [sub, ...NOEXT, ...rest] : [sub, ...rest]));
  assert.deepEqual(f.calls().map((c) => c.slice(3)), expected);
});

const BAD = [['commit', '-m', 'x'], ['fetch'], ['stash'], ['status'], ['diff', 'a..b'], ['worktree', 'add', 'x'],
  ['log', '--output=C:/x.txt'], ['show', '--output', 'x'], ['diff', '--name-only', '--ext-diff'], [],
  ['-c', 'core.x=1', 'log'], ['log', '--textconv']];
for (const args of BAD) {
  test(`обёртка: ${JSON.stringify(args)} → исключение, подменный git не запускался`, async () => {
    const f = fakeGit();
    await assert.rejects(() => f.make()('C:/r', args), /git-read/);
    assert.deepEqual(f.calls(), []);
  });
}

test('обёртка: счётчик вызовов по репозиториям (для server.log)', async () => {
  const seen = [];
  const f = fakeGit();
  const git = f.make({ onCall: (repo) => seen.push(repo) });
  await git('C:/a', ['rev-parse', 'HEAD']);
  await git('C:/b', ['rev-parse', 'HEAD']);
  assert.deepEqual(seen, ['C:/a', 'C:/b']);
  assert.equal(f.calls().length, 2);
});

test("обёртка: законные флаги чтения после подкоманды (-C у log — поиск копий) проходят", async () => {
  const f = fakeGit();
  await f.make()("C:/r", ["log", "-C", "--format=%H"]);
  assert.deepEqual(f.calls()[0].slice(3), ["log", "--no-textconv", "--no-ext-diff", "-C", "--format=%H"]);
});

// ---------- гейт п.7 за прогон всех читателей (В5) и зрячесть отрицательного контроля ----------
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createRulesMoment } from '../lib/rules-moment.mjs';
import { createCommitsCache } from '../lib/waiting.mjs';
import { createGitReader } from '../lib/git-reader.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { tmpDir, makeBoard, BOARD_LIB } from './helpers.mjs';

// белый список читающих — выписан из спеки 1.2 здесь, не взят из обёртки
const READING = (rest) => {
  const [sub, ...r] = rest;
  if (sub === 'status') return r.includes('--porcelain');
  if (sub === 'diff') return r.includes('--name-only');
  if (sub === 'worktree') return r[0] === 'list';
  return ['rev-parse', 'log', 'show'].includes(sub);
};

test('гейт п.7: каждый вызов git за прогон всех читателей — --no-optional-locks -C <путь> и читающая команда', async () => {
  const f = fakeGit();
  const d = path.dirname(f.env.FAKE_GIT_LOG);
  f.env.FAKE_GIT_WT = path.join(d, 'wt.txt');
  f.env.FAKE_GIT_STATUS = path.join(d, 'st.txt');
  fs.writeFileSync(f.env.FAKE_GIT_WT, 'worktree C:/r1\nHEAD ' + 'a'.repeat(40) + '\nbranch refs/heads/main\n\nworktree C:/r1-wt\nHEAD ' + 'b'.repeat(40) + '\nbranch refs/heads/x\n\n');
  fs.writeFileSync(f.env.FAKE_GIT_STATUS, ' M a.txt\n?? b.txt\n');
  const git = f.make();
  const { parseCard } = await import(pathToFileURL(path.join(BOARD_LIB, 'header.mjs')).href);
  const board = createBoardReader({ root: makeBoard(tmpDir('g7b-'), { codes: ['EXT'] }), git, parseCard });
  await board.init();
  f.setHead('c'.repeat(40)); f.setDiff(['projects.md']);
  await board.refresh();
  const chron = tmpDir('g7c-');
  fs.writeFileSync(path.join(chron, '2026-10.md'), '02.10 · цех · правила обновлены: x · EXT-6 · abc1234\n');
  await createRulesMoment({ dir: chron, git, repos: ['C:/s1'], vaultRepo: 'C:/s1' }).refresh();
  const cc = createCommitsCache({ git, reposOf: () => ['C:/r1'] });
  cc.get({ key: 'k', code: 'EXT', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' });
  await cc.settle();
  const reg = path.join(tmpDir('g7r-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { repos: ['C:/r1', 'C:/board'] } }, board_shared_repos: { repos: ['C:/s1'] } }));
  await createGitReader({ git, registry: createRegistryReader(reg), boardRoot: 'C:/board' }).refresh();

  const calls = f.calls();
  const subs = new Set(calls.map((c) => c[3]));
  for (const s of ['rev-parse', 'diff', 'log', 'worktree', 'status']) assert.ok(subs.has(s), `прогон не дошёл до «${s}»`);
  for (const c of calls) {
    assert.equal(c[0], '--no-optional-locks', JSON.stringify(c));
    assert.equal(c[1], '-C', JSON.stringify(c));
    assert.ok(READING(c.slice(3)), `не читающая команда: ${JSON.stringify(c)}`);
  }
  assert.ok(calls.some((c) => c[2] === 'C:/r1-wt' && c[3] === 'status'), 'status — и у рабочей копии');
});

test('зрячесть отрицательного контроля: обёртка с выключенной проверкой пропускает запрещённое до подменного git', async () => {
  const src = fs.readFileSync(new URL('../lib/git-read.mjs', import.meta.url), 'utf8');
  const cut = src.replace(/^\s*checkArgs\(args\);\r?\n/m, '');
  assert.notEqual(cut, src, 'проверка в обёртке не найдена — тест ослеп');
  const file = path.join(tmpDir('mutant-'), 'git-read-unchecked.mjs');
  fs.writeFileSync(file, cut);
  const { createGitRead: unchecked } = await import(pathToFileURL(file).href);
  for (const args of [['commit', '-m', 'x'], ['fetch'], ['stash']]) {
    const f = fakeGit();
    await unchecked({ bin: process.execPath, prefix: [path.join(import.meta.dirname, 'fake-git.mjs')], env: f.env })('C:/r', args);
    assert.equal(f.calls().length, 1, `${args[0]}: без проверки подменный git запущен — отказной тест выше покраснел бы`);
  }
});
