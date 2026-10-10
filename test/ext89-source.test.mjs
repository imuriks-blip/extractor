// EXT-89 (ПТ1б; спека пульта §4.3): отметка процесса-источника. Ожидания — из спеки (msedge.exe и нет claude.exe в цепочке,
// без учёта регистра; сбой — ok false с причиной; время не больше 300 мс), не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { registerPult } from '../lib/pult/routes.mjs';
import { classify, createHelperReader, createSource, pickOwner } from '../lib/pult/source.mjs';

// таблица процессов: [pid, ppid, образ]
const TABLE = [
  [1, 0, 'System'], [100, 1, 'explorer.exe'], [200, 100, 'msedge.exe'], [201, 200, 'msedge.exe'],
  [300, 100, 'Claude.exe'], [301, 300, 'msedge.exe'], [302, 301, 'msedge.exe'],
  [400, 100, 'cmd.exe'], [401, 400, 'node.exe'], [402, 400, 'curl.exe'],
  [500, 100, 'MSEDGE.EXE'], [600, 100, 'CLAUDE.EXE'], [601, 600, 'node.exe'], [602, 601, 'msedge.exe'],
];
const source = (read, o = {}) => createSource({ read, ...o });
const fromTable = (pid) => async () => ({ pid, procs: TABLE });

test('Edge с родителем explorer → ok true; образ и цепочка записаны', async () => {
  const r = await source(fromTable(201)).identify({ clientPort: 5, serverPort: 4317 });
  assert.equal(r.ok, true);
  assert.equal(r.image, 'msedge.exe');
  assert.deepEqual(r.chain, ['msedge.exe', 'explorer.exe', 'System']);
  assert.equal(r.reason, undefined);
});

test('образ без учёта регистра: MSEDGE.EXE с родителем explorer → ok true', async () => {
  assert.equal((await source(fromTable(500)).identify({})).ok, true);
});

test('Edge с Claude.exe в цепочке → ok false (причина — claude-in-chain), в любом регистре и на любой глубине', async () => {
  for (const pid of [302, 602]) {
    const r = await source(fromTable(pid)).identify({});
    assert.equal(r.ok, false, `pid ${pid}`);
    assert.equal(r.image, 'msedge.exe');
    assert.equal(r.reason, 'claude-in-chain');
  }
});

test('node и curl → ok false (причина — image), образ назван', async () => {
  for (const [pid, image] of [[401, 'node.exe'], [402, 'curl.exe']]) {
    const r = await source(fromTable(pid)).identify({});
    assert.equal(r.ok, false);
    assert.equal(r.image, image);
    assert.equal(r.reason, 'image');
  }
});

test('цикл родителей и процесс, которого нет в таблице, не зацикливают и не бросают', async () => {
  const loop = classify({ pid: 1, procs: [[1, 2, 'msedge.exe'], [2, 1, 'explorer.exe']] });
  assert.equal(loop.ok, true);
  assert.deepEqual(loop.chain, ['explorer.exe']);
  const gone = classify({ pid: 9, procs: TABLE });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'process-gone');
});

test('сбой определения → ok false с причиной, не исключение; зависание — timeout по пределу', async () => {
  const bad = await source(async () => { throw new Error('no-socket'); }).identify({});
  assert.deepEqual([bad.ok, bad.reason], [false, 'no-socket']);
  const odd = await source(async () => { throw new Error('Не удалось: C:\\секрет\\путь'); }).identify({});
  assert.deepEqual([odd.ok, odd.reason], [false, 'error']); // чужой текст в журнал не идёт
  const t0 = Date.now();
  const slow = await source(() => new Promise(() => {}), { limitMs: 50 }).identify({});
  assert.deepEqual([slow.ok, slow.reason], [false, 'timeout']);
  assert.ok(Date.now() - t0 < 500);
});

test('время определения (подменные таблицы) — не больше 300 мс', async () => {
  const r = await source(fromTable(201)).identify({});
  assert.ok(r.ms <= 300, `ms=${r.ms}`);
});

