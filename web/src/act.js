// Общее для кнопок пульта (спека пульта §1.1 п.3, §1.7, §4.2): POST /api/act с секретом страницы из <meta>, одна
// перезагрузка страницы после 403 с тем же ключом намерения, «дотянуть» — вызов «Обновить» в шапке.
// Пользуются «Обновить» (Mirror.jsx, EXT-42) и «Принять»/«Вернуть» (Pult.jsx, EXT-43).

export const RELOAD_KEY = 'vitrina.act403'; // {intentId, at, payload}: страница перезагружена после 403
const RELOAD_FRESH_MS = 60000;

export const token = () => document.querySelector('meta[name="vitrina-token"]')?.content ?? '';
// в хранилище браузера — не сам секрет страницы (§4.1 п.6), а его отпечаток: FNV-1a 32 бита (мелочь Голема на EXT-42)
export const tokenMark = (t) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return t ? h.toString(16) : '';
};
export const store = {
  get(s, k) { try { return s.getItem(k); } catch { return null; } },
  set(s, k, v) { try { s.setItem(k, v); } catch { /* хранилище недоступно — без памяти */ } },
  del(s, k) { try { s.removeItem(k); } catch { /* то же */ } },
};

// → {status, body}; сбой сети — исключение (повтор — тем же intentId, §1.1 п.3)
export async function postAct(payload) {
  const r = await fetch('/api/act', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vitrina-Token': token() },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const read403 = () => { try { return JSON.parse(store.get(sessionStorage, RELOAD_KEY)); } catch { return null; } };

// 403 (§4.2): токен на запуск сервера — первая перезагрузка страницы с тем же намерением (true — уже перезагружаем),
// второй 403 подряд на том же намерении — false: «пульт отказал, перезапусти витрину»
export function reloadOn403(payload) {
  if (read403()?.intentId !== payload.intentId) {
    store.set(sessionStorage, RELOAD_KEY, JSON.stringify({ intentId: payload.intentId, at: Date.now(), payload }));
    window.location.reload();
    return true;
  }
  store.del(sessionStorage, RELOAD_KEY);
  return false;
}
// ответ пришёл — запись снимается, только если она про это намерение (чужое ждёт своего получателя)
export const clear403 = (intentId) => { if (read403()?.intentId === intentId) store.del(sessionStorage, RELOAD_KEY); };

// намерение, прерванное перезагрузкой на 403, если оно свежее и его берёт этот получатель (mine(payload)); чужое не
// трогается. Запись не снимается здесь — её снимает ответ (clear403) или второй 403 (reloadOn403), иначе повтор зациклится
export function take403(mine) {
  const prev = read403();
  if (!prev?.intentId) return null;
  if (Date.now() - prev.at >= RELOAD_FRESH_MS) { store.del(sessionStorage, RELOAD_KEY); return null; }
  const payload = prev.payload ?? { action: 'mirror', intentId: prev.intentId }; // запись до EXT-43 — только «Обновить»
  return mine(payload) ? payload : null;
}

// «дотянуть» (§3.2, таблица 1.3): та же кнопка «Обновить» в шапке — она регистрирует себя здесь, пока видна
let puller = null;
export const setPuller = (fn) => { puller = fn; return () => { if (puller === fn) puller = null; }; };
export const canPull = () => puller !== null;
// → 'started' | 'busy' (проход уже идёт или запускается) | 'off' (пульт выключен) | null (кнопки нет)
export const pull = () => (puller ? puller() : null);
