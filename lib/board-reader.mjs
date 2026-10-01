// Читатель доски (спека витрины 1.2): C:\projects\unorbis-board, только чтение.
// Старт — projects.md и все шапки <КОД>/<КОД>-<N>.md; опрос — `rev-parse HEAD`, сменился —
// перечитать только файлы из `diff --name-only <старый>..<новый>`. Ошибка — прежние данные,
// счётчик ошибок, время последнего удачного чтения не двигается (2.7).
import nodeFs from 'node:fs';
import path from 'node:path';

const CODE_RE = /^[A-Z]{2,6}$/;

// projects.md (§1.6 спеки доски): первая таблица — «код | имя | статус».
export function parseProjectsMd(text) {
  const out = [];
  let inTable = false;
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) { if (inTable && out.length) break; continue; }
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (!inTable) { if (cells[0] === 'код') inTable = true; continue; }
    if (/^-+$/.test(cells[0])) continue;
    if (CODE_RE.test(cells[0])) out.push({ code: cells[0], name: cells[1] ?? '', status: cells[2] ?? '' });
  }
  return out;
}

export function createBoardReader({ root, git, parseCard, fs = nodeFs }) {
  const ROOT = path.resolve(root);
  const st = { projects: [], cards: new Map(), head: null, lastOkAt: null, errors: 0, lastError: null, busy: false };

  const fileOf = (code, id) => {
    const p = path.resolve(ROOT, code, `${id}.md`);
    if (!p.startsWith(ROOT + path.sep)) throw new Error('путь вне корня доски');
    return p;
  };

  function loadCard(code, id) {
    let text;
    try {
      text = fs.readFileSync(fileOf(code, id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { st.cards.delete(id); return; }
      throw e;
    }
    try {
      const { header } = parseCard(text.replace(/\r\n/g, '\n'));
      st.cards.set(id, { id, code, status: header.status, title: header.title, updated: header.updated, markB: header.mark_b });
    } catch (e) {
      st.cards.delete(id);
      st.errors++; st.lastError = `шапка ${id}: ${e.message}`;
    }
  }

  function loadAll() {
    st.projects = parseProjectsMd(fs.readFileSync(path.join(ROOT, 'projects.md'), 'utf8'));
    st.cards.clear();
    for (const { code } of st.projects) {
      let names = [];
      try { names = fs.readdirSync(path.join(ROOT, code)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const re = new RegExp(`^(${code}-\\d+)\\.md$`);
      for (const n of names) { const m = n.match(re); if (m) loadCard(code, m[1]); }
    }
  }

  const ok = () => { st.lastOkAt = new Date().toISOString(); };
  const fail = (e) => { st.errors++; st.lastError = e.code || e.message; };

  async function readHead() {
    return (await git(ROOT, ['rev-parse', 'HEAD'])).trim();
  }

  return {
    async init() {
      try {
        st.head = await readHead();
        loadAll();
        ok();
      } catch (e) { fail(e); }
    },
    async refresh() {
      if (st.busy) return;
      st.busy = true;
      try {
        const head = await readHead();
        if (head === st.head) { ok(); return; }
        if (!st.head) { loadAll(); st.head = head; ok(); return; }
        const changed = (await git(ROOT, ['diff', '--name-only', `${st.head}..${head}`])).split(/\r?\n/).filter(Boolean);
        if (changed.includes('projects.md')) loadAll();
        else {
          const codes = new Set(st.projects.map((p) => p.code));
          for (const f of changed) {
            const m = f.match(/^([A-Z]{2,6})\/(\1-\d+)\.md$/);
            if (m && codes.has(m[1])) loadCard(m[1], m[2]);
          }
        }
        st.head = head;
        ok();
      } catch (e) { fail(e); } finally { st.busy = false; }
    },
    codes: () => st.projects.slice(),
    hasCode: (code) => st.projects.some((p) => p.code === code),
    counts(code) {
      const c = { inProgress: 0, ready: 0, review: 0 };
      for (const card of st.cards.values()) {
        if (card.code !== code) continue;
        if (card.status === 'in-progress') c.inProgress++;
        else if (card.status === 'ready') c.ready++;
        else if (card.status === 'review') c.review++;
      }
      return c;
    },
    // id уже проверен по формату и словарю кодов (lib/params.mjs); путь сверяется с корнем ещё раз.
    readCard(id) {
      const code = id.split('-')[0];
      let text;
      try { text = fs.readFileSync(fileOf(code, id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      return parseCard(text.replace(/\r\n/g, '\n'));
    },
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError, head: st.head, cards: st.cards.size }),
  };
}
