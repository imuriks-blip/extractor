// В6 (EXT-30), серверная часть: раздача собранной статики web/dist (1.1), снятие markdown в строках «Ждёт меня» (а),
// у обрыва PARTIAL и записи субагента (2.4, 2.3), failingSince у свежести доски и журналов (2.7), падежи имени
// агента у такта. Ожидаемые значения — из данных, положенных в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildApp } from '../lib/app.mjs';
import { distPath } from '../lib/web-static.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { waitingThreads, buildMarks } from '../lib/waiting.mjs';
import { newSessionState, feedSession, newAgentState, feedAgent, agentSummary } from '../lib/journal-parse.mjs';
import * as text from '../lib/text.mjs';

const stripMarkdown = (s) => text.stripMarkdown(s);
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, spyFs } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const PORT = 4317;
const H = { host: `127.0.0.1:${PORT}` };
const T0 = Date.parse('2026-10-02T10:00:00Z');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

// ---------- статика web/dist (1.1) ----------

const STUB_BOARD = { state: () => ({ lastOkAt: null }), hasCode: () => false, codes: () => [], cardsList: () => [] };
const STUB_REG = { state: () => ({}), get: () => ({ codes: [] }) };
const CANARY = 'КАНАРЕЙКА-вне-dist';

function dist() {
  const top = tmpDir('web-');
  const root = path.join(top, 'dist');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fonts'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Цех</title>');
  fs.writeFileSync(path.join(root, 'theme-init.js'), 'document.documentElement.dataset.t="1";');
  fs.writeFileSync(path.join(root, 'assets', 'index-DlhUvg85.js'), 'console.log("цех")');
  fs.writeFileSync(path.join(root, 'assets', 'index-DpygJKng.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'assets', 'ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  fs.writeFileSync(path.join(root, 'assets', 'plain.js'), '1');
  fs.writeFileSync(path.join(root, 'fonts', 'x.woff'), Buffer.from([1, 2]));
  fs.writeFileSync(path.join(top, 'secret.txt'), CANARY);
  return { top, root };
}

async function staticApp(webDir, webFs) {
  return buildApp({ port: PORT, board: STUB_BOARD, registry: STUB_REG, scan, webDir, webFs });
}

test('статика: GET / — index.html без кэша; /theme-init.js — без кэша; файл assets с хешем — надолго', async () => {
  const { root } = dist();
  const app = await staticApp(root);
  const r = await app.inject({ method: 'GET', url: '/', headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, '<!doctype html><title>Цех</title>');
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  const ix = await app.inject({ method: 'GET', url: '/index.html', headers: H });
  assert.equal(ix.headers['cache-control'], 'no-store');
  const th = await app.inject({ method: 'GET', url: '/theme-init.js', headers: H });
  assert.equal(th.statusCode, 200);
  assert.equal(th.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(th.headers['cache-control'], 'no-store');
  const js = await app.inject({ method: 'GET', url: '/assets/index-DlhUvg85.js', headers: H });
  assert.equal(js.statusCode, 200);
  assert.equal(js.body, 'console.log("цех")');
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
  const css = await app.inject({ method: 'GET', url: '/assets/index-DpygJKng.css', headers: H });
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  const font = await app.inject({ method: 'GET', url: '/assets/ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2', headers: H });
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.deepEqual([...font.rawPayload], [0x77, 0x4f, 0x46, 0x32]);
  assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
  const plain = await app.inject({ method: 'GET', url: '/assets/plain.js', headers: H });
  assert.equal(plain.headers['cache-control'], 'no-cache', 'без хеша в имени — не надолго');
  const fw = await app.inject({ method: 'GET', url: '/fonts/x.woff', headers: H });
  assert.equal(fw.statusCode, 200);
  assert.equal(fw.headers['content-type'], 'font/woff');
});

// Сырые пути — как их шлёт curl --path-as-is: inject нормализует URL (%2e%2e → ..), поэтому обход проверяется
// и чистой функцией, и настоящим HTTP-запросом без нормализации.
const RAW = ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/assets/..%5c..%5csecret.txt',
  '/assets/%2E%2E/%2E%2E/secret.txt', '/..\\secret.txt', '/%5c..%5csecret.txt', '/C:%5cWindows%5cwin.ini', '/%00index.html', '/assets/../../secret.txt', '/.env', '/assets/', '/assets//x.js'];

test('статика: обход пути — разбор пути отвергает до диска (.., %2e%2e, %5c, обратная косая, точка в начале)', () => {
  for (const url of RAW) assert.equal(distPath(url), null, url);
  assert.equal(distPath('/'), 'index.html');
  assert.equal(distPath('/assets/index-DlhUvg85.js?v=1'), 'assets/index-DlhUvg85.js');
});

test('статика: обход пути настоящим HTTP — 404 без единого обращения к диску; каталог и нет файла — 404 без чтения вне dist', async () => {
  const { root } = dist();
  const spy = spyFs();
  const app = await staticApp(root, spy);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const get = (p) => new Promise((ok, no) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: H }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    rq.on('error', no); rq.end();
  });
  try {
    for (const url of RAW) {
      spy.calls.length = 0;
      const r = await get(url);
      assert.equal(r.status, 404, url);
      assert.notEqual(r.body, CANARY, url);
      assert.deepEqual(spy.calls, [], `${url}: диск не трогается`);
    }
    // битое %-кодирование: Fastify отвечает 400 до маршрута — тоже без диска
    spy.calls.length = 0;
    assert.equal((await get('/%E0%A4%A')).status, 400);
    assert.deepEqual(spy.calls, []);
    for (const url of ['/assets', '/net.js', '/fonts']) {
      spy.calls.length = 0;
      assert.equal((await get(url)).status, 404, url);
      for (const c of spy.calls) assert.ok(path.resolve(c.path).startsWith(path.resolve(root) + path.sep), `${url}: чтение вне dist — ${c.path}`);
    }
    assert.equal((await get('/')).status, 200, 'исправный рядом');
  } finally { await app.close(); }
});

