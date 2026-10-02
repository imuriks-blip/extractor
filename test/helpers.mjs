// Общие помощники тестов: временная доска в живой форме (шапка §1.2 спеки доски, projects.md §1.6).
// Ожидаемые значения в тестах берутся из того, что положено сюда, а не из кода под тестом.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGitRead } from '../lib/git-read.mjs';

export const BOARD_LIB = 'C:/projects/unorbis-board/tools/lib';
export const FAKE_GIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-git.mjs');

export function tmpDir(prefix = 'vitrina-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cardText({ id, status = 'backlog', title = 'Карточка', body = '', markB = false, updated = '2026-09-30T12:00+03:00', parent = '', blocks = [], blockedBy = [], relates = [], labels = ['terminus'] }) {
  const l = (a) => `[${a.join(', ')}]`;
  return [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    'priority: medium',
    `labels: ${l(labels)}`,
    'owner: ""',
    `mark_b: ${markB}`,
    `parent:${parent ? ' ' + parent : ''}`,
    `blocks: ${l(blocks)}`,
    `blocked_by: ${l(blockedBy)}`,
    `relates: ${l(relates)}`,
    'spec: ""',
    'created: 2026-09-25T15:20+03:00',
    `updated: ${updated}`,
    '---',
    '',
    body,
  ].join('\n');
}

export function projectsMd(codes) {
  return [
    '# Проекты и лейблы доски',
    '',
    '| код | имя | статус |',
    '|---|---|---|',
    ...codes.map((c) => `| ${c} | имя-${c.toLowerCase()} | active |`),
    '',
    '| лейбл | смысл |',
    '|---|---|',
    '| terminus | Терминус |',
    '| ZZZ | не код: таблица лейблов |',
    '',
  ].join('\n');
}

// cards: [{id, status, title, body}] — файл <КОД>/<ID>.md; журнал рядом — чтобы читатель его не принял за шапку.
export function makeBoard(dir, { codes, cards = [] }) {
  fs.writeFileSync(path.join(dir, 'projects.md'), projectsMd(codes));
  fs.writeFileSync(path.join(dir, 'board.config.json'), '{"mode":"mirror","push":false,"tz":"Europe/Riga"}\n');
  for (const c of codes) fs.mkdirSync(path.join(dir, c), { recursive: true });
  for (const card of cards) writeCard(dir, card);
  return dir;
}

export function writeCard(dir, card) {
  const code = card.id.split('-')[0];
  fs.writeFileSync(path.join(dir, code, `${card.id}.md`), cardText(card));
  fs.writeFileSync(path.join(dir, code, `${card.id}.log.md`), '### 2026-09-25 14:03 +03:00 · plane · ▶\n\n▶ выдан: terminus · status: review\n\n');
}

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

export function gitInitCommit(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  return gitCommitAll(dir, 'init');
}

export function gitCommitAll(dir, msg = 'next') {
  git(dir, '-c', 'core.autocrlf=false', 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

// fs-обёртка со счётчиком чтений: проверка «чтения файла не было» (гейт п.1).
export function spyFs() {
  const calls = [];
  const wrap = (name) => (...a) => { calls.push({ name, path: String(a[0]) }); return fs[name](...a); };
  return {
    calls,
    readFileSync: wrap('readFileSync'),
    readdirSync: wrap('readdirSync'),
    existsSync: wrap('existsSync'),
    statSync: wrap('statSync'),
  };
}

// Подменный git (гейт п.7): своё окружение на каждый тест, журнал аргументов.
export function fakeGit() {
  const d = tmpDir('fakegit-');
  const env = { FAKE_GIT_LOG: path.join(d, 'calls.log'), FAKE_GIT_HEAD: path.join(d, 'head.txt'), FAKE_GIT_DIFF: path.join(d, 'diff.txt') };
  fs.writeFileSync(env.FAKE_GIT_HEAD, 'a'.repeat(40) + '\n');
  fs.writeFileSync(env.FAKE_GIT_DIFF, '');
  const calls = () => (fs.existsSync(env.FAKE_GIT_LOG)
    ? fs.readFileSync(env.FAKE_GIT_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const setHead = (h) => fs.writeFileSync(env.FAKE_GIT_HEAD, h + '\n');
  const setDiff = (lines) => fs.writeFileSync(env.FAKE_GIT_DIFF, lines.join('\n') + '\n');
  const make = (opts = {}) => createGitRead({ bin: process.execPath, prefix: [FAKE_GIT], env, ...opts });
  return { env, calls, setHead, setDiff, make };
}
