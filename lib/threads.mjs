// Строки «Кто работает» (спека витрины 2.1, 1.4, 2.2, 3.1; такт В3): живые треды из реестра процессов, состояние,
// проект, карточка, «идёт / открыт», живые субагенты. Чистая функция над выжимками читателей — без чтения диска.
// Красные пометки (marks) и «Ждёт меня» — такт В4 (lib/waiting.mjs): пометки приходят сюда готовыми.
import { resolveRef } from './journal-parse.mjs';

const MIN = 60000;
// Словарь агентов (2.2) — один на сервер: имя в именительном и дательном («▶ выдан Бальду», 2.3); неизвестный тип — как есть
const NAMES = {
  golem: ['Голем', 'Голему'], clap: ['Клапауций', 'Клапауцию'], terminus: ['Терминус', 'Терминусу'],
  bard: ['Бальд', 'Бальду'], demon: ['Демон', 'Демону'], tikhiy: ['Тихий', 'Тихому'],
};
export const WHO = Object.fromEntries(Object.entries(NAMES).map(([k, [n]]) => [k, n]));
export const WHO_DATIVE = Object.fromEntries(Object.entries(NAMES).map(([k, [, d]]) => [k, d]));
const KNOWN_STATUS = new Set(['busy', 'idle', 'waiting']);
// status «waiting» (факт дирижёра 02.10): причина — поле waitingFor реестра процессов
const WAITING_FOR = { 'permission prompt': 'permission', 'input needed': 'askUserQuestion' };
// Название по конвенции (1.4), расширено по снимку Ивана 02.10 (треды названы голым кодом): название после обрезки
// пробелов равно коду, или код в начале и за ним пробел, «·», «:», «—» или «-». \b не используется — рядом кириллица;
// «CARS», «LETGER» — целиком другое слово, кодом не считаются (кода нет в projects.md).
const TITLE_CODE = /^([A-Z]{2,6})(?=$|[\s·:—-])/;
const TAKT_ISSUED = /^▶️?\s*выдан/; // маркер — с двоеточием и без, с вариационным селектором и без (1.4)
const ORDER = { waiting: 1, busy: 2, idle: 3, stale: 4 };
// красная пометка (3.1, слово Ивана 02.10): красный такт, PARTIAL, старые правила, запись субагента; жёлтый такт — нет;
// «Общий файл» (EXT-60, kind collision) — всегда жёлтая: тред не поднимает, в счёт значка не идёт
export const isRedMark = (m) => !((m?.kind === 'takt' && m.level !== 'red') || m?.kind === 'collision');

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const ms = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

// Состояние живого треда (2.1): (А) — при любом status; (Б) — только при status ≠ busy; незнакомый status — как не busy
export function threadState({ status, askOpen, endTurnQ }) {
  if (status === 'waiting') return 'waiting'; // процесс сам стоит на разрешении или вопросе — при любых (А)/(Б)
  if (askOpen) return 'waiting';
  if (status === 'busy') return 'busy';
  if (endTurnQ === true) return 'waiting';
  return 'idle';
}

export function cardRefs(sess, board, mirrorIndex) {
  const out = [];
  for (const w of sess?.boardWrites ?? []) {
    const ids = (w.refs ?? []).map((r) => resolveRef(r, mirrorIndex)).filter((id) => id && board.hasCard(id));
    out.push({ at: w.at, ids, issued: TAKT_ISSUED.test(String(w.firstLine ?? '').trim()) });
  }
  return out;
}

export function projectOf(title, sess, board, writes) {
  const m = typeof title === 'string' ? title.trim().match(TITLE_CODE) : null;
  if (m && board.hasCode(m[1])) return { code: m[1], by: 'title' };
  const n = {};
  for (const [id, e] of Object.entries(sess?.ivan?.cards ?? {})) if (board.hasCard(id)) n[id.split('-')[0]] = (n[id.split('-')[0]] ?? 0) + (e.n ?? 1);
  for (const w of writes) for (const id of w.ids) n[id.split('-')[0]] = (n[id.split('-')[0]] ?? 0) + 1;
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > total / 2 ? { code: top[0], by: 'cards' } : { code: null, by: null };
}

