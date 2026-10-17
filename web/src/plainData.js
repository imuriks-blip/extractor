// EXT-125: витрина простыми словами — чистые функции для «Цеха» и «Карты» (макет TPHv64ezLFcv3SnpGk2VPt, слово Ивана
// «Макет нравится, проекты строками»). Только слова и раскладка того, что сервер уже отдаёт: данных и действий не добавляет.
// Главное — сверху словами; служебное (номер карточки, след, хеши, пути) — под «подробнее» у своего пункта.
import { plural } from './format.js';

/* ---------- след строки «Готово, посмотри» — плашкой словами ---------- */

// причины сервера (lib/trace.mjs), из-за которых работы «нет отчёта»: закрытия по контракту нет или оно неполное
const NO_REPORT = new Set(['no-contract', 'no-lines', 'no-who']);
// причины «не отправлено»: коммит не в main или не на сервере
const NOT_SENT = new Set(['not-pushed', 'not-in-main']);

// kind — вид для свёртки и фильтра: ok | warn | bad | none | wait; text — плашка; cls — цвет (s-ok / s-warn / s-bad)
export function traceWord(t) {
  if (t === undefined) return null;
  if (t === null || t.state == null) return { kind: 'wait', cls: 'wait', text: 'проверяю' };
  if (t.state === 'ok') return { kind: 'ok', cls: 'ok', text: 'цех проверил' };
  if (t.state === 'warn') return { kind: 'warn', cls: 'warn', text: 'проверь сам' };
  if (t.state === 'bad') {
    const bad = (t.reasons || []).filter((r) => r.level === 'bad').map((r) => r.code);
    const sent = bad.length > 0 && bad.every((c) => NOT_SENT.has(c));
    return sent ? { kind: 'bad', cls: 'bad', text: 'не отправлено' } : { kind: 'bad', cls: 'bad', text: 'нет отчёта' };
  }
  return { kind: 'none', cls: 'none', text: 'без проверки' };
}

// слова фильтра «Готово, посмотри» по виду следа (значения фильтра — прежние: ok / warn / bad, reviewData.js)
export const FILTER_WORD = { ok: 'цех проверил', warn: 'проверь сам', bad: 'не сходится' };

// подгруппа проекта в «Готово, посмотри»: все строки с одной плашкой — свёртка одной строкой (uniform — эта плашка)
export function reviewSubView(rows) {
  const words = rows.map((r) => traceWord(r.trace)?.text ?? null);
  const uniform = rows.length > 1 && words[0] && words.every((w) => w === words[0]) ? words[0] : null;
  return { uniform };
}

/* ---------- «Нужно твоё «да»»: метка строки — словом ---------- */

export const MARK_WORD = { Б: 'необратимо', развилка: 'выбор', сливай: 'слить', выкатывай: 'выкатить' };
export const markWord = (m) => MARK_WORD[m] ?? m;

/* ---------- «Кто работает»: замечания треда — строкой по-людски ---------- */

// level: red — тревога (в сводку «Сейчас»), amber — замечание; reread — у строки кнопка «Перечитать правила» (если тред открыт)
export function threadRemarks(t) {
  const out = [];
  const files = [];
  for (const m of t.marks || []) {
    const who = m.who || m.agent || 'помощник';
    if (m.kind === 'partial') out.push({ kind: m.kind, level: 'red', text: `помощник ${who} остановился на полпути${m.waitingWord ? ' — ждёт твоего слова' : ''}` });
    else if (m.kind === 'takt') out.push({ kind: m.kind, level: m.level === 'red' ? 'red' : 'amber', text: 'задача выдана, ответа от неё нет' });
    else if (m.kind === 'subagentWrite') out.push({ kind: m.kind, level: 'red', text: `помощник ${who} записал в доску — так нельзя` });
    else if (m.kind === 'oldRules') out.push({ kind: m.kind, level: 'amber', text: 'работает по старым правилам', reread: (m.missing?.length ?? 0) > 0 });
    else if (m.kind === 'collision') { const o = m.other?.title || 'другой тред'; if (!files.includes(o)) files.push(o); }
    else out.push({ kind: m.kind, level: 'red', text: m.kind });
  }
  if (files.length) out.push({ kind: 'collision', level: 'amber', text: `правит общие файлы вместе с: ${files.join(', ')}` });
  if (t.memory?.warn) out.push({ kind: 'memory', level: 'amber', text: 'память на исходе — пора сделать снимок и открыть новый тред' });
  return out;
}

