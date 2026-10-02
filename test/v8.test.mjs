// В8 (EXT-36): уведомления Windows (спека 4.1), пробуждение (5), поток событий /api/events (1.1, 1.6, 6).
// Часы — подменные; тост — подменный spawn (настоящий тост — живая проверка, не тест). Ожидаемое — из данных теста.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createNotifier, createWake, createNotifyLoop, toastRows } from '../lib/notify.mjs';
import { toastXml, showToast, createToastQueue } from '../lib/toast.mjs';
import { createEvents, createServerTick } from '../lib/events.mjs';
import { waitingThreads } from '../lib/waiting.mjs';
import { EventEmitter } from 'node:events';
import { buildThreads } from '../lib/threads.mjs';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const T0 = Date.parse('2026-10-02T10:00:00Z');
const MIN = 60000;

const row = (key, title = 'тред', body = 'Трурль: да?') => ({ key, title, body });
const notifiedFile = () => path.join(tmpDir('v8-'), 'notified.json');

// ---------- ключи и notified.json (4.1) ----------

test('4.1: показанный ключ не показывается второй раз — и после рестарта (новый notifier с тем же notified.json)', () => {
  const file = notifiedFile();
  const shown = [];
  const a = createNotifier({ file, show: (r) => shown.push(r.key) });
  a.cycle([row('s1|u1')], { silent: true }); // первый цикл после старта
  a.cycle([row('s1|u1'), row('s1|u2')]);
  assert.deepEqual(shown, ['s1|u2']);
  // рестарт: тот же файл, первый цикл снова тихий, потом — те же ключи и один новый
  const b = createNotifier({ file, show: (r) => shown.push(r.key) });
  b.cycle([row('s1|u1'), row('s1|u2')], { silent: true });
  b.cycle([row('s1|u1'), row('s1|u2'), row('EXT-6|2026-10-02 10:00 +03:00 · trurl · коммент')]);
  assert.deepEqual(shown, ['s1|u2', 'EXT-6|2026-10-02 10:00 +03:00 · trurl · коммент']);
  // и без тихого цикла: ключ из файла не всплывает
  const c = createNotifier({ file, show: (r) => shown.push(r.key) });
  c.cycle([row('s1|u2')]);
  assert.equal(shown.length, 2);
});

test('4.1: notified.json пишется атомарно — целый JSON с ключами, временного файла не остаётся', () => {
  const file = notifiedFile();
  const n = createNotifier({ file, show: () => {} });
  n.cycle([row('k1'), row('k2')], { silent: true });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.keys).sort(), ['k1', 'k2']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['notified.json']);
});

test('4.1: битый notified.json — не падение; первый цикл тихий и перезаписывает файл', () => {
  const file = notifiedFile();
  fs.writeFileSync(file, '{"keys": {"k1"');
  const shown = [];
  const n = createNotifier({ file, show: (r) => shown.push(r.key) });
  n.cycle([row('k1')], { silent: true });
  n.cycle([row('k1')]);
  assert.deepEqual(shown, []);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).keys.k1);
});

test('4.1: строка ушла и вернулась с новым ключом — новое уведомление; с тем же — нет', () => {
  const shown = [];
  const n = createNotifier({ file: notifiedFile(), show: (r) => shown.push(r.key) });
  n.cycle([row('s1|u1')], { silent: true });
  n.cycle([]);
  n.cycle([row('s1|u1')]);
  n.cycle([row('s1|u3')]);
  assert.deepEqual(shown, ['s1|u3']);
});

test('4.1: строки тостов — (а) и (б), заголовок и тело по спеке; Review (в) тостов не даёт', () => {
  const rows = toastRows({
    threads: [{ key: 's1|u1', uuid: 'u1', kind: 'question', title: 'EXT · витрина', text: 'Трурль: сливаем?' }, { key: 's2|t', uuid: null, title: null, kind: 'permission', text: 'ждёт разрешения на команду' },
      { key: 's3|2026-10-02T10:00:00.000Z', uuid: null, kind: 'askUserQuestion', title: 'хвост не дочитан', text: null }],
    yes: [{ key: 'EXT-6|k', id: 'EXT-6', mark: 'развилка', title: 'Этап 1' }],
    review: [{ id: 'EXT-7', title: 'Готово' }],
  });
  assert.deepEqual(rows, [
    { key: 's1|u1', title: 'EXT · витрина ждёт ответа', body: 'Трурль: сливаем?' },
    { key: 's2|t', title: 'Тред ждёт ответа', body: 'ждёт разрешения на команду' },
    { key: 'EXT-6|k', title: 'EXT-6: нужно твоё «да»', body: 'развилка · Этап 1' },
  ]);
});

