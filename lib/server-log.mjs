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
  // готовая строка (без перевода строки) — в файл; ротация — последние maxLines, когда набралось maxLines + slack
  function writeLine(line) {
    try {
      fs.appendFileSync(file, line + '\n');
      if (++count >= maxLines + slack) {
        const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-maxLines);
        writeAtomic(file, keep.join('\n') + '\n');
        count = keep.length;
      }
    } catch { /* журнал не роняет сервер */ }
  }
  return {
    // возвращает записанную строку — её же можно продублировать в другой журнал (stats.log, EXT-53)
    write(event, fields = {}) {
      const parts = [new Date().toISOString(), fmt(event)];
      for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${fmt(v)}`);
      const line = parts.join(' ');
      writeLine(line);
      return line;
    },
    writeLine,
  };
}

// stats.log (EXT-53, вердикт Голема на В10, Важно 2; гейт Г4 — RSS за сутки): строки stats отдельно от server.log,
// где 5 000 строк общего журнала к 24-му часу могли срезать первый час. Держит последние STATS_KEEP_LINES строк:
// 1 500 при шаге statsEveryMin = 10 — ~10,4 суток (не меньше 7 суток = 1 008 строк). Шаг меньше — суток меньше.
export const STATS_KEEP_LINES = 1500;
export function createStatsLog(file, { maxLines = STATS_KEEP_LINES, slack = 100 } = {}) {
  return createServerLog(file, { maxLines, slack });
}
