// Живая проверка П.4 в headless Edge (CDP): пульт на 127.0.0.1:4399, злая страница на 127.0.0.1:4398.
// По каждой попытке — что страница увидела, что браузер отправил (CDP Network), что получил сервер (его журнал
// запросов), дошло ли действие до лога действий (файл). Плюс исправный случай и перепривязка DNS:
// rebind.example → 127.0.0.1 (--host-resolver-rules), первый ответ документа подменён злым HTML через CDP Fetch —
// так выглядит страница атакующего в момент, когда его домен уже указывает на 127.0.0.1.
// Edge гасится по командной строке (p4-edge-profile): taskkill /T дочерние процессы Edge не ловит.
// node probe/p4/live.mjs  → вывод в консоль и probe/p4/run/live.json
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPult } from './pult.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, 'run');
fs.mkdirSync(run, { recursive: true });
const logFile = path.join(run, 'actions.log');
fs.rmSync(logFile, { force: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = path.join(os.tmpdir(), 'p4-edge-profile');
const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const actions = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);

const serverSeen = [];
const { app: pult } = await buildPult({ port: 4399, logFile, trace: (t) => serverSeen.push(t) });
await pult.listen({ host: '127.0.0.1', port: 4399 });
const evilHtml = fs.readFileSync(path.join(here, 'evil.html'));
const evil = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(evilHtml); });
await new Promise((r) => evil.listen(4398, '127.0.0.1', r));

function killEdge() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*p4-edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*p4-edge-profile*' } | Measure-Object).Count`;
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout.trim();
}

// P4_LNA_OFF=1 — отключить защиту локальной сети самого браузера (Local/Private Network Access), чтобы перепривязка
// дошла до сервера и проверялся его Host, а не браузер (так ведёт себя браузер старый или без этой защиты)
const lnaOff = process.env.P4_LNA_OFF === '1';
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--host-resolver-rules=MAP rebind.example 127.0.0.1',
  ...(lnaOff ? ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults'] : []),
  'about:blank'], { windowsHide: true, stdio: 'ignore' });
