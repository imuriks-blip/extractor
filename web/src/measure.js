// «Замерить остаток» (EXT-87; спека пульта §1.3, §1.7, §6 п.2): общее состояние для пункта меню «Служебное» и кнопки на экране
// «Расход». POST /api/act {action: "measure", intentId} — один запуск короткой сессии Claude, до 60 с; ответы: удача, reused (замер
// был меньше 5 мин назад), 409 measure-running, ошибка словами (measureAnswer). Данные для подписи — GET /api/usage (remaining,
// measures, measuring). Состояние живёт вне React: меню и экран видят одно и то же.
import { useSyncExternalStore } from 'react';
import { clear403, postAct, reloadOn403 } from './act.js';
import { usageSource } from './data.js';
import { measureAnswer } from './usageData.js';

let S = { u: null, busy: false, note: null };
const subs = new Set();
const set = (p) => { S = { ...S, ...p }; subs.forEach((f) => f()); };
const get = () => S;
const sub = (f) => { subs.add(f); return () => subs.delete(f); };
export const useMeasure = () => useSyncExternalStore(sub, get);

let intent = null; // ключ намерения без ответа (сбой сети) — повтор нажатием с тем же ключом

// свежие данные для подписи меню (экран «Расход» читает свой источник сам)
export async function loadUsage() {
  try {
    const r = await fetch('/api/usage', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    set({ u: await r.json() });
  } catch { /* прежние данные остаются */ }
}

export async function measure(resend) {
  if (S.busy) return;
  const payload = resend ?? (intent ?? { action: 'measure', intentId: crypto.randomUUID() });
  intent = payload;
  set({ busy: true, note: null });
  let r;
  try { r = await postAct(payload); } catch {
    set({ busy: false, note: { cls: 'pbad', text: 'нет связи с витриной — нажми ещё раз' } });
    return;
  }
  if (r.status === 403) {
    if (reloadOn403(payload)) return;
    intent = null;
    set({ busy: false, note: { cls: 'pbad', text: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' } });
    return;
  }
  clear403(payload.intentId);
  intent = null;
  set({ busy: false, note: measureAnswer(r.status, r.body) });
  await loadUsage();
  usageSource.reload?.(); // экран «Расход», если открыт, перечитывает свою ручку сразу
}
