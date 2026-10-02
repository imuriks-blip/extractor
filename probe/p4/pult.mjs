// Проба П.4 (EXT-33): пробный «пульт» с одной пишущей ручкой POST /api/act — защита записи от чужих страниц
// в браузере Ивана и от перепривязки DNS. Не код витрины: lib/ и web/ не тронуты.
// Защита (ТЗ дирижёра 02.10):
//   Host  — только 127.0.0.1:<порт> и localhost:<порт>, прочее 421 без тела (как витрина, спека 1.1);
//   метод — GET, и POST только на /api/act; прочее 405 (в т.ч. OPTIONS — предварительный запрос CORS);
//   (а)   — Content-Type ровно application/json (параметры вроде charset допускаются), иначе 415 — до разбора тела;
//   (б)   — Origin ровно http://127.0.0.1:<порт> или http://localhost:<порт>; нет, null или чужой — 403;
//   (в)   — X-Vitrina-Token = случайный токен, вложенный в HTML страницы (не куки, не адрес); новый при каждом старте;
//   (г)   — никаких Access-Control-Allow-*.
// off — ТОЛЬКО для отрицательного контроля (blind.mjs): отключает одну проверку, чтобы показать, что её тест зрячий.
//   off a → сервер «как забыли»: принимает любое тело (текст, форму); off d → «включили CORS» с эхом Origin.
// Запуск руками: node probe/p4/pult.mjs  → http://127.0.0.1:4399/ (лог действий — probe/p4/run/actions.log)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const ACTION = /^[a-z][a-z-]{0,31}$/;

function page(token) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="vitrina-token" content="${token}">
<title>П.4 · пульт</title></head>
<body>
<button id="accept">Принять (проба)</button>
<pre id="out"></pre>
<script>
const token = document.querySelector('meta[name="vitrina-token"]').content;
async function act(action) {
  const r = await fetch('/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vitrina-token': token }, body: JSON.stringify({ action }) });
  document.getElementById('out').textContent = action + ' → ' + r.status;
  return r.status;
}
document.getElementById('accept').onclick = () => act('accept');
window.act = act;
</script>
</body></html>
`;
}

export async function buildPult({ port, logFile, off = [], trace = () => {} }) {
  const skip = new Set(off);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const app = Fastify({ logger: false, exposeHeadRoutes: false });

  const tokenOk = (v) => {
    if (typeof v !== 'string') return false;
    const b = Buffer.from(v);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return reply.code(421).send();
    const url = req.url.split('?')[0];
    const write = url === '/api/act';
    if (skip.has('d') && req.method === 'OPTIONS') return; // «включили CORS»: предварительный запрос пропускается
    if (write ? req.method !== 'POST' : req.method !== 'GET') return reply.code(405).send();
    if (!write) return;
    if (!skip.has('a')) {
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return reply.code(415).send();
    }
    if (!skip.has('b') && !origins.has(String(req.headers.origin ?? ''))) return reply.code(403).send();
    if (!skip.has('c') && !tokenOk(req.headers['x-vitrina-token'])) return reply.code(403).send();
  });

  if (skip.has('a')) {
    // «как забыли»: любое тело принимается строкой и разбирается как JSON или форма
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
      try { done(null, JSON.parse(body)); } catch { done(null, Object.fromEntries(new URLSearchParams(body))); }
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    if (skip.has('d') && req.headers.origin) {
      reply.header('access-control-allow-origin', req.headers.origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-allow-methods', 'POST');
      reply.header('access-control-allow-headers', 'content-type, x-vitrina-token');
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const t = req.headers['x-vitrina-token'];
    trace({ method: req.method, url: req.url, host: req.headers.host ?? null, origin: req.headers.origin ?? null, contentType: req.headers['content-type'] ?? null, token: t === undefined ? 'нет' : tokenOk(t) ? 'верный' : 'неверный', status: reply.statusCode });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send());
  app.setErrorHandler((err, req, reply) => reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send());

  app.get('/', async (req, reply) => reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(page(token)));
  if (skip.has('d')) app.options('/api/act', async (req, reply) => reply.code(204).send());
  app.post('/api/act', async (req, reply) => {
    const action = req.body?.action;
    if (typeof action !== 'string' || !ACTION.test(action)) return reply.code(400).send();
    fs.appendFileSync(logFile, `${new Date().toISOString()} act ${action} origin=${req.headers.origin ?? '-'}\n`);
    return { ok: true };
  });

  return { app, token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run');
  fs.mkdirSync(dir, { recursive: true });
  const port = 4399;
  const { app } = await buildPult({ port, logFile: path.join(dir, 'actions.log') });
  await app.listen({ host: '127.0.0.1', port });
  console.log(`пульт П.4: http://127.0.0.1:${port}/`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