console.log(`защита локальной сети браузера: ${lnaOff ? 'ОТКЛЮЧЕНА флагом' : 'как есть'}`);
const report = [];
try {
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); if (list.some((t) => t.type === 'page')) break; } catch {} await sleep(200); }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const wait = new Map(); const handlers = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method) handlers.get(m.method)?.(m.params);
  });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => { const m = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description; };

  // что браузер отправил и чем кончилось — по requestId
  const net = new Map();
  const rec = (rid) => { if (!net.has(rid)) net.set(rid, { rid }); return net.get(rid); };
  handlers.set('Network.requestWillBeSent', (p) => Object.assign(rec(p.requestId), { method: p.request.method, url: p.request.url, type: p.type }));
  handlers.set('Network.requestWillBeSentExtraInfo', (p) => { const h = p.headers; const r = rec(p.requestId); r.sent = { origin: h.Origin ?? h.origin ?? '—', contentType: h['Content-Type'] ?? h['content-type'] ?? '—', token: (h['X-Vitrina-Token'] ?? h['x-vitrina-token']) ? 'есть' : '—', method: h[':method'] }; });
  handlers.set('Network.responseReceived', (p) => { rec(p.requestId).status = p.response.status; });
  handlers.set('Network.responseReceivedExtraInfo', (p) => { rec(p.requestId).status ??= p.statusCode; });
  handlers.set('Network.loadingFailed', (p) => Object.assign(rec(p.requestId), { failed: p.errorText, cors: p.corsErrorStatus?.corsError, blocked: p.blockedReason }));
  await cdp('Network.enable');
  await cdp('Page.enable');

  async function step(name, fn) {
    const n0 = serverSeen.length; const a0 = actions().length; const k0 = new Set(net.keys());
    const page = await fn();
    await sleep(500);
    const browser = [...net.values()].filter((r) => !k0.has(r.rid) && r.url && !r.url.startsWith('data:') && !/\/\/127\.0\.0\.1:4398\/$/.test(r.url))
      .map((r) => `${r.method} ${r.url.replace(/^http:\/\//, '')} [${r.type}] Origin=${r.sent?.origin ?? '?'} CT=${r.sent?.contentType ?? '?'} token=${r.sent?.token ?? '?'} → ${r.status ?? ''}${r.failed ? ' сбой: ' + r.failed : ''}${r.cors ? ' cors: ' + r.cors : ''}${r.blocked ? ' blocked: ' + r.blocked : ''}`);
    const server = serverSeen.slice(n0).map((t) => `${t.method} ${t.url} Host=${t.host} Origin=${t.origin ?? '—'} CT=${t.contentType ?? '—'} token=${t.token} → ${t.status}`);
    const reached = actions().slice(a0);
    report.push({ name, page, browser, server, reached });
    console.log(`\n### ${name}\n  страница: ${JSON.stringify(page)}\n  браузер:\n${browser.map((s) => '    ' + s).join('\n') || '    (нет запросов)'}\n  сервер:\n${server.map((s) => '    ' + s).join('\n') || '    (ничего не получил)'}\n  в логе действий: ${reached.length ? reached.join(' | ') : 'НЕТ'}`);
  }

  const nav = async (url) => { await cdp('Page.navigate', { url }); await sleep(1500); };

  // исправный случай: страница пульта читает свой токен и жмёт кнопку
  await step('ИСПРАВНЫЙ: страница пульта 127.0.0.1:4399 жмёт «Принять»', async () => { await nav('http://127.0.0.1:4399/'); return { page: 'act(accept) → ' + await evalJs("act('accept')") }; });
  await step('ИСПРАВНЫЙ: страница пульта localhost:4399 жмёт «Принять»', async () => { await nav('http://localhost:4399/'); return { page: 'act(accept-localhost) → ' + await evalJs("act('accept-localhost')") }; });

  // злая страница
  await nav('http://127.0.0.1:4398/');
  const names = await evalJs('Object.keys(window.attacks)');
  for (const n of names) await step(n, () => evalJs(`window.attacks[${JSON.stringify(n)}]()`));

  // перепривязка DNS: страница атакующего на rebind.example:4399, домен уже указывает на 127.0.0.1
  let served = false;
  handlers.set('Fetch.requestPaused', async (p) => {
    if (!served && p.resourceType === 'Document') {
      served = true;
      await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><title>rebind</title><p>страница атакующего</p>').toString('base64') });
    } else await cdp('Fetch.continueRequest', { requestId: p.requestId });
  });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'http://rebind.example:4399/*', requestStage: 'Request' }] });
  await nav('http://rebind.example:4399/');
  await step('ПЕРЕПРИВЯЗКА DNS: rebind.example:4399 читает «свою» страницу ради токена', () => evalJs(`fetch('/').then(async r => { const t = await r.text(); return { page: 'status=' + r.status + ' длина=' + t.length, tokenRead: /vitrina-token/.test(t) }; }, e => ({ page: 'fetch упал: ' + e.name, tokenRead: false }))`));
  await step('ПЕРЕПРИВЯЗКА DNS: rebind.example:4399 шлёт POST JSON «к себе»', () => evalJs(`fetch('/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vitrina-token': 'guess' }, body: JSON.stringify({ action: 'evil-rebind' }) }).then(r => ({ page: 'status=' + r.status, tokenRead: false }), e => ({ page: 'fetch упал: ' + e.name, tokenRead: false }))`));
  await cdp('Fetch.disable');
  ws.close();
} finally {
  const left = killEdge();
  await pult.close();
  await new Promise((r) => evil.close(r));
  fs.writeFileSync(path.join(run, lnaOff ? 'live-lna-off.json' : 'live.json'), JSON.stringify({ report, actionsLog: actions(), edgeLeft: left }, null, 2));
  console.log(`\nлог действий целиком:\n${actions().map((s) => '  ' + s).join('\n')}\nпроцессов Edge с p4-edge-profile после гашения: ${left}`);
  void edge;
}