function cardOf(sess, board, writes) {
  for (let i = writes.length - 1; i >= 0; i--) if (writes[i].issued && writes[i].ids.length) return writes[i].ids.at(-1);
  let best = null;
  for (const [id, e] of Object.entries(sess?.ivan?.cards ?? {})) if (board.hasCard(id) && (!best || ms(e.lastAt) > ms(best[1].lastAt))) best = [id, e];
  return best ? best[0] : null;
}

function firstMention(card, sess, writes) {
  const times = [ms(sess?.ivan?.cards?.[card]?.firstAt), ...writes.filter((w) => w.ids.includes(card)).map((w) => ms(w.at))].filter(Number.isFinite);
  return times.length ? Math.min(...times) : NaN;
}

// Живые субагенты треда (2.2): запуск живой в журнале этой сессии; копия сессии — итог того же агента в другой
// сессии не раньше последней строки журнала агента — дубль, снимается.
function subagentsOf(sess, endsByAgent, maxTurns) {
  const out = [];
  for (const r of sess?.runs ?? []) {
    if (!r.alive) continue;
    const last = ms(r.lastAt ?? r.at);
    if ((endsByAgent.get(r.agentId) ?? []).some((e) => e.sessionId !== sess.sessionId && ms(e.at) >= last)) continue;
    out.push({ agent: r.agentType ?? null, who: WHO[r.agentType] ?? r.agentType ?? null, description: r.description ?? null, cards: r.cards ?? [], turns: r.currentZakhod ?? 0, maxTurns: r.agentType ? maxTurns(r.agentType) : null, target: r.target ?? null });
  }
  return out;
}

// Память треда (EXT-49, спека 2.1): выжимка читателя {tokens, model, at, compactions} → поле треда {tokens, window, pct,
// model, at, compactions, warn}. Окно — config.json → contextWindow {<начало имени модели>: <токенов>}, побеждает самое
// длинное совпадение; модели нет в настройке — window и pct null, warn false (не гадаем). pct — целая часть процента,
// warn — pct ≥ thresholds.memoryWarnPct (показанное число и жёлтое не расходятся: 79,99 % — «79 %», не жёлтое).
export function memoryOf(mem, { contextWindow = {}, warnPct = 80 } = {}) {
  if (!mem || !Number.isFinite(mem.tokens)) return null;
  let window = null;
  let best = -1;
  const model = typeof mem.model === 'string' ? mem.model : '';
  for (const [prefix, w] of Object.entries(contextWindow ?? {})) {
    if (model.startsWith(prefix) && prefix.length > best && Number.isFinite(w) && w > 0) { window = w; best = prefix.length; }
  }
  const pct = window ? Math.floor((mem.tokens * 100) / window) : null;
  return { tokens: mem.tokens, window, pct, model: mem.model ?? null, at: mem.at ?? null, compactions: mem.compactions ?? 0, warn: pct !== null && Number.isFinite(warnPct) && pct >= warnPct };
}

// marks — красные пометки по sessionId (В4: lib/waiting.mjs → buildMarks); без них — пустые списки
// contextWindow, memoryWarnPct — память треда (EXT-49): config.json → contextWindow, thresholds.memoryWarnPct
// Название живого треда: десктопное, иначе имя процесса, иначе custom-title журнала (1.4); общее для строки «Кто работает»
// и для «другого треда» пометки «Общий файл» (EXT-60)
export function liveTitle(p, desktop, sess) {
  const desk = p.hostSessionId && desktop ? desktop(p.hostSessionId) : null;
  return (typeof desk?.title === 'string' && desk.title) || p.name || sess?.thread?.customTitle || null;
}

