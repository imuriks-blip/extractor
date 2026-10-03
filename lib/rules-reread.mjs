// Набор файлов «правила перечитаны» (EXT-54, спека витрины 2.3): config.json → rulesReread.files.
// «~/…» — от домашней папки (автослой дирижёра ~/.claude/CLAUDE.md), абсолютный — как есть, остальное — от vault_root
// реестра. Любой неразрешимый элемент (пустой, не строка, «~/» без домашней папки, относительный без vault_root) или
// пустой набор выключает функцию целиком — неполный набор не засчитывается. Причина — кодом (server.log пишет только
// идентификаторы): в журнал сервера и в /api/health (readers.journals.rereadOff).
import path from 'node:path';

// → { files: [абсолютные пути], off: null | код причины, item: номер элемента-причины | null }
export function resolveReread(files, { vaultRoot = null, home = null } = {}) {
  const off = (code, item = null) => ({ files: [], off: code, item });
  if (!Array.isArray(files)) return off('NOT_LIST');
  if (files.length === 0) return off('EMPTY');
  const out = [];
  for (const [i, f] of files.entries()) {
    if (typeof f !== 'string' || !f.trim()) return off('BAD_ITEM', i);
    if (/^~[\\/]/.test(f)) {
      if (!home) return off('NO_HOME', i);
      out.push(path.join(home, f.slice(2)));
    } else if (path.isAbsolute(f)) out.push(f);
    else if (vaultRoot) out.push(path.join(vaultRoot, f));
    else return off('NO_VAULT_ROOT', i);
  }
  return { files: out, off: null, item: null };
}