// чем занят тред — одной строкой (детали — под «подробнее»)
export function threadDoing(t) {
  if (t.state === 'waiting') return 'ждёт твоего ответа';
  if (t.state === 'stale') return 'нет вестей';
  const subs = t.subagents || [];
  if (subs.length) return subs.map((s) => `${s.who || s.agent}: ${s.description || 'задача без описания'}`).join('; ');
  if (t.state === 'busy') return 'работает';
  return 'свободен';
}

// порядок: с тревогой, с замечанием, ждёт, работает; свободные и «нет вестей» без замечаний — каждой группой одной строкой
export function workersView(threads) {
  const rows = (threads || []).map((t) => ({ t, remarks: threadRemarks(t) }));
  const rank = (r) => (r.remarks.some((x) => x.level === 'red') ? 0 : r.remarks.length ? 1 : r.t.state === 'waiting' ? 2 : r.t.state === 'busy' ? 3 : 9);
  const shown = rows.filter((r) => rank(r) < 9).sort((a, b) => rank(a) - rank(b));
  const quiet = rows.filter((r) => rank(r) === 9);
  return {
    shown,
    idle: quiet.filter((r) => r.t.state !== 'stale').map((r) => r.t),
    stale: quiet.filter((r) => r.t.state === 'stale').map((r) => r.t),
    withRemarks: rows.filter((r) => r.remarks.length).length,
  };
}

/* ---------- сводка «Цеха» ---------- */

// «Сейчас»: сколько тредов работает и свободно; тревога — первая красная пометка
export function briefNow(threads) {
  const ts = threads || [];
  const n = (s) => ts.filter((t) => t.state === s).length;
  const parts = [];
  if (n('busy')) parts.push(`работают ${n('busy')}`);
  if (n('waiting')) parts.push(`ждут ответа ${n('waiting')}`);
  if (n('idle')) parts.push(`свободны ${n('idle')}`);
  if (n('stale')) parts.push(`нет вестей ${n('stale')}`);
  const line = parts.length ? `Тредов ${ts.length}: ${parts.join(', ')}.` : 'Живых тредов нет.';
  let alarm = null;
  for (const t of ts) {
    const r = threadRemarks(t).find((x) => x.level === 'red');
    if (r) { alarm = `${t.title || 'тред без названия'}: ${r.text}`; break; }
  }
  return { line, alarm };
}

// «Ждёт меня»: N ждут ответа или «да» (а + б — крупное число блока) и M посмотреть (в — «+ M посмотреть»)
export function briefMe(w) {
  const count = w?.count ?? 0;
  const more = w?.more ?? 0;
  if (!count && !more) return 'ничего не ждёт';
  const a = count ? `${plural(count, ['ждёт', 'ждут', 'ждут'])} ответа или «да»` : null;
  const b = more ? `${more} — посмотреть` : null;
  return [a, b].filter(Boolean).join(', ');
}

/* ---------- проекты строками ---------- */

// без фазы и следующего шага — «тихо, описания нет»: одной строкой внизу
export function splitProjects(projects) {
  const ps = projects || [];
  return { described: ps.filter((p) => p.phase || p.next), quiet: ps.filter((p) => !p.phase && !p.next) };
}

// счётчики справа — словами, только ненулевые
export function projectCounts(p) {
  return [
    p.inProgress ? `в работе ${p.inProgress}` : null,
    p.ready ? `в очереди ${p.ready}` : null,
    p.review ? `посмотри ${p.review}` : null,
  ].filter(Boolean);
}

/* ---------- карта проекта: статус карточки словом ---------- */

const MAP_STATUS = {
  'in-progress': ['делаем', 'work'], review: ['посмотри', 'look'], ready: ['потом', 'later'], backlog: ['потом', 'later'],
  done: ['сделано', 'done'], cancelled: ['снято', 'gone'],
};
export function mapStatus(s) {
  const [text, cls] = MAP_STATUS[s] ?? [s ? String(s) : 'нет на доске', 'later'];
  return { text, cls };
}