export function buildThreads({ procs, desktop = () => null, sessions, board, mirrorIndex = null, maxTurns = () => null, now = Date.now(), staleMin = 15, marks = {}, slept = null, contextWindow = {}, memoryWarnPct = 80 }) {
  const nowMs = ms(now);
  const bySid = new Map();
  const endsByAgent = new Map();
  for (const s of sessions ?? []) {
    const prev = bySid.get(s.sessionId);
    if (!prev || (s.lines ?? 0) > (prev.lines ?? 0)) bySid.set(s.sessionId, s);
    for (const r of s.runs ?? []) if (!r.alive && r.lastEndAt) {
      if (!endsByAgent.has(r.agentId)) endsByAgent.set(r.agentId, []);
      endsByAgent.get(r.agentId).push({ sessionId: s.sessionId, at: r.lastEndAt });
    }
  }
  // один тред на сессию: два файла процесса с одним sessionId — свежее наблюдение
  const live = new Map();
  for (const p of procs ?? []) if (p.live && p.sessionId && (!live.has(p.sessionId) || p.observedAt > live.get(p.sessionId).observedAt)) live.set(p.sessionId, p);

  const unknownStatus = {};
  const unknownWaitingFor = {};
  const threads = [];
  for (const p of live.values()) {
    // status нет — первые секунды процесса (факт 02.10): известная форма, не в счётчик
    if (p.status != null && !KNOWN_STATUS.has(p.status)) unknownStatus[String(p.status)] = (unknownStatus[String(p.status)] ?? 0) + 1;
    const sess = bySid.get(p.sessionId) ?? null;
    const th = sess?.thread ?? {};
    const title = liveTitle(p, desktop, sess);
    const writes = cardRefs(sess, board, mirrorIndex);
    const card = cardOf(sess, board, writes);
    // первое упоминание раньше старта процесса (копия сессии несёт старую историю) — от startedAt
    const firstAt = card ? Math.max(firstMention(card, sess, writes), Number.isFinite(ms(p.startedAt)) ? ms(p.startedAt) : -Infinity) : NaN;
    const proj = projectOf(title, sess, board, writes);
    let waitingKind = null;
    if (p.status === 'waiting') {
      waitingKind = WAITING_FOR[p.waitingFor] ?? '?';
      if (waitingKind === '?') unknownWaitingFor[String(p.waitingFor)] = (unknownWaitingFor[String(p.waitingFor)] ?? 0) + 1;
    }
    const base = threadState({ status: p.status, askOpen: th.askOpen === true, endTurnQ: th.endTurnQ });
    // удачное наблюдение = запись реестра + хвост СВОЕГО журнала (чужой запертый журнал тред не старит)
    const observed = Number.isFinite(ms(sess?.okAt)) ? Math.min(p.observedAt, ms(sess.okAt)) : p.observedAt;
    // проспанное машиной время (5) — не «нет вестей»: треды на той же машине спали вместе с ней
    const stale = nowMs - observed - (slept ? slept(observed, nowMs) || 0 : 0) > staleMin * MIN;
    const subagents = subagentsOf(sess, endsByAgent, maxTurns);
    threads.push({
      sessionId: p.sessionId,
      title,
      project: proj.code,
      projectBy: proj.by,
      state: stale ? 'stale' : base,
      procStatus: p.status ?? null,
      // для В4: ключ уведомления «ждёт разрешения» — sessionId + statusUpdatedAt (текста и uuid у такого ожидания нет)
      statusUpdatedAt: iso(ms(p.statusUpdatedAt)),
      card,
      since: card && Number.isFinite(firstAt) ? iso(firstAt) : iso(ms(p.startedAt)),
      sinceKind: card && Number.isFinite(firstAt) ? 'card' : 'opened',
      lastSeenAt: iso(observed),
      subagents,
      // тред без проекта (правило (3)) — не цеховой: «Старые правила» ему не ставятся (EXT-54, спека 2.3)
      marks: (marks[p.sessionId] ?? []).filter((m) => proj.code || m.kind !== 'oldRules'),
      waitingKind: base !== 'waiting' ? null : waitingKind ?? (th.askOpen ? 'askUserQuestion' : 'question'),
      lastState: stale ? base : null,
      // EXT-49: «память N %» третьей строкой; null — в журнале ещё нет строки с usage. Жёлтое тред не поднимает.
      memory: memoryOf(sess?.memory, { contextWindow, warnPct: memoryWarnPct }),
      _lastEvent: Math.max(ms(th.lastAt) || 0, ms(p.statusUpdatedAt) || 0),
    });
  }
  // порядок (решение Ивана 10, слово Ивана 02.10 «только красные»): есть красная пометка → ждёт тебя → работает →
  // свободен → устарело; жёлтый такт тред не поднимает (пометка видна, тред стоит по своему состоянию)
  const rank = (t) => (t.marks.some(isRedMark) ? 0 : ORDER[t.state]);
  threads.sort((a, b) => rank(a) - rank(b) || b._lastEvent - a._lastEvent);
  for (const t of threads) delete t._lastEvent;
  return { threads, subagentsCount: threads.reduce((a, t) => a + t.subagents.length, 0), unknownStatus, unknownWaitingFor };
}
