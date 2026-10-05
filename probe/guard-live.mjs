// Охранник проб: пробы стирают data/vitrina/actions.log и переписывают config.json той копии, откуда запущены.
// Из папки живой витрины или на её порту (4317) — отказ до любой записи (EXT-65, починка проб).
import path from 'node:path';

export const LIVE_ROOT = 'C:/projects/extractor';
export const LIVE_PORT = 4317;

// Приведение пути: path.resolve (win32-разбор: оба вида слешей, хвостовой слеш), слеши — прямые, без учёта регистра.
// Сравнение — на равенство, не на префикс: C:/projects/extractor-ext65 — другая папка.
const norm = (p) => path.win32.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Вернуть текст отказа или null, если запуск допустим.
export function liveRefusal(root, port) {
  if (norm(root) === norm(LIVE_ROOT)) return `отказ: корень копии ${root} — папка живой витрины (${LIVE_ROOT}); проба стёрла бы её actions.log и config.json`;
  if (Number(port) === LIVE_PORT) return `отказ: порт пробы ${port} — порт живой витрины`;
  return null;
}

// Вызывать первой строкой скрипта, до любой записи.
export function guardLive(root, port) {
  const r = liveRefusal(root, port);
  if (r) { console.error(r); process.exit(1) }
}
