// Реестр проектов (спека витрины 1.4, решение В0-реестр 01.10). Имена полей реестра — только здесь.
// board_codes — единственный источник связки код → карточки проекта → репозитории; порядок ключей —
// порядок проектов на «Цехе»; ключи с «_» — служебные. Наследное поле board в projects[] не читается.
import nodeFs from 'node:fs';

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export function parseRegistry(obj) {
  const codesObj = obj && typeof obj.board_codes === 'object' && obj.board_codes ? obj.board_codes : {};
  const codes = [];
  for (const [code, v] of Object.entries(codesObj)) {
    if (code.startsWith('_') || !v || typeof v !== 'object') continue;
    codes.push({
      code,
      projects: list(v.projects),
      projectCards: list(v.project_cards),
      repos: list(v.repos),
      note: typeof v.note === 'string' ? v.note : null,
    });
  }
  return {
    codes,
    sharedRepos: list(obj?.board_shared_repos?.repos),
    vaultRoot: typeof obj?.vault_root === 'string' ? obj.vault_root : null,
  };
}

export function readRegistry(file, fs = nodeFs) {
  return parseRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Читатель с кэшем по mtime (1.2: «по mtime»): ошибка чтения — прежнее значение и счётчик.
export function createRegistryReader(file, fs = nodeFs) {
  const st = { value: { codes: [], sharedRepos: [], vaultRoot: null }, mtimeMs: -1, lastOkAt: null, errors: 0, lastError: null };
  return {
    get() {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m !== st.mtimeMs) { st.value = readRegistry(file, fs); st.mtimeMs = m; }
        st.lastOkAt = new Date().toISOString();
      } catch (e) {
        st.errors++; st.lastError = e.code || e.name;
      }
      return st.value;
    },
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError }),
  };
}
