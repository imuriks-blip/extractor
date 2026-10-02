// Доска проекта (спека витрины 2.5, 3.2; такт В5): колонки «В работе», «В очереди», «Review», свёрнутые Backlog и Done.
// Давность карточки — max(updated, время последней записи журнала) (§1.2 спеки доски, как у (в) «Ждёт меня»);
// в колонке свежие сверху; Done — последние сверху, cancelled — в Done с пометкой. Поиск — на стороне браузера:
// списки отдаются целиком. agentWorking — живой субагент В3, несущий номер карточки в ТЗ (subagents[].cards).
const ms = (t) => (t == null ? NaN : Date.parse(t));

function ageAt(c) {
  const a = ms(c.updated);
  const b = ms(c.last?.at);
  const m = Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(b) ? b : -Infinity);
  return Number.isFinite(m) ? new Date(m).toISOString() : null;
}
const fresh = (x, y) => (ms(y.at) || 0) - (ms(x.at) || 0);

export function buildProjectBoard(cards, code, workingByCard = new Map()) {
  const out = { inProgress: [], ready: [], review: [], backlog: [], done: [] };
  const COL = { 'in-progress': 'inProgress', ready: 'ready', review: 'review' };
  for (const c of cards) {
    if (c.code !== code) continue;
    const at = ageAt(c);
    const col = COL[c.status];
    if (col) {
      out[col].push({
        id: c.id, title: c.title, label: c.label ?? null, markB: c.markB === true, at,
        agentWorking: workingByCard.get(c.id) ?? null,
        lastLog: c.last?.line != null ? { text: c.last.line, author: c.last.author ?? null } : null,
      });
    } else if (c.status === 'backlog') out.backlog.push({ id: c.id, title: c.title, label: c.label ?? null, at });
    else if (c.status === 'done' || c.status === 'cancelled') out.done.push({ id: c.id, title: c.title, at, cancelled: c.status === 'cancelled' });
  }
  for (const k of Object.keys(out)) out[k].sort(fresh);
  // заголовок блока «N живых · M в Backlog · K Done»
  out.counts = { live: out.inProgress.length + out.ready.length + out.review.length, backlog: out.backlog.length, done: out.done.length };
  return out;
}

// Живые субагенты строк «Кто работает» (В3) → номер карточки из ТЗ → кто работает (первый найденный)
export function workingByCard(threads) {
  const m = new Map();
  for (const t of threads ?? []) for (const s of t.subagents ?? []) for (const id of s.cards ?? []) if (!m.has(id)) m.set(id, s.who ?? s.agent ?? null);
  return m;
}
