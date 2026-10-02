// Карточки проектов (спека витрины 1.2, 2.5, 3.2): Vault/<project_cards[0] реестра>, frontmatter `phase`,
// `next_action`; по mtime, только чтение. Маячок показывает их целиком (без обрезки до 90 знаков).
// Путь — от vault_root реестра и сверяется: разрешённый путь лежит внутри Vault.
import nodeFs from 'node:fs';
import path from 'node:path';
import { cutChars } from './text.mjs';

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
      // ошибка чтения (2.7): прежние фаза и шаг, failingSince — с первого сбоя подряд, readAt — последнее удачное чтение
      const c = cache.get(file) ?? { mtimeMs: null, value: { phase: null, next: null }, readAt: null, failingSince: null };
      try {
        const m = fs.statSync(file).mtimeMs;
        if (c.mtimeMs !== m) {
          const f = parseFront(fs.readFileSync(file, 'utf8'));
          const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
          c.value = { phase: str(f.phase), next: str(f.next_action) };
          c.mtimeMs = m;
        }
        c.readAt = new Date().toISOString();
        c.failingSince = null;
      } catch {
        c.failingSince ??= new Date().toISOString();
      }
      cache.set(file, c);
      return { ...c.value, readAt: c.readAt, failingSince: c.failingSince };
    },
  };
}

// Строка проекта на «Цехе» (2.5): первое предложение (конец — . ! ? … перед пробелом или концом), не длиннее 90 знаков,
// обрезанное — с «…»; full — целиком, для подсказки. Нет текста — null (вёрстка пишет серым).
export const BRIEF_MAX = 90;
export function brief(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const full = text.trim();
  const m = full.match(/^.*?[.!?…](?=\s|$)/s);
  let short = m ? m[0] : full;
  short = cutChars(short, BRIEF_MAX);
  return { short, full };
}
