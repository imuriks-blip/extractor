// Карточки проектов (спека витрины 1.2, 2.5, 3.2): Vault/<project_cards[0] реестра>, frontmatter `phase`,
// `next_action`; по mtime, только чтение. Маячок показывает их целиком (без обрезки до 90 знаков).
// Путь — от vault_root реестра и сверяется: разрешённый путь лежит внутри Vault.
import nodeFs from 'node:fs';
import path from 'node:path';

// значение строки frontmatter: "…" (экраны \" \\ \n), '…' ('' → '), иначе как есть
function scalar(v) {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1).replace(/\\"/g, '"'); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function parseFront(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = {};
  if (lines[0] !== '---') return out;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) out[m[1]] = scalar(m[2]);
  }
  return out;
}

export function createProjectCards({ registry, fs = nodeFs }) {
  const cache = new Map(); // файл → {mtimeMs, value}
  return {
    // null — кода нет в реестре; {phase: null, next: null} — нет карточки, поля или файл не читается
    get(code) {
      const reg = registry.get();
      const entry = reg.codes.find((c) => c.code === code);
      if (!entry) return null;
      const rel = entry.projectCards[0];
      if (!rel || !reg.vaultRoot) return { phase: null, next: null };
      const root = path.resolve(reg.vaultRoot);
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) return { phase: null, next: null };
      try {
        const m = fs.statSync(file).mtimeMs;
        const c = cache.get(file);
        if (!c || c.mtimeMs !== m) {
          const f = parseFront(fs.readFileSync(file, 'utf8'));
          const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
          cache.set(file, { mtimeMs: m, value: { phase: str(f.phase), next: str(f.next_action) } });
        }
        return { ...cache.get(file).value };
      } catch {
        return cache.has(file) ? { ...cache.get(file).value } : { phase: null, next: null };
      }
    },
  };
}
