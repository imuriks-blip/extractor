// EXT-82 (ПТ10, спека пульта §5): MCP Экстрактора — пределы, фильтр слов по проекту треда, одна строка при остановленной
// витрине, ни одного не-GET запроса. Подменная витрина — http-сервер на своём порту: считает методы, проверяет Host.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS, WORD_LABELS, createTools, cut, clip } from '../mcp/tools.mjs';
import { WORD_LABEL } from '../lib/pult/words.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs');
const SID = '2fea3135-c7db-442b-9907-4d619949881d';
const long = (n, ch = 'ж') => ch.repeat(n);

// подменная витрина: handler(path, query) → объект; считает методы и Host-ошибки
async function fakeVitrina(data) {
  const seen = { methods: [], urls: [], badHost: 0 };
  const srv = http.createServer((req, res) => {
    seen.methods.push(req.method);
    seen.urls.push(req.url);
    if (req.headers.host !== `127.0.0.1:${srv.address().port}`) { seen.badHost++; res.statusCode = 421; return res.end(); }
    const u = new URL(req.url, 'http://x');
    const out = data(u.pathname, u.searchParams);
    if (out === undefined) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }) };
}

// процесс сервера MCP: строка запроса → строка ответа
function startServer({ url, env = {}, logFile }) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env, EXTRACTOR_URL: url, EXTRACTOR_MCP_LOG: logFile ?? path.join(os.tmpdir(), `mcp-test-${process.pid}.log`) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const callTool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise((r) => { child.on('exit', r); child.stdin.end(); });
  return { child, rpc, callTool, stop };
}

const ceh = ({ threads = [], yes = [], review = [], workers = [] } = {}) => ({ waiting: { threads, yes, review }, workers: { threads: workers } });
const actionRow = (i, over = {}) => ({ id: `W-261007-1200${String(i).padStart(2, '0')}-abcd`, at: `2026-10-07T12:${String(i % 60).padStart(2, '0')}:00+03:00`, action: 'yes', card: 'EXT-1', project: 'EXT', text: null, status: 'done', ring: 'прочитано', ...over });

test('пределы — константы, значения из спеки §5', () => {
  assert.deepEqual(LIMITS, { ...LIMITS, waitingChars: 600, waitingRows: 5, waitingRowChars: 70, wordsChars: 900, wordsRows: 10, healthChars: 600 });
  assert.equal(LIMITS.defaultSinceMs, 24 * 3600000);
});

test('cut и clip: резка не превышает предел; короткое — как есть (отрицательный контроль)', () => {
  assert.equal(cut('abc', 5), 'abc');
  assert.equal(Array.from(cut(long(100), 70)).length, 70);
  assert.ok(cut(long(100), 70).endsWith('…'));
  assert.equal(clip(['a', 'b'], 10), 'a\nb');
  assert.ok(clip([long(50), long(50), long(50)], 120).length <= 120);
  assert.equal(clip([long(500)], 100).length, 100);
});

test('waiting: длинные данные режутся — ≤5 строк по ≤70 знаков, ≤600 всего; счёт — полный (не обрезан вместе со строками)', async () => {
  const f = await fakeVitrina((p) => p === '/api/ceh' && ceh({
    threads: Array.from({ length: 8 }, (_, i) => ({ project: 'EXT', text: `Трурль: ${long(300)}`, sessionId: String(i) })),
    yes: Array.from({ length: 6 }, (_, i) => ({ id: `EXT-${i}`, project: 'EXT', mark: 'развилка', title: long(300) })),
    review: Array.from({ length: 9 }, (_, i) => ({ id: `CAR-${i}`, project: 'CAR', title: long(300) })),
  }));
  const s = startServer({ url: f.url });
  const r = await s.callTool('waiting');
  const lines = r.content[0].text.split('\n');
  assert.equal(r.isError, undefined);
  assert.ok(r.content[0].text.length <= LIMITS.waitingChars);
  assert.equal(lines.length - 1, LIMITS.waitingRows);
  for (const l of lines.slice(1)) assert.ok(Array.from(l).length <= LIMITS.waitingRowChars, l);
  assert.match(lines[0], /\(а\).* 8, \(б\).* 6, \(в\).* 9/);
  // отрицательный контроль: короткие данные не режутся и не дописываются
  const f2 = await fakeVitrina(() => ceh({ yes: [{ id: 'EXT-1', project: 'EXT', mark: 'развилка', title: 'коротко' }] }));
  const s2 = startServer({ url: f2.url });
  assert.equal((await s2.callTool('waiting')).content[0].text, 'Ждёт Ивана: (а) тред ждёт ответа 0, (б) нужно «да» 1, (в) Review 0.\n- б · EXT-1 · развилка · коротко');
  await Promise.all([s.stop(), s2.stop()]); await f.close(); await f2.close();
});

