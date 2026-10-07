// EXT-83: общая обвязка тестов уборки рабочих копий — временные репозитории в os.tmpdir (git init, коммиты, `git worktree add`) и стенд витрины.
// Настоящие копии машины (C:/projects/extractor*) не трогаются.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createGitWrite } from '../lib/git-write.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons } from '../lib/pult/worktrees.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

void Fastify;
const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);

const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const DAY = 86400000;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 83000;
const nextIntent = () => uuid(++intents);

// ---------- временные репозитории ----------
const G = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', windowsHide: true });
const fwd = (p) => p.replace(/\\/g, '/');
let nWt = 0;
function mkRepo(name = 'main') {
  const root = tmpDir('ext83-');
  const main = path.join(root, name);
  fs.mkdirSync(main);
  G(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\ndist/\n.env\ndata/\n');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  G(main, 'add', '.');
  G(main, 'commit', '-q', '-m', 'init');
  return { root, main };
}
// копия: ветка от main; commits — свои коммиты; merge — слить в main; amend — единственный «коммит» ветки — commit --amend
function addWt(r, branch, { commits = 0, merge = false, amend = false } = {}) {
  const wt = path.join(r.root, `wt${++nWt}-${branch}`);
  G(r.main, 'worktree', 'add', '-q', '-b', branch, wt);
  for (let i = 0; i < commits; i++) {
    G(wt, 'commit', '-q', '--allow-empty', '-m', `${branch} ${i}`); // одна команда: git здесь медленный
  }
  if (amend) G(wt, 'commit', '-q', '--amend', '--allow-empty', '-m', 'amended');
  if (merge) G(r.main, 'merge', '-q', '--no-edit', branch);
  return wt;
}
const listPaths = (main) => G(main, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => fwd(l.slice(9)));
const branchesOf = (main) => G(main, 'branch', '--list', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean).sort();
const regStub = (...repos) => ({ get: () => ({ codes: [{ code: 'EXT', repos }] }) });
const boardStub = (m) => ({ card: (id) => (m[id] ? { status: m[id] } : null) });
const emptySessions = () => tmpDir('ext83-sess-');
const rowOf = (rows, wt) => rows.find((x) => path.resolve(x.path).toLowerCase() === path.resolve(wt).toLowerCase());

function unit(r, over = {}) {
  const writes = [];
  const gw = createGitWrite({ onCall: (repo, args) => writes.push([repo, ...args]) });
  const w = createWorktrees({ registry: regStub(r.main), board: boardStub({}), git: createGitRead(), gitWrite: gw, sessionsDir: emptySessions(), ...over });
  return { w, writes };
}

// ---------- шесть копий ----------
async function six() {
  const r = mkRepo();
  const wts = {
    done: addWt(r, 'ext-501-done', { commits: 1, merge: true }),
    fresh: addWt(r, 'ext-502-fresh'),
    dirty: addWt(r, 'ext-503-dirty', { commits: 1, merge: true }),
    unmerged: addWt(r, 'ext-504-unmerged', { commits: 1 }),
    env: addWt(r, 'ext-505-env', { commits: 1, merge: true }),
    locked: addWt(r, 'ext-506-locked', { commits: 1, merge: true }),
  };
  fs.writeFileSync(path.join(wts.dirty, 'new.txt'), 'x');
  fs.writeFileSync(path.join(wts.env, '.env'), 'SECRET=1');
  G(r.main, 'worktree', 'lock', wts.locked);
  const status = { 'EXT-501': 'done', 'EXT-502': 'in-progress', 'EXT-503': 'done', 'EXT-504': 'done', 'EXT-505': 'cancelled', 'EXT-506': 'done' };
  return { r, wts, status };
}

// ---------- ссылки ----------
const mkJunction = (target, link) => fs.symlinkSync(target, link, 'junction');
const dropLink = (link) => { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } }; // саму ссылку, не рекурсивно

// ---------- действие: второй щелчок ----------
async function harness({ withCar = false, clock = { t: Date.now() }, gw = null, sessions = emptySessions(), isAlive = undefined } = {}) {
  // малый набор: годная (done), свежая без коммитов (fresh), грязная (dirty); «шесть копий» — отдельный тест выше
  const r = mkRepo();
  const wts = { done: addWt(r, 'ext-501-done', { commits: 1, merge: true }), fresh: addWt(r, 'ext-502-fresh'), dirty: addWt(r, 'ext-503-dirty', { commits: 1, merge: true }) };
  fs.writeFileSync(path.join(wts.dirty, 'new.txt'), 'x');
  const s = { r, wts, status: { 'EXT-501': 'done', 'EXT-502': 'in-progress', 'EXT-503': 'done' } };
  const car = mkRepo('carmain');
  const carWt = withCar ? addWt(car, 'car-1-done', { commits: 1, merge: true }) : null;
  const extraRepos = [];
  const boardDir = makeBoard(tmpDir('ext83-board-'), { codes: ['EXT', 'CAR'],
    cards: [...Object.entries(s.status).map(([id, st]) => ({ id, status: st })), { id: 'CAR-1', status: 'done' }] });
  gitInitCommit(boardDir);
  const regFile = path.join(tmpDir('ext83-reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { repos: [s.r.main, ...extraRepos] }, CAR: { repos: [car.main] } } }));
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const birth = new Map(); // создание папки копии: путь → мс; нет записи — только что
  const writes = [];
  const base = createGitWrite({ onCall: (repo, args) => writes.push([fwd(repo), ...args.map((a, i) => (i === 2 ? fwd(a) : a))]) });
  const gitWrite = gw ? gw(base) : base;
  const web = tmpDir('ext83-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const data = tmpDir('ext83-data-');
  const actionsLog = path.join(data, 'actions.log');
  const app = await buildApp({ port: PORT, board, registry: createRegistryReader(regFile), scan, webDir: web, git: createGitRead(), gitWrite, sessionsDir: sessions,
    pult: { enabled: true, words: true, actionsLog, boardRoot: boardDir },
    pultSeams: { now: () => clock.t, worktrees: { birthOf: (p) => birth.get(fwd(p)) ?? Date.now(), ...(isAlive ? { isAlive } : {}) } } });
  const r0 = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r0.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const hdr = { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token };
  const press = (body, action = 'cleanup') => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), action, ...body }), headers: hdr });
  const get = (url) => app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } });
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const removes = () => writes.filter((w) => w[1] === 'worktree' && w[2] === 'remove');
  return { ...s, car, carWt, app, press, get, lines, writes, removes, clock, birth };
}

export { PORT, SELF, DAY, nextIntent, G, fwd, mkRepo, addWt, listPaths, branchesOf, regStub, boardStub, emptySessions, rowOf, unit, six, harness, mkJunction, dropLink, createWorktrees, findLink, hasOwnCommits, reflogMessages, cardOfBranch, parseStatus, groupReasons, createGitRead, createGitWrite, tmpDir };
