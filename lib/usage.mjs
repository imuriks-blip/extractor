// Экран «Расход» (EXT-84, спека пульта §6): объём из журналов (usage строк ассистента) по дням, проектам, тредам и агентам;
// окна «сегодня» и 7 дней; топ тредов за 5 ч; предупреждение «за 5 ч расход выше обычного»; остаток — из уже виденного
// rate_limit_event (lib/rate-limit.mjs) или из замера (lib/pult/measure.mjs, EXT-87: кнопка «Замерить остаток» вернулась словом Ивана 09.10).
// Источник объёма — читатель журналов (journals.usageRecords: одна запись на сообщение, дубли сняты); здесь — только сведение.
//
// «Объём» = input + output + cacheRead + cacheWrite (сумма четырёх чисел usage; та же сумма — на экране: total).
// Сутки — по МЕСТНОМУ времени машины (Date: getFullYear/getMonth/getDate). «7 дней» — скользящие по дням: сегодня и шесть
// предыдущих местных суток (с местной полуночи шесть дней назад).
// 5-часовые окна — непрерывная нарезка от «сейчас» назад: k = 0 — текущее (now−5ч, now], k = 1…32 — полные предыдущие
// ((now−5ч·(k+1), now−5ч·k]); текущее + 32 полных = 165 ч ≤ 7 суток (168 ч): за пределы недели окна не выходят. В медиану идут только окна с ненулевым объёмом (иначе ночь
// обнуляет медиану, и предупреждение горит всегда); непустых окон меньше 3 — предупреждения нет, «мало данных».
// EXT-87: объём ОКНА (текущего, медианы, «непустого») — взвешенный по ценам API (WEIGHTS); плитки и разрезы — все четыре числа как есть.
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
// Вес по ценам API (EXT-87, спека пульта §6 п.3): ввод ×1, вывод ×5, запись кэша ×1,25, чтение кэша ×0,1. Считается в целых,
// умноженных на 20 (1 / 100 / 25 / 2), чтобы сумма не копила ошибку дробей; делится на 20 один раз, в конце.
export const WEIGHTS = { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const WEIGHT_NOTE = 'вес: вывод ×5, чтение кэша ×0,1';
const weigh20 = (r) => r.in * 20 + r.out * 100 + r.cacheWrite * 25 + r.cacheRead * 2;
export const ZERO_MEASURES = { today: { count: 0, costUsd: 0, tokens: 0 } };
export const FRESH_FIVE_HOUR_MIN = 30;
export const FRESH_SEVEN_DAY_H = 6;

// Остаток новой формы (EXT-87, §1.7 «Чтение замера», §6 п.2 «Свежесть»). measure — last.json замера (или null), foreman — remaining
// читателя прогонов прораба (или null). Показывается самый свежий из двух (при равенстве — замер); число 5 ч — только если окно
// не сменилось (resetsAt в будущем) и событию не больше 30 мин; 7 дн — не больше 6 ч (и окно не сменилось, если resetsAt известен).
// Несвежее — utilization: null (число на страницу не уходит вовсе). У «прораба» возраст — нижняя граница (ageKind lowerBound).
export function buildRemaining({ measure = null, foreman = null, foremanNote = NOTE_NONE, nowMs, cfg = {} }) {
  const fiveMin = Number.isFinite(cfg.freshFiveHourMin) && cfg.freshFiveHourMin > 0 ? cfg.freshFiveHourMin : FRESH_FIVE_HOUR_MIN;
  const sevenH = Number.isFinite(cfg.freshSevenDayH) && cfg.freshSevenDayH > 0 ? cfg.freshSevenDayH : FRESH_SEVEN_DAY_H;
  const isoOfS = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
  const cands = [];
  const mAt = Date.parse(measure?.at);
  if (measure && Number.isFinite(mAt)) cands.push({ source: 'measure', atMs: mAt, ageKind: 'exact', five: measure.fiveHour, seven: measure.sevenDay, resets: isoOfS });
  const fAt = Date.parse(foreman?.eventAt);
  if (foreman && Number.isFinite(fAt)) cands.push({ source: 'foreman', atMs: fAt, ageKind: 'lowerBound', five: foreman.fiveHour, seven: foreman.sevenDay, resets: (v) => (typeof v === 'string' ? v : null) });
  if (!cands.length) return { remaining: null, note: foremanNote ?? NOTE_NONE };
  cands.sort((a, b) => b.atMs - a.atMs || (a.source === 'measure' ? -1 : 1));
  const c = cands[0];
  const ageSec = Math.max(0, Math.round((nowMs - c.atMs) / 1000));
  const part = (w, ageLimitSec, needFuture) => {
    const resetsAt = w ? c.resets(w.resetsAt) : null;
    const resetMs = resetsAt ? Date.parse(resetsAt) : null;
    const future = resetMs !== null && resetMs > nowMs;
    const fresh = !!w && Number.isFinite(w.utilization) && ageSec <= ageLimitSec && (needFuture ? future : resetMs === null || future);
    return { utilization: fresh ? w.utilization : null, resetsAt, fresh };
  };
  return {
    remaining: { source: c.source, at: new Date(c.atMs).toISOString(), ageSec, ageKind: c.ageKind, fiveHour: part(c.five, fiveMin * 60, true), sevenDay: part(c.seven, sevenH * 3600, false) },
    note: null,
  };
}
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
  const win5 = []; // взвешенный объём окон, умноженный на 20 (weigh20)
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
    if (age >= 0 && age < (WINDOWS_BACK + 1) * WINDOW_H * HOUR) win5[Math.floor(age / (WINDOW_H * HOUR))] += weigh20(r);
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
  // EXT-87: окно, медиана и «непустое окно» — по взвешенной сумме (ценовые веса API), не по сумме четырёх чисел
  const current = win5[0] / 20;
  const prev = win5.slice(1).filter((x) => x > 0).map((x) => x / 20);
  const enough = prev.length >= MIN_WINDOWS;
  const med = enough ? median(prev) : null;
  const warn = enough && current > warnFactor * med;
  const message = !enough ? `мало данных: непустых 5-часовых окон за 7 дней — ${prev.length} из ${MIN_WINDOWS} нужных`
    : warn ? `за 5 ч расход выше обычного: ≈ ${Math.round(current)} условных токенов против медианы ${Math.round(med)} (×${(current / med).toFixed(1)}, порог ×${warnFactor}; ${WEIGHT_NOTE})`
      : `расход за 5 ч в норме: ≈ ${Math.round(current)} условных токенов при медиане ${Math.round(med)} (порог ×${warnFactor}; ${WEIGHT_NOTE})`;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    today: { date: today, ...tod },
    week: { from, to: today, ...week },
    days: dates.map((d) => ({ date: d, ...dayAcc.get(d) })),
    byProject: { today: t.byProject, week: w.byProject },
    byAgent: { today: t.byAgent, week: w.byAgent },
    byThread: { today: t.byThread, week: w.byThread },
    top5h: [...top5].map(([s, v]) => threadRow(s, v)).sort(byTotal).slice(0, DEFAULTS.topWindow),
    window5h: { total: current, median: med, factor: current > 0 && med ? Math.round((current / med) * 100) / 100 : null, warn, enough, nonEmptyWindows: prev.length, weights: WEIGHTS, message },
    remaining: remaining.remaining ?? null,
    remainingNote: remaining.remaining ? null : (remaining.note ?? null),
    measuring: false, // createUsage подставляет живое: идёт ли замер
    measures: ZERO_MEASURES, // createUsage подставляет счёт замеров из log.jsonl
    unplaced: lost, // строки с usage без времени или ключа: в день не поставлены; счёт — за всё время с пересборки индекса (не за 7 суток: у таких строк времени нет)
  };
}

