// В5: читатель git (спека витрины 1.2, 1.4, 2.5, 2.6, 2.7, 2.8) на настоящих временных репозиториях.
// Ожидаемое — из того, что положено в репозитории здесь же (коммиты, рабочие копии, грязные файлы), а не из кода.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createGitReader } from '../lib/git-reader.mjs';
import { createProjectCards } from '../lib/project-cards.mjs';
import { tmpDir, git, gitInitCommit, gitCommitAll } from './helpers.mjs';

const commitEmpty = (dir, msg) => {
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
};

function world() {
  const root = tmpDir('v5git-');
  const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.txt'), n); gitInitCommit(d); return d; };
  const A = mk('proj-a');
  const S = mk('shared-s');
  const B = mk('board-b');
  const h = {};
  h.subj = commitEmpty(A, 'feat: маячок (EXT-29)');
  h.other = commitEmpty(A, 'fix: соседняя EXT-290 и EXT-2');
  h.body = commitEmpty(A, 'refactor: без номера в теме\n\nТело: такт EXT-29, хвост.');
  const WT = path.join(root, 'proj-a-wt');
  git(A, 'worktree', 'add', '-q', '-b', 'ext-29-wt', WT);
  h.wt = commitEmpty(WT, 'wt: коммит из рабочей копии EXT-29');
  fs.writeFileSync(path.join(WT, 'new1.txt'), 'x');
  fs.writeFileSync(path.join(WT, 'a.txt'), 'changed');
  h.shared = commitEmpty(S, 'chronicle: 02.10 · EXT-29');
  fs.writeFileSync(path.join(S, 'd1.txt'), 'x'); fs.writeFileSync(path.join(S, 'd2.txt'), 'x'); fs.writeFileSync(path.join(S, 'd3.txt'), 'x');
  h.board = commitEmpty(B, 'mirror: EXT-29 EXT-30 CAR-1');
  fs.writeFileSync(path.join(B, 'dirty.txt'), 'x');
  const V = path.join(root, 'vault'); fs.mkdirSync(path.join(V, 'unorbis'), { recursive: true });
  const reg = path.join(root, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({
    vault_root: V,
    board_codes: { _comment: 'служебный', EXT: { projects: [], project_cards: ['unorbis/ext.md'], repos: [A, B] }, CAR: { projects: [], project_cards: [], repos: [] } },
    board_shared_repos: { repos: [S] },
  }));
  return { root, A, S, B, WT, V, h, registry: createRegistryReader(reg) };
}
const short = (h) => h.slice(0, 7);
const NO_WATCH = () => { throw new Error('без наблюдателя'); };
const W = world();

async function reader(opts = {}) {
  const calls = [];
  const git = opts.git ?? createGitRead({ onCall: (r) => calls.push(r) });
  // без наблюдателя — опрос по-старому каждый проход (EXT-37); подсказки наблюдателя — test/ext37.test.mjs
  const r = createGitReader({ git, registry: W.registry, boardRoot: W.B, watch: NO_WATCH, ...opts });
  await r.refresh();
  return { r, calls };
}

test('маячок: репозитории проекта и их рабочие копии — имя папки, ветка, число незакоммиченных; общие — не идут', async () => {
  const { r } = await reader();
  const b = r.beacon('EXT');
  assert.equal(b.described, true);
  assert.equal(b.message, null);
  const rows = b.repos.map((x) => [x.name, x.branch, x.dirty]);
  assert.deepEqual(rows, [['proj-a', 'main', 0], ['proj-a-wt', 'ext-29-wt', 2], ['board-b', 'main', 1]]);
  assert.ok(!b.repos.some((x) => x.name === 'shared-s'), 'общий репозиторий в маячок проекта не идёт (1.4)');
  assert.match(b.readAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(b.failingSince, null);
});

test('маячок: код без записи в реестре — «проект не описан в реестре»', async () => {
  const { r } = await reader();
  const b = r.beacon('NEW');
  assert.equal(b.described, false);
  assert.equal(b.message, 'проект не описан в реестре');
  assert.deepEqual(b.repos, []);
});

test('коммиты карточки: тема или тело, репозитории проекта, рабочие копии и общие; без доски; граница номера; каждый раз', async () => {
  const { r } = await reader();
  const c = r.commitsFor('EXT-29');
  const got = c.commits.map((x) => x.hash).sort();
  assert.deepEqual(got, [W.h.subj, W.h.body, W.h.wt, W.h.shared].map(short).sort());
  assert.ok(!got.includes(short(W.h.board)), 'репозиторий доски исключён');
  assert.ok(!got.includes(short(W.h.other)), 'EXT-290 и EXT-2 — не EXT-29');
  const wt = c.commits.find((x) => x.hash === short(W.h.wt));
  assert.equal(wt.subject, 'wt: коммит из рабочей копии EXT-29');
  assert.equal(wt.repo, 'proj-a');
  assert.equal(wt.branch, 'ext-29-wt');
  assert.match(wt.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(c.commits.find((x) => x.hash === short(W.h.shared)).repo, 'shared-s');
  assert.equal(r.commitsFor('EXT-2').commits.map((x) => x.hash).join(), short(W.h.other));
});

test('git не зовётся на запрос: маячок и коммиты — из прохода опроса', async () => {
  const { r, calls } = await reader();
  const n = calls.length;
  assert.ok(n > 0);
  for (let i = 0; i < 5; i++) { r.beacon('EXT'); r.commitsFor('EXT-29'); }
  assert.equal(calls.length, n);
});

test('ошибка git: прежние данные остаются, failingSince — с первого сбоя, readAt не двигается', async () => {
  let broken = false;
  const real = createGitRead();
  let t = Date.parse('2026-10-02T10:00:00Z');
  const now = () => t;
  const git = (repo, args) => (broken ? Promise.reject(Object.assign(new Error('x'), { code: 'EBUSY' })) : real(repo, args));
  const { r } = await reader({ git, now });
  const okAt = r.beacon('EXT').readAt;
  broken = true; t += 30000;
  await r.refresh();
  t += 30000;
  await r.refresh();
  const b = r.beacon('EXT');
  assert.equal(b.repos.length, 3, 'прежние строки маячка');
  assert.equal(b.readAt, okAt);
  assert.equal(b.failingSince, '2026-10-02T10:00:30.000Z');
  const c = r.commitsFor('EXT-29');
  assert.equal(c.commits.length, 4, 'прежние коммиты');
  assert.equal(c.failingSince, '2026-10-02T10:00:30.000Z');
  assert.ok(r.state().errors >= 1);
  broken = false; t += 30000;
  await r.refresh();
  assert.equal(r.beacon('EXT').failingSince, null);
});

test('карточка проекта: фаза и следующий шаг — целиком (без обрезки), первый путь project_cards; нет файла — null', () => {
  const long = 'Этап 1: витрина. ' + 'Очень длинная фаза с «кавычками» и \\"экраном\\". '.repeat(5);
  fs.writeFileSync(path.join(W.V, 'unorbis', 'ext.md'), `---\ntype: project\nphase: "${long}"\npriority: high\nnext_action: Такт В5 — маячок\n---\n\n# Тело\nphase: не это\n`);
  const pc = createProjectCards({ registry: W.registry });
  const p = pc.get('EXT');
  assert.equal(p.phase, long.replace(/\\"/g, '"'));
  assert.ok(p.phase.length > 90);
  assert.equal(p.next, 'Такт В5 — маячок');
  assert.deepEqual(pc.get('CAR'), { phase: null, next: null });
  assert.equal(pc.get('NEW'), null);
});
