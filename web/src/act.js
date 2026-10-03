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

// 403 (§4.2): токен на запуск сервера — первая перезагрузка страницы с тем же намерением (true — уже перезагружаем),
// второй 403 подряд — false: «пульт отказал, перезапусти витрину»
export function reloadOn403(payload) {
  if (!store.get(sessionStorage, RELOAD_KEY)) {
    store.set(sessionStorage, RELOAD_KEY, JSON.stringify({ intentId: payload.intentId, at: Date.now(), payload }));
    window.location.reload();
    return true;
  }
  store.del(sessionStorage, RELOAD_KEY);
  return false;
}
export const clear403 = () => store.del(sessionStorage, RELOAD_KEY);

// намерение, прерванное перезагрузкой на 403, если оно свежее и его берёт этот получатель (mine(payload)); чужое не трогается
export function take403(mine) {
  let prev = null;
  try { prev = JSON.parse(store.get(sessionStorage, RELOAD_KEY)); } catch { prev = null; }
  if (!prev?.intentId) return null;
  if (Date.now() - prev.at >= RELOAD_FRESH_MS) { clear403(); return null; }
  const payload = prev.payload ?? { action: 'mirror', intentId: prev.intentId }; // запись до EXT-43 — только «Обновить»
  return mine(payload) ? payload : null;
}

// «дотянуть» (§3.2, таблица 1.3): та же кнопка «Обновить» в шапке — она регистрирует себя здесь, пока видна
let puller = null;
export const setPuller = (fn) => { puller = fn; return () => { if (puller === fn) puller = null; }; };
export const canPull = () => puller !== null;
export const pull = () => puller?.();