// Сборка для приложения. journals — читатель журналов (usageRecords, usageGen, markForemen, sessions); rateLimit — читатель
// остатка; board — читатель доски (проект треда по §1.4); titleOf(sessionId) — название закрытого/живого треда (десктопный
// индекс). Ответ строится из готовых записей читателя; кэш ответа — до cacheMs и пока читатель не продвинулся (usageGen).
// measure — замер остатка (lib/pult/measure.mjs: last(), today(nowMs), running()); нет — остаток только от прораба
export function createUsage({ journals, rateLimit, measure = null, board, titleOf = () => null, thresholds = {}, cfg = {}, now = () => Date.now(), cacheMs = 15000 }) {
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
    return buildUsage({ records, nowMs, info, lost: journals.usageLost?.() ?? 0, cfg });
  }
  // живая часть ответа — каждый раз, мимо кэша объёма: остаток (свежесть считается на момент ответа), идёт ли замер, счёт замеров
  function live() {
    const nowMs = now();
    const rl = rateLimit?.get() ?? { remaining: null, note: NOTE_NONE };
    const { remaining, note } = buildRemaining({ measure: measure?.last?.() ?? null, foreman: rl.remaining, foremanNote: rl.note, nowMs, cfg });
    return { remaining, remainingNote: remaining ? null : (note ?? null), measuring: !!measure?.running?.(), measures: measure?.today ? { today: measure.today(nowMs) } : ZERO_MEASURES };
  }
  return {
    tick: detectForemen,
    // → ответ до маски (имена тредов — маска в app.mjs: сеть проекта треда, без проекта — строгая)
    payload() {
      const nowMs = now();
      const gen = journals.usageGen?.() ?? 0;
      if (cached && cached.gen === gen && nowMs - cached.at < cacheMs) return { ...cached.value, ...live() };
      const value = compute();
      cached = { gen: journals.usageGen?.() ?? 0, at: nowMs, value };
      return { ...value, ...live() };
    },
  };
}

// Пустой ответ той же формы (нет читателя — тесты В1; пустые журналы)
export const NO_USAGE = { payload: () => buildUsage({ records: [], nowMs: Date.now() }) };
