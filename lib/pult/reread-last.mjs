// «Последняя просьба» «Перечитать правила» (EXT-65, §1.8): одно правило для сервера (отказ queued) и страницы (статус и кнопка).
// Новее — по времени просьбы (at); при равном времени или без него — по номеру действия (W-ГГММДД-ЧЧММСС-xxxx, растёт со временем).
// Та же функция — в web/src/rereadFeed.js (страница не может импортировать из lib/); совпадение — test/ext65-reread.test.mjs.
export const newestReread = (items) => items.reduce((best, x) => {
  if (!best) return x;
  const dt = (Date.parse(x.at) || 0) - (Date.parse(best.at) || 0);
  return dt > 0 || (dt === 0 && String(x.id) > String(best.id)) ? x : best;
}, null);