// ---------- пробуждение (5) ----------

function clock(t = T0) { const c = { t, now: () => c.t }; return c; }

test('5: пробуждение — скачок стенных часов больше 90 с между тиками; 80 с и обычные тики — не пробуждение', () => {
  const c = clock();
  const w = createWake({ now: c.now, jumpMs: 90000 });
  assert.equal(w.tick(), null); // первый тик — опорный
  c.t += 2000; assert.equal(w.tick(), null);
  c.t += 80000; assert.equal(w.tick(), null, '80 с — пауза сборщика или долгий проход, не сон');
  const from = c.t;
  c.t += 31 * MIN; assert.deepEqual(w.tick(), { from, to: c.t });
  c.t += 2000; assert.equal(w.tick(), null);
});

test('5: проспанное время — пересечение отрезка со снами', () => {
  const c = clock();
  const w = createWake({ now: c.now, jumpMs: 90000 });
  w.tick(); c.t += 30 * MIN; w.tick(); // сон T0 … T0+30 мин
  assert.equal(w.slept(T0 - 10 * MIN, T0 + 40 * MIN), 30 * MIN);
  assert.equal(w.slept(T0 + 20 * MIN, T0 + 40 * MIN), 10 * MIN);
  assert.equal(w.slept(T0 + 31 * MIN, T0 + 40 * MIN), 0);
});

test('5: «устарело» по проспанному машиной времени не ставится; без сна — ставится', () => {
  const board = { hasCode: () => false, hasCard: () => false };
  const proc = { live: true, sessionId: 'aaaaaaaa-1111-4000-8000-000000000001', status: 'idle', observedAt: T0 - 20 * MIN, startedAt: T0 - 60 * MIN, statusUpdatedAt: T0 - 60 * MIN };
  const build = (o) => buildThreads({ procs: [proc], sessions: [], board, now: T0, staleMin: 15, ...o }).threads[0].state;
  assert.equal(build({}), 'stale', 'исправный случай: 20 мин без вестей наяву');
  // из 20 мин тишины 18 машина спала: наяву — 2 мин
  assert.equal(build({ slept: (a, b) => (a === T0 - 20 * MIN && b === T0 ? 18 * MIN : NaN) }), 'idle');
  // спала 3 мин из 20: наяву 17 мин — устарело
  assert.equal(build({ slept: () => 3 * MIN }), 'stale');
});

test('5 + 4.1: без лавины — первый цикл после старта и цикл после пробуждения тихие, полный цикл чтения один', async () => {
  const c = clock();
  const shown = [];
  let rows = [row('a1')];
  let reads = 0;
  const loop = createNotifyLoop({
    notifier: createNotifier({ file: notifiedFile(), show: (r) => shown.push(r.key) }),
    rows: () => rows,
    readAll: async () => { reads++; rows = [...rows, row('w1'), row('w2'), row('w3')]; }, // за сон накопилось три
    wake: createWake({ now: c.now, jumpMs: 90000 }),
  });
  await loop.tick(); // до конца первого прохода — ни цикла, ни тоста
  assert.deepEqual(shown, []);
  await loop.start(Promise.resolve());
  assert.deepEqual(shown, [], 'первый цикл после старта — только заполняет notified.json');
  rows = [...rows, row('a2')];
  c.t += 2000; await loop.tick();
  assert.deepEqual(shown, ['a2']);
  c.t += 45 * MIN; await loop.tick(); // пробуждение
  assert.equal(reads, 1, 'один полный цикл чтения');
  assert.deepEqual(shown, ['a2'], 'накопленное за сон — без тостов');
  rows = [...rows, row('a3')];
  c.t += 2000; await loop.tick();
  assert.deepEqual(shown, ['a2', 'a3']);
  assert.equal(reads, 1);
});

// ---------- тост (4.1 «способ») ----------

test('4.1: XML тоста — текст экранирован, щелчок открывает витрину (protocol)', () => {
  const x = toastXml({ title: 'A & B <тред>', body: 'Трурль: "да"?', url: 'http://127.0.0.1:4317/#/' });
  assert.match(x, /activationType="protocol"/);
  assert.match(x, /launch="http:\/\/127\.0\.0\.1:4317\/#\/"/);
  assert.match(x, /<text>A &amp; B &lt;тред&gt;<\/text>/);
  assert.match(x, /<text>Трурль: &quot;да&quot;\?<\/text>/);
});

