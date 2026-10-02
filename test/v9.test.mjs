// В9 (EXT-38): один экземпляр (спека 5 — порт и есть замок), имя отправителя тостов (AppUserModelID из реестра).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkPort, launch, startServer, VITRINA_APP, EXIT_FOREIGN } from '../lib/start.mjs';
import { showToast, AUMID } from '../lib/toast.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const close = (server) => new Promise((res) => server.close(() => res()));

// занятый порт: HTTP-сервер с заданным ответом на /api/health
function httpOccupant(answer) {
  const hosts = [];
  const s = http.createServer((req, res) => {
    hosts.push(req.headers.host);
    const [status, body] = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  return { s, hosts };
}

function config(port) {
  const board = makeBoard(tmpDir('v9b-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review' }] });
  gitInitCommit(board);
  const reg = path.join(tmpDir('v9r-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  return { port, paths: { board, boardLib: BOARD_LIB, registry: reg }, pollMs: { board: 60000 }, statsEveryMin: 10 };
}

// ---------- checkPort: три случая и молчун ----------

test('5: свободный порт — free', async () => {
  const port = await freePort();
  assert.deepEqual(await checkPort({ port }), { state: 'free' });
});

test('5: на порту витрина (/api/health с app и pid) — vitrina и её pid; Host — 127.0.0.1:<порт>', async () => {
  const { s, hosts } = httpOccupant((req) => (req.url === '/api/health' ? [200, JSON.stringify({ ok: true, app: VITRINA_APP, pid: 4242 })] : [404, '']));
  const port = await listen(s);
  try {
    assert.deepEqual(await checkPort({ port }), { state: 'vitrina', pid: 4242 });
    assert.deepEqual(hosts, [`127.0.0.1:${port}`]);
  } finally { await close(s); }
});

test('5: на порту чужой HTTP (200 без метки витрины, 404) — foreign', async () => {
  for (const answer of [() => [200, JSON.stringify({ ok: true })], () => [404, ''], () => [200, 'не json']]) {
    const { s } = httpOccupant(answer);
    const port = await listen(s);
    try { assert.deepEqual(await checkPort({ port }), { state: 'foreign' }); } finally { await close(s); }
  }
});

test('5: на порту молчун (TCP без ответа) — foreign по таймауту, не зависание', async () => {
  const socks = [];
  const s = net.createServer((c) => socks.push(c));
  const port = await listen(s);
  try {
    const t = Date.now();
    assert.deepEqual(await checkPort({ port, timeoutMs: 300 }), { state: 'foreign' });
    assert.ok(Date.now() - t < 3000);
  } finally { for (const c of socks) c.destroy(); await close(s); }
});

// ---------- /api/health несёт метку витрины и pid ----------

test('5: /api/health отвечает app=extractor-vitrina и pid процесса', async () => {
  const port = await freePort();
  const s = await startServer({ config: config(port), dataDir: tmpDir('v9d-'), toast: () => ({ on() {} }) });
  try {
    const r = await checkPort({ port });
    assert.deepEqual(r, { state: 'vitrina', pid: process.pid });
  } finally { await s.stop(); }
});

// ---------- launch: исход запуска при занятом порте ----------

test('5: второй запуск при живой витрине — код 0, строка already в server.log, первая живёт', async () => {
  const port = await freePort();
  const first = await startServer({ config: config(port), dataDir: tmpDir('v9d-'), toast: () => ({ on() {} }) });
  const dataDir = tmpDir('v9d-');
  const out = [];
  try {
    const r = await launch({ config: config(port), dataDir, print: (l) => out.push(l), printErr: (l) => out.push(l) });
    assert.equal(r.exitCode, 0);
    assert.equal(r.server, undefined);
    const log = fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8');
    assert.match(log, new RegExp(` already port=${port} pid=${process.pid}\\n`));
    assert.doesNotMatch(log, / start /);
    assert.deepEqual(await checkPort({ port }), { state: 'vitrina', pid: process.pid });
  } finally { await first.stop(); }
});

test('5: порт занят чужим — код ≠ 0, строка «порт занят чужим», port-foreign в server.log', async () => {
  const { s } = httpOccupant(() => [200, '{}']);
  const port = await listen(s);
  const dataDir = tmpDir('v9d-');
  const err = [];
  try {
    const r = await launch({ config: config(port), dataDir, print: () => {}, printErr: (l) => err.push(l) });
    assert.equal(r.exitCode, EXIT_FOREIGN);
    assert.notEqual(EXIT_FOREIGN, 0);
    assert.ok(err.some((l) => l.includes('порт занят чужим')), err.join('|'));
    assert.match(fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8'), new RegExp(` port-foreign port=${port}\\n`));
  } finally { await close(s); }
});

test('5: свободный порт — launch поднимает сервер (исправный случай)', async () => {
  const port = await freePort();
  const r = await launch({ config: config(port), dataDir: tmpDir('v9d-'), print: () => {}, printErr: () => {} });
  try {
    assert.equal(r.exitCode, undefined);
    assert.deepEqual(await checkPort({ port }), { state: 'vitrina', pid: process.pid });
  } finally { await r.server.stop(); }
});

// ---------- тост: отправитель «Экстрактор», если идентификатор зарегистрирован ----------

test('4.1/В9: тост несёт свой AppUserModelID окружением; сценарий берёт его, только если он есть в HKCU, иначе — PowerShell', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ args, opts }); return { on() {} }; };
  showToast({ title: 't', body: 'b' }, { spawn, url: 'http://127.0.0.1:4317/#/', appId: 'Unorbis.Extractor' });
  const { args, opts } = calls[0];
  const script = args[args.length - 1];
  assert.equal(opts.env.EXTRACTOR_TOAST_APPID, 'Unorbis.Extractor');
  assert.ok(script.includes('HKCU:\\Software\\Classes\\AppUserModelId\\'), script);
  assert.ok(script.includes(AUMID), 'запасной отправитель — Windows PowerShell, как в В8');
  assert.ok(!args.join(' ').includes('Unorbis.Extractor'), 'идентификатор — через окружение, не в командной строке');
});