test('waiting: project фильтрует; ответенные строки (answered) не считаются', async () => {
  const f = await fakeVitrina(() => ceh({
    yes: [{ id: 'EXT-1', project: 'EXT', mark: 'да', title: 'a' }, { id: 'CAR-1', project: 'CAR', mark: 'да', title: 'b' }, { id: 'EXT-2', project: 'EXT', mark: 'да', title: 'c', answered: true }],
    review: [{ id: 'CAR-2', project: 'CAR', title: 'd' }],
  }));
  const s = startServer({ url: f.url });
  const ext = (await s.callTool('waiting', { project: 'EXT' })).content[0].text;
  assert.match(ext, /по EXT: .*\(б\) нужно «да» 1, \(в\) Review 0/);
  assert.ok(!ext.includes('CAR-'));
  const all = (await s.callTool('waiting')).content[0].text;
  assert.match(all, /\(б\) нужно «да» 2, \(в\) Review 1/);
  const bad = await s.callTool('waiting', { project: 'ext; DROP' });
  assert.match(bad.content[0].text, /^project:/);
  assert.equal(f.seen.urls.length, 2); // плохой project до витрины не дошёл
  await s.stop(); await f.close();
});

test('words: ≤10 строк, ≤900 знаков; формат «<id> · ЧЧ:ММ · <карточка> · «<слово>» · <статус>»; текст слова режется', async () => {
  const f = await fakeVitrina((p) => p === '/api/actions' && Array.from({ length: 30 }, (_, i) => actionRow(i, { action: i % 2 ? 'no' : 'yes', text: i % 2 ? long(300) : null })));
  const s = startServer({ url: f.url });
  const r = (await s.callTool('words')).content[0].text;
  const lines = r.split('\n');
  assert.equal(lines.length, LIMITS.wordsRows);
  assert.ok(r.length <= LIMITS.wordsChars);
  assert.match(lines[0], /^W-\d{6}-\d{6}-[0-9a-f]{4} · \d\d:\d\d · EXT-1 · «[^»]+» · прочитано$/);
  // самые новые первыми (id с большим номером минут); длинный текст «нет» урезан
  assert.ok(lines.some((l) => l.includes('«нет: ')));
  assert.ok(lines.every((l) => Array.from(l).length < 120));
  // предел 900 держится на длинных строках: «ответ» с текстом и длинный статус — 10 строк не влезают, лишние не режутся посреди
  const fl = await fakeVitrina(() => Array.from({ length: 10 }, (_, i) => actionRow(i + 10, { action: 'reply', text: long(300), ring: 'отозвано поздно: прочитано' })));
  const sl = startServer({ url: fl.url });
  const tl = (await sl.callTool('words')).content[0].text;
  assert.ok(tl.length <= LIMITS.wordsChars && tl.split('\n').length < LIMITS.wordsRows, tl.length);
  assert.ok(tl.split('\n').every((l) => l.endsWith('отозвано поздно: прочитано')));
  // порядок: самые новые первыми, ЧЧ:ММ из времени записи
  assert.deepEqual(lines.slice(0, 3).map((l) => l.split(' · ')[1]), ['12:29', '12:28', '12:27']);
  await sl.stop(); await fl.close();
  // отрицательный контроль: мало данных — ровно столько строк
  const f2 = await fakeVitrina(() => [actionRow(1), actionRow(2, { action: 'ping' }), actionRow(3, { action: 'mirror' })]);
  const s2 = startServer({ url: f2.url });
  assert.equal((await s2.callTool('words')).content[0].text.split('\n').length, 1); // не слова (ping, mirror) отброшены
  await Promise.all([s.stop(), s2.stop()]); await f.close(); await f2.close();
});

