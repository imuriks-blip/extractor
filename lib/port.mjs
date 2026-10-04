// Кто на порту витрины (EXT-50: вынесено из start.mjs, чтобы tools/restore-actions.mjs не тянул сервер).
// Только встроенные модули node — без fastify и читателей.
import http from 'node:http';
import net from 'node:net';

export const HOST = '127.0.0.1';
// метка витрины в /api/health (app.mjs отдаёт её же)
export const VITRINA_APP = 'extractor-vitrina';

// Кто на порту: 'free' — занять можно; 'vitrina' — отвечает витрина (её pid); 'foreign' — занят чем-то иным
// (другой HTTP, не JSON, молчит дольше timeoutMs).
// Слушатель, на который нельзя соединиться (ECONNREFUSED, обрыв без ответа), — чаще всего такая же проба второго
// запуска, занявшая порт на миг (гонка двух стартов, вердикт Голема на В9): тогда проба повторяется, а не «чужой».
export async function checkPort({ port, host = HOST, timeoutMs = 3000, retries = 10, retryMs = 100 }) {
  for (let i = 0; ; i++) {
    const busy = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(true) : reject(e)));
      s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(false)));
    });
    if (!busy) return { state: 'free' };
    const h = await healthOf({ port, host, timeoutMs });
    if (h.answer && h.answer.app === VITRINA_APP && Number.isInteger(h.answer.pid)) return { state: 'vitrina', pid: h.answer.pid };
    if (h.answered || h.timeout || i >= retries) return { state: 'foreign' };
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

// { answered, answer, timeout }: answered — пришёл HTTP-ответ (answer — JSON при 200, иначе null)
function healthOf({ port, host, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/api/health', headers: { host: `${host}:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { let j = null; try { j = res.statusCode === 200 ? JSON.parse(body) : null; } catch { /* не JSON */ } end({ answered: true, answer: j }); });
      res.on('error', () => end({ answered: true, answer: null }));
    });
    req.on('timeout', () => { end({ answered: false, timeout: true }); req.destroy(); });
    req.on('error', () => end({ answered: false }));
  });
}