test('4.1/В9: без appId — отправитель PowerShell, как в В8', () => {
  const calls = [];
  showToast({ title: 't' }, { spawn: (c, a, o) => { calls.push(o); return { on() {} }; }, url: 'u' });
  assert.equal(calls[0].env.EXTRACTOR_TOAST_APPID, '');
});

// ---------- вывод скрытого запуска: node пишет сам, дописыванием (без замка на файл) ----------

test('В9: redirectConsole — console.log/error дописываются в файл; второй писатель в тот же файл не заперт', async () => {
  const { redirectConsole } = await import('../lib/console-log.mjs');
  const { EventEmitter } = await import('node:events');
  const file = path.join(tmpDir('v9c-'), 'console.log');
  const a = { log() {}, error() {} };
  const b = { log() {}, error() {} };
  redirectConsole({ file, target: a, proc: new EventEmitter() });
  redirectConsole({ file, target: b, proc: new EventEmitter() });
  a.log('первый', 1);
  b.error('второй');
  a.error('третий');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+ первый 1$/);
  assert.match(lines[1], / второй$/);
  assert.match(lines[2], / третий$/);
});

test('В9: redirectConsole — неперехваченная ошибка: стек в файл и выход 1', async () => {
  const { redirectConsole } = await import('../lib/console-log.mjs');
  const { EventEmitter } = await import('node:events');
  const file = path.join(tmpDir('v9c-'), 'console.log');
  const proc = new EventEmitter();
  const codes = [];
  proc.exit = (c) => codes.push(c);
  redirectConsole({ file, target: { log() {}, error() {} }, proc });
  const e = new TypeError('кусок журнала: секрет');
  proc.emit('uncaughtException', e);
  assert.deepEqual(codes, [1]);
  const text = fs.readFileSync(file, 'utf8');
  // имя ошибки и кадры стека — да; текст сообщения (может быть куском журнала) — нет (вердикт Голема на В9)
  assert.match(text, /uncaught: TypeError\n/);
  assert.match(text, /\n {4}at .*v9\.test\.mjs/);
  assert.doesNotMatch(text, /секрет|кусок журнала/);
});

// ---------- гонка за порт (вердикт Голема на В9) ----------

