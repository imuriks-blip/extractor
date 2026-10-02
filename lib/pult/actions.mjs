// Словарь действий пульта (спека пульта §1.3) и проверка параметров (§1.1 п.2) — до любого действия.
// ПТ1: у настоящих действий обработчиков нет — вход отвечает 501 «ещё не подключено» без записи во внешний мир
// (подключают ПТ3, ПТ6, ПТ8, ПТ8б, ПТ9). Обработчик есть только у пустышки ping — исправный случай каркаса.
// Поля словаря: label — имя из таблицы; word — кнопка-слово (держится флагом pult.words, §4.3);
// card / project — 'required' | 'optional' (нет поля — параметр не принимается); text / title — {max, required}.
const WORD = { word: true, card: 'required' };
export const ACTIONS = {
  yes: { label: 'да', ...WORD },
  go: { label: 'го', ...WORD },
  merge: { label: 'сливай', ...WORD },
  deploy: { label: 'выкатывай', ...WORD },
  no: { label: 'нет', ...WORD, text: { max: 300 } },
  // строка (а) — тред без карточки (session), строка (б) и тред с карточкой — card
  reply: { label: 'ответ треду', word: true, card: 'optional', session: 'optional', oneOf: ['card', 'session'], text: { max: 500, required: true } },
  accept: { label: 'Принять', card: 'required' },
  return: { label: 'Вернуть', card: 'required', text: { max: 500, required: true } },
  take: { label: 'В работу', card: 'required', session: 'optional', pick: 'optional' },
  mirror: { label: 'Прогони зеркало' },
  cleanup: { label: 'Прибери отслужившие рабочие копии' },
  reindex: { label: 'Пересобрать индекс' },
  'new-card': { label: 'Новая карточка / мысль', project: 'required', title: { max: 120, required: true }, text: { max: 2000 } },
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
const KEYS = new Set(['action', 'intentId', 'card', 'session', 'text', 'title', 'project', 'q', 'confirm', 'pick']);
// управляющие символы прочь (§1.1 п.2), перевод строки остаётся (ответ — одна–три строки)
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
export const cleanText = (s) => s.replace(CONTROL, '');

// body → {ok: true, value} | {ok: false, why}; why — имя поля, без текста Ивана
export function validate(body, { hasCode }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, why: 'body' };
  for (const k of Object.keys(body)) if (!KEYS.has(k)) return { ok: false, why: 'field' };
  const spec = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!spec) return { ok: false, why: 'action' };
  if (typeof body.intentId !== 'string' || !UUID_RE.test(body.intentId)) return { ok: false, why: 'intentId' };
  const v = { action: body.action, intentId: body.intentId.toLowerCase() };
  const allowed = (name) => spec[name] !== undefined;
  for (const name of ['card', 'session', 'project', 'pick', 'text', 'title']) {
    if (body[name] !== undefined && !allowed(name)) return { ok: false, why: name };
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
    v[name] = body[name];
  }
  if (spec.oneOf && !spec.oneOf.some((k) => v[k] !== undefined)) return { ok: false, why: spec.oneOf.join('|') };
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
    if (!body.q || typeof body.q !== 'object' || Array.isArray(body.q)) return { ok: false, why: 'q' };
    v.q = body.q;
  }
  if (body.confirm !== undefined) {
    if (typeof body.confirm !== 'string' || !ACTION_ID_RE.test(body.confirm)) return { ok: false, why: 'confirm' };
    v.confirm = body.confirm;
  }
  return { ok: true, value: v };
}