test('статика: Host evil.example → 421 и на «/»; не GET → 405; /api/* не перекрыт', async () => {
  const { root } = dist();
  const app = await staticApp(root);
  for (const url of ['/', '/assets/index-DlhUvg85.js']) {
    const r = await app.inject({ method: 'GET', url, headers: { host: 'evil.example' } });
    assert.equal(r.statusCode, 421, url);
    assert.equal(r.body, '');
  }
  assert.equal((await app.inject({ method: 'POST', url: '/', headers: H })).statusCode, 405);
  const h = await app.inject({ method: 'GET', url: '/api/health', headers: H });
  assert.equal(h.statusCode, 200);
  assert.equal(h.json().ok, true);
  const nope = await app.inject({ method: 'GET', url: '/api/nope', headers: H });
  assert.equal(nope.statusCode, 404);
  assert.equal(nope.body, '');
});

test('статика: нет dist — 503 «интерфейс не собран», ручки живы; появился dist — отдаётся без рестарта', async () => {
  const { top, root } = dist();
  const gone = path.join(top, 'нет-dist');
  const app = await staticApp(gone);
  for (const url of ['/', '/theme-init.js']) {
    const r = await app.inject({ method: 'GET', url, headers: H });
    assert.equal(r.statusCode, 503, url);
    assert.equal(r.body, 'интерфейс не собран: npm run build в web/');
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: H })).statusCode, 200);
  fs.renameSync(root, gone);
  assert.equal((await app.inject({ method: 'GET', url: '/', headers: H })).statusCode, 200);
});

// ---------- markdown → текст (2.4 (а), 2.3) ----------

