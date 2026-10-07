// Экран «Расход» (EXT-84, спека пульта §6): объём из журналов (usage строк ассистента) по дням, проектам, тредам и агентам;
// окна «сегодня» и 7 дней; топ тредов за 5 ч; предупреждение «за 5 ч расход выше обычного»; остаток — из уже виденного
// rate_limit_event (lib/rate-limit.mjs). Витрина claude не запускает; «Замерить остаток» не делается (слово Ивана 07.10).
// Источник объёма — читатель журналов (journals.usageRecords: одна запись на сообщение, дубли сняты); здесь — только сведение.
//
// «Объём» = input + output + cacheRead + cacheWrite (сумма четырёх чисел usage; та же сумма — на экране: total).
// Сутки — по МЕСТНОМУ времени машины (Date: getFullYear/getMonth/getDate). «7 дней» — скользящие по дням: сегодня и шесть
// предыдущих местных суток (с местной полуночи шесть дней назад).
// 5-часовые окна — непрерывная нарезка от «сейчас» назад: k = 0 — текущее (now−5ч, now], k = 1…32 — полные предыдущие
// ((now−5ч·(k+1), now−5ч·k]); текущее + 32 полных = 165 ч ≤ 7 суток (168 ч): за пределы недели окна не выходят. В медиану идут только окна с ненулевым объёмом (иначе ночь
// обнуляет медиану, и предупреждение горит всегда); непустых окон меньше 3 — предупреждения нет, «мало данных».
import { WHO } from './threads.mjs';
import { projectOf, cardRefs } from './threads.mjs';
import { bySession, foremanFamilies, FOREMAN_START_MIN } from './waiting.mjs';
import { EDIT_WINDOW_H } from './journal-parse.mjs';
import { NOTE_NONE } from './rate-limit.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const WINDOW_H = 5;
export const WINDOWS_BACK = 32;
export const MIN_WINDOWS = 3;
export const DEFAULTS = { warnFactor: 1.5, topThreads: 15, topWindow: 5 };
export const AGENT_LABELS = { main: 'главная сессия', foreman: 'прораб', subagent: 'субагент (тип не известен)' };

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
function add(acc, r) {
  acc.in += r.in; acc.out += r.out; acc.cacheRead += r.cacheRead; acc.cacheWrite += r.cacheWrite;
  acc.total += r.in + r.out + r.cacheRead + r.cacheWrite;
  return acc;
}
const recTotal = (r) => r.in + r.out + r.cacheRead + r.cacheWrite;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// records — [{t, in, out, cacheRead, cacheWrite, sessionId, agent}]; info(sessionId) → {title, project};
// remaining — {remaining, note} из rate-limit.mjs. Чистая функция: часы — nowMs.
export function buildUsage({ records, nowMs, info = () => ({ title: null, project: null }), remaining = { remaining: null, note: NOTE_NONE }, lost = 0, cfg = {} }) {
  const warnFactor = Number.isFinite(cfg.warnFactor) && cfg.warnFactor > 0 ? cfg.warnFactor : DEFAULTS.warnFactor;
  const topN = Number.isInteger(cfg.topThreads) && cfg.topThreads > 0 ? cfg.topThreads : DEFAULTS.topThreads;
  // семь местных суток, старые первыми
  const now = new Date(nowMs);
  const dates = [];
  for (let i = 6; i >= 0; i--) dates.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12).getTime()));
  const today = dates[6];
  const from = dates[0];
  const dayAcc = new Map(dates.map((d) => [d, zero()]));
  const week = zero();
  const tod = zero();
  const group = (map, key, init) => { let g = map.get(key); if (!g) { g = init(); map.set(key, g); } return g; };
  const scopes = { today: { project: new Map(), agent: new Map(), thread: new Map() }, week: { project: new Map(), agent: new Map(), thread: new Map() } };
  const cache = new Map();
  const infoOf = (sid) => { if (!cache.has(sid)) cache.set(sid, info(sid) ?? { title: null, project: null }); return cache.get(sid); };
  const win5 = [];
  for (let k = 0; k <= WINDOWS_BACK; k++) win5.push(0);
  const top5 = new Map();
  for (const r of records) {
    const dk = dayKey(r.t);
    const day = dayAcc.get(dk);
    if (day) {
      add(day, r); add(week, r);
      const inf = infoOf(r.sessionId);
      const hit = [scopes.week];
      if (dk === today) { add(tod, r); hit.push(scopes.today); }
      for (const sc of hit) {
        add(group(sc.project, inf.project ?? null, zero), r);
        add(group(sc.agent, r.agent, zero), r);
        add(group(sc.thread, r.sessionId, zero), r);
      }
    }
    const age = nowMs - r.t;
    if (age >= 0 && age < (WINDOWS_BACK + 1) * WINDOW_H * HOUR) win5[Math.floor(age / (WINDOW_H * HOUR))] += recTotal(r);
    if (age >= 0 && age < WINDOW_H * HOUR) add(group(top5, r.sessionId, zero), r);
  }
  const byTotal = (a, b) => b.total - a.total;
  const threadRow = (sid, v) => { const inf = infoOf(sid); return { sessionId: sid, title: inf.title ?? `тред ${String(sid).slice(0, 8)}`, project: inf.project ?? null, projectBy: inf.project ? (inf.by ?? null) : null, ...v }; };
  const scopeOut = (sc) => ({
    byProject: [...sc.project].map(([p, v]) => ({ project: p, label: p ?? 'без проекта', ...v })).sort(byTotal),
    byAgent: [...sc.agent].map(([a, v]) => ({ agent: a, label: AGENT_LABELS[a] ?? WHO[a] ?? a, ...v })).sort(byTotal),
    byThread: [...sc.thread].map(([s, v]) => threadRow(s, v)).sort(byTotal).slice(0, topN),
  });
  const t = scopeOut(scopes.today);
  const w = scopeOut(scopes.week);
  const current = win5[0];
  const prev = win5.slice(1).filter((x) => x > 0);
  const enough = prev.length >= MIN_WINDOWS;
  const med = enough ? median(prev) : null;
  const warn = enough && current > warnFactor * med;
  const message = !enough ? `мало данных: непустых 5-часовых окон за 7 дней — ${prev.length} из ${MIN_WINDOWS} нужных`
    : warn ? `за 5 ч расход выше обычного: ${current} против медианы ${Math.round(med)} (×${(current / med).toFixed(1)}, порог ×${warnFactor})`
      : `расход за 5 ч в норме: ${current} при медиане ${Math.round(med)} (порог ×${warnFactor})`;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    today: { date: today, ...tod },
    week: { from, to: today, ...week },
    days: dates.map((d) => ({ date: d, ...dayAcc.get(d) })),
    byProject: { today: t.byProject, week: w.byProject },
    byAgent: { today: t.byAgent, week: w.byAgent },
    byThread: { today: t.byThread, week: w.byThread },
    top5h: [...top5].map(([s, v]) => threadRow(s, v)).sort(byTotal).slice(0, DEFAULTS.topWindow),
    window5h: { total: current, median: med, factor: current > 0 && med ? Math.round((current / med) * 100) / 100 : null, warn, enough, nonEmptyWindows: prev.length, message },
    remaining: remaining.remaining ?? null,
    remainingNote: remaining.remaining ? null : (remaining.note ?? null),
    unplaced: lost, // строки с usage без времени или ключа: в день не поставлены; счёт — за всё время с пересборки индекса (не за 7 суток: у таких строк времени нет)
  };
}

