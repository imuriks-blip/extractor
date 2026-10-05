// Словарь действий пульта (спека пульта §1.3) и проверка параметров (§1.1 п.2) — до любого действия.
// ПТ1: у настоящих действий обработчиков нет — вход отвечает 501 «ещё не подключено» без записи во внешний мир
// (подключают ПТ3, ПТ6, ПТ8, ПТ8б, ПТ9). Обработчик есть только у пустышки ping — исправный случай каркаса.
// Поля словаря: label — имя из таблицы; word — кнопка-слово (держится флагом pult.words, §4.3);
// card / project — 'required' | 'optional' (нет поля — параметр не принимается); text / title — {max, required};
// kind — допустимые виды, первый — по умолчанию (вид прохода зеркала, EXT-42).
import { UNTIL } from './defer.mjs';

const WORD = { word: true, card: 'required', pick: 'optional' };
export const ACTIONS = {
  yes: { label: 'да', ...WORD },
  go: { label: 'го', ...WORD },
  merge: { label: 'сливай', ...WORD },
  deploy: { label: 'выкатывай', ...WORD },
  no: { label: 'нет', ...WORD, text: { max: 300 } },
  // строка (а) — тред без карточки (session), строка (б) и тред с карточкой — card
  reply: { label: 'ответ треду', word: true, card: 'optional', session: 'optional', pick: 'optional', oneOf: ['card', 'session'], text: { max: 500, required: true } },
  // q — запись-вопрос карточки {at, head} или {at: null} (§1.1 п.5): обязателен, форма треда {uuid, at} не годится (ПТ3)
  accept: { label: 'Принять', card: 'required', q: 'card' },
  return: { label: 'Вернуть', card: 'required', q: 'card', text: { max: 500, required: true } },
  take: { label: 'В работу', card: 'required', session: 'optional', pick: 'optional' },
  // full (ПТ8) — первый щелчок: need-confirm с ценой, ничего не запущено; второй щелчок с confirm (номер первого) — запуск
  // (routes.mjs: проверка подтверждения — bad-confirm, confirm-expired; запуск — mirror-run.mjs)
  mirror: { label: 'Прогони зеркало', kind: ['changed', 'full'] },
  cleanup: { label: 'Прибери отслужившие рабочие копии' },
  reindex: { label: 'Пересобрать индекс' },
  'new-card': { label: 'Новая карточка / мысль', project: 'required', title: { max: 120, required: true }, text: { max: 2000 } },
  // EXT-47: личная отметка на строке «Ждёт меня» — не слово по карточке (в Plane ничего); rowKey — key строки (спека
  // витрины 1.6), until — срок из меню (defer.mjs, UNTIL)
  defer: { label: 'Отложить до …', rowKey: 'required', until: UNTIL },
  undefer: { label: 'Вернуть сейчас', rowKey: 'required' },
  // EXT-65, §1.8: вход ровно {action, intentId, session}; пути и список missing берёт сервер сам, любое иное поле — 400
  // (в том числе q и confirm: код проверяет их только по форме, для reread они отбиваются явно — exact)
  reread: { label: 'Перечитать правила', session: 'required', exact: true },
  // пустышка каркаса (ПТ1): проходит весь путь — защита, словарь, intentId, лимиты, asked → done
  ping: { label: 'проверка пульта', card: 'optional' },
};

// обработчики по умолчанию: только пустышка; ctx — {id, action, card, project, plane (очередь записей в Plane)}
export const HANDLERS = {
  ping: async () => ({ outcome: 'ok', message: 'пульт на связи' }),
};

const CARD_RE = /^([A-Z]{2,6})-(\d+)$/;
const CODE_RE = /^[A-Z]{2,6}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTION_ID_RE = /^W-\d{6}-\d{6}-[0-9a-f]{4}$/;
const KEYS = new Set(['action', 'intentId', 'card', 'session', 'text', 'title', 'project', 'q', 'confirm', 'pick', 'kind', 'rowKey', 'until']);
// key строки «Ждёт меня»: sessionId|uuid, номер|заголовок записи журнала («2026-10-01 11:05 +03:00 · plane · коммент») —
// без управляющих символов, до 300 знаков
const ROW_KEY_MAX = 300;
// в ключе строки не бывает ни одного управляющего символа, перевода строки тоже (М7)
const ROW_KEY_BAD = /[\u0000-\u001F\u007F-\u009F]/;
// управляющие символы прочь (§1.1 п.2), перевод строки остаётся (ответ — одна–три строки)
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
export const cleanText = (s) => s.replace(CONTROL, '');

