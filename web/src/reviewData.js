// «Готово, посмотри» на «Цехе» с 11 карточек (EXT-79, макет Бальда VKxJw5DGv6VvqiY6iFreph, вариант В — слово Ивана 06.10):
// подгруппы по проекту в порядке таблицы «Проекты» и одна строка чипов следа. Без React — держит node-тест
// (test/ext79-review-groups.test.mjs). До 10 карточек — плоский список как раньше, сохранённый фильтр не действует.

export const REVIEW_GROUP_MIN = 11;
export const REVIEW_FILTER_KEY = 'ceh-review-trace'; // localStorage: выбор чипа помнится между заходами (слово Ивана 06.10)

// слова чипов — слово Ивана 06.10: «проверен · проверь · нет следа»; знак — как у значка следа (Trace.jsx)
export const TRACE_CHIPS = [
  { val: 'ok', sign: '✓', word: 'проверен' },
  { val: 'warn', sign: '!', word: 'проверь' },
  { val: 'bad', sign: '✕', word: 'нет следа' },
];
const VALS = new Set(TRACE_CHIPS.map((c) => c.val));
export const isReviewFilter = (v) => v === 'all' || VALS.has(v);

// состояние следа строки для чипа: ok / warn / bad; «–» (none), «проверяю след…» (null) и поля нет — ни в один чип
const traceOf = (r) => (VALS.has(r?.trace?.state) ? r.trace.state : null);
const codeOf = (r) => r.project ?? String(r.id ?? '').split('-')[0];
const ms = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : -Infinity; };

function counts(rows) {
  const o = { ok: 0, warn: 0, bad: 0 };
  for (const r of rows) { const s = traceOf(r); if (s) o[s]++; }
  return o;
}

// щелчок по чипу: «все» — сброс; выбранный чип — снова «все»; другой — он
export const nextFilter = (cur, val) => (val === 'all' || cur === val ? 'all' : val);

// rows — открытые строки (в) (без «Отвечено»), свежие сверху; order — коды проектов в порядке таблицы «Проекты»;
// filter — сохранённый выбор чипа. Возвращает всё, что рисует блок:
//  head — число в заголовке группы: «M» или, при включённом фильтре, «показано N из M» (всегда, даже при N = M);
//  grouped — подгруппы и чипы (с 11 карточек); chips — «все» не входит, у каждого n и on; чип с нулём скрыт, кроме выбранного;
//  groups — подгруппы с карточками под фильтром (пустые скрыты): {code, rows, total, counts, at}; rows — плоский список;
//  empty — фильтр включён, а под него карточек нет («Под выбранный след карточек нет.»).
export function reviewView(rows, order, filter) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const grouped = total >= REVIEW_GROUP_MIN;
  const f = grouped && VALS.has(filter) ? filter : 'all';
  const vis = f === 'all' ? list : list.filter((r) => traceOf(r) === f);
  const all = counts(list);
  const chips = grouped
    ? TRACE_CHIPS.filter((c) => all[c.val] > 0 || c.val === f).map((c) => ({ ...c, n: all[c.val], on: c.val === f }))
    : [];
  let groups = null;
  if (grouped) {
    // порядок таблицы «Проекты»; код, которого в таблице нет, — следом, в порядке первой карточки
    const codes = [...(order ?? [])];
    for (const r of list) { const c = codeOf(r); if (!codes.includes(c)) codes.push(c); }
    groups = [];
    for (const code of codes) {
      const sub = vis.filter((r) => codeOf(r) === code);
      if (!sub.length) continue;
      const at = sub.reduce((a, r) => (ms(r.at) > ms(a) ? r.at : a), sub[0].at);
      groups.push({ code, rows: sub, total: list.filter((r) => codeOf(r) === code).length, counts: counts(sub), at });
    }
  }
  return {
    total,
    shown: vis.length,
    grouped,
    filter: f,
    head: f === 'all' ? String(total) : `показано ${vis.length} из ${total}`,
    chips,
    groups,
    rows: grouped ? null : list,
    empty: grouped && f !== 'all' && vis.length === 0,
  };
}
