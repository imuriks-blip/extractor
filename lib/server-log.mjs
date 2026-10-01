// server.log (спека витрины 1.3, 6.3): последние ~5 000 строк, без текстов — только идентификаторы,
// коды, времена, числа. Строковое поле, не похожее на идентификатор, пишется как «?».
import fs from 'node:fs';
import { writeAtomic } from './config.mjs';

const ID_LIKE = /^[A-Za-z0-9_.:/+-]{0,80}$/;

// Объект, у которого в листьях только числа (счётчики по путям репозиториев), — JSON одной лексемой:
// ключи-пути с пробелами остаются в кавычках и не рвут строку «ключ=значение».
const numbersOnly = (v) => (typeof v === 'number' ? true
  : v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(numbersOnly));

function fmt(v) {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'string' && ID_LIKE.test(v)) return v;
  if (v && typeof v === 'object' && numbersOnly(v)) return JSON.stringify(v);
  return '?';
}

export function createServerLog(file, { maxLines = 5000, slack = 500 } = {}) {
  let count = 0;
  try { count = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { /* файла ещё нет */ }
  return {
    write(event, fields = {}) {
      const parts = [new Date().toISOString(), fmt(event)];
      for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${fmt(v)}`);
      try {
        fs.appendFileSync(file, parts.join(' ') + '\n');
        if (++count >= maxLines + slack) {
          const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-maxLines);
          writeAtomic(file, keep.join('\n') + '\n');
          count = keep.length;
        }
      } catch { /* журнал не роняет сервер */ }
    },
  };
}