test('words: подписи слов — как WORD_LABEL витрины; статусы без звонка — те же слова, что на странице «Мои слова» (outcomeText)', async () => {
  for (const [k, v] of Object.entries(WORD_LABEL)) assert.equal(WORD_LABELS[k], v, k);
  const f = await fakeVitrina(() => [
    actionRow(1, { ring: null, status: 'done', action: 'accept' }),
    actionRow(2, { ring: null, status: 'refused', action: 'go' }),
    actionRow(3, { ring: null, status: 'need-confirm', bdeal: 'слово «сливай»', action: 'merge' }),
    actionRow(6, { ring: null, status: 'need-confirm', bdeal: null, action: 'take' }),
    actionRow(7, { ring: null, status: 'error', action: 'return' }),
    actionRow(8, { ring: null, status: 'asked', action: 'no' }),
    actionRow(9, { ring: null, status: 'partial', action: 'yes' }),
    actionRow(4, { ring: 'положено', action: 'deploy' }),
    actionRow(5, { ring: null, status: 'done', withdrawnBy: 'W-x', action: 'yes' }),
  ]);
  const s = startServer({ url: f.url });
  const t = (await s.callTool('words')).content[0].text;
  for (const part of ['«принято» · записано', '«го» · отказ', '«сливай» · ждёт второго щелчка', '«в работу» · ждёт выбора треда', '«вернуть» · не записано', '«нет» · идёт или оборвано', '«да» · частично: запись есть, статус не сменился', '«выкатывай» · положено', '«да» · отозвано']) assert.ok(t.includes(part), part);
  await s.stop(); await f.close();
});

test('words по умолчанию — проект вызывающего треда: тред EXT не видит слов CAR; без переменной сессии — все; явный project сильнее', async () => {
  const rows = (project) => (project ? [actionRow(1, { project, card: `${project}-1` })] : [actionRow(1, { project: 'EXT', card: 'EXT-1' }), actionRow(2, { project: 'CAR', card: 'CAR-2' })]);
  const f = await fakeVitrina((p, q) => (p === '/api/ceh' ? ceh({ workers: [{ sessionId: SID, project: 'EXT' }, { sessionId: 'другая', project: 'CAR' }, { sessionId: 'без-проекта', project: null }] })
    : p === '/api/actions' ? rows(q.get('project')) : undefined));
  // 1. сессия есть, проект треда EXT
  const a = startServer({ url: f.url, env: { CLAUDE_CODE_SESSION_ID: SID.toUpperCase() } });
  const ta = (await a.callTool('words')).content[0].text;
  assert.ok(ta.includes('EXT-1') && !ta.includes('CAR-'), ta);
  assert.ok(f.seen.urls.some((u) => u.includes('project=EXT')));
  // 2. явный project из входа сильнее умолчания
  assert.ok((await a.callTool('words', { project: 'CAR' })).content[0].text.includes('CAR-1'));
  // 3. отрицательный контроль: без переменной сессии — все проекты (и запрос без project)
  const n0 = f.seen.urls.length;
  const b = startServer({ url: f.url });
  const tb = (await b.callTool('words')).content[0].text;
  assert.ok(tb.includes('EXT-1') && tb.includes('CAR-2'), tb);
  assert.ok(f.seen.urls.slice(n0).every((u) => !u.includes('project=')) && !f.seen.urls.slice(n0).some((u) => u.startsWith('/api/ceh')));
  assert.ok((await b.callTool('words', { project: 'CAR' })).content[0].text.includes('CAR-1') === true); // без переменной — project из входа
  // 4. сессия не из живых тредов или у треда нет проекта — все
  for (const sid of ['3fea3135-c7db-442b-9907-4d619949881d', 'без-проекта']) {
    const c = startServer({ url: f.url, env: { CLAUDE_CODE_SESSION_ID: sid } });
    const tc = (await c.callTool('words')).content[0].text;
    assert.ok(tc.includes('EXT-1') && tc.includes('CAR-2'), tc);
    await c.stop();
  }
  await Promise.all([a.stop(), b.stop()]); await f.close();
});

