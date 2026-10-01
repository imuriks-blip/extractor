// Маска секретов на выходе (спека витрины 6.2). Сеть — `scan` доски (одно место правды, импорт по пути
// в server.mjs), маску по позициям находок накладывает витрина: классы 2 и 5 → [скрыто: <вид>].
// Находка scan: {cls, kind, line (с 1), start, end} — позиции внутри строки текста с концами LF.
const MASKED = new Set([2, 5]);

export function maskText(text, scan, opts = {}) {
  if (typeof text !== 'string' || text === '') return text;
  const found = scan(text, opts).filter((f) => MASKED.has(f.cls) && f.end > f.start);
  if (found.length === 0) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const byLine = new Map();
  for (const f of found) {
    if (!byLine.has(f.line)) byLine.set(f.line, []);
    byLine.get(f.line).push(f);
  }
  for (const [ln, fs] of byLine) {
    // слить пересечения, затем заменять с конца строки — позиции левее не сдвигаются
    fs.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const f of fs) {
      const last = merged[merged.length - 1];
      if (last && f.start < last.end) last.end = Math.max(last.end, f.end);
      else merged.push({ start: f.start, end: f.end, kind: f.kind });
    }
    let s = lines[ln - 1];
    for (const m of merged.reverse()) s = s.slice(0, m.start) + `[скрыто: ${m.kind}]` + s.slice(m.end);
    lines[ln - 1] = s;
  }
  return lines.join('\n');
}

// Все строки-значения объекта ответа; ключи, числа, null — как есть.
export function maskDeep(value, scan, opts = {}) {
  if (typeof value === 'string') return maskText(value, scan, opts);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, scan, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, scan, opts);
    return out;
  }
  return value;
}