test('stripMarkdown: жирный, курсив, код, ссылки, заголовки, маркеры списков — на кириллице; snake_case и «2 * 3» целы', () => {
  assert.equal(stripMarkdown('**Следующий шаг — T13:** сделать _быстро_ `npm test` и [спека](https://x/y.md)'),
    'Следующий шаг — T13: сделать быстро npm test и спека');
  assert.equal(stripMarkdown('*курсив* и __жирный__, ***оба***'), 'курсив и жирный, оба');
  assert.equal(stripMarkdown('## Итог\n- пункт один\n* пункт два\n  + вложенный\n1. пункт три\n2) пункт четыре'),
    'Итог\nпункт один\nпункт два\nвложенный\nпункт три\nпункт четыре');
  assert.equal(stripMarkdown('поле board_codes, слово_с_подчёркиванием, 2 * 3 * 4'), 'поле board_codes, слово_с_подчёркиванием, 2 * 3 * 4');
  assert.equal(stripMarkdown('_слово_ и *ещё*.'), 'слово и ещё.');
  assert.equal(stripMarkdown('код `**не жирный**` как есть'), 'код **не жирный** как есть');
  assert.equal(stripMarkdown('![схема](a.png) и [[ссылка]]'), 'схема и [[ссылка]]');
  assert.equal(stripMarkdown(null), '');
});

test('(а): текст вопроса без разметки; снятие — до обрезки 160 знаков', () => {
  const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const t = { sessionId: sid, title: 'EXT', project: 'EXT', projectBy: 'title', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(T0) };
  const row = (text, kind = 'question') => waitingThreads({ threads: [{ ...t, waitingKind: kind }], sessions: [{ sessionId: sid, thread: { askOpen: kind !== 'question', [kind === 'question' ? 'q' : 'ask']: { text, uuid: 'u', at: iso(T0) } } }], now: T0 })[0].text;
  assert.equal(row('**Следующий шаг — T13:** прогон `npm test`, затем [В6](https://x).'), 'Трурль: Следующий шаг — T13: прогон npm test, затем В6.');
  assert.equal(row('Какой _вариант_ брать?', 'askUserQuestion'), 'Трурль: Какой вариант брать?');
  // сырой текст 161 знак, без разметки — 155: обрезка после снятия не трогает его и не оставляет непарный `
  const raw = '**Шаг:** `' + 'я'.repeat(150) + '`';
  assert.equal(raw.length, 161);
  assert.equal(row(raw), 'Трурль: Шаг: ' + 'я'.repeat(150));
});

const SID1 = '11111111-0000-4000-8000-000000000001';
const cardBoard = () => ({ hasCode: (c) => ['EXT', 'CAR'].includes(c), hasCard: (id) => id === 'EXT-7', card: (id) => (id === 'EXT-7' ? { id, code: 'EXT', status: 'in-progress', title: 't' } : null) });
const sess = (o) => ({ sessionId: SID1, ivan: { lastAt: null, cards: {} }, runs: [], partials: [], boardWrites: [], thread: {}, ...o });
const marks = (sessions) => buildMarks({ procs: [{ sessionId: SID1, live: true, startedAt: T0 - 5 * 60 * MIN }], sessions, board: cardBoard(), now: T0, thresholds: { taktYellowMin: 60, taktRedMin: 180 } }).bySession[SID1];

test('PARTIAL: последний текст и «осталось» — без разметки; запись субагента — строка без разметки', () => {
  const run = { agentId: 'a1', agentType: 'terminus', cards: ['EXT-7'], starts: [iso(T0 - 3 * 60 * MIN)], lastText: '**Итог:** сделал _половину_ `lib/app.mjs`', left: '- **Осталось:** тесты [В6](https://x)', alive: false };
  const [p] = marks([sess({ runs: [run], partials: [{ agentId: 'a1', at: iso(T0 - 60 * MIN), limit: 90 }] })]);
  assert.equal(p.kind, 'partial');
  assert.equal(p.lastText, 'Итог: сделал половину lib/app.mjs');
  assert.equal(p.left, 'Осталось: тесты В6');
  const r = { agentId: 'a2', agentType: 'golem', cards: [], starts: [], alive: true, boardWrites: [{ at: iso(T0 - 20 * MIN), refs: ['EXT-7'], firstLine: '**Вердикт:** [EXT-7](https://x) — без _«Критично»_' }] };
  const [w] = marks([sess({ runs: [r] })]);
  assert.equal(w.kind, 'subagentWrite');
  assert.equal(w.line, 'Вердикт: EXT-7 — без «Критично»');
});

// ---------- падеж у такта ----------

