// Общий опрос для всех блоков «Перечитать правила» на странице (EXT-65): один запрос /api/health и один /api/actions
// раз в POLL_MS, сколько бы блоков ни было. Блок подписывается и получает {on, rows}; последний отписался — опрос стоит.
// on = пульт включён (health.pult.enabled) И звонок включён (health.bell.on); сбой чтения health = «выключен».
// rows — строки reread со звонком (с полем session) от новых к старым; сбой чтения actions = прежние строки.
export const POLL_MS = 5000;

const subs = new Set();
let state = { on: false, rows: [] };
let timer = null;
let inflight = null;

async function poll() {
  const [on, rows] = await Promise.all([
    fetch('/api/health', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.pult?.enabled === true && j?.bell?.on === true).catch(() => false),
    fetch('/api/actions', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state = { on, rows: Array.isArray(rows) ? rows.filter((x) => x.action === 'reread' && x.ring && x.session) : state.rows };
  for (const f of [...subs]) f(state);
}

// сразу после нажатия — не ждать таймера; параллельные вызовы сливаются в один запрос
// fresh — после нажатия: опрос, начатый ДО ответа POST, строки просьбы ещё не видел — ждём его и делаем свежий
export function refreshNow(fresh = false) {
  if (inflight && fresh) {
    const p = inflight.then(() => poll()).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }
  inflight ??= poll().finally(() => { inflight = null; });
  return inflight;
}

export function subscribe(fn) {
  subs.add(fn);
  if (subs.size === 1) timer = setInterval(refreshNow, POLL_MS);
  fn(state);
  refreshNow();
  return () => {
    subs.delete(fn);
    if (!subs.size) { clearInterval(timer); timer = null; }
  };
}

// Кнопка неактивна (§1.8, то же правило, что отказ queued на сервере): просьба «положена» или доставлена меньше 10 минут назад;
// время — от доставки (ringAt, шаг ring-delivered по данным сервера), не от времени просьбы; «прочитано» окно не снимает.
export const FRESH_MS = 10 * 60_000;
export const inFlight = (row, now) => !!row && (row.ring === 'положено'
  || ((row.ring === 'доставлено' || row.ring === 'прочитано') && now - (Date.parse(row.ringAt) || Date.parse(row.at)) < FRESH_MS));

// «Последняя просьба» — то же правило, что на сервере (lib/pult/reread-last.mjs): новее по времени просьбы (at), при равенстве — по номеру
const newestReread = (items) => items.reduce((best, x) => {
  if (!best) return x;
  const dt = (Date.parse(x.at) || 0) - (Date.parse(best.at) || 0);
  return dt > 0 || (dt === 0 && String(x.id) > String(best.id)) ? x : best;
}, null);
export const lastFor = (rows, session) => newestReread(rows.filter((x) => x.session === session));
export { newestReread };
