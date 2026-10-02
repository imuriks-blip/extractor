// Десктопный индекс тредов (спека витрины 1.2; такт В3): <корень>\<…>\<…>\local_<id>.json, только чтение.
// Корни — настройка (paths.desktopIndex: обычный %APPDATA% и каталог пакета MSIX). Файл перечитывается только при
// смене mtime; хранятся только поля, нужные витрине. Ключ — sessionId файла (= hostSessionId реестра процессов).
import nodeFs from 'node:fs';
import path from 'node:path';

const LOCAL = /^local_[A-Za-z0-9-]+\.json$/;
const MAX_DEPTH = 3;

export function createDesktopIndex({ roots = [], fs = nodeFs }) {
  const cache = new Map(); // путь → { mtimeMs, rec }
  const st = { lastOkAt: null, errors: 0, lastError: null, files: 0 };

  function walk(dir, depth, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1, out);
      else if (e.isFile() && LOCAL.test(e.name)) out.push(p);
    }
  }

  function refresh() {
    const found = [];
    let failed = false;
    for (const r of roots) {
      try { walk(r, 0, found); } catch (e) { if (e.code !== 'ENOENT') { failed = true; st.errors++; st.lastError = e.code ?? 'ERR'; } }
    }
    const seen = new Set(found);
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    for (const f of found) {
      try {
        const m = fs.statSync(f).mtimeMs;
        if (cache.get(f)?.mtimeMs === m) continue;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        cache.set(f, { mtimeMs: m, rec: { sessionId: j.sessionId ?? path.basename(f, '.json'), cliSessionId: j.cliSessionId ?? null, title: typeof j.title === 'string' ? j.title : null, lastActivityAt: j.lastActivityAt ?? null, isArchived: j.isArchived === true, priorCliSessionIds: Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds : [] } });
      } catch (e) { failed = true; st.errors++; st.lastError = e.code ?? e.name; }
    }
    st.files = cache.size;
    if (!failed) st.lastOkAt = new Date().toISOString();
  }

  // одна и та же запись в двух корнях (обычный путь и MSIX) — берётся более свежая по mtime
  function get(hostSessionId) {
    let best = null;
    for (const v of cache.values()) if (v.rec.sessionId === hostSessionId && (!best || v.mtimeMs > best.mtimeMs)) best = v;
    return best ? best.rec : null;
  }

  return { refresh, get, state: () => ({ ...st }) };
}
