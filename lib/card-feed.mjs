// Карточка (спека витрины 2.6, 3.3; такт В5): связи со встречной стороной и лента — комменты журнала, коммиты, запуски.
// Тексты уходят в ручку как есть — маску накладывает общий хук ответа сетью проекта карточки (6.2).
import { WHO } from './threads.mjs';

const ms = (t) => (t == null ? NaN : Date.parse(t));
const num = (id) => Number(String(id).split('-')[1]);
const byId = (a, b) => (a.id.split('-')[0] === b.id.split('-')[0] ? num(a.id) - num(b.id) : a.id < b.id ? -1 : 1);

// Связи (§1.3 спеки доски: хранятся один раз, на карточке, где завели): из шапки — parent, blocks, blocked_by, relates;
// встречные — обходом шапок доски: «← блокирует её» (их blocks), «← связана» (их relates), «ждёт её» (их blocked_by), дети.
export function buildLinks(board, id, header) {
  const ref = (x) => ({ id: x, title: board.card(x)?.title ?? null });
  const list = (a) => (Array.isArray(a) ? a : []).map(ref);
  const blockingIt = [];
  const relatedFrom = [];
  const blockedByIt = [];
  const children = [];
  for (const c of board.cardsList()) {
    if (c.id === id || !c.links) continue;
    const one = { id: c.id, title: c.title ?? null };
    if (c.links.blocks.includes(id)) blockingIt.push(one);
    if (c.links.relates.includes(id)) relatedFrom.push(one);
    if (c.links.blockedBy.includes(id)) blockedByIt.push(one);
    if (c.links.parent === id) children.push(one);
  }
  return {
    parent: header?.parent ? ref(header.parent) : null,
    blocks: list(header?.blocks),
    blockedBy: list(header?.blocked_by),
    relates: list(header?.relates),
    blockingIt: blockingIt.sort(byId),
    relatedFrom: relatedFrom.sort(byId),
    blockedByIt: blockedByIt.sort(byId),
    children: children.sort(byId),
  };
}

// Запуски Agent с номером карточки в prompt (индекс В2: run.cards). Один запуск лежит и в копиях сессии продолженного
// треда — в ленте один раз: закончен, если в какой-то копии конец не раньше последней активности запуска во всех копиях.
// Итог: «работает» / «обрыв · PARTIAL» (последний конец — с признаком тормоза) / «готово».
export function cardRuns(sessions, id, maxTurns = () => null) {
  const groups = new Map();
  const partials = new Map();
  for (const s of sessions ?? []) {
    for (const p of s.partials ?? []) { if (!partials.has(p.agentId)) partials.set(p.agentId, []); partials.get(p.agentId).push(p); }
    for (const r of s.runs ?? []) {
      if (!(r.cards ?? []).includes(id)) continue;
      if (!groups.has(r.agentId)) groups.set(r.agentId, []);
      groups.get(r.agentId).push(r);
    }
  }
  const out = [];
  for (const [agentId, copies] of groups) {
    const last = Math.max(...copies.map((r) => ms(r.lastAt ?? r.at)).filter(Number.isFinite), -Infinity);
    const ended = copies.filter((r) => r.lastEndAt && ms(r.lastEndAt) >= last).sort((a, b) => ms(b.lastEndAt) - ms(a.lastEndAt))[0] ?? null;
    const alive = !ended && copies.some((r) => r.alive);
    const rep = ended ?? copies.slice().sort((a, b) => ms(b.lastAt ?? b.at) - ms(a.lastAt ?? a.at))[0];
    const endAt = ended ? ms(ended.lastEndAt) : NaN;
    const partial = !alive && ended && (partials.get(agentId) ?? []).some((p) => ms(p.at) >= endAt);
    const at = copies.map((r) => r.at).filter(Boolean).sort((a, b) => ms(a) - ms(b))[0] ?? null;
    const agent = rep.agentType ?? null;
    out.push({
      kind: 'run', at, agent, who: WHO[agent] ?? agent, description: rep.description ?? null,
      turnsTotal: rep.turns ?? null, entries: Array.isArray(rep.zakhods) ? rep.zakhods.length : null, // zakhods индекса — ходы по заходам
      maxTurns: agent ? maxTurns(agent) : null, target: rep.target ?? null,
      result: alive ? 'работает' : partial ? 'обрыв · PARTIAL' : 'готово',
    });
  }
  return out;
}

// Лента, новые сверху: коммент — каждая запись журнала (время заголовка, автор кроме plane, вид, тело);
// коммит — {hash, at, subject, repo, branch} читателя git; запуск — cardRuns.
export function buildFeed({ logEntries = [], commits = [], runs = [] }) {
  const comments = logEntries.map((e) => ({ kind: 'comment', at: Number.isFinite(e.ms) ? new Date(e.ms).toISOString() : null, author: e.as === 'plane' ? null : e.as, logKind: e.kind, body: e.body, _i: e.index ?? 0 }));
  // время — одним видом: ISO UTC (коммиты приходят со смещением, %cI)
  const utc = (t) => (Number.isFinite(ms(t)) ? new Date(ms(t)).toISOString() : t ?? null);
  const feed = [...comments, ...commits.map((c) => ({ kind: 'commit', ...c, at: utc(c.at) })), ...runs.map((r) => ({ ...r, at: utc(r.at) }))];
  // при равном времени — позже в файле журнала выше (§1.4 спеки доски)
  feed.sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0) || (b._i ?? 0) - (a._i ?? 0));
  for (const f of feed) delete f._i;
  const counts = { comment: 0, commit: 0, run: 0 };
  for (const f of feed) counts[f.kind]++;
  return { feed, counts };
}