test('5: два startServer на одном порту одновременно — проигравший ALREADY_RUNNING и already, победитель жив', async () => {
  const port = await freePort();
  const dirs = [tmpDir('v9g-'), tmpDir('v9g-')];
  const quiet = () => ({ on() {} });
  const res = await Promise.allSettled(dirs.map((dataDir) => startServer({ config: config(port), dataDir, toast: quiet })));
  const won = res.filter((r) => r.status === 'fulfilled');
  const lost = res.filter((r) => r.status === 'rejected');
  try {
    assert.equal(won.length, 1, JSON.stringify(res.map((r) => r.reason?.code ?? r.status)));
    assert.equal(lost[0].reason.code, 'ALREADY_RUNNING');
    const logs = dirs.map((d) => fs.readFileSync(path.join(d, 'server.log'), 'utf8'));
    assert.equal(logs.filter((l) => new RegExp(` already port=${port} pid=${process.pid}\\n`).test(l)).length, 1);
    assert.equal(logs.filter((l) => / start port=/.test(l)).length, 1);
    assert.deepEqual(await checkPort({ port }), { state: 'vitrina', pid: process.pid });
  } finally { for (const w of won) await w.value.stop(); }
});

// ---------- toasts: false — пробные копии тостов не шлют ----------

test('В9: toasts=false в настройке — тост не запускается; по умолчанию — запускается', async () => {
  const { pickToast } = await import('../lib/start.mjs');
  const t = () => {};
  assert.equal(pickToast({ toasts: false }, t), null);
  assert.equal(pickToast({}, t), t);
  assert.equal(pickToast({ toasts: true }, t), t);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).toasts, true);
});

// ---------- проверки скриптов (tools/vitrina-checks.ps1) — чистые функции, без реестра и процессов ----------

const CHECKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'vitrina-checks.ps1');
function ps(lines) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. '${CHECKS}'; ${lines.join('; ')}`], { encoding: 'utf8', windowsHide: true });
  return out.trim().split(/\r?\n/);
}

test('В9: AppId — с буквы или цифры, без «..» и «\\»; «.» и «..» отвергаются (живьём не пробуются)', () => {
  const ids = ['Unorbis.Extractor', 'Unorbis.Extractor.Probe38', 'a', '.', '..', '...', 'a..b', '.hidden', '-x', 'a\\b', 'a/b', '', 'Unorbis Extractor'];
  const want = ['True', 'True', 'True', 'False', 'False', 'False', 'False', 'False', 'False', 'False', 'False', 'False', 'False'];
  assert.deepEqual(ps(ids.map((i) => `Test-AppIdArg '${i}'`)), want);
});

test('В9: своя витрина для update.ps1 — путь server.mjs этого корня буквально и pid слушателя порта', () => {
  const root = 'C:\\projects\\extractor';
  const own = '"C:\\Program Files\\nodejs\\node.exe"  "C:\\projects\\extractor\\server.mjs" --console-log';
  const call = (o) => `Test-OwnVitrina -Root '${o.root ?? root}' -HealthPid 10 -ListenerPids @(${o.l ?? '10'}) -Name '${o.name ?? 'node.exe'}' -CommandLine '${o.cmd ?? own}'`;
  const r = ps([
    call({}),
    call({ cmd: own.toUpperCase() }),
    call({ root: 'C:\\scratch\\copy' }),
    call({ l: '11' }),
    call({ l: '' }),
    call({ cmd: 'node server.mjs' }),
    call({ cmd: '"node.exe" "C:\\projects\\extractor2\\server.mjs"' }),
    call({ cmd: '"node.exe" "D:\\x\\C:\\projects\\extractor\\server.mjs"' }),
    call({ name: 'cmd.exe' }),
  ]);
  assert.deepEqual(r, ['True', 'True', 'False', 'False', 'False', 'False', 'False', 'False', 'False']);
});

test('В9: ярлык свой — аргументы ведут на vitrina-hidden.js именно этого корня', () => {
  const r = ps([
    `Test-OursShortcutArgs -Root 'C:\\projects\\extractor' -Arguments '//B //Nologo //E:JScript "C:\\projects\\extractor\\tools\\vitrina-hidden.js" "C:\\node.exe"'`,
    `Test-OursShortcutArgs -Root 'C:\\projects\\extractor' -Arguments '//B //Nologo //E:JScript "C:\\scratch\\wt\\tools\\vitrina-hidden.js" "C:\\node.exe"'`,
    `Test-OursShortcutArgs -Root 'C:\\projects\\extractor' -Arguments ''`,
  ]);
  assert.deepEqual(r, ['True', 'False', 'False']);
});
