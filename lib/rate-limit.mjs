// Остаток лимита подписки из уже виденного rate_limit_event (EXT-84, спека пульта §6 п.2). Витрина НЕ запускает claude и
// «замера» не делает (слово Ивана 07.10): читается только то, что уже лежит в stream.jsonl прогонов прораба
// (<foremanRuns>/<прогон>/stream.jsonl, режим `-p` stream-json). Только чтение; файл бывает в мегабайты — берётся хвост
// (TAIL_BYTES), не весь файл; прогонов — не больше maxRuns последних по mtime файла.
// Форма события (живые прогоны 07.10): {"type":"rate_limit_event","rate_limit_info":{"status":"allowed|allowed_warning",
// "resetsAt":<epoch с>,"rateLimitType":"five_hour|seven_day","unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":<epoch с>},
// "seven_day":{…}}}} — времени строки в событии НЕТ: время события — mtime stream.jsonl (файл дописывается после события, mtime ≥ время события: возраст ageSec — НИЖНЯЯ
// граница, «данные не моложе N»). Статуса у окна нет: status — общий, rate_limit_info.status (тип лимита — rateLimitType).
import nodeFs from 'node:fs';
import path from 'node:path';

export const TAIL_BYTES = 1024 * 1024;
// Предел чтения с конца: 16 МБ. Замер 07.10 на 17 живых прогонах (2–21 событие на прогон, равномерно по файлу, строка события
// ≤ 422 байт, самая длинная строка файла — 610 КБ): у 16 из 17 последнее событие в последнем мегабайте, у одного (2,76 МБ) —
// в 2,4 МБ от конца, поэтому окно растёт, а не обрывается на 1 МБ.
export const CAP_BYTES = 16 * 1024 * 1024;
export const NOTE_NONE = 'остаток не виден (событий лимита нет)';
const MARK = '"type":"rate_limit_event"';

function readRange(fs, fd, start, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (n <= 0) break; got += n; }
  return buf.toString('utf8', 0, got);
}

// Последнее событие файла: {info, incomplete}. Файл читается с конца окном tailBytes; не нашлось (или строка события
// оборвана границей окна, или оборвана слева) — окно удваивается до capBytes. Строка события на границе не теряется:
// граница окна не режет строку, пока окно не дошло до начала файла. incomplete: true — предел достигнут, а файл не пройден
// до начала: «событий нет» утверждать нельзя. Хвост без перевода строки (запись идёт) — строка пропускается, берётся предыдущая.
export function lastEventIn(file, fs = nodeFs, tailBytes = TAIL_BYTES, capBytes = CAP_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let win = Math.max(1, tailBytes);
    for (;;) {
      const len = Math.min(size, win);
      const start = size - len;
      const text = readRange(fs, fd, start, len);
      let needMore = false;
      for (let i = text.lastIndexOf(MARK); i !== -1; i = i > 0 ? text.lastIndexOf(MARK, i - 1) : -1) {
        const ls = text.lastIndexOf('\n', i) + 1;
        if (ls === 0 && start > 0) { needMore = true; break; } // начало строки за границей окна
        const le = text.indexOf('\n', i);
        try { const d = JSON.parse(text.slice(ls, le === -1 ? text.length : le)); if (d?.type === 'rate_limit_event' && d.rate_limit_info) return { info: d.rate_limit_info, incomplete: false }; } catch { /* оборванная строка — предыдущее вхождение */ }
      }
      if (!needMore && start === 0) return { info: null, incomplete: false };
      if (win >= capBytes) return { info: null, incomplete: start > 0 };
      win = Math.min(win * 2, capBytes);
    }
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
export function createRateLimitReader({ dir, maxRuns = 10, everyMs = 30000, now = () => Date.now(), fs = nodeFs, tailBytes = TAIL_BYTES, capBytes = CAP_BYTES } = {}) {
  let at = -Infinity;
  let found = null; // {info, eventAtMs}
  let error = null;
  let incompleteRun = null; // прогон, чей файл не пройден до конца (предел чтения): к старым прогонам не откатываемся

  function scan() {
    found = null;
    error = null;
    incompleteRun = null;
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
        const { info, incomplete } = lastEventIn(r.f, fs, tailBytes, capBytes);
        if (info) { found = { info, eventAtMs: r.mtimeMs }; return; }
        // событий в виденной части нет, а файл не пройден — откат к старому прогону дал бы устаревшее число молча: стоп
        if (incomplete) { incompleteRun = path.basename(path.dirname(r.f)); return; }
      } catch (err) { error = err.code ?? 'ERR'; }
    }
  }

  return {
    get() {
      const nowMs = now();
      if (!dir) return { remaining: null, note: NOTE_NONE };
      if (nowMs - at >= everyMs) { at = nowMs; scan(); }
      if (!found) return { remaining: null, note: incompleteRun ? `остаток не определён: файл самого свежего прогона (${incompleteRun}) длиннее предела чтения, события в просмотренной части нет; к старым прогонам не откатываюсь` : NOTE_NONE };
      const { info, eventAtMs } = found;
      const w = info.unifiedWindows ?? {};
      return {
        remaining: {
          fiveHour: win(w.five_hour, info, nowMs), sevenDay: win(w.seven_day, info, nowMs),
          rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null, status: typeof info.status === 'string' ? info.status : null,
          eventAt: new Date(eventAtMs).toISOString(), ageSec: Math.max(0, Math.round((nowMs - eventAtMs) / 1000)), ageKind: 'lowerBound', source: 'mtime stream.jsonl: файл не старше события, возраст — нижняя граница («не моложе N»)',
        },
        note: null,
      };
    },
    error: () => error,
  };
}