test('words: since — ISO или 30m/6h/2d; мусор — строка-подсказка без запроса к витрине', async () => {
  const f = await fakeVitrina(() => []);
  const s = startServer({ url: f.url });
  assert.equal((await s.callTool('words', { since: '6h' })).content[0].text, 'слов Ивана нет за период');
  await s.callTool('words', { since: '2026-10-07T00:00:00Z' });
  assert.ok(f.seen.urls[1].includes('since=2026-10-07T00%3A00%3A00.000Z'));
  const n = f.seen.urls.length;
  assert.match((await s.callTool('words', { since: 'вчера' })).content[0].text, /^since: не понял/);
  assert.equal(f.seen.urls.length, n);
  await s.stop(); await f.close();
});

test('health: читатели, зеркало, звонок, очередь Plane — ≤600 знаков; длинные ошибки режутся', async () => {
  const f = await fakeVitrina((p) => (p === '/api/health' ? {
    readers: Object.fromEntries(['board', 'registry', 'journals', 'processes', 'desktop', 'git'].map((k) => [k, { lastOkAt: new Date(Date.now() - 5 * 60000).toISOString(), errors: k === 'git' ? 3 : 0, lastError: k === 'git' ? long(500) : null }])),
    bell: { on: true, waiters: 2, queued: 1 }, planeQueue: { running: 0, queued: 4 },
  } : p === '/api/mirror' ? { running: false, lastOk: new Date(Date.now() - 3 * 3600000).toISOString(), lastFullOk: new Date(Date.now() - 6 * 86400000).toISOString(), lastError: long(500) } : undefined));
  const s = startServer({ url: f.url });
  const t = (await s.callTool('health')).content[0].text;
  assert.ok(t.length <= LIMITS.healthChars, t.length);
  assert.ok(t.includes('git 5м ош3') && t.includes('board 5м,'));
  assert.ok(t.includes('Зеркало: 3ч назад, полное 6д назад, идёт нет, ошибка: '));
  assert.ok(t.includes('Звонок: вкл, ждущих 2, слов в очереди 1'));
  assert.ok(t.includes('Очередь Plane: идёт 0, ждёт 4'));
  assert.ok(!t.includes(long(100)));
  // отрицательный контроль: витрина без planeQueue и зеркала — «нет данных», не падение
  const f2 = await fakeVitrina((p) => (p === '/api/health' ? { readers: {}, bell: { on: false, waiters: null, queued: 0 } } : undefined));
  const s2 = startServer({ url: f2.url });
  const t2 = (await s2.callTool('health')).content[0].text;
  assert.ok(t2.includes('Зеркало: нет данных') && t2.includes('Очередь Plane: нет данных') && t2.includes('Звонок: выкл, ждущих ?'));
  await Promise.all([s.stop(), s2.stop()]); await f.close(); await f2.close();
});

test('витрина не запущена — одна строка на каждый инструмент; код ответа витрины — строка с isError', async () => {
  const f = await fakeVitrina(() => ({}));
  const port = f.port;
  await f.close();
  const s = startServer({ url: `http://127.0.0.1:${port}` });
  for (const name of ['waiting', 'words', 'health']) {
    const r = await s.callTool(name);
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].text, `витрина не запущена (127.0.0.1:${port})`, name);
  }
  await s.stop();
  // по умолчанию — адрес из спеки
  const t = createTools({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal((await t.call('health')).text, 'витрина не запущена (127.0.0.1:4317)');
  // отрицательный контроль: витрина жива, но ответила не 200 (здесь 404) — это не «не запущена»
  const f2 = await fakeVitrina(() => undefined);
  const s2 = startServer({ url: f2.url });
  const r2 = await s2.callTool('health');
  assert.equal(r2.isError, true);
  assert.equal(r2.content[0].text, 'витрина ответила 404');
  await s2.stop(); await f2.close();
});

