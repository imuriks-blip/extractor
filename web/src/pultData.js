// Выбор данных для кнопок-слов (EXT-70, хвост ПТ7) — без разметки, чтобы проверялось тестом сервера (test/ext70-page-data.test.mjs).

// «Мои слова» (Words.jsx): подпись исхода строки GET /api/actions. need-confirm бывает двух видов — Б-дело ждёт второго щелчка
// (у строки bdeal шага need-confirm), выбор треда при нескольких живых (bdeal нет) ждёт, кому слово.
const OUTCOME = {
  done: 'записано',
  partial: 'частично: запись есть, статус не сменился',
  refused: 'отказ',
  error: 'не записано',
  asked: 'идёт или оборвано',
};
export function outcomeText(r) {
  if (r.status === 'need-confirm') return r.bdeal ? 'ждёт второго щелчка' : 'ждёт выбора треда';
  return OUTCOME[r.status] ?? r.status ?? '—';
}

/* ---------- «Отозвать» (EXT-71; спека пульта §1.9 «Кнопка и что видит Иван», ПВ-11, ПВ-12) ---------- */

// круг действий, кладущих слово в звонок (§1.9 «Круг действий»); прочие отозвать нельзя
export const WITHDRAW_CIRCLE = ['yes', 'go', 'merge', 'deploy', 'no', 'reply', 'return', 'take', 'reread'];
export const RETURN_HINT = 'звонок снят; карточка осталась в In Progress — попроси дирижёра вернуть в Review';
export const LATE_TEXT = 'отозвано поздно: тред слово получил — скажи ему в чате';
const isWithdrawnRing = (ring) => typeof ring === 'string' && ring.startsWith('отозвано');
const isLateRing = (ring) => typeof ring === 'string' && ring.startsWith('отозвано поздно');

// partial (§1.9): звонок снят, записи об отзыве нет — слово «отозвано», а withdrawnBy у него нет; «Отозвать» остаётся повтором
export const isPartialWithdraw = (r) => isWithdrawnRing(r?.ring) && !r.withdrawnBy;

// Видна ли кнопка у строки «Моих слов»: пульт и звонок включены (/api/ceh → pult), действие из круга, у строки нет withdrawnBy,
// ring — «положено» или «не доставлено: тред закрыт», у слова с карточкой ещё «сброшено перезапуском» (только запись)
export function canWithdraw(r, pult) {
  if (!r || pult?.enabled !== true || pult?.bell !== true) return false;
  if (!WITHDRAW_CIRCLE.includes(r.action) || r.withdrawnBy) return false;
  if (r.ring === 'положено' || r.ring === 'не доставлено: тред закрыт') return true;
  if (r.ring === 'сброшено перезапуском') return !!r.card;
  return isPartialWithdraw(r);
}

// Статус звонка слова — {text, cls: off|bad|amb|ring}: cls ring — обычный статус 2.8 (рисует Ring), остальные — своя подпись
export function wordRingView(r) {
  const by = r?.withdrawnBy;
  const ring = r?.ring;
  if (!ring) return null;
  if (by) {
    if (isLateRing(ring)) return { text: `${LATE_TEXT} · ${by}`, cls: 'bad' };
    if (ring === 'отозвано') return { text: `отозвано · ${by}`, cls: 'off' };
    return { text: `${ring} · отозвано ${by}`, cls: ring === 'сброшено перезапуском' ? 'amb' : 'off' };
  }
  if (isWithdrawnRing(ring)) return { text: `${isLateRing(ring) ? LATE_TEXT : 'отозвано'} · звонок снят, записи об отзыве нет — «Отозвать» повторит`, cls: isLateRing(ring) ? 'bad' : 'amb' };
  return { text: ring, cls: 'ring' };
}

// Строка самого отзыва: «отозвать <номер слова>» и исход. rows — все строки /api/actions: по ним ищется отзываемое слово
// (подсказка «Вернуть» и поздняя гонка — красным)
export function withdrawRowView(r, rows) {
  const target = (rows ?? []).find((x) => x.id === r.withdraws) ?? null;
  const label = `отозвать ${r.word ?? r.withdraws ?? ''}`.trim();
  if (r.status === 'done') {
    if (isLateRing(target?.ring)) return { label, text: LATE_TEXT, cls: 'bad' };
    return { label, text: `отозвано${target?.action === 'return' ? ` · ${RETURN_HINT}` : ''}`, cls: null };
  }
  if (r.status === 'partial') return { label, text: 'звонок снят, запись об отзыве не легла — повторить', cls: 'amb' };
  if (r.status === 'refused') return { label, text: 'отказ', cls: 'amb' };
  if (r.status === 'error') return { label, text: 'не записано', cls: 'bad' };
  return { label, text: 'идёт или оборвано', cls: null };
}

// Исход нажатия «Отозвать» по ответу POST /api/act (после ответа, до прихода строк в опросе): {phase, text, by?}
export function withdrawResult(status, body) {
  const b = body || {};
  const msg = b.message || `ошибка: HTTP ${status}`;
  const outcome = status === 200 ? b.outcome : status === 409 || status === 429 || status === 503 ? 'refused' : 'error';
  if (outcome === 'ok') return { phase: 'ok', by: b.id ?? null, late: /^отозвано поздно/.test(msg), text: msg };
  if (outcome === 'partial') return { phase: 'partial', text: msg };
  if (outcome === 'refused') return { phase: 'refused', text: msg };
  return { phase: 'error', text: msg };
}

// Местная отметка отозванного слова (§1.9): для кнопок слов считается красной — кнопки у карточки и строки снова есть
export const markIsRed = (m) => !!m && (m.missing === true || isWithdrawnRing(m.ring));

// Панель карточки (CardPanel.jsx): метка главного слова — у строки (б) «Ждёт меня» этой карточки, живой или отложенной
// (waiting.deferred, группа yes — там та же метка, спека витрины §1.6, EXT-47). Строки нет — undefined.
export function cardMainMark(waiting, id) {
  return waiting?.yes?.find((r) => r.id === id)?.mark
    ?? waiting?.deferred?.find((d) => d.group === 'yes' && d.card === id)?.mark ?? undefined;
}