test('такт: who — именительный, whoDative — дательный по словарю; неизвестный агент — как есть', () => {
  const dative = { terminus: 'Терминусу', bard: 'Бальду', clap: 'Клапауцию', golem: 'Голему', demon: 'Демону', tikhiy: 'Тихому' };
  const nominative = { terminus: 'Терминус', bard: 'Бальд', clap: 'Клапауций', golem: 'Голем', demon: 'Демон', tikhiy: 'Тихий' };
  for (const agent of [...Object.keys(dative), 'foo']) {
    const [m] = marks([sess({ boardWrites: [{ at: iso(T0 - 61 * MIN), refs: ['EXT-7'], firstLine: `▶ выдан: ${agent} · ext-7 · В6`, tool: 't' }] })]);
    assert.equal(m.kind, 'takt', agent);
    assert.equal(m.agent, agent);
    assert.equal(m.who, nominative[agent] ?? agent);
    assert.equal(m.whoDative, dative[agent] ?? agent);
  }
});

// ---------- failingSince (2.7) ----------

// EXT-37: HEAD доски читается файлами .git; «git упал» — и .git не читается, и процесс git падает
function gitDirFails(isBroken) {
  const f = Object.create(fs);
  f.readFileSync = (p, ...a) => { if (isBroken() && /[\\/]\.git[\\/]/.test(String(p))) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return fs.readFileSync(p, ...a); };
  return f;
}

test('доска: failingSince — с первого сбоя подряд, null после удачи', async () => {
  const dir = makeBoard(tmpDir('b6-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review' }] });
  gitInitCommit(dir);
  const real = createGitRead();
  let broken = false;
  const r = createBoardReader({ root: dir, git: (repo, args) => (broken ? Promise.reject(new Error('git упал')) : real(repo, args)), parseCard, fs: gitDirFails(() => broken) });
  await r.init();
  assert.equal(r.state().failingSince, null);
  broken = true;
  const before = Date.now();
  await r.refresh();
  const first = r.state().failingSince;
  assert.ok(Date.parse(first) >= before - 1000 && Date.parse(first) <= Date.now(), first);
  await new Promise((ok) => setTimeout(ok, 15));
  await r.refresh();
  assert.equal(r.state().failingSince, first, 'второй сбой подряд — время первого');
  broken = false;
  await r.refresh();
  assert.equal(r.state().failingSince, null);
});

test('журналы: failingSince — с первого сбоя подряд, null после удачи', async () => {
  const root = path.join(tmpDir('j6-'), 'projects');
  let clock = T0;
  const r = createJournalReader({ root, indexDir: tmpDir('i6-'), now: () => new Date(clock) });
  await r.refresh();
  assert.equal(r.state().failingSince, iso(T0));
  clock += 5 * MIN;
  await r.refresh();
  assert.equal(r.state().failingSince, iso(T0), 'второй сбой подряд — время первого');
  fs.mkdirSync(root);
  clock += MIN;
  await r.refresh();
  assert.equal(r.state().failingSince, null);
  assert.equal(r.state().lastOkAt, iso(clock));
});

test('/api/ceh и /api/project: freshness.board и freshness.journals несут failingSince', async () => {
  const dir = makeBoard(tmpDir('b6a-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review' }] });
  gitInitCommit(dir);
  const real = createGitRead();
  let broken = false;
  const board = createBoardReader({ root: dir, git: (repo, args) => (broken ? Promise.reject(new Error('x')) : real(repo, args)), parseCard, fs: gitDirFails(() => broken) });
  await board.init();
  const regFile = path.join(tmpDir('reg6-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const journals = { state: () => ({ lastOkAt: iso(T0 - MIN), failingSince: iso(T0) }) };
  const app = await buildApp({ port: PORT, board, registry: createRegistryReader(regFile), journals, scan });
  const ok = (await app.inject({ method: 'GET', url: '/api/ceh', headers: H })).json().freshness;
  assert.equal(ok.board.failingSince, null);
  assert.equal(ok.journals.failingSince, iso(T0));
  broken = true;
  await board.refresh();
  const bad = (await app.inject({ method: 'GET', url: '/api/project/EXT', headers: H })).json().freshness;
  assert.equal(bad.board.failingSince, board.state().failingSince);
  assert.ok(bad.board.failingSince);
});

