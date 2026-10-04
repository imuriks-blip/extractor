// Словарь цеха (спека витрины §2.10, EXT-61): Vault unorbis/Словарь.md (ведёт Демон) — разделы `## …` и строки таблиц
// `| термин | по-русски | что это у нас | пример |`. Шапка YAML пропускается; в таблице первая строка (шапка) и
// разделитель `|---|` пропускаются; `\|` в ячейке — не разделитель; строки вне таблиц и таблицы до первого раздела —
// мимо; обратные кавычки — как есть (вид рисует моноширинным). Разделы без строк не отдаются.
// Читатель: файл перечитывается только при смене времени изменения (или размера); git не нужен; файла нет,
// не читается, нет разделов с таблицами — sections: [] и error словами (ручка — 200).
import nodeFs from 'node:fs';

const SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

// ячейки строки таблицы: делим по «|», перед которым нет «\»; крайние пустые (до первой и после последней «|») — мимо
function cells(line) {
  const parts = line.split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseGlossary(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  // шапка YAML: первая строка «---» — до следующей «---»
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    i = end === -1 ? lines.length : end + 1;
  }
  const sections = [];
  let cur = null;
  let inTable = false;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const h = /^##\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (h) { cur = { title: h[1], rows: [] }; sections.push(cur); inTable = false; continue; }
    if (!line.startsWith('|')) { inTable = false; continue; }
    // первая строка таблицы — шапка
    if (!inTable) { inTable = true; continue; }
    if (SEP.test(line) || !cur) continue;
    const [term = '', ru = '', meaning = '', example = ''] = cells(line);
    cur.rows.push({ term, ru, meaning, example });
  }
  return sections.filter((s) => s.rows.length > 0);
}

// file() — полный путь к словарю или null (Vault не задан); fs — подмена в тестах
export function createGlossary({ file, fs = nodeFs }) {
  let cache = null; // {path, mtimeMs, size, value}
  const fail = (error) => ({ sections: [], updatedAt: null, error });
  return {
    get() {
      const p = file();
      if (!p) return fail('не задан путь к Vault (paths.vault или vault_root реестра)');
      let st;
      try { st = fs.statSync(p); } catch (e) {
        return fail(e.code === 'ENOENT' ? 'файла словаря нет (unorbis/Словарь.md)' : `файл словаря не читается (${e.code ?? 'ошибка'})`);
      }
      if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.value;
      let value;
      try {
        const sections = parseGlossary(fs.readFileSync(p, 'utf8'));
        value = sections.length
          ? { sections, updatedAt: new Date(st.mtimeMs).toISOString(), error: null }
          : fail('в файле словаря нет разделов «## …» с таблицами');
      } catch (e) {
        return fail(`файл словаря не читается (${e.code ?? 'ошибка'})`);
      }
      cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, value };
      return value;
    },
  };
}

export const NO_GLOSSARY = { get: () => ({ sections: [], updatedAt: null, error: 'словарь не подключён' }) };
