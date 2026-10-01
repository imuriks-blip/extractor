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
  assert.deepEqual(f.calls().map((c) => c.slice(3)), ok);
});

const BAD = [['commit', '-m', 'x'], ['fetch'], ['stash'], ['status'], ['diff', 'a..b'], ['worktree', 'add', 'x'],
  ['log', '--output=C:/x.txt'], ['show', '--output', 'x'], ['diff', '--name-only', '--ext-diff'], [],
  ['-c', 'core.x=1', 'log'], ['log', '--textconv'], ['rev-parse', '-C', 'x']];
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