test('4.1: тост — powershell без окна (windowsHide, без -WindowStyle), текст не в командной строке', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, stderr: null }; };
  showToast({ title: 'тред ждёт ответа', body: 'секретный текст' }, { spawn, url: 'http://127.0.0.1:4317/#/' });
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.match(cmd, /powershell\.exe$/i);
  assert.equal(opts.windowsHide, true);
  assert.ok(!args.some((a) => /windowstyle/i.test(a)), 'грабля Т4: -WindowStyle Hidden окно показывает');
  assert.ok(!args.join(' ').includes('секретный текст'), 'текст — через окружение, не через аргументы');
  assert.ok(Object.values(opts.env).some((v) => String(v).includes('секретный текст')));
});

// ---------- поток событий /api/events ----------

const PORT = 4317;
const H = { host: `127.0.0.1:${PORT}` };

async function setupApp({ now = () => Date.now() } = {}) {
  const dir = makeBoard(tmpDir('v8b-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review', title: 'Карточка' }] });
  gitInitCommit(dir);
  const regFile = path.join(tmpDir('v8r-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard });
  await board.init();
  const events = createEvents({ scan, refreshEveryMs: 20000, now });
  const app = await buildApp({ port: PORT, board, registry: createRegistryReader(regFile), scan, events });
  return { app, events };
}

// открыть поток; frames — разобранные события, close — оборвать с клиентской стороны
function openStream(port, host = H.host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host, accept: 'text/event-stream' } }, (res) => {
      const s = { res, status: res.statusCode, headers: res.headers, raw: '', ended: false, close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', (d) => { s.raw += d; });
      res.on('end', () => { s.ended = true; });
      res.on('error', () => {});
      resolve(s);
    });
    req.on('error', reject);
  });
}
const frames = (raw) => raw.split('\n\n').filter((f) => /^event: /m.test(f)).map((f) => ({ event: /^event: (.*)$/m.exec(f)[1], data: JSON.parse(/^data: (.*)$/m.exec(f)[1]) }));
const until = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('не дождался'); await new Promise((r) => setTimeout(r, 10)); } };

test('1.1: /api/events — чужой Host → 421 без тела; не GET → 405', async () => {
  const { app } = await setupApp();
  const r = await app.inject({ url: '/api/events', headers: { host: 'evil.example' } });
  assert.equal(r.statusCode, 421);
  assert.equal(r.body, '');
  const p = await app.inject({ method: 'POST', url: '/api/events', headers: H });
  assert.equal(p.statusCode, 405);
  await app.close();
});

test('1.6: /api/events — поток text/event-stream, без кэша и фреймов; changed при смене подписи, без смены — тишина', async () => {
  const { app, events } = await setupApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const s = await openStream(app.server.address().port);
  assert.equal(s.status, 200);
  assert.match(s.headers['content-type'], /^text\/event-stream/);
  assert.equal(s.headers['cache-control'], 'no-store');
  assert.equal(s.headers['x-frame-options'], 'DENY');
  assert.equal(s.headers['access-control-allow-origin'], undefined, 'без CORS');
  await until(() => events.count() === 1);
  events.tick('a');
  events.tick('a');
  events.tick('b');
  await until(() => frames(s.raw).length >= 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(frames(s.raw).map((f) => f.data.scope), ['data', 'data'], 'первая подпись и смена; повтор — без события');
  s.close();
  await app.close();
});

test('6.2: маска на всём, что уходит в поток', async () => {
  const { app, events } = await setupApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const s = await openStream(app.server.address().port);
  await until(() => events.count() === 1);
  events.broadcast('changed', { scope: `ключ ${SECRET}` });
  await until(() => frames(s.raw).length === 1);
  assert.ok(!s.raw.includes(SECRET), 'секрет не ушёл в поток');
  assert.match(frames(s.raw)[0].data.scope, /\[скрыто: [^\]]+\]/);
  s.close();
  await app.close();
});

