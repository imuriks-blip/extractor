// Экран «Расход» (EXT-84, ПТ12; спека пульта §6): выбор данных без разметки, чтобы проверялось тестом (test/ext84-usage-page.test.mjs).
// Ручка: GET /api/usage (lib/usage.mjs). Остаток — новая форма remaining (EXT-87, спека пульта §1.7): источник, возраст, свежесть;
// «Замерить остаток» вернулась (слово Ивана 09.10) — пункт меню «Служебное» и кнопка на экране.

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

// Подпись веса из window5h.weights (ценовые веса API, EXT-87): «вывод ×5, чтение кэша ×0,1». Ввод ×1 и запись кэша ×1,25 — в подсказке.
// Весов в ответе нет (старый сервер) — подписи нет: число не выдаём за «условные токены».
const W_NAMES = [['in', 'ввод'], ['out', 'вывод'], ['cacheWrite', 'запись кэша'], ['cacheRead', 'чтение кэша']];
const wTxt = (v) => `×${dec(v)}`;
export function weightNote(weights, short = true) {
  if (!weights || typeof weights !== 'object') return null;
  const list = W_NAMES.filter(([k]) => Number.isFinite(weights[k]) && (!short || weights[k] !== 1 && weights[k] !== 1.25));
  return list.length ? `вес: ${list.map(([k, n]) => `${n} ${wTxt(weights[k])}`).join(', ')}` : null;
}

// предупреждение 5 ч (объём взвешен по ценам API — «условные токены»): kind — warn | ok | few | none
export function windowNote(w) {
  if (!w) return { kind: 'none', text: '' };
  if (!w.enough) return { kind: 'few', text: 'за 5 ч: мало данных для сравнения', title: w.message };
  const f = Number.isFinite(w.factor) ? `×${dec(w.factor)}` : '';
  const wn = weightNote(w.weights);
  const title = [w.message, weightNote(w.weights, false)].filter(Boolean).join(' · ') || undefined;
  if (w.warn) return { kind: 'warn', head: 'За 5 ч расход выше обычного', text: `≈ ${fmtTokens(w.total)} условных токенов против медианы ${fmtTokens(w.median)}${f || wn ? ` (${[f && `${f} от медианы`, wn].filter(Boolean).join('; ')})` : ''}`, title };
  return { kind: 'ok', text: `за 5 ч в норме: ≈ ${fmtTokens(w.total)} условных токенов при медиане ${fmtTokens(w.median)}${wn ? ` (${wn})` : ''}`, title };
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

export const MEASURE_HINT = 'Служебное → Замерить остаток';
const NO_EVENTS = 'остаток не виден (событий лимита нет)';

// возраст рядом с числом: замер — точный («замер 5 мин назад»), прогон прораба — нижняя граница («прогон прораба, не моложе 20 мин»)
export function sourceText(r) {
  const age = Number.isFinite(r?.ageSec) ? (r.ageSec < 60 ? 'меньше минуты' : ageText(r.ageSec)) : null;
  if (r?.source === 'foreman') return `прогон прораба, не моложе ${age ?? '—'}`;
  return age ? `замер ${r.ageSec < 60 ? 'меньше минуты' : age} назад` : 'замер';
}
// возраст события в подписи «последнее событие лимита N назад» (у прораба — нижняя граница)
const lastEventAge = (r) => `${r?.ageKind === 'lowerBound' ? 'не моложе ' : ''}${ageText(r?.ageSec)}`;

// Остаток новой формы (EXT-87, спека пульта §1.7 и §6 п.2 «Свежесть»): число показывается, только если fresh; сервер несвежему
// число не отдаёт (utilization: null), страница не пытается его достать. Результат:
//   kind: 'none' — событий нет (text — remainingNote дословно); 'stale' — оба окна несвежие; 'ok' — виден хотя бы один процент;
//   five/seven — готовая подпись части (null — нет вовсе), parts — {k, text, fresh}; source — «замер 5 мин назад»; at — «ЧЧ:ММ» события.
export function remainingView(d) {
  const r = d?.remaining;
  if (!r) return { kind: 'none', text: d?.remainingNote ?? NO_EVENTS, hint: MEASURE_HINT };
  const part = (w, label, withReset) => {
    if (!w) return null;
    if (w.fresh === true && Number.isFinite(w.utilization)) {
      const reset = withReset && w.resetsAt ? clock(w.resetsAt) : null;
      return { fresh: true, text: `${label}: ${pct(w.utilization)}${reset ? ` · сброс ${reset}` : ''}` };
    }
    return { fresh: false, text: `${label}: не виден` };
  };
  const five = part(r.fiveHour, '5 ч', true);
  const seven = part(r.sevenDay, '7 дн', false);
  const parts = [five, seven].filter(Boolean);
  const source = sourceText(r);
  const at = r.at ? clock(r.at) : null;
  if (!parts.some((p) => p.fresh)) {
    return { kind: 'stale', text: `остаток не виден — последнее событие лимита ${lastEventAge(r)} назад`, hint: MEASURE_HINT, parts, source, at };
  }
  return { kind: 'ok', text: parts.map((p) => p.text).join(' · '), parts, source, at, lowerBound: r.ageKind === 'lowerBound' };
}

// «замеры сегодня: 3, ≈$0,08» (measures.today из log.jsonl; стоимость — округлённо до цента, меньше цента — «<$0,01»)
export function measuresLine(d) {
  const t = d?.measures?.today;
  if (!t || !Number.isFinite(t.count)) return null;
  const c = Number.isFinite(t.costUsd) ? t.costUsd : 0;
  const money = c <= 0 ? null : c < 0.005 ? '<$0,01' : `≈$${dec(c.toFixed(2))}`;
  return `замеры сегодня: ${t.count}${money ? `, ${money}` : ''}`;
}

// Подпись пункта «Замерить остаток» в меню «Служебное»: «5 ч: N % · сброс ЧЧ:ММ · 7 дн: M % · замер ЧЧ:ММ» по тому же правилу свежести
export function measureMenuLine(d) {
  const v = remainingView(d);
  if (v.kind === 'none') return { cls: 'faint', text: 'замеров ещё не было' };
  if (v.kind === 'stale') return { cls: 'pamb', text: v.text };
  const src = d.remaining.source === 'foreman' ? `прораб, не моложе ${ageText(d.remaining.ageSec)}` : v.at ? `замер ${v.at}` : 'замер';
  return { cls: 'muted', text: `${v.text} · ${src}` };
}

// Ответ на «Замерить остаток» словами: {cls, text}. status — HTTP, body — тело /api/act (outcome, refusal, reused, message)
export function measureAnswer(status, body) {
  const b = body ?? {};
  if (status === 409 && b.refusal === 'measure-running') return { cls: 'going', text: 'замер уже идёт' };
  if (status === 501) return { cls: 'muted', text: 'ещё не подключено' };
  if (status === 503) return { cls: 'muted', text: 'пульт выключен' };
  if (status === 429) return { cls: 'pbad', text: 'слишком часто — попробуй через минуту' };
  if (b.outcome === 'ok') return b.reused === true ? { cls: 'muted', text: b.message || 'замер был недавно' } : { cls: 'muted', text: b.message || 'замер сделан' };
  if (b.outcome === 'error') return { cls: 'pbad', text: b.message || 'замер не удался' };
  if (b.outcome === 'refused') return { cls: 'pbad', text: b.message || 'отказ' };
  return { cls: 'pbad', text: b.message || `ошибка: HTTP ${status}` };
}
