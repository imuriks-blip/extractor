// Окно «Агенты» (EXT-116, спека витрины, раздел «EXT-116 — окно «агенты»», Р4): чистые функции вида — что написать
// и чем пометить. Ответ GET /api/agents (Р3) окно не пересчитывает: сверку (check, drift, drifts) считает сервер, здесь
// только слова к ней. Отдельный файл — чтобы тесты (node --test, без сборки JSX) звали то же, что Agents.jsx.
import { dm, hm, minutes, plural } from './format.js';

export const TITLE = 'Агенты цеха';
export const DRIFT_HINT = 'прав источник — определение; реестр правит тред INFRA';
export const PROPOSAL_NOTE = 'Роль не действует: ниже — предложение, а не права';
export const MISSING = 'раздела нет в реестре';
export const NOTHING = 'ничего не найдено';
// колонки строки роли: ключ fields → подпись (подпись видна в шапке таблицы и на узком окне у поля)
export const COLS = [['label', 'лейбл'], ['sign', 'подпись'], ['model', 'модель'], ['brake', 'тормоз']];

const strip = (s) => String(s ?? '').replace(/\*\*/g, '').trim();

export const rolesTitle = (n) => plural(n, ['роль', 'роли', 'ролей']);

// серая строка шапки: «реестр от ДД.ММ ЧЧ:ММ · выжимка, прав источник»; времени нет (разбора ещё не было) — строки нет
export function headLine(data) {
  return data?.updatedAt ? `реестр от ${dm(data.updatedAt)} · выжимка, прав источник` : null;
}

// сводка сверки (Р2): N > 0 — жёлтым, 0 — серым «с определениями сходится»
export function driftLine(data) {
  const n = Number(data?.drifts) || 0;
  return n > 0 ? { text: `расхождений с определениями: ${n}`, warn: true } : { text: 'с определениями сходится', warn: false };
}

// ошибка разбора (Р4): строка ошибки; при прежних ролях и failingSince — «данные на ЧЧ:ММ, чтение не удаётся N мин» (§2.7);
// «данные на» — время прежнего удачного разбора (updatedAt: время изменения разобранного файла — другого времени ручка не даёт)
export function errorLines(data, now = Date.now()) {
  if (!data?.error) return null;
  const roles = data.roles?.length ?? 0;
  const f = data.failingSince ? Date.parse(data.failingSince) : NaN;
  const stale = roles && Number.isFinite(f)
    ? `данные на ${data.updatedAt ? hm(data.updatedAt, now) : '—'}, чтение не удаётся ${minutes(f, now)}`
    : null;
  return { error: `реестр не разобран: ${data.error}`, stale, list: roles > 0 };
}

// пояснение «Как читать «держит»» свёрнуто до первой фразы: конец фразы — . ! ? (с закрывающими ** или *) перед пробелом
export function legendHead(legend) {
  if (!legend) return null;
  const s = String(legend);
  const m = /[.!?…](\*\*|\*)?(?=\s)/.exec(s);
  if (!m) return { head: s, rest: '' };
  const end = m.index + m[0].length;
  return { head: s.slice(0, end), rest: s.slice(end).trim() };
}

// пометка у поля строки роли — по check сервера: drift — жёлтая с обоими значениями, unchecked — серая «не сверяется»,
// ok и check: null — без пометки
export function fieldMark(role, field) {
  const c = role?.check?.[field];
  if (c === 'drift') {
    const d = (role.drift ?? []).find((x) => x.field === field);
    return { kind: 'drift', text: d ? `реестр: ${d.registry} · определение: ${d.fact}` : 'расходится с определением', title: DRIFT_HINT };
  }
  if (c === 'unchecked') return { kind: 'unchecked', text: 'не сверяется', title: 'сверять не с чем: в определении нет поля или слово реестра не сопоставляется' };
  return null;
}

// метки у имени роли: предложение (значением статуса из файла), «разобрано не всё: N», «определение не читается»
export function roleTags(role) {
  const tags = [];
  if (role?.status === 'proposal') tags.push({ kind: 'proposal', text: strip(role.fields?.status) || 'предложение' });
  if (role?.problems?.length) tags.push({ kind: 'problems', text: `разобрано не всё: ${role.problems.length}`, title: role.problems.join('\n') });
  if (role?.fact?.def === null) tags.push({ kind: 'nodef', text: 'определение не читается', title: 'файл определения есть, но не читается — сверки нет' });
  return tags;
}

// текст раздела: null — раздела нет в файле; «Нет.» — серым; прочее — текстом
export function sectionKind(text) {
  if (text == null) return 'missing';
  return /^нет\.?$/i.test(String(text).trim()) ? 'none' : 'text';
}

// поиск: без регистра, ё = е, разметка не мешает; слово от 4 букв ищется без окончания («база» находит «базы», «в базу»);
// основа ищется только с начала слова текста («бот» находит «бота», «боты», но не «работ»); слова запроса в 1 букву
// не учитываются — запрос из одних таких как пустой; от 2 букв — да: «ТЗ», «ИИ», «PR» (ревью Голема по Т2, два круга);
// несколько слов — все должны найтись в роли
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[`*]/g, '');
export function queryWords(q) {
  return norm(q).split(/\s+/).filter((w) => w.length >= 2).map((w) => {
    if (w.length < 4) return w;
    const s = w.replace(/[аеиоуыэюяйь]+$/, '');
    return s.length >= 3 ? s : w;
  });
}
// буква или цифра (буква — у которой есть регистр: кириллица, латиница); перед началом слова такой нет
const wordChar = (c) => c !== undefined && (c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9'));
const has = (text, w) => {
  const t = norm(text);
  for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) if (!wordChar(t[i - 1])) return true;
  return false;
};

const roleText = (r) => [r.name, ...Object.values(r.fields ?? {}), ...(r.sections ?? []).flatMap((s) => [s.title, s.text])].join('\n');

// роли под поиском: [{ role, hits }] — hits = null без поиска (раскрытие по щелчку), иначе индексы разделов с совпадением
export function searchRoles(roles, q) {
  const words = queryWords(q);
  if (!words.length) return (roles ?? []).map((role) => ({ role, hits: null }));
  return (roles ?? [])
    .filter((r) => words.every((w) => has(roleText(r), w)))
    .map((role) => ({
      role,
      hits: (role.sections ?? []).map((s, i) => (words.some((w) => has(`${s.title}\n${s.text ?? ''}`, w)) ? i : -1)).filter((i) => i >= 0),
    }));
}

// сводка под поиском: подраздел с совпадением в имени или абзаце — целиком, иначе только строки таблицы с совпадением
export function searchSummary(summary, q) {
  const words = queryWords(q);
  const list = summary ?? [];
  if (!words.length) return list;
  const hit = (t) => words.some((w) => has(t, w));
  return list.flatMap((s) => {
    if (hit(s.title) || hit(s.text)) return [s];
    const rows = (s.rows ?? []).filter((r) => hit(r.join('\n')));
    return rows.length ? [{ ...s, rows }] : [];
  });
}
