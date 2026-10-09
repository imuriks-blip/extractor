// EXT-85: строка prev-end — прошлый процесс витрины кончился без строки stop (спека витрины 5, «Выключение ноутбука»,
// абзац «Строка о нечистом прошлом конце»). Причина — по системному журналу Windows в окне от последней записи прошлого
// процесса до старта: выход из сеанса / выключение — shutdown, сон без выключения — sleep, ничего или сбой — unknown.
// Читатель журнала — подменный шов: настоящий wevtutil в тестах не зовётся.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { findPrevEnd, parseEvents, classifyEnd, createPrevEnd, readSystemEvents } from '../lib/prev-end.mjs';
import { startServer } from '../lib/start.mjs';
import { tmpDir, makeBoard, gitInitCommit, BOARD_LIB } from './helpers.mjs';

const T = (s) => Date.parse(s);
// строки server.log и stats.log в формате lib/server-log.mjs
const SERVER_CLEAN = [
  '2026-10-08T18:00:00.000Z start port=4317 pid=111 cards=800 boardErrors=0',
  '2026-10-08T18:10:00.000Z stats pid=111 upS=600 rss=1',
  '2026-10-08T19:00:00.000Z stats pid=111 upS=3600 rss=1',
  '2026-10-08T19:00:00.100Z stop pid=111',
].join('\n') + '\n';
const SERVER_CUT = [
  '2026-10-08T17:00:00.000Z stop pid=100',
  '2026-10-08T18:00:00.000Z start port=4317 pid=111 cards=800 boardErrors=0',
  '2026-10-08T18:00:30.000Z journals files=1 lines=1 ms=1 errors=0 unknown={}',
  '2026-10-08T19:20:00.000Z stats pid=111 upS=4800 rss=1',
  // второй запуск, который вышел сам («уже запущена») — не запись прошлого процесса
  '2026-10-08T19:25:00.000Z already port=4317 pid=111',
].join('\n') + '\n';
const STATS_CUT = [
  '2026-10-08T19:10:00.000Z stats pid=111 upS=4200 rss=1',
  '2026-10-08T19:23:00.000Z stats pid=111 upS=4980 rss=1',
].join('\n') + '\n';

test('findPrevEnd: прошлый процесс кончился строкой stop — конца нет (null)', () => {
  assert.equal(findPrevEnd({ serverLog: SERVER_CLEAN, statsLog: '' }), null);
});

test('findPrevEnd: без stop — время последней записи прошлого процесса (server.log и stats.log) и его pid; строка already не его', () => {
  assert.deepEqual(findPrevEnd({ serverLog: SERVER_CUT, statsLog: STATS_CUT }), { at: '2026-10-08T19:23:00.000Z', pid: 111 });
  // без stats.log — последняя своя строка server.log (19:20), не already (19:25)
  assert.deepEqual(findPrevEnd({ serverLog: SERVER_CUT, statsLog: '' }), { at: '2026-10-08T19:20:00.000Z', pid: 111 });
});

test('findPrevEnd: ротация срезала прошлый start — опора на stats.log (pid и время его последней строки)', () => {
  const rotated = '2026-10-08T19:00:00.000Z toast group=thread\n2026-10-08T19:05:00.000Z wake readMs=40\n';
  assert.deepEqual(findPrevEnd({ serverLog: rotated, statsLog: STATS_CUT }), { at: '2026-10-08T19:23:00.000Z', pid: 111 });
  // stats.log старого формата (без pid) — pid неизвестен, время есть
  assert.deepEqual(findPrevEnd({ serverLog: rotated, statsLog: '2026-10-08T19:30:00.000Z stats upS=1 rss=1\n' }), { at: '2026-10-08T19:30:00.000Z', pid: null });
});

test('findPrevEnd: первый запуск — журналов нет (или только чужие already) — ничего', () => {
  assert.equal(findPrevEnd({ serverLog: '', statsLog: '' }), null);
  assert.equal(findPrevEnd({ serverLog: '2026-10-08T19:25:00.000Z already port=4317 pid=9\n', statsLog: '' }), null);
});