// ---------- вердикт Голема на В6: разметка снимается до обрезки и через настоящий разбор журнала (EXT-31) ----------

test('Важно 1 Голема: (а) через journal-parse — «**» на границе 160 не остаётся непарной, на конце «…»', () => {
  const sid = 'aaaaaaaa-0000-4000-8000-000000000009';
  const st = newSessionState();
  const para = 'я'.repeat(150) + ' **жирный хвост** и дальше текст?';
  feedSession(st, { type: 'assistant', uuid: 'u1', timestamp: iso(T0), message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: `Сделал.\n\n${para}` }] } });
  const t = { sessionId: sid, title: 'CAR', project: 'CAR', projectBy: 'title', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(T0) };
  const [row] = waitingThreads({ threads: [t], sessions: [{ sessionId: sid, thread: st.thread }], now: T0 });
  assert.equal(row.text, 'Трурль: ' + 'я'.repeat(150) + ' жирный х…');
  assert.ok(!row.text.includes('*'));
  // AskUserQuestion — тот же путь
  const st2 = newSessionState();
  feedSession(st2, { type: 'assistant', uuid: 'u2', timestamp: iso(T0), message: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: { questions: [{ question: 'ё'.repeat(155) + ' [ссылка на спеку](https://example.org/very/long/path)?', header: 'h', multiSelect: false, options: [] }] } }] } });
  const [ask] = waitingThreads({ threads: [{ ...t, waitingKind: 'askUserQuestion' }], sessions: [{ sessionId: sid, thread: st2.thread }], now: T0 });
  assert.equal(ask.text, 'Трурль: ' + 'ё'.repeat(155) + ' ссы…');
});

test('Важно 1 Голема (EXT-31): lastText PARTIAL через journal-parse — разметка снята до обрезки 200, на конце «…»; короткий — без «…»', () => {
  const st = newAgentState();
  feedAgent(st, { type: 'assistant', timestamp: iso(T0 - 70 * MIN), message: { id: 'x1', content: [{ type: 'text', text: 'ю'.repeat(190) + ' **итог работы** конец\n**Осталось:** `npm test`' }] } });
  const s = agentSummary(st);
  const run = { agentId: 'a1', agentType: 'terminus', cards: ['EXT-7'], starts: [iso(T0 - 3 * 60 * MIN)], lastText: s.lastText, left: s.left, alive: false };
  const [p] = marks([sess({ runs: [run], partials: [{ agentId: 'a1', at: iso(T0 - 60 * MIN), limit: 90 }] })]);
  assert.equal(p.lastText, 'ю'.repeat(190) + ' итог раб…');
  assert.equal(p.left, 'Осталось: npm test');
  const st2 = newAgentState();
  feedAgent(st2, { type: 'assistant', timestamp: iso(T0 - 70 * MIN), message: { id: 'x2', content: [{ type: 'text', text: '**Итог:** коротко' }] } });
  const [p2] = marks([sess({ runs: [{ ...run, lastText: agentSummary(st2).lastText }], partials: [{ agentId: 'a1', at: iso(T0 - 60 * MIN), limit: 90 }] })]);
  assert.equal(p2.lastText, 'Итог: коротко');
});

// ---------- мелочь Голема: запрет фреймов ----------

test('мелочь Голема: X-Frame-Options DENY и CSP frame-ancestors none — у всех ответов (статика, ручка, 404, 421, 503)', async () => {
  const { top, root } = dist();
  const app = await staticApp(root);
  const gone = await staticApp(path.join(top, 'нет'));
  const cases = [[app, '/', H, 200], [app, '/assets/index-DlhUvg85.js', H, 200], [app, '/api/health', H, 200], [app, '/api/nope', H, 404],
    [app, '/net.js', H, 404], [app, '/', { host: 'evil.example' }, 421], [gone, '/', H, 503]];
  for (const [a, url, headers, code] of cases) {
    const r = await a.inject({ method: 'GET', url, headers });
    assert.equal(r.statusCode, code, url);
    assert.equal(r.headers['x-frame-options'], 'DENY', `${url} ${code}`);
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'", `${url} ${code}`);
  }
});
