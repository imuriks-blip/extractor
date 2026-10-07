// Остаток лимита подписки из уже виденного rate_limit_event (EXT-84, спека пульта §6 п.2). Витрина НЕ запускает claude и
// «замера» не делает (слово Ивана 07.10): читается только то, что уже лежит в stream.jsonl прогонов прораба
// (<foremanRuns>/<прогон>/stream.jsonl, режим `-p` stream-json). Только чтение; файл бывает в мегабайты — берётся хвост
// (TAIL_BYTES), не весь файл; прогонов — не больше maxRuns последних по mtime файла.
// Форма события (живые прогоны 07.10): {"type":"rate_limit_event","rate_limit_info":{"status":"allowed|allowed_warning",
// "resetsAt":<epoch с>,"rateLimitType":"five_hour|seven_day","unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":<epoch с>},
// "seven_day":{…}}}} — времени строки в событии НЕТ: время события — mtime stream.jsonl (верхняя граница: не раньше самого
// события). Статуса у окна нет: status — общий, rate_limit_info.status (тип лимита — rateLimitType).
import nodeFs from 'node:fs';
import path from 'node:path';

export const TAIL_BYTES = 1024 * 1024;
export const NOTE_NONE = 'остаток не виден (событий лимита нет)';
const MARK = '"type":"rate_limit_event"';

// Последняя строка-событие в хвосте файла или null. Файл читается с конца окном TAIL_BYTES; первая (возможно, обрезанная
// слева) строка окна пропускается, если окно начинается не с начала файла.
export function lastEventIn(file, fs = nodeFs, tailBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, start + got); if (n <= 0) break; got += n; }
    const lines = buf.toString('utf8', 0, got).split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(MARK)) continue;
      try { const d = JSON.parse(lines[i]); if (d?.type === 'rate_limit_event' && d.rate_limit_info) return d.rate_limit_info; } catch { /* оборванная строка — следующая выше */ }
    }
    return null;
  } finally { fs.closeSync(fd); }
}

const isoOfEpochS = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
const win = (w, info, nowMs) => {
  if (!w || typeof w !== 'object') return null;
  const resetMs = Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null;
  return { utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: isoOfEpochS(w.resetsAt), status: typeof w.status === 'string' ? w.status : (typeof info.status === 'string' ? info.status : null),
    // окно уже сменилось: число — из прошлого окна, показывать как устаревшее
    expired: resetMs !== null && resetMs <= nowMs };
};

// dir — папка прогонов (pult.usage.foremanRuns); everyMs — не чаще раза в N мс (по умолчанию 30 с); maxRuns — сколько
// последних прогонов смотреть. get() → {remaining: null | {fiveHour, sevenDay, rateLimitType, status, eventAt, ageSec, source}, note}
export function createRateLimitReader({ dir, maxRuns = 10, everyMs = 30000, now = () => Date.now(), fs = nodeFs } = {}) {
  let at = -Infinity;
  let found = null; // {info, eventAtMs}
  let error = null;

  function scan() {
    found = null;
    error = null;
    let runs = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const f = path.join(dir, e.name, 'stream.jsonl');
        try { runs.push({ f, mtimeMs: fs.statSync(f).mtimeMs }); } catch { /* прогон без stream.jsonl */ }
      }
    } catch (err) { error = err.code ?? 'ERR'; return; }
    runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const r of runs.slice(0, Math.max(1, maxRuns))) {
      try {
        const info = lastEventIn(r.f, fs);
        if (info) { found = { info, eventAtMs: r.mtimeMs }; return; }
      } catch (err) { error = err.code ?? 'ERR'; }
    }
  }

  return {
    get() {
      const nowMs = now();
      if (!dir) return { remaining: null, note: NOTE_NONE };
      if (nowMs - at >= everyMs) { at = nowMs; scan(); }
      if (!found) return { remaining: null, note: NOTE_NONE };
      const { info, eventAtMs } = found;
      const w = info.unifiedWindows ?? {};
      return {
        remaining: {
          fiveHour: win(w.five_hour, info, nowMs), sevenDay: win(w.seven_day, info, nowMs),
          rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null, status: typeof info.status === 'string' ? info.status : null,
          eventAt: new Date(eventAtMs).toISOString(), ageSec: Math.max(0, Math.round((nowMs - eventAtMs) / 1000)), source: 'mtime stream.jsonl',
        },
        note: null,
      };
    },
    error: () => error,
  };
}