// настоящий вывод `wevtutil qe System /f:xml /e:Events` (ночь 08.10, Kernel-Power 42) + Winlogon 7002 того же вида
const XML_42 = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>42</EventID><Version>3</Version><Level>4</Level><Task>64</Task><Opcode>0</Opcode><Keywords>0x8000000000000404</Keywords><TimeCreated SystemTime='2026-10-08T19:30:43.6509771Z'/><EventRecordID>93301</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='62368'/><Channel>System</Channel><Computer>X</Computer><Security/></System><EventData><Data Name='TargetState'>6</Data><Data Name='EffectiveState'>5</Data><Data Name='Reason'>4</Data><Data Name='Flags'>0</Data><Data Name='TransitionsToOn'>50</Data></EventData></Event>";
const XML_7002 = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Winlogon' Guid='{dbe9b383-7cf3-4331-91cc-a3cb16a3b538}'/><EventID>7002</EventID><Version>0</Version><Level>4</Level><TimeCreated SystemTime='2026-10-08T19:30:41.5186366Z'/><Channel>System</Channel><Computer>X</Computer></System><EventData><Data Name='TSId'>20</Data><Data Name='UserSid'>S-1-5-21-1</Data></EventData></Event>";

test('parseEvents: поставщик, номер, время (UTC) и TargetState из XML wevtutil', () => {
  assert.deepEqual(parseEvents(`<Events>\n${XML_7002}\n${XML_42}</Events>`), [
    { provider: 'Microsoft-Windows-Winlogon', id: 7002, at: T('2026-10-08T19:30:41.518Z'), targetState: null },
    { provider: 'Microsoft-Windows-Kernel-Power', id: 42, at: T('2026-10-08T19:30:43.650Z'), targetState: 6 },
  ]);
  assert.deepEqual(parseEvents('<Events></Events>'), []);
  assert.deepEqual(parseEvents(''), []);
});

const KP = 'Microsoft-Windows-Kernel-Power';
const WL = 'Microsoft-Windows-Winlogon';
const ev = (provider, id, at, targetState = null) => ({ provider, id, at: T(at), targetState });
const WIN = { from: T('2026-10-08T19:23:00Z'), to: T('2026-10-09T16:30:00Z') };

test('classifyEnd: выход из сеанса и/или 42 с TargetState=6 в окне — shutdown (и при 506/507 пробуждения рядом)', () => {
  assert.equal(classifyEnd([ev(WL, 7002, '2026-10-08T19:30:41Z'), ev(KP, 42, '2026-10-08T19:30:43Z', 6), ev(KP, 506, '2026-10-09T16:25:52Z'), ev(KP, 507, '2026-10-09T16:25:53Z')], WIN), 'shutdown');
  assert.equal(classifyEnd([ev(WL, 7002, '2026-10-08T19:30:41Z')], WIN), 'shutdown');
  assert.equal(classifyEnd([ev(KP, 42, '2026-10-08T19:30:43Z', 6)], WIN), 'shutdown');
});

test('classifyEnd: только 506/507 или 42 без выключения — sleep', () => {
  assert.equal(classifyEnd([ev(KP, 506, '2026-10-08T21:37:05Z'), ev(KP, 507, '2026-10-08T21:43:46Z')], WIN), 'sleep');
  assert.equal(classifyEnd([ev(KP, 42, '2026-10-08T21:37:05Z', 4)], WIN), 'sleep');
});

test('classifyEnd: ничего в окне — unknown; событие раньше последней записи или позже старта — не считается', () => {
  assert.equal(classifyEnd([], WIN), 'unknown');
  assert.equal(classifyEnd([ev(WL, 7002, '2026-10-08T19:22:59Z'), ev(KP, 42, '2026-10-08T19:22:59Z', 6)], WIN), 'unknown');
  assert.equal(classifyEnd([ev(KP, 506, '2026-10-08T19:00:00Z'), ev(KP, 42, '2026-10-09T16:31:00Z', 6)], WIN), 'unknown');
  // Kernel-General и прочее — не сон и не выход из сеанса
  assert.equal(classifyEnd([ev('Microsoft-Windows-Kernel-General', 1, '2026-10-09T00:00:00Z')], WIN), 'unknown');
});

