// Отметка строки (а) «Ждёт меня» (EXT-70, спека пульта §1.7 «Местная отметка»): после «Ответить» / «го <ID>» (оба — действие
// reply из строки: session и q.uuid) сервер отдаёт у строки pultMark той же формы {id, action, at, state, ring}; страница
// по ring решает, активны ли кнопки (неактивны, пока ring ∈ {«положено», «доставлено»}). Ключ — `<session>|<q.uuid>`
// (тот же, что key строки (а): sessionId|uuid вопроса); новый вопрос — новый uuid, отметка к нему не липнет.
// Ставится только при исходе ok. «Последняя просьба» по ключу — то же правило, что у «Перечитать правила»
// (reread-last.mjs: новее по времени просьбы, при равенстве — больший номер действия), не дубль.
import { newestReread } from './reread-last.mjs';

export const rowMarkKey = (session, uuid) => `${session}|${uuid}`;

// → Map ключ → отметка. ring(ls) — статус звонка 2.8 по строкам действия (routes.mjs), считается только у последней просьбы
export function rowMarks({ lines, ring = null }) {
  const byId = new Map();
  for (const l of lines) if (typeof l?.id === 'string') byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  const byKey = new Map();
  for (const [aid, ls] of byId) {
    const asked = ls.find((l) => l.step === 'asked');
    if (asked?.action !== 'reply' || typeof asked.session !== 'string' || typeof asked.q?.uuid !== 'string') continue;
    const done = ls.find((l) => l.step === 'done' && l.result?.outcome === 'ok');
    if (!done) continue;
    const key = rowMarkKey(asked.session, asked.q.uuid);
    byKey.set(key, [...(byKey.get(key) ?? []), { id: aid, at: asked.at, ls, record: done.result?.record ?? aid, planeAt: done.result?.planeAt ?? null }]);
  }
  const out = new Map();
  for (const [key, items] of byKey) {
    const last = newestReread(items);
    const at = Date.parse(last.planeAt ?? last.at);
    out.set(key, { id: last.record, action: 'reply', at: Number.isFinite(at) ? new Date(at).toISOString() : null, state: null, ring: ring ? ring(last.ls) ?? null : null });
  }
  return out;
}
