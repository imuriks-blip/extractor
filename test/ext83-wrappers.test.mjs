// EXT-83, ПТ8б: белые списки git по ФОРМЕ вызова — читающая обёртка (спека пульта §0, Н5) и пишущая (§1.5).
// Подменный git (test/fake-git.mjs) пишет каждый запуск в журнал: «не запускался» = журнал пуст. Ожидания — выписаны здесь, не из обёрток.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitWrite } from '../lib/git-write.mjs';
import { checkArgs } from '../lib/git-read.mjs';
import { fakeGit, tmpDir } from './helpers.mjs';

const FAKE = path.join(import.meta.dirname, 'fake-git.mjs');
const writer = (f, opts = {}) => createGitWrite({ bin: process.execPath, prefix: [FAKE], env: f.env, ...opts });

// ---------- читающая ----------
const READ_BAD = [['reflog', 'expire', '--all'], ['reflog', 'delete', 'x@{0}'], ['reflog', 'show', 'x', 'y'], ['reflog', 'show'], ['reflog', 'show', '--output=x'],
  ['reflog', 'show', '-n', 'x'], ['reflog'], ['reflog', 'x'],
  ['branch', '-D', 'x'], ['branch', 'newname'], ['log', '--output=x'], ['show', '--output=x'], ['show', '--output', 'x'],
  ['worktree', 'add', 'x'], ['worktree', 'remove', 'x'], ['worktree', 'prune'], ['worktree', 'list', '--porcelain', 'x'], ['worktree', 'list', '-z'], ['worktree'],
  ['status', '--porcelain', '--ignored', 'x'], ['status', '--porcelain', '-uall'], ['status', '--porcelain', '-uno'], ['status', '--porcelain', '--untracked-files=no'], ['status', '--porcelain', '--untracked-files=all'],
  ['status', '--porcelain', '--untracked-files=normal', '--untracked-files=normal'], ['status', '--porcelain', '--ignored', '--untracked-files=normal', 'x'], ['status', '--ignored'], ['status']];
for (const args of READ_BAD) {
  test(`чтение: ${JSON.stringify(args)} → исключение, подменный git не запускался`, async () => {
    const f = fakeGit();
    await assert.rejects(() => f.make()('C:/r', args), /git-read/);
    assert.deepEqual(f.calls(), []);
  });
}

test('чтение: исправные формы проходят и доходят до git с --no-optional-locks -C', async () => {
  const f = fakeGit();
  const g = f.make();
  const ok = [['reflog', 'show', 'ext-83-x'], ['branch', '--list', 'ext-*', '--format=%(refname:short)'], ['worktree', 'list', '--porcelain'], ['worktree', 'list'],
    ['status', '--porcelain', '--ignored'], ['status', '--porcelain', '--ignored', '--untracked-files=normal'], ['status', '--porcelain', '--untracked-files=normal'], ['reflog', 'show', 'refs/heads/x'], ['status', '--porcelain'], ['merge-base', '--is-ancestor', 'a', 'b']];
  for (const a of ok) await g('C:/r', a);
  assert.deepEqual(f.calls().map((c) => c.slice(0, 3)), ok.map(() => ['--no-optional-locks', '-C', 'C:/r']));
  assert.deepEqual(f.calls().map((c) => c.slice(3)), ok);
  checkArgs(['reflog', 'show', 'x']);
});

// ---------- пишущая ----------
const WRITE_BAD = [['worktree', 'remove', '--force', 'C:/wt'], ['worktree', 'remove', 'C:/wt', '--force'], ['worktree', 'remove', '-f', 'C:/wt'], ['worktree', 'remove', '-f', '-f', 'C:/wt'],
  ['worktree', 'remove', 'C:/wt', 'extra'], ['worktree', 'remove'], ['worktree', 'remove', '--lock'], ['worktree', 'remove', ''],
  ['branch', '-D', 'x'], ['worktree', 'add', 'C:/wt', 'b'], ['reset', '--hard'], ['commit', '-m', 'x'], ['worktree', 'prune', '--expire=now'], ['worktree', 'prune', '-n'],
  ['worktree', 'list'], ['worktree', 'lock', 'C:/wt'], ['push'], ['status', '--porcelain'], [], ['worktree', 'remove', 5]];
for (const args of WRITE_BAD) {
  test(`запись: ${JSON.stringify(args)} → исключение, подменный git не запускался`, async () => {
    const f = fakeGit();
    await assert.rejects(() => writer(f)('C:/r', args), /git-write/);
    assert.deepEqual(f.calls(), []);
  });
}

test('запись: две исправные формы проходят и зовут git с -C <репозиторий>; onCall видит вызов', async () => {
  const f = fakeGit();
  const seen = [];
  const w = writer(f, { onCall: (repo, args) => seen.push([repo, ...args]) });
  await w('C:/main', ['worktree', 'remove', 'C:/main-wt']);
  await w('C:/main', ['worktree', 'prune']);
  assert.deepEqual(f.calls(), [['-C', 'C:/main', 'worktree', 'remove', 'C:/main-wt'], ['-C', 'C:/main', 'worktree', 'prune']]);
  assert.deepEqual(seen, [['C:/main', 'worktree', 'remove', 'C:/main-wt'], ['C:/main', 'worktree', 'prune']]);
  await assert.rejects(() => w('', ['worktree', 'prune']), /git-write/);
});

test('запись: путь репозитория не строка/пуст → исключение до запуска', async () => {
  const f = fakeGit();
  await assert.rejects(() => writer(f)(undefined, ['worktree', 'prune']), /git-write/);
  assert.deepEqual(f.calls(), []);
});

// зрячесть отрицательного контроля: без проверки запрещённое доходит до подменного git (и тогда тесты выше краснели бы)
for (const [name, file] of [['запись', '../lib/git-write.mjs'], ['чтение', '../lib/git-read.mjs']]) {
  test(`зрячесть контроля (${name}): обёртка с вырезанной проверкой пропускает запрещённое до подменного git`, async () => {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const cut = src.replace(/^\s*check(?:Write)?Args\(args\);\r?\n/m, '');
    assert.notEqual(cut, src, 'проверка не найдена — тест ослеп');
    const p = path.join(tmpDir('ext83-mutant-'), path.basename(file));
    fs.writeFileSync(p, cut);
    const mod = await import(pathToFileURL(p).href);
    const f = fakeGit();
    const make = mod.createGitWrite ?? mod.createGitRead;
    await make({ bin: process.execPath, prefix: [FAKE], env: f.env })('C:/r', name === 'запись' ? ['worktree', 'remove', '--force', 'C:/wt'] : ['reflog', 'expire', '--all']);
    assert.equal(f.calls().length, 1, 'без проверки git запущен — отказные тесты выше покраснели бы');
  });
}
