// Чистые подписи кнопки «Обновить»/«полный» и блока «Служебное» (EXT-75, ПТ8) — без React, чтобы их держал node-тест.
// Вход — ответ GET /api/mirror (спека пульта §1.3 «Прогони зеркало», «Пересобрать индекс»).
import { dm, hm, plural } from './format.js';

export const KIND = { changed: 'обычный', full: 'полный' };
// фазы прохода в status.json progress.phase (tools/mirror.mjs доски): projects, cards, comments, relations, write; незнакомая — как есть
const PHASE = { projects: 'проекты', cards: 'карточки', comments: 'комменты', relations: 'связи', write: 'запись' };
export const phaseWord = (p) => (p ? PHASE[p] ?? p : null);
// отказ сервера по коду refusal в теле ответа /api/act (outcome 'refused'): 'mirror-running', 'reindex-running', 'bad-confirm', …
export const isRefusal = (body, code) => body?.outcome === 'refused' && body.refusal === code;
// пометка отказа нажатия зеркала {text, title}: у «полного» «подтверждение не годится» — только на отказ самого подтверждения
// (чужое, потраченное, просроченное — нажать заново); любой другой отказ (rate-limit, …) — «отказ» с причиной в подсказке,
// как у «Обновить» (Голем дирижёра на экран ПТ8: rate-limit первого щелчка писал «подтверждение не годится»)
const CONFIRM_REFUSALS = new Set(['bad-confirm', 'confirm-expired']);
export function refusalNote(kind, body) {
  if (kind === 'full' && CONFIRM_REFUSALS.has(body?.refusal)) return { text: 'подтверждение не годится — нажми ещё раз', title: body.message || 'подтверждение не годится' };
  return { text: 'отказ', title: body?.message || 'пульт отказал' };
}
export const FRESH_MS = 60 * 60000; // зелёный итог в шапке — час после конца прохода, дальше его место занимает время зеркала

// «8 мин», «1 ч 36 мин», «45 с» — длительность прохода из lastRun.seconds
export function secs(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 60) return `${n} с`;
  if (n < 3600) return `${Math.round(n / 60)} мин`;
  const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60);
  return m ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${h} ч`;
}
// итог последнего прохода (lastRun из /api/mirror): {red, text, title}; null — итога нет
export function runResult(m, now = Date.now()) {
  const r = m?.lastRun;
  if (!r) return null;
  const kind = KIND[r.kind] ?? r.kind ?? 'проход';
  const at = r.endedAt ? hm(r.endedAt, now) : null;
  const title = [`последний проход зеркала: ${kind}`, r.endedAt && `закончен ${dm(r.endedAt)}`, secs(r.seconds), Number.isFinite(r.requests) && `запросов ${r.requests}`, r.code !== 0 && `код ${r.code ?? 'неизвестен'}`].filter(Boolean).join(' · ');
  if (r.code !== 0) return { red: true, text: [kind, at, 'красный'].filter(Boolean).join(' · ') + (m.lastError ? `: ${m.lastError}` : ''), title: m.lastError ? `${title} — ${m.lastError}` : title };
  const end = r.endedAt ? new Date(r.endedAt).getTime() : NaN;
  if (!(now - end < FRESH_MS)) return null;
  return { red: false, text: ['итог', kind, at, secs(r.seconds), Number.isFinite(r.requests) && `${r.requests} запросов`].filter(Boolean).join(' · '), title };
}

// ход и итоги — GET /api/mirror
export async function readMirror() {
  const r = await fetch('/api/mirror', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// строка «Пересобрать индекс»: {cls, text}; ri — reindex из /api/mirror (null — ещё не прочитан)
export function reindexLine(ri) {
  if (!ri) return { cls: 'faint', text: 'читаю состояние…' };
  if (ri.running) {
    const n = Number.isFinite(ri.done) && Number.isFinite(ri.total) ? `: ${ri.done} из ${ri.total} журналов` : '…';
    return { cls: 'going', text: `пересобираю${n}` };
  }
  if (ri.lastError) return { cls: 'pbad', text: `не удалось пересобрать: ${ri.lastError}` };
  if (ri.lastAt) {
    const took = Number.isFinite(ri.lastMs) ? secs(Math.round(ri.lastMs / 1000)) : null;
    return { cls: 'muted', text: ['пересобран', dm(ri.lastAt), took, Number.isFinite(ri.lastFiles) && plural(ri.lastFiles, ['журнал', 'журнала', 'журналов'])].filter(Boolean).join(' · ') };
  }
  return { cls: 'faint', text: 'с запуска витрины не пересобирался' };
}
