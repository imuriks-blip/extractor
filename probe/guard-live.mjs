// Охранник проб: пробы стирают data/vitrina/actions.log и переписывают config.json той копии, откуда запущены.
// Из папки живой витрины или на её порту (4317) — отказ до любой записи (EXT-65, починка проб).
import fs from 'node:fs';
import path from 'node:path';

export const LIVE_ROOT = 'C:/projects/extractor';
export const LIVE_PORT = 4317;

// Приведение пути: path.resolve (win32-разбор: оба вида слешей, хвостовой слеш), слеши — прямые, без учёта регистра.
// Сравнение — на равенство, не на префикс: C:/projects/extractor-ext65 — другая папка.
const norm = (p) => path.win32.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Реальный путь (fs.realpathSync.native): ловит subst-диск, junction/симлинк, UNC и короткие 8.3-имена, которые норма по тексту не видит.
// Пути нет (или не читается) — null: не падаем, остаётся сравнение по норме.
const real = (p) => { try { return norm(fs.realpathSync.native(path.resolve(String(p)))) } catch { return null } };

// Вернуть текст отказа или null, если запуск допустим.
export function liveRefusal(root, port) {
  const liveReal = real(LIVE_ROOT) ?? norm(LIVE_ROOT);
  if (norm(root) === norm(LIVE_ROOT) || norm(root) === liveReal || real(root) === liveReal) return `отказ: корень копии ${root} — папка живой витрины (${LIVE_ROOT}); проба стёрла бы её actions.log и config.json`;
  if (Number(port) === LIVE_PORT) return `отказ: порт пробы ${port} — порт живой витрины`;
  return null;
}

// Вызывать первой строкой скрипта, до любой записи.
export function guardLive(root, port) {
  const r = liveRefusal(root, port);
  if (r) { console.error(r); process.exit(1) }
}