// q — ровно {at, head} (запись-вопрос карточки: at — время или null, head — до 60 знаков после снятия управляющих;
// у карточки без записей — {at: null}, head можно не слать, Н2) или {uuid, at} (сообщение треда). Иное — null.
// время — только ISO с поясом (как заголовки доски и created_at Plane): 2026-10-02T19:40+03:00, …T09:00:41.018Z;
// не любая строка, которую понимает Date.parse («October 3, 2026», «1») — мелочь Голема ПТ1, сужено в ПТ3
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const timeOrNull = (x) => x === null || (typeof x === 'string' && ISO_TIME.test(x) && Number.isFinite(Date.parse(x)));
export function validQ(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  const keys = Object.keys(q).sort().join(',');
  if (keys === 'at,uuid') return typeof q.uuid === 'string' && UUID_RE.test(q.uuid) && timeOrNull(q.at) ? { uuid: q.uuid, at: q.at } : null;
  if (keys !== 'at,head' && !(keys === 'at' && q.at === null)) return null;
  if (!timeOrNull(q.at)) return null;
  if (q.head === undefined) return { at: null };
  if (typeof q.head !== 'string') return null;
  const head = cleanText(q.head);
  return [...head].length <= 60 ? { at: q.at, head } : null;
}

// body → {ok: true, value} | {ok: false, why}; why — имя поля, без текста Ивана
export function validate(body, { hasCode }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, why: 'body' };
  for (const k of Object.keys(body)) if (!KEYS.has(k)) return { ok: false, why: 'field' };
  const spec = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!spec) return { ok: false, why: 'action' };
  if (typeof body.intentId !== 'string' || !UUID_RE.test(body.intentId)) return { ok: false, why: 'intentId' };
  const v = { action: body.action, intentId: body.intentId.toLowerCase() };
  if (spec.exact) for (const k of Object.keys(body)) if (!['action', 'intentId', 'session'].includes(k)) return { ok: false, why: k === 'q' || k === 'confirm' ? k : 'field' };
  if (spec.session === 'required' && body.session === undefined) return { ok: false, why: 'session' };
  const allowed = (name) => spec[name] !== undefined;
  for (const name of ['card', 'session', 'project', 'pick', 'text', 'title', 'kind', 'rowKey', 'until']) {
    if (body[name] !== undefined && !allowed(name)) return { ok: false, why: name };
  }
  if (spec.kind) {
    if (body.kind !== undefined && !spec.kind.includes(body.kind)) return { ok: false, why: 'kind' };
    v.kind = body.kind ?? spec.kind[0];
  }
  if (body.card !== undefined) {
    const m = typeof body.card === 'string' ? body.card.match(CARD_RE) : null;
    if (!m || hasCode(m[1]) !== true) return { ok: false, why: 'card' };
    v.card = body.card;
    v.project = m[1];
  } else if (spec.card === 'required') return { ok: false, why: 'card' };
  if (body.project !== undefined) {
    if (typeof body.project !== 'string' || !CODE_RE.test(body.project) || hasCode(body.project) !== true) return { ok: false, why: 'project' };
    v.project = body.project;
  } else if (spec.project === 'required') return { ok: false, why: 'project' };
  for (const name of ['session', 'pick']) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'string' || !UUID_RE.test(body[name])) return { ok: false, why: name };
    v[name] = body[name].toLowerCase(); // UUID — без учёта регистра; треды и журналы — в нижнем (как intentId выше)
  }
  if (spec.oneOf && !spec.oneOf.some((k) => v[k] !== undefined)) return { ok: false, why: spec.oneOf.join('|') };
  if (spec.rowKey) {
    const k = body.rowKey;
    if (typeof k !== 'string' || !k || ROW_KEY_BAD.test(k) || [...k].length > ROW_KEY_MAX) return { ok: false, why: 'rowKey' };
    v.rowKey = k;
  }
  if (spec.until) {
    if (!spec.until.includes(body.until)) return { ok: false, why: 'until' };
    v.until = body.until;
  }
  for (const name of ['text', 'title']) {
    const lim = spec[name];
    if (!lim) continue;
    if (body[name] === undefined) { if (lim.required) return { ok: false, why: name }; continue; }
    if (typeof body[name] !== 'string') return { ok: false, why: name };
    const t = cleanText(body[name]);
    if ([...t].length > lim.max || (lim.required && !t.trim())) return { ok: false, why: name };
    v[name] = t;
  }
  // q (привязка к вопросу, §1.1 п.5) и confirm (второй щелчок, п.7) — их смысл проверяют ПТ3/ПТ6; здесь — форма
  if (body.q !== undefined) {
    const q = validQ(body.q);
    if (!q) return { ok: false, why: 'q' };
    v.q = q;
  }
  if (spec.q === 'card' && (!v.q || v.q.uuid !== undefined)) return { ok: false, why: 'q' };
  if (body.confirm !== undefined) {
    if (typeof body.confirm !== 'string' || !ACTION_ID_RE.test(body.confirm)) return { ok: false, why: 'confirm' };
    v.confirm = body.confirm;
  }
  return { ok: true, value: v };
}