// Сборка для приложения. journals — читатель журналов (usageRecords, usageGen, markForemen, sessions); rateLimit — читатель
// остатка; board — читатель доски (проект треда по §1.4); titleOf(sessionId) — название закрытого/живого треда (десктопный
// индекс). Ответ строится из готовых записей читателя; кэш ответа — до cacheMs и пока читатель не продвинулся (usageGen).
export function createUsage({ journals, rateLimit, board, titleOf = () => null, thresholds = {}, cfg = {}, now = () => Date.now(), cacheMs = 15000 }) {
  let cached = null;
  // прораб: семья прораба по журналам (waiting.mjs) — признак запоминается в индексе читателя (позже след запуска забыт).
  // Зовёт опрос (start.mjs), НЕ ручка: признак не зависит от того, открывал ли кто экран.
  function detectForemen() {
    const nowMs = now();
    const sess = bySession(journals.sessions?.() ?? []);
    const fsm = thresholds.foremanStartMin;
    const wh = thresholds.collisionWindowH;
    const { foremen } = foremanFamilies({ sess, home: (sid) => sid, nowMs, windowMs: (Number.isFinite(wh) && wh > 0 ? wh : EDIT_WINDOW_H) * HOUR,
      startMs: (Number.isFinite(fsm) && fsm > 0 ? fsm : FOREMAN_START_MIN) * 60000 });
    journals.markForemen?.(foremen);
  }
  function compute() {
    const nowMs = now();
    const sessions = journals.sessions?.() ?? [];
    const sess = bySession(sessions);
    const records = journals.usageRecords?.(nowMs - 7 * DAY - DAY) ?? [];
    const mirrorIndex = board?.mirrorIndex?.() ?? null;
    const info = (sid) => {
      const s = sess.get(sid) ?? null;
      const title = titleOf(sid) ?? s?.thread?.customTitle ?? null;
      let project = null;
      let by = null;
      if (s && board) { try { const p = projectOf(title, s, board, cardRefs(s, board, mirrorIndex)); project = p.code ?? null; by = p.by ?? null; } catch { project = null; } }
      return { title, project, by };
    };
    return buildUsage({ records, nowMs, info, remaining: rateLimit?.get() ?? undefined, lost: journals.usageLost?.() ?? 0, cfg });
  }
  return {
    tick: detectForemen,
    // → ответ до маски (имена тредов — маска в app.mjs: сеть проекта треда, без проекта — строгая)
    payload() {
      const nowMs = now();
      const gen = journals.usageGen?.() ?? 0;
      if (cached && cached.gen === gen && nowMs - cached.at < cacheMs) return cached.value;
      const value = compute();
      cached = { gen: journals.usageGen?.() ?? 0, at: nowMs, value };
      return value;
    },
  };
}

// Пустой ответ той же формы (нет читателя — тесты В1; пустые журналы)
export const NO_USAGE = { payload: () => buildUsage({ records: [], nowMs: Date.now() }) };