test('сервер не делает ни одного не-GET запроса и шлёт правильный Host (контроль: подменная витрина считает методы)', async () => {
  const f = await fakeVitrina((p) => (p === '/api/ceh' ? ceh({ workers: [{ sessionId: SID, project: 'EXT' }] }) : p === '/api/actions' ? [actionRow(1)] : { readers: {}, bell: {} }));
  const s = startServer({ url: f.url, env: { CLAUDE_CODE_SESSION_ID: SID } });
  await s.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 't' } });
  await s.rpc('tools/list');
  for (const [name, args] of [['waiting', {}], ['waiting', { project: 'EXT' }], ['words', {}], ['words', { project: 'CAR', since: '1d' }], ['health', {}], ['нет-такого', {}]]) await s.callTool(name, args);
  assert.ok(f.seen.methods.length === 7);
  assert.deepEqual([...new Set(f.seen.methods)], ['GET']);
  assert.equal(f.seen.badHost, 0);
  // контроль самого счётчика: подменная витрина видит и другой метод
  await fetch(f.url + '/api/ceh', { method: 'POST', headers: { host: `127.0.0.1:${f.port}` } });
  assert.deepEqual([...new Set(f.seen.methods)].sort(), ['GET', 'POST']);
  await s.stop(); await f.close();
  // и в коде: ровно один вызов fetch, метод зашит
  const src = fs.readFileSync(path.join(path.dirname(SERVER), 'tools.mjs'), 'utf8') + fs.readFileSync(SERVER, 'utf8');
  assert.equal(src.match(/fetchImpl\(/g).length, 1);
  assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(src));
});

test('протокол: initialize, tools/list (три инструмента, у каждого описание), ping, неизвестный метод; журнал — вызов и длина, значение сессии не пишется', async () => {
  const f = await fakeVitrina(() => ({ readers: {}, bell: { on: true, waiters: 0, queued: 0 } }));
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp82-')), 'mcp.log');
  const s = startServer({ url: f.url, logFile, env: { CLAUDE_CODE_SESSION_ID: SID } });
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  assert.equal(init.result.serverInfo.name, 'extractor');
  const list = (await s.rpc('tools/list')).result.tools;
  assert.deepEqual(list.map((t) => t.name).sort(), ['health', 'waiting', 'words']);
  assert.ok(list.every((t) => t.description && t.inputSchema.type === 'object' && !('run' in t)));
  assert.deepEqual((await s.rpc('ping')).result, {});
  assert.equal((await s.rpc('resources/list')).error.code, -32601);
  assert.equal((await s.callTool('нет-такого')).isError, true);
  await s.callTool('health');
  await s.stop();
  const log = fs.readFileSync(logFile, 'utf8');
  const evs = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.ev === 'initialize' && e.sessionEnv === true));
  assert.ok(evs.some((e) => e.ev === 'call' && e.name === 'health') && evs.some((e) => e.ev === 'ok' && e.name === 'health' && e.chars > 0));
  assert.ok(!log.includes(SID));
  await f.close();
});

test('project: пусто и null — все, строчный код — заглавный; тело не список и нечисловая очередь — строка, не падение', async () => {
  const f = await fakeVitrina((p) => (p === '/api/actions' ? null : p === '/api/health' ? { readers: {}, planeQueue: {}, bell: { on: true } } : p === '/api/ceh' ? ceh({ yes: [{ id: 'EXT-1', project: 'EXT', mark: 'да', title: 'a' }] }) : undefined));
  const s = startServer({ url: f.url });
  for (const project of ['', null]) assert.match((await s.callTool('waiting', { project })).content[0].text, /^Ждёт Ивана: /);
  assert.match((await s.callTool('waiting', { project: 'ext' })).content[0].text, /по EXT: .*\(б\).* 1/);
  const w = await s.callTool('words');
  assert.equal(w.isError, true);
  assert.equal(w.content[0].text, 'витрина ответила не списком');
  assert.match((await s.callTool('health')).content[0].text, /Очередь Plane: нет данных/);
  await s.stop(); await f.close();
});

test('health: ошибка читателя — только первая строка', async () => {
  const f = await fakeVitrina((p) => (p === '/api/health' ? { readers: { git: { lastOkAt: null, errors: 1, lastError: 'первая\nвторая-строка' } }, bell: {} } : undefined));
  const s = startServer({ url: f.url });
  const t = (await s.callTool('health')).content[0].text;
  assert.ok(t.includes('git: первая') && !t.includes('вторая-строка'));
  await s.stop(); await f.close();
});

test('адрес не локальный — сервер не стартует (код 2), наружу не ходит', async () => {
  for (const url of ['http://example.com:4317', 'https://127.0.0.1:4317', 'не-адрес']) {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXTRACTOR_URL: url }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 2, url);
  }
});
