// Подписи времени и чисел — по образцам макета «Цех».
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const p2 = (n) => String(n).padStart(2, '0');

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);

// Давность в списках («8 мин», «2 ч», «1 дн 4 ч», «6 дн»): ждёт меня, активность проекта.
export function ageShort(iso, now) {
  const d = now - ms(iso);
  if (!Number.isFinite(d)) return '—';
  if (d < MIN) return '<1 мин';
  if (d < HOUR) return `${Math.floor(d / MIN)} мин`;
  if (d < DAY) return `${Math.floor(d / HOUR)} ч`;
  const days = Math.floor(d / DAY), h = Math.floor((d % DAY) / HOUR);
  return days < 3 && h ? `${days} дн ${h} ч` : `${days} дн`;
}

// Длительность точнее («2 ч 40 мин», «1 ч 05 мин», «1 дн 5 ч»): идёт / открыт, такт без ответа.
export function dur(fromIso, now) {
  const d = now - ms(fromIso);
  if (!Number.isFinite(d)) return '—';
  if (d < MIN) return '<1 мин';
  if (d < HOUR) return `${Math.floor(d / MIN)} мин`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR), m = Math.floor((d % HOUR) / MIN);
    return m ? `${h} ч ${p2(m)} мин` : `${h} ч`;
  }
  const days = Math.floor(d / DAY), h = Math.floor((d % DAY) / HOUR);
  return h ? `${days} дн ${h} ч` : `${days} дн`;
}

// «N мин» для серой строки 2.7; меньше минуты — так и пишем.
export function minutes(fromMs, now) {
  const d = now - fromMs;
  return d < MIN ? 'меньше минуты' : `${Math.floor(d / MIN)} мин`;
}

export function hms(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
}

// «ЧЧ:ММ» сегодня, иначе «ДД.ММ ЧЧ:ММ».
export function hm(iso, now = Date.now()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const n = new Date(now);
  const time = `${p2(t.getHours())}:${p2(t.getMinutes())}`;
  return t.toDateString() === n.toDateString() ? time : `${p2(t.getDate())}.${p2(t.getMonth() + 1)} ${time}`;
}

// «ДД.ММ» — дата создания карточки.
export function dd(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : `${p2(t.getDate())}.${p2(t.getMonth() + 1)}`;
}

export function dm(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : `${p2(t.getDate())}.${p2(t.getMonth() + 1)} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
}

// Русское число: plural(4, ['тред', 'треда', 'тредов']) → «4 треда».
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${w}`;
}

// Самое старое из времён (наименьшее) — «журналы и доска · время» (2.7).
export function oldest(...isos) {
  const v = isos.filter(Boolean).map((x) => [ms(x), x]).filter(([t]) => Number.isFinite(t));
  if (!v.length) return null;
  return v.sort((a, b) => a[0] - b[0])[0][1];
}

// строка (а) «Тред ждёт ответа», которой ответить можно только в окне десктопа (EXT-77; спека пульта §2.4: при waiting Иван
// видит «тред ждёт тебя в десктопе: ответь там»): вид ожидания из waitingFor десктопа — askUserQuestion, permission или
// незнакомый «?». «Ответить» у таких строк нет; у вопроса в чате (question) подсказки нет. Вопрос окна «следующий шаг»
// (nextStep, EXT-107 Р1) — с подсказкой, только когда кнопок ответа нет (canReplyRow ложно; EXT-110 п.7): ветка с кнопками
// в Ceh.jsx подсказку не рисует
// Событие «тред сжат» в строке памяти треда (EXT-107 Р2): пока у памяти есть lastCompact (сервер держит его
// thresholds.compactShowH часов) — «сжат ЧЧ:ММ · 800 тыс. → 16 тыс. · вручную» («· сам» при auto) обычным цветом;
// без preTokens или postTokens — без чисел, без trigger — без способа. Позже — прежнее бледное «сжат N раз»; сжатий нет — null.
// Тысячи — целая часть без округления (800 537 — «800 тыс.»), как процент памяти.
const kTok = (n) => { const k = Math.floor(n / 1000); return `${k > 0 ? k : 'меньше 1'} тыс.`; };
const HOW = { manual: 'вручную', auto: 'сам' };
export function compactLine(m, now = Date.now()) {
  const c = m?.lastCompact;
  if (c?.at) {
    const parts = [`сжат ${hm(c.at, now)}`];
    if (Number.isFinite(c.pre) && Number.isFinite(c.post)) parts.push(`${kTok(c.pre)} → ${kTok(c.post)}`);
    if (HOW[c.trigger]) parts.push(HOW[c.trigger]);
    return { text: parts.join(' · '), faint: false };
  }
  const n = m?.compactions ?? 0;
  return n > 0 ? { text: `сжат ${plural(n, ['раз', 'раза', 'раз'])}`, faint: true } : null;
}

