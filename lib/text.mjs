// Обрезка текста для строк витрины (90 знаков «Цеха», 120 знаков записи журнала — 2.5): по видимым символам
// (графемам), не по единицам UTF-16 — эмодзи и символ с вариационным селектором на месте разреза не рвутся.
const SEG = new Intl.Segmenter('ru', { granularity: 'grapheme' });

export function cutChars(text, max) {
  const s = String(text ?? '');
  const g = [...SEG.segment(s)].map((x) => x.segment);
  if (g.length <= max) return s;
  return g.slice(0, max - 1).join('').trimEnd() + '…';
}