// ---- настоящий помощник на настоящем сокете этого же процесса (внешний источник: владелец известен — это мы) ----
test('настоящий помощник: владелец клиентского конца loopback — этот процесс node, это не Edge (ok false, причина image); тёплый запрос ≤ 300 мс; закрытие убирает помощника',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const server = net.createServer((s) => s.on('error', () => {}));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = net.connect(server.address().port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    const reader = createHelperReader();
    const src = createSource({ read: reader.read, limitMs: 15000 });
    try {
      const ports = { clientPort: client.localPort, serverPort: server.address().port, clientAddr: client.localAddress, serverAddr: client.remoteAddress };
      const cold = await src.identify(ports); // первый запрос ждёт запуска помощника — в предел 300 мс не входит
      assert.equal(cold.pid, process.pid);
      assert.equal(cold.image.toLowerCase(), process.platform === 'win32' ? 'node.exe' : '');
      assert.equal(cold.ok, false); // node — не Edge
      assert.equal(cold.reason, 'image');
      const warm = [];
      for (let i = 0; i < 5; i++) warm.push(await src.identify(ports));
      for (const w of warm) { assert.equal(w.pid, process.pid); assert.ok(w.ms <= 300, `ms=${w.ms}`); }
      // порта нет → причина no-socket, действие не страдает
      const none = await src.identify({ clientPort: 1, serverPort: 2, clientAddr: '127.0.0.1', serverAddr: '127.0.0.1' });
      assert.deepEqual([none.ok, none.reason], [false, 'no-socket']);
      // без портов (inject) → no-ports, помощник не нужен
      assert.equal((await src.identify({})).reason, 'no-ports');
      // помощник — наш потомок (powershell.exe с родителем этим процессом): по нему проверяем снятие
      const raw = await reader.read(ports);
      const mine = raw.procs.filter((p) => p[1] === process.pid && String(p[2]).toLowerCase() === 'powershell.exe').map((p) => p[0]);
      assert.equal(mine.length, 1, 'помощник один');
      reader.close();
      const deadline = Date.now() + 5000;
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (alive(mine[0]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(mine[0]), false, 'помощник снят закрытием');
    } finally {
      reader.close();
      client.destroy();
      server.close();
    }
  });

// ---- Голем, Важно 1: адреса и состояние; подменная таблица сокетов [состояние, laddr, lport, raddr, rport, pid] ----
const ASK = { clientPort: 50000, serverPort: 4317, clientAddr: '127.0.0.1', serverAddr: '127.0.0.1' };

test('владелец сокета: исправный случай — один адрес, ESTABLISHED → найден (и ::ffff:-вид адреса)', () => {
  assert.equal(pickOwner([[5, '127.0.0.1', 50000, '127.0.0.1', 4317, 777]], ASK), 777);
  assert.equal(pickOwner([[5, '127.0.0.1', 50000, '127.0.0.1', 4317, 777]], { ...ASK, clientAddr: '::ffff:127.0.0.1', serverAddr: '::ffff:127.0.0.1' }), 777);
});

test('владелец сокета: две строки на один local-порт, разные local-адреса (обход bind на 127.0.0.2) → берётся строка с совпавшим адресом', () => {
  const rows = [[5, '127.0.0.2', 50000, '127.0.0.1', 4317, 666], [5, '127.0.0.1', 50000, '127.0.0.1', 4317, 777]];
  assert.equal(pickOwner(rows, ASK), 777);
  assert.equal(pickOwner([...rows].reverse(), ASK), 777);
  assert.equal(pickOwner([rows[0]], ASK), null, 'совпавшего адреса нет — владельца нет, чужая строка не берётся');
});

test('владелец сокета: TIME_WAIT (11) и pid 0 не берутся; ESTABLISHED рядом — берётся', () => {
  assert.equal(pickOwner([[11, '127.0.0.1', 50000, '127.0.0.1', 4317, 0]], ASK), null);
  assert.equal(pickOwner([[11, '127.0.0.1', 50000, '127.0.0.1', 4317, 555]], ASK), null);
  assert.equal(pickOwner([[5, '127.0.0.1', 50000, '127.0.0.1', 4317, 0]], ASK), null);
  assert.equal(pickOwner([[11, '127.0.0.1', 50000, '127.0.0.1', 4317, 555], [5, '127.0.0.1', 50000, '127.0.0.1', 4317, 777]], ASK), 777);
});

// ---- Голем, Мелочь 3: прогрев только при включённом пульте ----
test('прогрев помощника: pult.enabled = false → PowerShell не запускается; true → запускается один раз', async () => {
  for (const [enabled, want] of [[false, 0], [true, 1]]) {
    let spawned = 0;
    const helperSpawn = () => { spawned++; const c = new PassThrough(); c.stdout = new PassThrough(); c.stdin = new PassThrough(); c.kill = () => {}; c.unref = () => {}; return c; };
    const app = Fastify();
    const api = registerPult(app, { hasCode: () => true, maskRow: (x) => x, pult: { enabled }, seams: { helperSpawn } });
    api.warmSource();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawned, want, `enabled=${enabled}`);
    await app.close(); // onClose закрывает помощника
  }
});