const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
function fakeLog() { const lines = []; return { lines, write: (event, fields) => { lines.push({ event, ...fields }); } }; }

test('createPrevEnd: чтение журнала идёт с окном [последняя запись, старт]; ответ — строка prev-end и состояние', async () => {
  const log = fakeLog();
  let asked = null;
  const p = createPrevEnd({ serverLog: SERVER_CUT, statsLog: STATS_CUT, startedAt: T('2026-10-09T16:30:00Z'), log,
    readEvents: async (w) => { asked = w; return [ev(WL, 7002, '2026-10-08T19:30:41Z'), ev(KP, 42, '2026-10-08T19:30:43Z', 6)]; } });
  assert.deepEqual(p.state(), { at: '2026-10-08T19:23:00.000Z', pid: 111, reason: null }, 'до ответа причина не известна');
  await p.done;
  assert.deepEqual({ from: asked.from, to: asked.to }, { from: T('2026-10-08T19:23:00Z'), to: T('2026-10-09T16:30:00Z') });
  assert.deepEqual(p.state(), { at: '2026-10-08T19:23:00.000Z', pid: 111, reason: 'shutdown' });
  assert.deepEqual(log.lines, [{ event: 'prev-end', at: '2026-10-08T19:23:00.000Z', pid: 111, reason: 'shutdown' }]);
});

test('createPrevEnd: штатный прошлый конец и первый запуск — журнал не читается, строки нет, состояние null', async () => {
  for (const [serverLog, statsLog] of [[SERVER_CLEAN, ''], ['', '']]) {
    const log = fakeLog();
    let calls = 0;
    const p = createPrevEnd({ serverLog, statsLog, startedAt: Date.now(), log, readEvents: async () => { calls++; return []; } });
    await p.done;
    assert.equal(p.state(), null);
    assert.equal(calls, 0);
    assert.deepEqual(log.lines, []);
  }
});

test('createPrevEnd: чтение упало — unknown; зависло — unknown по таймауту', async () => {
  const a = fakeLog();
  const pa = createPrevEnd({ serverLog: SERVER_CUT, statsLog: '', startedAt: T('2026-10-09T16:30:00Z'), log: a, readEvents: async () => { throw new Error('wevtutil 5'); } });
  await pa.done;
  assert.equal(pa.state().reason, 'unknown');
  assert.equal(a.lines[0].reason, 'unknown');
  const b = fakeLog();
  const t0 = Date.now();
  const pb = createPrevEnd({ serverLog: SERVER_CUT, statsLog: '', startedAt: T('2026-10-09T16:30:00Z'), log: b, timeoutMs: 100, readEvents: () => new Promise(() => {}) });
  await pb.done;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(pb.state().reason, 'unknown');
  assert.deepEqual(b.lines, [{ event: 'prev-end', at: '2026-10-08T19:20:00.000Z', pid: 111, reason: 'unknown' }]);
});

test('readSystemEvents: wevtutil без окна (windowsHide), с таймаутом, окно времени в запросе; сбой — отказ промиса', async () => {
  let call = null;
  const fake = (file, args, opts, cb) => { call = { file, args, opts }; cb(null, `<Events>${XML_42}</Events>`, ''); };
  const got = await readSystemEvents({ from: T('2026-10-08T19:23:00Z'), to: T('2026-10-09T16:30:00Z'), timeoutMs: 7000, execFile: fake });
  assert.match(call.file, /wevtutil(\.exe)?$/i);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.timeout, 7000);
  assert.deepEqual(call.args.slice(0, 2), ['qe', 'System']);
  const q = call.args.find((a) => a.startsWith('/q:'));
  assert.ok(q.includes("@SystemTime>='2026-10-08T19:23:00.000Z'") && q.includes("@SystemTime<='2026-10-09T16:30:00.000Z'"), q);
  assert.ok(q.includes('Microsoft-Windows-Winlogon') && q.includes('Microsoft-Windows-Kernel-Power'));
  assert.deepEqual(got.map((e) => e.id), [42]);
  await assert.rejects(readSystemEvents({ from: 0, to: 1, execFile: (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 5 }), '', '') }));
});

