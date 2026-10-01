// Сервер витрины (спека 1.1, 1.6, 6): только GET, проверка Host, без CORS, параметры — до чтения диска,
// каждый ответ — через маску секретов. Слушать (127.0.0.1) — забота server.mjs; здесь только приложение.
import Fastify from 'fastify';
import { maskDeep } from './mask.mjs';
import { validCode, validCardId } from './params.mjs';
import { buildCeh } from './ceh.mjs';

export async function buildApp({ port, board, registry, scan, log = { write() {} }, gitCalls = () => ({}) }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const app = Fastify({ logger: false, exposeHeadRoutes: false });

  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    // защита от перепривязки DNS (1.1): чужой Host — 421 без тела
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return reply.code(421).send();
    if (req.method !== 'GET') return reply.code(405).send();
  });
  app.addHook('preSerialization', async (req, reply, payload) => maskDeep(payload, scan));
  app.addHook('onResponse', async (req, reply) => {
    const ms = Number((process.hrtime.bigint() - req.startedAt) / 1000000n);
    // в server.log — маршрут (шаблон), код и время; ни параметров, ни текстов (6.3)
    log.write('req', { route: req.routeOptions?.url ?? '-', status: reply.statusCode, ms });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send());
  app.setErrorHandler((err, req, reply) => {
    log.write('error', { route: req.routeOptions?.url ?? '-', code: err.code ?? 'ERR' });
    reply.code(500).send();
  });

  const freshness = () => ({ board: { lastOkAt: board.state().lastOkAt }, journals: null, mirror: null });
  const isCode = (code) => validCode(code, (c) => board.hasCode(c));

  app.get('/api/health', async () => ({
    ok: true,
    readers: { board: board.state(), registry: registry.state() },
    gitCalls: gitCalls(),
    rss: process.memoryUsage().rss,
    uptimeS: Math.round(process.uptime()),
  }));

  app.get('/api/ceh', async () => buildCeh({ board, registry: registry.get(), freshness: freshness() }));

  // Окно проекта — каркас В1: проверка параметра; наполнение — такты В2–В5.
  app.get('/api/project/:code', async (req, reply) => {
    const { code } = req.params;
    if (!isCode(code)) return reply.code(404).send();
    return {
      code,
      name: board.codes().find((p) => p.code === code)?.name ?? '',
      beacon: null,
      waiting: [],
      workers: { threads: [] },
      board: { inProgress: [], ready: [], review: [], backlog: [], done: [] },
      freshness: freshness(),
    };
  });

  // Карточка — каркас В1: шапка и тело из файла; связи и лента — такт В5.
  app.get('/api/card/:id', async (req, reply) => {
    const { id } = req.params;
    if (!validCardId(id, (c) => board.hasCode(c))) return reply.code(404).send();
    const card = board.readCard(id);
    if (!card) return reply.code(404).send();
    return { header: card.header, body: card.body, links: null, feed: [] };
  });

  await app.ready();
  return app;
}
