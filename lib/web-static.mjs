// Раздача собранного интерфейса (спека 1.1, такт В6): web/dist тем же сервером, без @fastify/static — хватает node:fs.
// Проверка Host и «только GET» — общие хуки app.mjs, действуют и здесь. Путь запроса проверяется до любого
// обращения к диску: сегменты — только [A-Za-z0-9._-] без точки в начале, без %-кодирования и обратной косой
// (имена файлов сборки Vite — латиница); иначе 404. Разрешённый путь ещё раз сверяется: лежит внутри dist.
// Кэш: index.html и theme-init.js — no-store (оболочка не кэшируется); файлы assets/ с хешем в имени — надолго.
// Токен пульта (спека пульта §4.1 п.6) вписывается в index.html при отдаче: заглушка сборки Vite заменяется;
// заглушки нет (старая сборка) — <meta> вставляется в <head>.
import nodeFs from 'node:fs';
import path from 'node:path';

export const NOT_BUILT = 'интерфейс не собран: npm run build в web/';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const SHELL = new Set(['index.html', 'theme-init.js']);
// имя сборки Vite: <имя>-<хеш из 8 знаков base64url>.<расш.> в assets/
const HASHED = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// путь запроса → путь внутри dist (через «/») или null — без чтения диска
export function distPath(url) {
  const p = String(url ?? '').split('?')[0];
  if (p === '/') return 'index.html';
  if (!p.startsWith('/') || p.includes('%') || p.includes('\\')) return null;
  const segs = p.slice(1).split('/');
  return segs.every((s) => SEGMENT.test(s)) ? segs.join('/') : null;
}

export const TOKEN_STUB = '__VITRINA_TOKEN__';

export function withToken(html, token) {
  if (html.includes(TOKEN_STUB)) return html.replaceAll(TOKEN_STUB, token);
  const meta = `<meta name="vitrina-token" content="${token}">`;
  const head = html.match(/<head[^>]*>/i);
  return head ? html.replace(head[0], head[0] + meta) : meta + html;
}

export function createWebStatic({ root, fs = nodeFs, token = null }) {
  const base = path.resolve(root);
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  return function serve(req, reply) {
    const rel = distPath(req.raw.url);
    if (!rel) return reply.code(404).send();
    const file = path.join(base, ...rel.split('/'));
    if (!file.startsWith(base + path.sep)) return reply.code(404).send();
    if (!isFile(file)) {
      // нет сборки — понятный ответ вместо пустого 404; сервер и ручки живут
      if (!isFile(path.join(base, 'index.html'))) return reply.code(503).type('text/plain; charset=utf-8').send(NOT_BUILT);
      return reply.code(404).send();
    }
    const cache = SHELL.has(rel) ? 'no-store' : HASHED.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return reply
      .header('cache-control', cache)
      .header('x-content-type-options', 'nosniff')
      .type(TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream')
      .send(token && rel === 'index.html' ? withToken(fs.readFileSync(file, 'utf8'), token) : fs.readFileSync(file));
  };
}
