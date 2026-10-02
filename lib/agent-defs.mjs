// Определения агентов (спека витрины 1.2, 2.2): ~/.claude/agents/<имя>.md → maxTurns из шапки (frontmatter).
// По mtime; только чтение. Имя — только [a-z0-9-] (тип агента из журнала в путь иначе не попадает).
import nodeFs from 'node:fs';
import path from 'node:path';

export function createAgentDefs({ dir, fs = nodeFs }) {
  const cache = new Map(); // имя → { mtimeMs, maxTurns }
  return function maxTurns(name) {
    if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) return null;
    const f = path.join(dir, `${name}.md`);
    try {
      const m = fs.statSync(f).mtimeMs;
      if (cache.get(name)?.mtimeMs !== m) {
        const head = fs.readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const v = head?.[1].match(/^maxTurns:\s*(\d+)\s*$/m);
        cache.set(name, { mtimeMs: m, maxTurns: v ? Number(v[1]) : null });
      }
      return cache.get(name).maxTurns;
    } catch { return cache.get(name)?.maxTurns ?? null; }
  };
}
