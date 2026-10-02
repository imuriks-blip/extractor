// Поток событий GET /api/events (спека 1.1, 1.6): SSE, событие `changed {scope}` — сигнал «перечитай»; данных в
// потоке нет, интерфейс перезапрашивает свою ручку (она отдаёт маскированный ответ, как при опросе). Так проще и
// надёжнее, чем слать сами ответы: одна форма данных, маска и проверка параметров — в ручках, как были.
// scope: 'data' — сменилась подпись данных (start.mjs: «Цех» без свежести + шапки и последние записи доски);
// 'tick' — данных не меняли refreshEveryMs: перечитать ради свежести (серая строка 2.7 «стоящий читатель» — 60 с)
// и коммитов, запусков, маячка, которых подпись не видит.
// Host и «только GET» — общий хук app.mjs (до этой ручки). Ответ уводится из Fastify (hijack): хуки onSend и
// preSerialization его не видят — заголовки и маску ставит этот модуль сам (6.2: строгая сеть на всё в потоке).
import { maskDeep } from './mask.mjs';

const STRICT = 'IPTV';

export function createEvents({ scan, refreshEveryMs = 20000, now = () => Date.now(), retryMs = 5000 }) {
  const clients = new Set();
  let sig = null;
  let sentAt = null;

  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(maskDeep(data, scan, { project: STRICT }))}\n\n`;
  const send = (text) => {
    for (const c of clients) {
      try { c.write(text); } catch { clients.delete(c); }
    }
  };

  return {
    count: () => clients.size,
    broadcast(event, data) { send(frame(event, data)); sentAt = now(); },
    // signature — подпись текущих данных (строка); вызывается опросом сервера
    tick(signature) {
      if (signature !== sig) { sig = signature; this.broadcast('changed', { scope: 'data' }); return; }
      if (sentAt == null || now() - sentAt >= refreshEveryMs) this.broadcast('changed', { scope: 'tick' });
    },
    // обработчик ручки: ответ уводится из Fastify, поток живёт до обрыва клиентом или закрытия сервера
    attach(req, reply, onClose = () => {}) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      });
      res.write(`retry: ${retryMs}\n\n`);
      clients.add(res);
      const gone = () => { if (clients.delete(res)) onClose(); };
      res.on('close', gone);
      res.on('error', gone);
    },
    // закрытие сервера: живые потоки обрываются, иначе close ждал бы их вечно
    closeAll() {
      for (const c of clients) { try { c.end(); } catch { /* уже закрыт */ } }
      clients.clear();
    },
  };
}
