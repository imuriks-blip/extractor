// Окно «Дорожная карта» (EXT-103 Т3; спека Vault extractor/SPEC-extractor-roadmap.md, раздел 3 «Вид», гейт Г3): слова и пометки
// без разметки, чтобы проверялись тестом (test/ext103-roadmap-view.test.mjs). Данные — GET /api/roadmap и /api/roadmap/<КОД>
// (lib/roadmap.mjs, образцы web/fixtures/roadmap*.json). Только показ (Р-4 (а)): кнопок записи в карту нет.

// Правку карты поток событий не сигналит — окно опрашивает ручку само, пока открыто; 5 с — как запасной опрос
// остальных экранов (data.js streamSource) и опрос доски сервером: чаще не нужно.
export const ROADMAP_POLL_MS = 5000;
export const roadmapUrl = (code) => (code ? `/api/roadmap/${code}` : '/api/roadmap');

// #/roadmap — все проекты; #/roadmap/EXT — карта проекта
export function roadmapRoute(hash) {
  const m = /^#\/roadmap(?:\/([A-Z]{2,6}))?$/.exec(String(hash ?? ''));
  return m ? { name: 'roadmap', code: m[1] ?? null } : null;
}

// Порядок разделов карты проекта — спека, раздел 3: Где стоим · Ждёт Ивана · Идеи · Впереди · Сделано · Снято
export const SECTIONS = [
  ['where', 'Где стоим'],
  ['ask', 'Ждёт Ивана'],
  ['ideas', 'Идеи'],
  ['ahead', 'Впереди'],
  ['done', 'Сделано'],
  ['cancelled', 'Снято'],
];

// «2026-10-17» → «17.10»; «2026-10-17 10:00» → «17.10 10:00»; иное — как пришло
export function dateShort(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(String(s ?? ''));
  if (!m) return s ?? '';
  return `${m[3]}.${m[2]}${m[4] ? ` ${m[4]}` : ''}`;
}

const pl = (n, [one, few, many]) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

// строка проекта на #/roadmap: «ждёт Ивана N · идей в обсуждении M · впереди K»; карты нет — null (серое «карты нет»)
export function countsParts(counts) {
  if (!counts) return null;
  return [
    { k: 'askOpen', text: `ждёт Ивана ${counts.askOpen ?? 0}`, hot: (counts.askOpen ?? 0) > 0 },
    { k: 'ideasDiscuss', text: `идей в обсуждении ${counts.ideasDiscuss ?? 0}` },
    { k: 'ahead', text: `впереди ${counts.ahead ?? 0}` },
  ];
}
export const countsLine = (counts) => countsParts(counts)?.map((p) => p.text).join(' · ') ?? null;
export const NO_MAP = 'карты нет';
export const totalLine = (total) => (Number.isInteger(total?.ahead) ? `впереди по цеху — ${pl(total.ahead, ['карточка', 'карточки', 'карточек'])}` : null);

// «карта недоступна: …» (модуль доски не загрузился, roadmap-off) — строка вместо окна и что с ней делать
export function offLines(d) {
  if (!d || d.available !== false) return null;
  return { error: d.error || 'карта недоступна', hint: 'Карта появится после перезапуска витрины с модулем доски.' };
}

// битая карта или план: данные — прежний удачный разбор (спека витрины 2.7), ошибки — строкой
export function brokenLine(b, what = 'карта') {
  if (!b) return null;
  const errs = Array.isArray(b.errors) ? b.errors : [];
  const first = errs[0];
  const where = first ? `строка ${first.line}: ${first.msg}` : 'не разбирается';
  const more = errs.length > 1 ? ` (и ещё ${errs.length - 1})` : '';
  return `${what}${b.file ? ` ${b.file}` : ''} не разбирается — ${where}${more}; показан прежний разбор`;
}

// «откуда · дата» строки вопроса и идеи; дата, которая уже есть в «откуда» («чат EXT 17.10»), не повторяется
export function srcLine(x) {
  const from = x?.from ?? '';
  const d = x?.date ? dateShort(x.date) : '';
  if (!d || from.includes(d)) return from;
  return from ? `${from} · ${d}` : d;
}

// Ждёт Ивана: открытые вопросы — списком, закрытые — свёрнуты; счётчик = открытые qN (Р-7 (а))
export function splitQuestions(qs) {
  const list = Array.isArray(qs) ? qs : [];
  return { open: list.filter((q) => q.status !== 'закрыт'), closed: list.filter((q) => q.status === 'закрыт') };
}

