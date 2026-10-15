// Общие помощники тестов: временная доска в живой форме (шапка §1.2 спеки доски, projects.md §1.6).
// Ожидаемые значения в тестах берутся из того, что положено сюда, а не из кода под тестом.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
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

// ---- EXT-112: свои процессы в тестах — без pid ----
// pid Windows раздаёт заново, а снятый taskkill процесс под нагрузкой ещё секунды «жив» по сигналу 0: проверка
// «process.kill(pid, 0) через 300 мс» под полным прогоном лжёт в обе стороны, а снятие «если жив — убить по pid»
// задевает чужой процесс, получивший тот же pid (так падали git init / git add соседних тестов кодом 1 без вывода).
// Свой процесс опознаётся иначе: прямой ребёнок — по своему ChildProcess (событие exit), внук — по каналу-метке.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// имя канала-метки: своё на каждый вызов (pid теста + случайный хвост) — чужой процесс его не держит
export function lifePipe(tag = 'p') {
  return `\\\\.\\pipe\\vitrina-test-${tag}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

// код для `node -e` (CommonJS): держать канал-метку и отвечать своим pid; любой присланный байт — выйти самому
export const lifeCode = (pipe) => `require('net').createServer((s) => { s.on('error', () => {}); s.on('data', () => process.exit(0)); s.write(String(process.pid)); }).listen(${JSON.stringify(pipe)});`;

// канал-метка отвечает: держатель жив. Нет канала — ошибка сразу (ENOENT); канал есть, но занят — считается живым
export function pipeAlive(pipe, ms = 5000) {
  return new Promise((resolve) => {
    const c = net.connect(pipe);
    const end = (v) => { clearTimeout(t); c.destroy(); resolve(v); };
    const t = setTimeout(() => end(true), ms);
    c.once('connect', () => end(true));
    c.once('error', () => end(false));
  });
}

// уборка внука по метке: он выходит сам по байту в канал — ни pid, ни taskkill (чужой процесс задеть нечем)
export function pipeExit(pipe, ms = 5000) {
  return new Promise((resolve) => {
    const c = net.connect(pipe);
    const end = () => { clearTimeout(t); c.destroy(); resolve(); };
    const t = setTimeout(end, ms);
    c.once('connect', () => c.write('x'));
    c.once('error', end);
    c.once('close', end);
  });
}

// ждать условия (в том числе асинхронного) до срока: событие, а не время
export async function untilAsync(fn, ms = 15000, step = 50) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleepMs(step); }
  return !!(await fn());
}

// канал-метка пропал до срока — держатель снят
export const untilPipeGone = (pipe, ms = 15000) => untilAsync(async () => !(await pipeAlive(pipe)), ms);

// свой прямой ребёнок завершился: по его ChildProcess (pid не участвует)
export const exited = (child) => child.exitCode !== null || child.signalCode !== null;
export function untilExit(child, ms = 15000) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.off('exit', on); resolve(exited(child)); }, ms);
    const on = () => { clearTimeout(t); resolve(true); };
    child.once('exit', on);
  });
}

// ---- EXT-112: сервер витрины на свободном порту ----
// Порт выбирает ОС (listen 0 → закрыть). Между выбором и listen витрины порт может занять другой процесс: исходящие
// соединения берут порты того же динамического диапазона (EACCES / EADDRINUSE), чужой слушатель — PORT_FOREIGN,
// витрина параллельного теста — ALREADY_RUNNING. Условие теста «порт свободен» тогда не выполнено — новый порт.
const PORT_RACE = new Set(['EACCES', 'EADDRINUSE', 'PORT_FOREIGN', 'ALREADY_RUNNING']);
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
export async function onFreePort(start, tries = 5) {
  for (let i = 1; ; i++) {
    const port = await freePort();
    try { return { port, s: await start(port) }; } catch (e) { if (i >= tries || !PORT_RACE.has(e?.code)) throw e; }
  }
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
