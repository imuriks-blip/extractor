// Экран «Расход» (EXT-84, ПТ12; спека пульта §6): выбор данных без разметки, чтобы проверялось тестом (test/ext84-usage-page.test.mjs).
// Ручка: GET /api/usage (lib/usage.mjs). «Замерить остаток» не делается (слово Ивана 07.10): остаток — строкой из уже виденного события.

export const USAGE_URL = '/api/usage';
export const USAGE_POLL_MS = 30000;

// четыре числа usage; порядок — как на экране. cacheRead ≈ 97 % объёма, поэтому разрез показывается всегда, не одна сумма
export const PARTS = [
  { k: 'in', label: 'ввод', short: 'ввод' },
  { k: 'out', label: 'вывод', short: 'вывод' },
  { k: 'cacheRead', label: 'чтение кэша', short: 'чт. кэша' },
  { k: 'cacheWrite', label: 'запись кэша', short: 'зап. кэша' },
];

const dec = (v) => String(v).replace('.', ',');
// 950 → «950», 12 300 → «12,3 тыс», 4 200 000 → «4,2 млн», 3 100 000 000 → «3,1 млрд»; три значащие цифры не больше
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const unit = (div, name) => {
    const v = n / div;
    const s = Math.abs(v) >= 100 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${dec(s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)} ${name}`;
  };
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return unit(1e3, 'тыс');
  if (a < 1e9) return unit(1e6, 'млн');
  return unit(1e9, 'млрд');
}
// точное значение с пробелами между тысячами — в title
export const exact = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU').replace(/ | /g, ' ') : '—');

// доли четырёх чисел в сумме частей (проценты, целые для подписи, точные для полосы); сумма 0 → нули
export function shares(row) {
  const sum = PARTS.reduce((s, p) => s + (Number(row?.[p.k]) || 0), 0);
  return PARTS.map((p) => {
    const v = Number(row?.[p.k]) || 0;
    const f = sum > 0 ? v / sum : 0;
    return { ...p, value: v, frac: f, pct: sum > 0 ? (f > 0 && f < 0.005 ? '<1' : String(Math.round(f * 100))) : '0' };
  });
}

export const isZero = (row) => !row || !(row.total > 0);
export const noUsage = (d) => isZero(d?.week) && isZero(d?.today);

// «2026-10-07» → «07.10»
export const dayLabel = (s) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(s ?? '')); return m ? `${m[2]}.${m[1]}` : '—'; };

// столбики по дням: высота — доля от самого большого дня (0..1); последний день — «сегодня»
export function dayBars(days) {
  const list = Array.isArray(days) ? days : [];
  const max = Math.max(0, ...list.map((d) => d?.total || 0));
  return list.map((d, i) => ({ date: d.date, label: dayLabel(d.date), total: d.total || 0, h: max > 0 ? (d.total || 0) / max : 0, today: i === list.length - 1, parts: shares(d) }));
}

// строки разреза «проекты / агенты / треды» для окна scope ('today' | 'week'); название — как пришло
export function breakdownRows(d, kind, scope) {
  const list = d?.[kind]?.[scope];
  if (!Array.isArray(list)) return [];
  return list.map((r, i) => {
    const name = kind === 'byThread' ? (r.title ?? '') : (r.label ?? '');
    return { key: `${i}:${r.sessionId ?? r.agent ?? r.project ?? ''}`, name, tag: kind === 'byThread' ? (r.project ?? null) : null, row: r };
  });
}

// предупреждение 5 ч: kind — warn | ok | few | none
export function windowNote(w) {
  if (!w) return { kind: 'none', text: '' };
  if (!w.enough) return { kind: 'few', text: 'за 5 ч: мало данных для сравнения' };
  const f = Number.isFinite(w.factor) ? `×${dec(w.factor)}` : '';
  if (w.warn) return { kind: 'warn', head: 'За 5 ч расход выше обычного', text: `${fmtTokens(w.total)} против медианы ${fmtTokens(w.median)}${f ? ` (${f} от медианы)` : ''}`, title: `${exact(w.total)} против медианы ${exact(Math.round(w.median))}` };
  return { kind: 'ok', text: `за 5 ч в норме: ${fmtTokens(w.total)} при медиане ${fmtTokens(w.median)}`, title: `${exact(w.total)} при медиане ${exact(Math.round(w.median))}` };
}

const pct = (u) => (Number.isFinite(u) ? `${Math.round(u * 100)} %` : '—');
export function ageText(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return 'меньше минуты';
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.floor(sec / 86400)} дн`;
}
const p2 = (n) => String(n).padStart(2, '0');
const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? null : `${p2(t.getHours())}:${p2(t.getMinutes())}`; };

// строка остатка. remaining есть — части строки (5 ч, сброс, 7 дн, возраст) и пометки; нет — remainingNote дословно
export function remainingLine(d) {
  const r = d?.remaining;
  if (!r) return { has: false, text: d?.remainingNote ?? 'остаток не виден (событий лимита нет)' };
  const five = r.fiveHour ?? null, seven = r.sevenDay ?? null;
  const reset = five?.resetsAt ? clock(five.resetsAt) : null;
  const parts = [];
  if (five) parts.push(`5 ч: ${pct(five.utilization)}`);
  if (reset) parts.push(`сброс в ${reset}`);
  if (seven) parts.push(`7 дн: ${pct(seven.utilization)}`);
  // возраст — нижняя граница (время файла прогона не раньше самого события): «не моложе N»
  parts.push(`данные не моложе ${Number.isFinite(r.ageSec) && r.ageSec >= 60 ? ageText(r.ageSec) : '0 мин'} (событие прогона прораба)`);
  const expired = [five?.expired ? '5 ч' : null, seven?.expired ? '7 дн' : null].filter(Boolean);
  return {
    has: true,
    text: parts.join(' · '),
    expired: expired.length ? `окно (${expired.join(', ')}) уже сменилось — число из прошлого окна` : null,
    note: 'возраст — нижняя граница: время файла прогона не раньше самого события',
  };
}
