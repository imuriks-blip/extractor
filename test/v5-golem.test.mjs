// В5, вердикт Голема (EXT-29): опрос git без лишнего log, сбойная рабочая копия, журнал карточки и карточка проекта
// при ошибке чтения (2.7), ключ счёта вызовов git (Г3), обрезка текста по символам. Ожидаемое — из данных этого файла.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGitRead } from '../lib/git-read.mjs';
import { createGitStats } from '../lib/git-stats.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createGitReader } from '../lib/git-reader.mjs';
import { createProjectCards, brief } from '../lib/project-cards.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { BOARD_LIB, tmpDir, git, gitInitCommit, makeBoard } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const commit = (dir, msg) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg);

function repoWorld() {
  const root = tmpDir('v5g-');
  const A = path.join(root, 'proj'); fs.mkdirSync(A); fs.writeFileSync(path.join(A, 'a.txt'), 'a'); gitInitCommit(A);
  commit(A, 'feat: один (EXT-29)');
  const WT = path.join(root, 'proj-wt');
  git(A, 'worktree', 'add', '-q', '-b', 'side', WT);
  const reg = path.join(root, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [A] } } }));
  const calls = [];
  const real = createGitRead();
  const g = (repo, args) => { calls.push(args[0]); return real(repo, args); };
  return { A, WT, calls, reader: createGitReader({ git: g, registry: createRegistryReader(reg), boardRoot: null }) };
}

test('опрос git: вершины не сменились — log не зовётся, коммиты прежние; новая вершина — log есть', async () => {
  const w = repoWorld();
  await w.reader.refresh();
  const logs = () => w.calls.filter((c) => c === 'log').length;
  assert.equal(logs(), 1);
  assert.ok(w.calls.includes('rev-parse'), 'перед log — rev-parse --all');
  await w.reader.refresh();
  await w.reader.refresh();
  assert.equal(logs(), 1, 'вершины те же — log пропущен');
  assert.equal(w.reader.state().logSkipped, 2);
  assert.equal(w.reader.commitsFor('EXT-29').commits.length, 1);
  commit(w.A, 'feat: два (EXT-29)');
  await w.reader.refresh();
  assert.equal(logs(), 2, 'новая вершина — log');
  assert.equal(w.reader.commitsFor('EXT-29').commits.length, 2);
  assert.ok(Number.isFinite(w.reader.state().firstPassMs) && Number.isFinite(w.reader.state().lastPassMs));
});

test('сбойная рабочая копия (не prunable): её строка — dirty null и error; репозиторий и его лента обновляются', async () => {
  const w = repoWorld();
  await w.reader.refresh();
  fs.rmSync(path.join(w.WT, '.git'), { force: true }); // скрытый файл Windows не перезаписывается — удалить и написать
  fs.writeFileSync(path.join(w.WT, '.git'), 'gitdir: C:/нет/такого/каталога\n'); // папка есть, git в ней не читается
  commit(w.A, 'feat: после поломки (EXT-29)');
  await w.reader.refresh();
  const b = w.reader.beacon('EXT');
  const bad = b.repos.find((r) => r.name === 'proj-wt');
  assert.equal(bad.dirty, null);
  assert.ok(bad.error, 'у строки копии — ошибка');
  assert.equal(b.repos.find((r) => r.name === 'proj').dirty, 0);
  assert.equal(b.failingSince, null, 'репозиторий не заморожен');
  assert.equal(w.reader.commitsFor('EXT-29').commits.length, 2, 'лента репозитория обновилась');
});

test('журнал карточки: удачное чтение → EBUSY → комменты прежние, logError стоит (2.7)', async () => {
  const dir = makeBoard(tmpDir('v5gb-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', title: 'Т' }] });
  gitInitCommit(dir);
  let busy = false;
  const logFile = path.join(dir, 'EXT', 'EXT-1.log.md');
  const spy = { ...fs, readFileSync: (p, ...a) => { if (busy && path.resolve(String(p)) === path.resolve(logFile)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.readFileSync(p, ...a); } };
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest, fs: spy });
  await board.init();
  const ok = board.readLog('EXT-1');
  assert.equal(ok.entries.length, 1);
  assert.equal(ok.error, null);
  fs.appendFileSync(logFile, '### 2026-09-26 10:00 +03:00 · plane · коммент\n\nещё\n\n');
  const t = new Date(Date.now() + 5000); fs.utimesSync(logFile, t, t);
  busy = true;
  const r = board.readLog('EXT-1');
  assert.equal(r.error, 'EBUSY');
  assert.deepEqual(r.entries, ok.entries, 'прежние записи, не пустота');
});

test('Г3: один репозиторий под разными написаниями пути — один ключ счёта', () => {
  const s = createGitStats(() => Date.parse('2026-10-02T12:00:00Z'));
  s.onCall('C:/projects/x');
  s.onCall('C:\\projects\\x');
  s.onCall('c:\\Projects\\X\\');
  assert.deepEqual(s.snapshot(), { 'c:\\projects\\x': { total: 3, peakPerMin: 3 } });
});

test('обрезка по символам: эмодзи на месте разреза не рвётся (90 знаков «Цеха»)', () => {
  const text = 'а'.repeat(88) + '📱' + 'б'.repeat(10) + '.';
  const b = brief(text);
  assert.equal([...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(b.short)].length, 90);
  assert.ok(b.short.endsWith('📱…'), b.short.slice(-4));
  assert.doesNotMatch(b.short, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'нет одинокой половины суррогатной пары');
  const flag = brief('б'.repeat(89) + '❤️' + 'в'.repeat(5));
  assert.ok(!flag.short.includes('\uFE0F') || flag.short.includes('❤️'), 'вариационный селектор не отрезан от сердца');
});

test('карточка проекта: ошибка чтения — прежние фаза и шаг плюс failingSince (2.7)', () => {
  const root = tmpDir('v5gp-');
  const V = path.join(root, 'vault'); fs.mkdirSync(path.join(V, 'u'), { recursive: true });
  const card = path.join(V, 'u', 'p.md');
  fs.writeFileSync(card, '---\nphase: "Фаза один."\nnext_action: Шаг.\n---\n');
  const reg = path.join(root, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ vault_root: V, board_codes: { EXT: { project_cards: ['u/p.md'], repos: [] } } }));
  let busy = false;
  const spy = { ...fs, readFileSync: (p, ...a) => { if (busy && path.resolve(String(p)) === path.resolve(card)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.readFileSync(p, ...a); } };
  const pc = createProjectCards({ registry: createRegistryReader(reg), fs: spy });
  const ok = pc.get('EXT');
  assert.equal(ok.phase, 'Фаза один.');
  assert.equal(ok.failingSince, null);
  assert.match(ok.readAt, /^\d{4}-/);
  fs.writeFileSync(card, '---\nphase: "Фаза два."\n---\n');
  const t = new Date(Date.now() + 5000); fs.utimesSync(card, t, t);
  busy = true;
  const r = pc.get('EXT');
  assert.equal(r.phase, 'Фаза один.');
  assert.equal(r.next, 'Шаг.');
  assert.match(r.failingSince, /^\d{4}-/);
  assert.equal(r.readAt, ok.readAt);
});