// Идеи: отброшенные — свёрнуты
export function splitIdeas(ideas) {
  const list = Array.isArray(ideas) ? ideas : [];
  return { shown: list.filter((i) => i.shown !== 'отброшена'), dropped: list.filter((i) => i.shown === 'отброшена') };
}

// Статус идеи (1 п.2): у идеи с карточкой — со статуса карточки (сервер кладёт его в shown), у прочих — из файла.
// cls: work — зелёный «в работе», done — «сделана» со значком следа, gone — серым (карточка снята), wait — «ждёт Ивана».
export const IDEA_GONE = 'стала карточкой · карточка снята';
export function ideaView(i) {
  const text = i?.shown || i?.status || '—';
  let cls = 'idle';
  if (i?.card && i.cardStatus === 'cancelled') cls = 'gone';
  else if (text === 'в работе') cls = 'work';
  else if (text === 'сделана') cls = 'done';
  else if (text === 'ждёт Ивана') cls = 'wait';
  else if (text === 'отложена' || text === 'отброшена') cls = 'gone';
  return { text: cls === 'gone' && i?.card ? IDEA_GONE : text, cls, card: i?.card ?? null, ask: i?.ask ?? null,
    trace: text === 'сделана' && i?.card ? (i.cardTrace ?? null) : undefined };
}

// статус карточки доски — словами окна проекта (колонки «В работе», «В очереди», Review, Backlog, Done; «отменена»)
const CARD_WORDS = { backlog: 'Backlog', ready: 'в очереди', 'in-progress': 'в работе', review: 'Review', done: 'Done', cancelled: 'отменена' };
export const cardWord = (s) => (s ? CARD_WORDS[s] ?? s : 'нет на доске');
export const cardHref = (id) => `#/project/${String(id).split('-')[0]}/${id}`;

// «ждёт: …» у пункта [!]: ссылка — только когда значение целиком номер карточки; «слово Ивана» и прочее — текстом
const CARD_ID = /^[A-Z]{2,6}-\d+$/;
export function waitView(w) {
  if (w == null || w === '') return null;
  const text = String(w);
  return { card: CARD_ID.test(text) ? text : null, text };
}

// отметка пункта плана (2.2, Р-2 (а)): знак и слово — не только цветом. Для [>] — shownMark со статуса карточки.
const MARKS = {
  ' ': ['○', 'не начат', 'm-todo'],
  '~': ['◔', 'идёт', 'm-go'],
  '!': ['!', 'ждёт', 'm-wait'],
  x: ['✓', 'сделано', 'm-done'],
  '-': ['–', 'снято', 'm-drop'],
  '>': ['→', 'отдан карточкой', 'm-go'],
};
export function markView(it) {
  const k = it?.shownMark ?? it?.mark ?? ' ';
  const [sign, word, cls] = MARKS[k] ?? MARKS[' '];
  return { sign, word, cls };
}

// след (шкала EXT-48, как значок у «Принять»): state ok / warn / bad / none, null — ещё проверяется.
// Подсказка — причины словами (коды сервера not-in-main, not-pushed, no-origin, not-found, … — в скобках, чтобы искались)
export const TRACE_SIGN = { ok: '✓', warn: '!', bad: '✕', none: '–' };
export function traceTip(t) {
  if (!t) return 'проверяю след…';
  const rs = Array.isArray(t.reasons) ? t.reasons : [];
  const lines = rs.length ? rs.map((r) => (r.code ? `${r.text} (${r.code})` : r.text)) : [t.label].filter(Boolean);
  if (t.hint) lines.push(t.hint);
  return lines.join('\n');
}
export function traceState(t) {
  if (!t || t.state == null) return 'wait';
  return TRACE_SIGN[t.state] ? t.state : 'none';
}

// подпись EXT-108 у пункта плана: «тред EXT: шаг 3 из 6» — только если поле пришло в данных (EXT-108 в коде витрины ещё нет);
// форма поля — предложение для сервера: step = { thread, n, of }
export function stepLine(it) {
  const s = it?.step;
  if (!s || !Number.isInteger(s.n) || !Number.isInteger(s.of)) return null;
  return `${s.thread ? `тред ${s.thread}: ` : ''}шаг ${s.n} из ${s.of}`;
}

// заголовок окна по маршруту
export const roadmapTitle = (code) => (code ? `Экстрактор · Карта ${code}` : 'Экстрактор · Карта');
