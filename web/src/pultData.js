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

// Панель карточки (CardPanel.jsx): метка главного слова — у строки (б) «Ждёт меня» этой карточки, живой или отложенной
// (waiting.deferred, группа yes — там та же метка, спека витрины §1.6, EXT-47). Строки нет — undefined.
export function cardMainMark(waiting, id) {
  return waiting?.yes?.find((r) => r.id === id)?.mark
    ?? waiting?.deferred?.find((d) => d.group === 'yes' && d.card === id)?.mark ?? undefined;
}
