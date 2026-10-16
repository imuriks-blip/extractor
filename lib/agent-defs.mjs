// Определения агентов (спека витрины 1.2, 2.2; EXT-116 Р2): ~/.claude/agents/<имя>.md → maxTurns и model из шапки
// (frontmatter). По mtime; только чтение. Имя — только [a-z0-9-] (тип агента из журнала в путь иначе не попадает).
// read(name) — факт для сверки окна «агенты»: файл есть — {def: true, maxTurns, model} (поля нет — null); файла нет
// (ENOENT) — {def: false}, запись убирается из кэша; другая ошибка stat или чтения — прежнее из кэша, без прежнего —
// {def: null} («определение не читается»); имя не по правилу — null без чтения диска.
// Сама функция — maxTurns(name) (полоса под тредом, лента карточки): сигнатура прежняя, число или null.
import nodeFs from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9-]+$/;

export function createAgentDefs({ dir, fs = nodeFs }) {
  const cache = new Map(); // имя → { mtimeMs, maxTurns, model }
  const fact = (c) => ({ def: true, maxTurns: c.maxTurns, model: c.model });
  function read(name) {
    if (typeof name !== 'string' || !NAME.test(name)) return null;
    const f = path.join(dir, `${name}.md`);
    try {
      const m = fs.statSync(f).mtimeMs;
      if (cache.get(name)?.mtimeMs !== m) {
        const head = fs.readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
        const turns = head?.match(/^maxTurns:\s*(\d+)\s*$/m);
        const model = head?.match(/^model:\s*["']?([^"'\s]+)["']?\s*$/m);
        cache.set(name, { mtimeMs: m, maxTurns: turns ? Number(turns[1]) : null, model: model ? model[1] : null });
      }
      return fact(cache.get(name));
    } catch (e) {
      if (e?.code === 'ENOENT') { cache.delete(name); return { def: false }; }
      const prev = cache.get(name);
      return prev ? fact(prev) : { def: null };
    }
  }
  function maxTurns(name) {
    return read(name)?.maxTurns ?? null;
  }
  maxTurns.read = read;
  return maxTurns;
}
