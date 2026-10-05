// EXT-75, ПТ8, такт 2 (экран): образцы web/fixtures/mirror.json не расходятся с ручкой, чистые подписи кнопки «полный»,
// итога прохода и «Пересобрать индекс» (web/src/mirrorData.js), коды отказов, на которые смотрит экран, — те, что отдаёт сервер.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { secs, runResult, reindexLine, phaseWord, FRESH_MS } from '../web/src/mirrorData.js';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'fixtures', 'mirror.json'), 'utf8'));
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');
const lib = (f) => fs.readFileSync(path.join(ROOT, 'lib', 'pult', f), 'utf8');
const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const PORT = 4317; // только в Host запросов inject; на нём ничего не слушает
const SELF = `http://127.0.0.1:${PORT}`;
const boardDir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
gitInitCommit(boardDir);
const regFile = path.join(tmpDir('reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard });
await board.init();
const registry = createRegistryReader(regFile);

async function server() {
  const web = tmpDir('web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><meta name="vitrina-token" content="__VITRINA_TOKEN__">');
  const boardRoot = tmpDir('mboard-');
  fs.mkdirSync(path.join(boardRoot, 'tools'));
  fs.writeFileSync(path.join(boardRoot, 'tools', 'mirror-hidden.js'), '');
  const calls = [];
  const spawn = () => { calls.push(1); throw new Error('тест не запускает зеркало'); };
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, log: { write() {} },
    pult: { enabled: true, words: true, bell: false, actionsLog: path.join(tmpDir('pult-'), 'actions.log'), mirrorDir: tmpDir('mirror-'), lock: lockLib, boardRoot }, pultSeams: { spawn } });
  const token = (await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } })).body.match(/content="([^"]+)"/)[1];
  const act = (body) => app.inject({ method: 'POST', url: '/api/act', headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token },
    payload: JSON.stringify({ intentId: crypto.randomUUID(), ...body }) });
  const mirror = async () => (await app.inject({ method: 'GET', url: '/api/mirror', headers: { host: `127.0.0.1:${PORT}` } })).json();
  return { act, mirror, calls };
}

test('образцы состояний _states: те же ключи, что у настоящей /api/mirror (и у lastRun, и у reindex)', async () => {
  const { mirror } = await server();
  const real = await mirror();
  const states = Object.entries(fx._states).filter(([k]) => !k.startsWith('_'));
  assert.ok(states.length >= 7, 'покой, обычный и полный идут, итог зелёный и красный, пересбор идёт и сбой');
  for (const [name, s] of states) {
    assert.deepEqual(keys(s), keys(real), name);
    assert.deepEqual(keys(s.reindex), keys(real.reindex), `${name}.reindex`);
    if (s.lastRun) assert.deepEqual(keys(s.lastRun), ['code', 'endedAt', 'kind', 'requests', 'seconds', 'startedAt'], `${name}.lastRun`);
  }
});

test('образец _confirm совпадает с настоящим ответом на первый щелчок «полный» (ключи и цена); запуска нет', async () => {
  const { act, calls } = await server();
  const r = (await act({ action: 'mirror', kind: 'full' })).json();
  assert.deepEqual(keys(fx._confirm), keys(r));
  assert.deepEqual(keys(fx._confirm.confirm), keys(r.confirm));
  assert.equal(fx._confirm.confirm.follows, r.confirm.follows);
  assert.equal(fx._confirm.confirm.what, r.confirm.what);
  assert.equal(calls.length, 0);
});

test('экран знает отказы сервера: «уже идёт» зеркала и пересбора — по коду refusal; потраченное и просроченное подтверждение — «нажми ещё раз»', () => {
  assert.ok(lib('mirror-run.mjs').includes("'mirror-running'"));
  assert.ok(lib('reindex.mjs').includes("'reindex-running'"));
  assert.ok(lib('routes.mjs').includes("'bad-confirm'") && lib('routes.mjs').includes("'confirm-expired'"));
  assert.ok(src('Mirror.jsx').includes("'mirror-running'"), 'Mirror.jsx отличает «уже идёт» от отказа подтверждения');
  assert.ok(src('Service.jsx').includes("'reindex-running'"));
});

test('secs: секунды → «45 с», «8 мин», «1 ч 36 мин», «2 ч»; нет числа — null', () => {
  assert.deepEqual([secs(45), secs(497), secs(5783), secs(7200), secs(null), secs(undefined)], ['45 с', '8 мин', '1 ч 36 мин', '2 ч', null, null]);
});

test('runResult: красный (код не 0) — всегда, с первой строкой lastError; зелёный — только час после конца; нет lastRun — null', () => {
  const end = Date.parse(fx._states.last_red.lastRun.endedAt);
  const now = end + 5 * 60000;
  const red = runResult(fx._states.last_red, now);
  assert.equal(red.red, true);
  assert.match(red.text, /^полный · \d\d:\d\d · красный: проход красный — см\. last-report\.txt$/);
  assert.match(red.title, /1 ч 36 мин/);
  assert.match(red.title, /код 3/);
  assert.equal(runResult(fx._states.last_red, now + 30 * 86400000).red, true, 'красный не стареет: его сменит только удачный проход');
  const green = runResult(fx._states.last_full_green, now);
  assert.equal(green.red, false);
  assert.match(green.text, /^итог · полный · \d\d:\d\d · 1 ч 36 мин · 2231 запросов$/);
  assert.equal(runResult(fx._states.last_full_green, end + FRESH_MS + 1), null, 'старый зелёный не показывается');
  assert.equal(runResult(fx._states.no_runs, now), null);
  assert.equal(runResult({ lastRun: { kind: 'full', endedAt: null, code: null, seconds: null, requests: null } }, now).red, true, 'код неизвестен — не зелёный');
});

test('reindexLine: идёт — «пересобираю: N из M журналов»; готов — время, длительность, число журналов; сбой — красным; нет данных — серым', () => {
  assert.deepEqual(reindexLine(fx._states.reindex_running.reindex), { cls: 'going', text: 'пересобираю: 18 из 40 журналов' });
  assert.equal(reindexLine({ ...fx._states.reindex_running.reindex, done: null, total: null }).text, 'пересобираю…');
  const ready = reindexLine(fx.reindex);
  assert.equal(ready.cls, 'muted');
  assert.match(ready.text, /^пересобран · 05\.10 \d\d:\d\d · 2 мин · 1560 журналов$/);
  assert.deepEqual(reindexLine(fx._states.reindex_failed.reindex), { cls: 'pbad', text: 'не удалось пересобрать: EACCES' });
  assert.equal(reindexLine(null).cls, 'faint');
  assert.equal(reindexLine({ running: false, lastAt: null, lastError: null }).cls, 'faint');
});

test('phaseWord: каждая фаза, которую настоящий mirror.mjs кладёт в status.json progress.phase, имеет русское слово (проба ПТ8: в шапке были «projects», «relations», «write»)', () => {
  const real = fs.readFileSync(`${BOARD_LIB}/../mirror.mjs`, 'utf8');
  const phases = [...new Set([...real.matchAll(/phase: '([a-z]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(phases, ['cards', 'comments', 'projects', 'relations', 'write'], 'набор фаз настоящего прохода');
  for (const p of phases) assert.match(phaseWord(p), /^[а-яё]+$/, p);
  assert.equal(phaseWord('новая-фаза'), 'новая-фаза', 'незнакомая — как есть');
  assert.equal(phaseWord(null), null);
});