// ---------- в живой витрине (startServer) ----------

function request(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function boot({ serverLog, statsLog, readEvents, timeoutMs = 300 }) {
  const board = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review' }] });
  gitInitCommit(board);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [board] } } }));
  const dataDir = tmpDir('prevend-');
  if (serverLog) fs.writeFileSync(path.join(dataDir, 'server.log'), serverLog);
  if (statsLog) fs.writeFileSync(path.join(dataDir, 'stats.log'), statsLog);
  const port = 47000 + Math.floor(Math.random() * 2000);
  const config = { port, paths: { board, boardLib: BOARD_LIB, registry: reg }, pollMs: { board: 60000, journals: 200 }, statsEveryMin: 10 };
  const s = await startServer({ config, dataDir, readEvents, prevEndTimeoutMs: timeoutMs });
  return { s, dataDir, port, log: () => fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8') };
}

test('витрина: прошлый процесс без stop, в окне выход из сеанса — строка prev-end после start и prevEnd в /api/health', async () => {
  const { s, port, log } = await boot({ serverLog: SERVER_CUT, statsLog: STATS_CUT,
    readEvents: async ({ from, to }) => [ev(WL, 7002, '2026-10-08T19:30:41Z'), ev(KP, 42, '2026-10-08T19:30:43Z', 6)].filter((e) => e.at >= from && e.at <= to) });
  try {
    assert.ok(await until(() => / prev-end /.test(log())), 'строки prev-end нет');
    const lines = log().split('\n');
    const iStart = lines.findLastIndex((l) => l.split(' ')[1] === 'start');
    const iPrev = lines.findIndex((l) => l.split(' ')[1] === 'prev-end');
    assert.ok(iPrev > iStart, 'prev-end — после строки start нового процесса');
    assert.match(lines[iPrev], /^\S+ prev-end at=2026-10-08T19:23:00\.000Z pid=111 reason=shutdown$/);
    assert.deepEqual((await request(port, '/api/health')).prevEnd, { at: '2026-10-08T19:23:00.000Z', pid: 111, reason: 'shutdown' });
  } finally { await s.stop(); }
});

test('витрина: чтение журнала зависло — старт не ждёт; причина unknown после таймаута', async () => {
  // старт не ждёт чтения: health ответил, пока читатель ещё висит (reason null); общий срок не мерится — под нагрузкой
  // полного прогона одна загрузка витрины бывает дольше 10 с
  const { s, port, log } = await boot({ serverLog: SERVER_CUT, statsLog: '', readEvents: () => new Promise(() => {}), timeoutMs: 3000 });
  try {
    assert.equal((await request(port, '/api/health')).prevEnd?.reason, null, 'старт дождался чтения журнала');
    assert.ok(await until(() => / prev-end .* reason=unknown/.test(log()), 8000));
    assert.equal((await request(port, '/api/health')).prevEnd.reason, 'unknown');
  } finally { await s.stop(); }
});

test('витрина: прошлый конец штатный и первый запуск — строки prev-end нет, prevEnd: null, журнал Windows не читается', async () => {
  for (const serverLog of [SERVER_CLEAN, '']) {
    let calls = 0;
    const { s, port, log } = await boot({ serverLog, statsLog: '', readEvents: async () => { calls++; return []; } });
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await request(port, '/api/health')).prevEnd, null);
    } finally { await s.stop(); }
    assert.equal(calls, 0);
    assert.doesNotMatch(log(), / prev-end /);
  }
});
