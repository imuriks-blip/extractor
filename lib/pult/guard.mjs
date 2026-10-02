// Защита записи пульта (спека пульта §4.1, по пробе П.4): проверки в `onRequest`, до разбора тела, по порядку.
// Отказ — код без тела; имя проверки идёт в server.log (код без текста), в actions.log — ничего (§1.1 п.1).
// Набор проверок — данные: сервер получает его целиком; тест подменяет набор, выключая по одной (отрицательный
// контроль: каждая проверка зрячая). Ни одного Access-Control-Allow-* — CORS нет вовсе.
import crypto from 'node:crypto';

export const ACT = '/api/act';
const pathOf = (req) => String(req.url ?? '').split('?')[0];
const isBell = (p) => p.startsWith('/api/bell/');

// scope: all — любой запрос; act — только POST-вход /api/act; bell — только GET /api/bell/:sid (ждущий звонка)
export const CHECKS = [
  // перепривязка DNS: чужой Host — 421 без тела, и для GET / (иначе чужая страница прочтёт токен)
  { name: 'host', code: 421, scope: 'all', fails: (req, c) => !c.hosts.has(String(req.headers.host ?? '').toLowerCase()) },
  // на /api/act — только POST, на прочем — только GET; OPTIONS — 405 везде (предварительного запроса CORS нет)
  { name: 'method', code: 405, scope: 'all', fails: (req) => (pathOf(req) === ACT ? req.method !== 'POST' : req.method !== 'GET') },
  // явно: Fastify по умолчанию принимает text/plain; параметры (charset) допускаются
  { name: 'content-type', code: 415, scope: 'act', fails: (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json' },
  // ровно свой адрес; нет, "null" или чужой — 403
  { name: 'origin', code: 403, scope: 'act', fails: (req, c) => !c.origins.has(String(req.headers.origin ?? '')) },
  // браузер его подделать не даёт; same-site и none — тоже отказ
  { name: 'sec-fetch-site', code: 403, scope: 'act', fails: (req) => req.headers['sec-fetch-site'] !== 'same-origin' },
  // секрет страницы — сверка без утечки по времени
  { name: 'token', code: 403, scope: 'act', fails: (req, c) => !c.tokenOk(req.headers['x-vitrina-token']) },
  // ручка ждущего: браузер шлёт Origin или Sec-Fetch-Site всегда, ждущий на node — нет (Н3)
  { name: 'bell-browser', code: 403, scope: 'bell', fails: (req) => req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined },
];

// токен страницы: 32 байта на запуск сервера, не одноразовый (§4.2)
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// → (req) => проверка, которая отказала, или null
export function createGuard({ port, token, checks = CHECKS }) {
  const tokenBuf = Buffer.from(token);
  const ctx = {
    hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
    origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    tokenOk: (v) => {
      if (typeof v !== 'string') return false;
      const b = Buffer.from(v);
      return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
    },
  };
  return (req) => {
    const p = pathOf(req);
    for (const ch of checks) {
      if (ch.scope === 'act' && p !== ACT) continue;
      if (ch.scope === 'bell' && !isBell(p)) continue;
      if (ch.fails(req, ctx)) return ch;
    }
    return null;
  };
}
