// EXT-125: витрина простыми словами — чистые функции для «Цеха» и «Карты» (макет TPHv64ezLFcv3SnpGk2VPt, слово Ивана
// «Макет нравится, проекты строками»). Только слова и раскладка того, что сервер уже отдаёт: данных и действий не добавляет.
// Главное — сверху словами; служебное (номер карточки, след, хеши, пути) — под «подробнее» у своего пункта.
import { plural } from './format.js';

/* ---------- след строки «Готово, посмотри» — плашкой словами ---------- */

// причины сервера (lib/trace.mjs): «нет отчёта» — закрытия по контракту нет или оно неполное; «не слито» — коммит не в main;
// «не отправлено» — в main, но не на сервере. Короткая причина видна рядом с плашкой, подробности — под «подробнее».
const BAD_WORD = { 'not-in-main': 'не слито', 'not-pushed': 'не отправлено' };
const BAD_WHY = {
  'no-contract': 'цех не оставил отчёт о сдаче',
  'no-lines': 'в отчёте о сдаче не хватает строк',
  'no-who': 'в отчёте не сказано, кто решил',
  'not-in-main': 'работа не слита в основную ветку',
  'not-pushed': 'работа не отправлена на сервер',
};

// «после контракта — ещё N» (EXT-48, В2 Голема): видна рядом с плашкой при любом state — как у TraceBadge
export function laterText(t) {
  if (!t || !(t.laterRecords > 0)) return null;
  return t.reasons?.find((r) => r.code === 'later')?.text ?? `после контракта — ещё ${plural(t.laterRecords, ['запись', 'записи', 'записей'])}`;
}

// kind — вид следа (ok | warn | bad | none | wait); text — плашка; cls — цвет; note — серым рядом (что проверять / почему);
// later — «после контракта — ещё N» рядом
export function traceWord(t) {
  if (t === undefined) return null;
  if (t === null || t.state == null) return { kind: 'wait', cls: 'wait', text: 'проверяю', note: null, later: null };
  const later = laterText(t);
  if (t.state === 'ok') {
    return later
      ? { kind: 'ok', cls: 'warn', text: 'проверено, но после проверки есть новые записи', note: null, later }
      : { kind: 'ok', cls: 'ok', text: 'цех проверил', note: null, later: null };
  }
  if (t.state === 'warn') return { kind: 'warn', cls: 'warn', text: 'проверь сам', note: t.label || null, later };
  if (t.state === 'bad') {
    const bad = (t.reasons || []).filter((r) => r.level === 'bad').map((r) => r.code);
    const report = bad.find((c) => !BAD_WORD[c]);
    const text = report || !bad.length ? 'нет отчёта' : bad.includes('not-in-main') ? 'не слито' : 'не отправлено';
    const first = report ?? (bad.includes('not-in-main') ? 'not-in-main' : bad[0]);
    const why = BAD_WHY[first] ?? null;
    const note = why && bad.length > 1 ? `${why} · ещё ${bad.length - 1}` : why;
    return { kind: 'bad', cls: 'bad', text, note, later };
  }
  return { kind: 'none', cls: 'none', text: 'без проверки', note: null, later };
}

// слова фильтра «Готово, посмотри» по виду следа (значения фильтра — прежние: ok / warn / bad, reviewData.js) — те же, что на плашках
export const FILTER_WORD = { ok: 'цех проверил', warn: 'проверь сам', bad: 'нет отчёта, не слито, не отправлено' };

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

// уровень — как у сервера (isRedMark, lib/threads.mjs): красное всё, кроме жёлтого такта и «Общего файла» (collision);
// «память на исходе» — не пометка сервера, жёлтая. reread — у строки кнопка «Перечитать правила» (если тред открыт)
export const isRedMark = (m) => !((m?.kind === 'takt' && m.level !== 'red') || m?.kind === 'collision');

export function threadRemarks(t) {
  const out = [];
  const files = [];
  (t.marks || []).forEach((m, i) => {
    const who = m.who || m.agent || 'помощник';
    const level = isRedMark(m) ? 'red' : 'amber';
    const key = `${m.kind}-${i}`;
    if (m.kind === 'partial') out.push({ key, kind: m.kind, level, text: `помощник ${who} остановился на полпути${m.card ? ` (${m.card})` : ''}${m.waitingWord ? ' — ждёт твоего слова' : ''}` });
    else if (m.kind === 'takt') out.push({ key, kind: m.kind, level, text: `задача ${m.card ? `${m.card} ` : ''}выдана, ответа от неё нет` });
    else if (m.kind === 'subagentWrite') out.push({ key, kind: m.kind, level, text: `помощник ${who} записал в доску — так нельзя` });
    else if (m.kind === 'oldRules') out.push({ key, kind: m.kind, level, text: 'работает по старым правилам', reread: (m.missing?.length ?? 0) > 0 });
    else if (m.kind === 'collision') { const o = m.other?.title || 'другой тред'; if (!files.includes(o)) files.push(o); }
    else out.push({ key, kind: m.kind, level, text: m.kind });
  });
  if (files.length) out.push({ key: 'collision', kind: 'collision', level: 'amber', text: `правит общие файлы вместе с: ${files.join(', ')}` });
  if (t.memory?.warn) out.push({ key: 'memory', kind: 'memory', level: 'amber', text: 'память на исходе — пора сделать снимок и открыть новый тред' });
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
    // красный счётчик шапки (3.1, marksCount): только треды с красными пометками
    withRed: rows.filter((r) => r.remarks.some((x) => x.level === 'red')).length,
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
  // тревога — самая срочная красная пометка цеха: обрыв помощника, запись в доску, такт без ответа, потом старые правила
  const PRI = ['partial', 'subagentWrite', 'takt', 'oldRules'];
  const pri = (k) => (PRI.includes(k) ? PRI.indexOf(k) : PRI.length);
  let best = null;
  for (const t of ts) {
    for (const r of threadRemarks(t).filter((x) => x.level === 'red')) {
      if (!best || pri(r.kind) < pri(best.r.kind)) best = { t, r };
    }
  }
  const alarm = best ? `${best.t.title || 'тред без названия'}: ${best.r.text}` : null;
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

// «тихо, описания пока нет»: нет фазы, нет шага, все счётчики нулевые и чтение не падает — одной строкой внизу;
// проект со счётчиками или со сбоем чтения — обычной строкой
export const isQuiet = (p) => !p.phase && !p.next && !p.inProgress && !p.ready && !p.review && !p.phaseFailingSince;
export function splitProjects(projects) {
  const ps = projects || [];
  return { described: ps.filter((p) => !isQuiet(p)), quiet: ps.filter(isQuiet) };
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
