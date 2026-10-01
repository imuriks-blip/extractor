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
  // badHeaders — id карточек, чья шапка сейчас не разбирается (число — в /api/health отдельно от errors)
  const st = { projects: [], cards: new Map(), badHeaders: new Set(), head: null, lastOkAt: null, errors: 0, lastError: null, busy: false };

  const fileOf = (code, id) => {
    const p = path.resolve(ROOT, code, `${id}.md`);
    if (!p.startsWith(ROOT + path.sep)) throw new Error('путь вне корня доски');
    return p;
  };

  // Читает одну шапку в cards/bad. Нет файла — карточка убирается; иная ошибка чтения — наверх.
  function loadCard(code, id, cards, bad) {
    let text;
    try {
      text = fs.readFileSync(fileOf(code, id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { cards.delete(id); bad.delete(id); return; }
      throw e;
    }
    try {
      const { header } = parseCard(text.replace(/\r\n/g, '\n'));
      cards.set(id, { id, code, status: header.status, title: header.title, updated: header.updated, markB: header.mark_b });
      bad.delete(id);
    } catch (e) {
      cards.delete(id);
      bad.add(id);
      st.errors++; st.lastError = `шапка ${id}`;
    }
  }

  // Полное чтение собирает новые projects/cards и подменяет их только при успехе:
  // сбой посреди чтения оставляет прежние данные (2.7).
  function loadAll() {
    const projects = parseProjectsMd(fs.readFileSync(path.join(ROOT, 'projects.md'), 'utf8'));
    const cards = new Map();
    const bad = new Set();
    for (const { code } of projects) {
      let names = [];
      try { names = fs.readdirSync(path.join(ROOT, code)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const re = new RegExp(`^(${code}-\\d+)\\.md$`);
      for (const n of names) { const m = n.match(re); if (m) loadCard(code, m[1], cards, bad); }
    }
    st.projects = projects; st.cards = cards; st.badHeaders = bad;
  }

  // Перечитать только изменившиеся файлы; на копиях — подмена при успехе, как у полного чтения.
  function loadChanged(changed) {
    if (changed.includes('projects.md')) { loadAll(); return; }
    const codes = new Set(st.projects.map((p) => p.code));
    const cards = new Map(st.cards);
    const bad = new Set(st.badHeaders);
    for (const f of changed) {
      const m = f.match(/^([A-Z]{2,6})\/(\1-\d+)\.md$/);
      if (m && codes.has(m[1])) loadCard(m[1], m[2], cards, bad);
    }
    st.cards = cards; st.badHeaders = bad;
  }

  const ok = () => { st.lastOkAt = new Date().toISOString(); };
  const fail = (e) => { st.errors++; st.lastError = e.code || e.message; };

  async function readHead() {
    return (await git(ROOT, ['rev-parse', 'HEAD'])).trim();
  }

  return {
    // HEAD запоминается только после удачного чтения: иначе опрос с тем же HEAD
    // не дочитал бы доску и двигал бы время удачного чтения над пустыми числами (вердикт Голема, Важно 1).
    async init() {
      try {
        const head = await readHead();
        loadAll();
        st.head = head;
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
        let changed = null;
        try {
          changed = (await git(ROOT, ['diff', '--name-only', '--no-renames', `${st.head}..${head}`])).split(/\r?\n/).filter(Boolean);
        } catch (e) {
          fail(e); // diff не удался (старый HEAD ушёл после перезаписи истории и т. п.) — полное чтение
        }
        if (changed) loadChanged(changed); else loadAll();
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
    // Активность проекта (2.5): наименьшая давность среди карточек — пока по `updated` шапки;
    // время последней записи журнала (§1.2 спеки доски: max(updated, журнал)) добавит читатель журналов доски.
    activity(code) {
      let best = null;
      let bestMs = -Infinity;
      for (const card of st.cards.values()) {
        if (card.code !== code) continue;
        const ms = Date.parse(card.updated);
        if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = card.updated; }
      }
      return best;
    },
    // id уже проверен по формату и словарю кодов (lib/params.mjs); путь сверяется с корнем ещё раз.
    // Нет файла — null; шапка не разбирается — {header: null, body: null, error: 'шапка'}.
    readCard(id) {
      const code = id.split('-')[0];
      let text;
      try { text = fs.readFileSync(fileOf(code, id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      try {
        const { header, body } = parseCard(text.replace(/\r\n/g, '\n'));
        return { header, body, error: null };
      } catch {
        return { header: null, body: null, error: 'шапка' };
      }
    },
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError, badHeaders: st.badHeaders.size, head: st.head, cards: st.cards.size }),
  };
}