test('обрыв: клиент ушёл — сервер его забыл и дальше рассылает без ошибок; закрытие сервера обрывает живые потоки', async () => {
  const { app, events } = await setupApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const gone = await openStream(port);
  const stay = await openStream(port);
  await until(() => events.count() === 2);
  gone.close();
  await until(() => events.count() === 1);
  events.tick('x');
  await until(() => frames(stay.raw).length === 1);
  const t = Date.now();
  await app.close();
  assert.ok(Date.now() - t < 1500, 'close не ждёт живого потока');
  await until(() => stay.ended);
  assert.equal(events.count(), 0);
});

test('поток: без смены данных — changed {scope: tick} не реже refreshEveryMs (свежесть 2.7 не стоит)', async () => {
  let t = T0;
  const { app, events } = await setupApp({ now: () => t });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const s = await openStream(app.server.address().port);
  await until(() => events.count() === 1);
  events.tick('a');
  t += 10000; events.tick('a');
  t += 10001; events.tick('a');
  await until(() => frames(s.raw).length >= 2);
  assert.deepEqual(frames(s.raw).map((f) => f.data.scope), ['data', 'tick']);
  s.close();
  await app.close();
});

// ---------- дозапрос Голема на В8 ----------

test('гонка: пробуждение до конца start() — после чтения тосты идут (ready не теряется)', async () => {
  const c = clock();
  const shown = [];
  let rows = [row('a1')];
  let releaseFirst, releaseRead;
  const first = new Promise((r) => { releaseFirst = r; });
  const loop = createNotifyLoop({
    notifier: createNotifier({ file: notifiedFile(), show: (r) => shown.push(r.key) }),
    rows: () => rows,
    readAll: () => new Promise((r) => { releaseRead = r; }),
    wake: createWake({ now: c.now, jumpMs: 90000 }),
  });
  await loop.tick(); // опорный тик часов
  const started = loop.start(first);
  c.t += 45 * MIN;
  const woke = loop.tick(); // пробуждение: readAll висит
  releaseFirst(); await started; // первый проход закончился во время чтения после сна
  releaseRead(); await woke;
  rows = [...rows, row('a2')];
  c.t += 2000; await loop.tick();
  assert.deepEqual(shown, ['a2']);
});

test('3 (Голем): (а) вопрос без uuid сообщения из журнала — в тосты не идёт; разрешение — идёт', () => {
  const rows = toastRows({ threads: [
    { key: 's1|2026-10-02T10:00:00.000Z', uuid: null, kind: 'askUserQuestion', title: 'А', text: null },
    { key: 's2|2026-10-02T10:00:00.000Z', uuid: null, kind: 'question', title: 'Б', text: null },
    { key: 's3|t', uuid: null, kind: 'permission', title: 'В', text: 'ждёт разрешения на команду' },
    { key: 's4|u4', uuid: 'u4', kind: 'askUserQuestion', title: 'Г', text: 'Трурль: какой?' },
  ] });
  assert.deepEqual(rows.map((r) => r.key), ['s3|t', 's4|u4']);
});

test('3 (Голем): строка (а) несёт uuid сообщения, по которому сработало правило; хвост не дочитан — null', () => {
  const t = { sessionId: 's1', state: 'waiting', waitingKind: 'askUserQuestion', title: 'тред', statusUpdatedAt: '2026-10-02T10:00:00.000Z' };
  const before = waitingThreads({ threads: [t], sessions: [], now: T0 })[0];
  assert.equal(before.uuid, null);
  const after = waitingThreads({ threads: [t], sessions: [{ sessionId: 's1', thread: { askOpen: true, ask: { text: 'Какой?', uuid: 'u9', at: '2026-10-02T09:59:00.000Z' } } }], now: T0 })[0];
  assert.equal(after.uuid, 'u9');
  assert.equal(after.key, 's1|u9');
});

test('2 (Голем): больше 3 свежих строк за цикл — 3 тоста и четвёртый «и ещё N — смотри витрину»; ключи — все', () => {
  const file = notifiedFile();
  const shown = [];
  const n = createNotifier({ file, show: (r) => shown.push(r) });
  n.cycle([], { silent: true });
  n.cycle(['k1', 'k2', 'k3', 'k4', 'k5'].map((k) => row(k)));
  assert.deepEqual(shown.slice(0, 3).map((r) => r.key), ['k1', 'k2', 'k3']);
  assert.equal(shown.length, 4);
  assert.match(`${shown[3].title} ${shown[3].body}`, /и ещё 2 — смотри витрину/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys).sort(), ['k1', 'k2', 'k3', 'k4', 'k5']);
  shown.length = 0;
  n.cycle(['k1', 'k6', 'k7', 'k8'].map((k) => row(k)));
  assert.deepEqual(shown.map((r) => r.key), ['k6', 'k7', 'k8'], 'ровно 3 — без схлопывания');
});