export const DESKTOP_HINT = 'ждёт тебя в десктопе — ответь там';
export const waitsInDesktop = (r) => typeof r?.kind === 'string' && r.kind !== 'question';

// Действие приложения — элемент окна с полем action (в том числе action: ''), то же правило, что у сервера (words.mjs,
// windowText: a.action !== undefined; EXT-110, Мелочь 4 ревью Голема). Кнопкой «ответ треду» оно не становится никогда.
const isAppAction = (a) => a.action !== undefined;
// кнопка «ответ треду» из элемента окна (EXT-110 п.1): только ответ (без action) с полем send — его ставит сервер (app.mjs, collect)
const sendOf = (a) => (a && typeof a === 'object' && !isAppAction(a) && typeof a.send === 'string' && a.send ? a.send : null);

// Чипы кнопок окна «следующий шаг» (EXT-107 Р1): серые, без нажатия. Ответ (элемент без action) — подпись label, в подсказке —
// что уйдёт треду: message, а нет его — сам label. Действие приложения — «действие: <action>», label не показывается
// (приложение его не использует); это кнопка десктопа, не ответ треду. {buttons: true} (EXT-110, «Цех» при кнопках): ответы
// с send — кнопки (stepWords), чипами остаются только действия и ответы без send. Без параметра — все чипы (окно проекта).
export function stepChips(actions, { buttons = false } = {}) {
  const out = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    if (isAppAction(a)) out.push({ text: typeof a.action === 'string' && a.action ? `действие: ${a.action}` : 'действие приложения', title: 'действие приложения — кнопка в окне десктопа, не ответ треду' });
    else if (buttons && sendOf(a) !== null) continue;
    else if (typeof a.label === 'string' && a.label) out.push({ text: a.label, title: typeof a.message === 'string' && a.message ? a.message : a.label });
  }
  return out;
}

// Кнопки-ответы окна «следующий шаг» (EXT-110 п.1) — слова пульта {action: 'reply', text: send, label, title, tail?, main?}.
// Подпись — label, без него — первые 24 знака message; title — ровно send; при send ≠ подписи — хвост «→ <начало send>»:
// 40 знаков (кодовые точки), переводы строк — пробелом, длиннее — 39 и «…». Дубли по send снимаются здесь (ключ слова в
// Pult.jsx — action + text): кнопкой становится первый, остальные не рисуются ни кнопкой, ни чипом. Первая — главная (pmain).
const WORD_LABEL_MAX = 24, TAIL_MAX = 40;
const NL = /\r\n|[\r\n]/g;
export function stepWords(actions) {
  const out = [], seen = new Set();
  for (const a of Array.isArray(actions) ? actions : []) {
    const send = sendOf(a);
    if (send === null || seen.has(send)) continue;
    seen.add(send);
    const label = typeof a.label === 'string' && a.label ? a.label
      : [...(typeof a.message === 'string' ? a.message : send).replace(NL, ' ')].slice(0, WORD_LABEL_MAX).join('');
    const flat = [...send.replace(NL, ' ')];
    const tail = send === label ? null : `→ ${flat.length > TAIL_MAX ? `${flat.slice(0, TAIL_MAX - 1).join('')}…` : flat.join('')}`;
    out.push({ action: 'reply', text: send, label, title: send, ...(tail ? { tail } : {}), ...(out.length ? {} : { main: true }) });
  }
  return out;
}

// Слова ответа строки (а) (§1.7, EXT-70; EXT-110 п.6): у question — «Ответить» и «го <ID>» при поле card строки; у nextStep —
// кнопки-ответы окна, затем «Ответить»; «го <ID>» нет (Д-1).
export function replyWords(r) {
  if (r?.kind === 'nextStep') return [...stepWords(r.actions), { action: 'reply' }];
  return [{ action: 'reply' }, ...(r?.card ? [{ action: 'reply', text: `го ${r.card}`, label: `го ${r.card}` }] : [])];
}

// Кнопки ответа у строки (а) (§1.7; EXT-110 п.1 «Когда»): вид question или nextStep, pult.words, у строки есть uuid (у keyTemp —
// нет) и звонок включён либо у треда есть карточка (tc — из «Кто работает»). Иначе прежний вид: чипы и DESKTOP_HINT.
export function canReplyRow(r, { wordsOn, bell, tc }) {
  return !!(wordsOn && (r?.kind === 'question' || r?.kind === 'nextStep') && r.uuid && (bell === true || tc));
}

// Метка треда прораба (EXT-107 Р4): серая «прораб · без окна», если семья известна — ещё «· от <название треда-дирижёра>»
// (foremanFrom). Обычный тред — null.
export function foremanLabel(t) {
  if (t?.foreman !== true) return null;
  return typeof t.foremanFrom === 'string' && t.foremanFrom ? `прораб · без окна · от ${t.foremanFrom}` : 'прораб · без окна';
}
