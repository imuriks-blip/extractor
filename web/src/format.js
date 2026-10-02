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