// подменный процесс тоста: выходит, когда скажут; kill — тоже выход
function fakeRun() {
  const kids = [];
  const run = (r) => { const k = new EventEmitter(); k.row = r; k.killed = false; k.kill = () => { k.killed = true; setImmediate(() => k.emit('exit', null)); }; kids.push(k); return k; };
  return { kids, run };
}

test('2 (Голем): тосты строго по одному — следующий процесс после выхода предыдущего', async () => {
  const f = fakeRun();
  const q = createToastQueue({ run: f.run, timeoutMs: 15000 });
  q.push(row('t1')); q.push(row('t2')); q.push(row('t3'));
  assert.equal(f.kids.length, 1);
  f.kids[0].emit('exit', 0);
  await until(() => f.kids.length === 2);
  assert.equal(f.kids[1].row.key, 't2');
  f.kids[1].emit('exit', 0);
  await until(() => f.kids.length === 3);
  f.kids[2].emit('exit', 0);
  await q.idle();
  assert.equal(f.kids.length, 3);
});

test('2 (Голем): потолок — зависший процесс тоста убивается по таймауту, очередь идёт дальше', async () => {
  const f = fakeRun();
  const done = [];
  const q = createToastQueue({ run: f.run, timeoutMs: 50, onDone: (code) => done.push(code) });
  q.push(row('hang')); q.push(row('next'));
  await until(() => f.kids.length === 2, 1000);
  assert.equal(f.kids[0].killed, true);
  f.kids[1].emit('exit', 0);
  await q.idle();
  assert.deepEqual(done, ['timeout', 0]);
});

test('5 (Голем): ошибка запуска тоста — одна запись (error и exit вместе), очередь идёт дальше; исключение spawn — тоже', async () => {
  const done = [];
  let n = 0;
  const run = (r) => {
    n++;
    if (r.key === 'throw') throw Object.assign(new Error('x'), { code: 'EPERM' });
    const k = new EventEmitter(); k.kill = () => {};
    setImmediate(() => { k.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })); k.emit('exit', -2); });
    return k;
  };
  const q = createToastQueue({ run, timeoutMs: 1000, onDone: (code) => done.push(code) });
  q.push(row('err')); q.push(row('throw')); q.push(row('ok-after'));
  await q.idle();
  assert.equal(n, 3);
  assert.deepEqual(done, ['ENOENT', 'EPERM', 'ENOENT']);
});

test('5 (Голем): исключение show логируется своим именем, не как запись notified.json', () => {
  const errs = [];
  const n = createNotifier({ file: notifiedFile(), show: () => { throw new Error('spawn'); }, onError: (e, kind) => errs.push(kind) });
  n.cycle([], { silent: true });
  n.cycle([row('k1')]);
  assert.deepEqual(errs, ['show']);
});

test('5 (Голем): XML тоста — управляющие символы вырезаны, перевод строки и табуляция остаются', () => {
  const x = toastXml({ title: 'a\x00b\x07c\x0Bd\x0Ce\x1Ff', body: 'с\tтаб\nстрока', url: 'http://127.0.0.1:4317/#/' });
  assert.match(x, /<text>abcdef<\/text>/);
  assert.match(x, /<text>с\tтаб\nстрока<\/text>/);
});

test('4 (Голем): «Цех» считается один раз на тик для тостов и подписи; без клиентов потока подпись не считается', async () => {
  let calls = 0, sigs = 0, clients = 0;
  const ticks = [];
  const tick = createServerTick({
    cehPayload: () => { calls++; return { waiting: { count: calls } }; },
    events: { count: () => clients, tick: (s) => ticks.push(s) },
    signature: (ceh) => { sigs++; return `sig${ceh.waiting.count}`; },
  });
  const loopTick = async () => { tick.current(); tick.current(); }; // строки тостов
  await tick.run(loopTick);
  assert.deepEqual([calls, sigs], [1, 0], 'без клиентов: один расчёт (тосты), подписи нет');
  clients = 1;
  await tick.run(loopTick);
  assert.deepEqual([calls, sigs], [2, 1], 'с клиентом: тот же расчёт идёт в подпись');
  assert.equal(ticks.at(-1), 'sig2');
  assert.equal(ticks.length, 2, 'tick ради свежести зовётся и без клиентов');
});
