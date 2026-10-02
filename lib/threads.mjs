// Строки «Кто работает» (спека витрины 2.1, 1.4, 2.2, 3.1; такт В3): живые треды из реестра процессов, состояние,
// проект, карточка, «идёт / открыт», живые субагенты. Чистая функция над выжимками читателей — без чтения диска.
// Красные пометки (marks) и «Ждёт меня» — такт В4: здесь marks — пустой список.
import { resolveRef } from './journal-parse.mjs';

const MIN = 60000;
// Словарь агентов (2.2); неизвестный тип — как есть
export const WHO = { golem: 'Голем', clap: 'Клапауций', terminus: 'Терминус', bard: 'Бальд', demon: 'Демон', tikhiy: 'Тихий' };
const KNOWN_STATUS = new Set(['busy', 'idle']);
// Название по конвенции (1.4): «<КОД> · …» или «<КОД>: …» в самом начале; \b не используется — рядом кириллица
const TITLE_CODE = /^([A-Z]{2,6})(?: · |: )/;
const TAKT_ISSUED = /^▶\s*выдан/; // маркер — с двоеточием и без (1.4)
const ORDER = { waiting: 1, busy: 2, idle: 3, stale: 4 };

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const ms = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

// Состояние живого треда (2.1): (А) — при любом status; (Б) — только при status ≠ busy; незнакомый status — как не busy
export function threadState({ status, askOpen, endTurnQ }) {
  if (askOpen) return 'waiting';
  if (status === 'busy') return 'busy';
  if (endTurnQ === true) return 'waiting';
  return 'idle';
}

function cardRefs(sess, board, mirrorIndex) {
  const out = [];
  for (const w of sess?.boardWrites ?? []) {
    const ids = (w.refs ?? []).map((r) => resolveRef(r, mirrorIndex)).filter((id) => id && board.hasCard(id));
    out.push({ at: w.at, ids, issued: TAKT_ISSUED.test(String(w.firstLine ?? '').trim()) });
  }
  return out;
}

export function projectOf(title, sess, board, writes) {
  const m = typeof title === 'string' ? title.match(TITLE_CODE) : null;
  if (m && board.hasCode(m[1])) return m[1];
  const n = {};
  for (const [id, e] of Object.entries(sess?.ivan?.cards ?? {})) if (board.hasCard(id)) n[id.split('-')[0]] = (n[id.split('-')[0]] ?? 0) + (e.n ?? 1);
  for (const w of writes) for (const id of w.ids) n[id.split('-')[0]] = (n[id.split('-')[0]] ?? 0) + 1;
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > total / 2 ? top[0] : null;
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
    out.push({ agent: r.agentType ?? null, who: WHO[r.agentType] ?? r.agentType ?? null, description: r.description ?? null, turns: r.currentZakhod ?? 0, maxTurns: r.agentType ? maxTurns(r.agentType) : null, target: r.target ?? null });
  }
  return out;
}

export function buildThreads({ procs, desktop = () => null, sessions, board, mirrorIndex = null, maxTurns = () => null, now = Date.now(), staleMin = 15, journalsOkAt = null }) {
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
  const threads = [];
  for (const p of live.values()) {
    if (!KNOWN_STATUS.has(p.status)) unknownStatus[String(p.status)] = (unknownStatus[String(p.status)] ?? 0) + 1;
    const sess = bySid.get(p.sessionId) ?? null;
    const th = sess?.thread ?? {};
    const desk = p.hostSessionId ? desktop(p.hostSessionId) : null;
    const title = (typeof desk?.title === 'string' && desk.title) || p.name || null;
    const writes = cardRefs(sess, board, mirrorIndex);
    const card = cardOf(sess, board, writes);
    const firstAt = card ? firstMention(card, sess, writes) : NaN;
    const base = threadState({ status: p.status, askOpen: th.askOpen === true, endTurnQ: th.endTurnQ });
    const observed = Number.isFinite(ms(journalsOkAt)) ? Math.min(p.observedAt, ms(journalsOkAt)) : p.observedAt;
    const stale = nowMs - observed > staleMin * MIN;
    const subagents = subagentsOf(sess, endsByAgent, maxTurns);
    threads.push({
      sessionId: p.sessionId,
      title,
      project: projectOf(title, sess, board, writes),
      state: stale ? 'stale' : base,
      procStatus: p.status ?? null,
      card,
      since: card && Number.isFinite(firstAt) ? iso(firstAt) : iso(ms(p.startedAt)),
      sinceKind: card && Number.isFinite(firstAt) ? 'card' : 'opened',
      lastSeenAt: iso(observed),
      subagents,
      marks: [],
      waitingKind: base !== 'waiting' ? null : th.askOpen ? 'askUserQuestion' : 'question',
      lastState: stale ? base : null,
      _lastEvent: Math.max(ms(th.lastAt) || 0, ms(p.statusUpdatedAt) || 0),
    });
  }
  threads.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b._lastEvent - a._lastEvent);
  for (const t of threads) delete t._lastEvent;
  return { threads, subagentsCount: threads.reduce((a, t) => a + t.subagents.length, 0), unknownStatus };
}
