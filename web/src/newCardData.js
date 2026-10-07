// «Новая карточка» (EXT-81, ПТ9; спека пульта §1.3, §1.4, §1.6, §1.7): данные кнопки без DOM — когда она видна, какие проекты
// в списке, когда «создать» активна, полезная нагрузка и вид исхода по ответу POST /api/act.
// Сервер — lib/pult/new-card.mjs: ответы и их слова оттуда.

export const TITLE_MAX = 120;
export const TEXT_MAX = 2000;
export const SIMILAR_SHOWN = 5;
export const NET_RETRY_MS = 9 * 60_000; // сервер помнит ключ намерения 10 мин; «повторить» тем же ключом — не дольше 9
export const NET_UNCLEAR_MESSAGE = 'нет связи с витриной — исход неясен: запрос мог дойти и создать карточку; проверь доску (повторять вслепую нельзя)';
// что даёт вид «исход неясен»: повторить нельзя никогда, скопировать — можно (вид и classifyReply берут решение отсюда)
export const UNCLEAR_ACTIONS = Object.freeze({ retry: false, copy: true });
// знаки как у сервера (кодовые точки): счётчик и обрезка
export const len = (s) => [...String(s ?? '')].length;
export const clip = (s, max) => { const a = [...String(s ?? '')]; return a.length > max ? a.slice(0, max).join('') : String(s ?? ''); };
// «нет связи»: «повторить» тем же intentId — до 9 мин от отправки; позже (или время неизвестно) — исход неясен
export const canRetryNet = (since, now) => Number.isFinite(since) && now - since >= 0 && now - since < NET_RETRY_MS;
// закрытие формы (отмена, Esc, кнопка «Новая карточка»): из «нет связи» — не молча, а в «исход неясен»; во время запроса — нельзя
export const closeAction = (phase) => (phase === 'net' ? 'unclear' : phase === 'busy' ? 'none' : phase === 'unclear' ? 'reset' : 'close');

export const NO_NEW_CARD = ['RADAR']; // в RADAR карточка рождается с вердиктом — заводит дирижёр (сервер откажет и сам)

// кнопка — только при включённых пульте и словах (иначе ответ 503); у RADAR кнопки нет
export const canNewCard = (pult) => pult?.enabled === true && pult?.words === true;
export const canNewCardIn = (pult, code = null) => canNewCard(pult) && !(code && NO_NEW_CARD.includes(code));

// список проектов в форме «Цеха»: коды из данных, без RADAR
export const projectChoices = (projects) => (Array.isArray(projects) ? projects : []).map((p) => p?.code).filter((c) => typeof c === 'string' && c && !NO_NEW_CARD.includes(c));

// «создать» активна: проект выбран (и не RADAR), заголовок не пуст, длины в пределах
export const canSubmit = ({ project, title, text }) => !!project && !NO_NEW_CARD.includes(project)
  && String(title ?? '').trim().length > 0 && len(title) <= TITLE_MAX && len(text) <= TEXT_MAX;

// text — только если не пуст; confirm — id ответа (второй щелчок / «это не секрет»); намерение новое — id даёт вызывающий
export const buildPayload = ({ project, title, text }, intentId, confirm = null) => ({
  action: 'new-card', intentId, project, title: String(title).trim(),
  ...(String(text ?? '').trim() ? { text: String(text).trim() } : {}),
  ...(confirm ? { confirm } : {}),
});

const isUnclear = (m) => /^исход неясен/.test(m);
const isNotCreated = (m) => /^не создана/.test(m);
const idIn = (m) => /([A-Z]{2,6}-\d+)/.exec(String(m ?? ''))?.[1] ?? null;

// Ответ → вид исхода. kind:
//  created      — создана: created (номер) · форма закрывается и очищается
//  confirm      — похожие: similar [{id,title}] (до 5), mirrorAt, what, id (для второго щелчка)
//  secret       — «похоже на секрет»: только «поправить текст»
//  secret-maybe — то же + «это не секрет — отправить» (rid — id отказа)
//  retype       — подтверждение не то / просрочено: «нажми заново», форма с текстом
//  not-created  — точно не создана: форма с текстом, «создать» можно заново (новый intentId)
//  unclear      — исход неясен: НИКАКОГО повтора одним щелчком, только «закрыть» и «скопировать текст»
//  refused / error / off (503) / none (501) — сообщение словами, форма остаётся
// retry — можно ли предложить «создать» тем же вводом; copy — «скопировать текст»
export function classifyReply(status, body) {
  const b = body && typeof body === 'object' ? body : {};
  const message = typeof b.message === 'string' ? b.message : '';
  if (status === 503) return { kind: 'off', message: message || 'пульт или слова выключены', retry: false, copy: false };
  if (status === 501) return { kind: 'none', message: message || 'ещё не подключено', retry: false, copy: false };
  if (status === 200 && b.outcome === 'need-confirm' && b.confirm) {
    const c = b.confirm;
    return { kind: 'confirm', id: b.id, what: c.what ?? '', follows: c.follows ?? '', mirrorAt: c.mirrorAt ?? null,
      similar: (Array.isArray(c.similar) ? c.similar : []).slice(0, SIMILAR_SHOWN), message, retry: false, copy: false };
  }
  if (status === 200 && b.outcome === 'ok') {
    const created = typeof b.created === 'string' ? b.created : idIn(message);
    return { kind: 'created', created, message, retry: false, copy: false };
  }
  if (b.outcome === 'refused') {
    switch (b.refusal) {
      case 'secret': return { kind: 'secret', message, retry: false, copy: false };
      case 'secret-maybe': return b.id ? { kind: 'secret-maybe', rid: b.id, message, retry: false, copy: false } : { kind: 'secret', message, retry: false, copy: false };
      case 'bad-confirm':
      case 'confirm-expired': return { kind: 'retype', message, retry: false, copy: false };
      default: return { kind: 'refused', message: message || `отказ: HTTP ${status}`, retry: false, copy: false };
    }
  }
  // 5xx без внятного ответа — запись могла лечь: как «исход неясен» (повторять вслепую нельзя)
  if (status >= 500 || (b.outcome === 'error' && isUnclear(message))) {
    return { kind: 'unclear', message: isUnclear(message) ? message : 'исход неясен — проверь доску: карточка могла создаться (повторять вслепую нельзя)', ...UNCLEAR_ACTIONS };
  }
  if (b.outcome === 'error' && isNotCreated(message)) return { kind: 'not-created', message, retry: true, copy: false };
  return { kind: 'error', message: message || `ошибка: HTTP ${status}`, retry: false, copy: false };
}

// тот же текст, что кнопка «скопировать текст» кладёт в буфер
export const copyText = ({ title, text }) => [String(title ?? '').trim(), String(text ?? '').trim()].filter(Boolean).join('\n\n');
