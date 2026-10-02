// Читатель доски (спека витрины 1.2): C:\projects\unorbis-board, только чтение.
// Старт — projects.md и все шапки <КОД>/<КОД>-<N>.md; опрос — `rev-parse HEAD`, сменился —
// перечитать только файлы из `diff --name-only <старый>..<новый>`. Ошибка — прежние данные,
// счётчик ошибок, время последнего удачного чтения не двигается (2.7).
import nodeFs from 'node:fs';
import path from 'node:path';
import { yesMark } from './waiting.mjs';

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

// parseLog — разбор журнала карточки доски (tools/lib/log.mjs, одно место правды); без него журналы не читаются.
// От журнала хранится только последняя запись (§1.4 спеки доски: время заголовка, затем место в файле): время,
// заголовок (ключ уведомления (б), 4.1) и метка «нужно твоё да» (2.4) — тело не хранится.
export function createBoardReader({ root, git, parseCard, parseLog = null, latest = null, fs = nodeFs }) {
  const ROOT = path.resolve(root);
  // badHeaders — id карточек, чья шапка сейчас не разбирается (число — в /api/health отдельно от errors);
  // logErrors — ошибки чтения или разбора журналов карточек (карточка остаётся с прежней последней записью)
  const st = { projects: [], cards: new Map(), badHeaders: new Set(), head: null, lastOkAt: null, errors: 0, lastError: null, busy: false, logErrors: 0, lastLogError: null, logRetry: new Set() };
  // карточки, чей журнал не прочитался, — в список перечитки следующего прохода
  const retryFiles = () => [...st.logRetry].map((id) => `${id.split('-')[0]}/${id}.md`);

  const fileOf = (code, id) => {
    const p = path.resolve(ROOT, code, `${id}.md`);
    if (!p.startsWith(ROOT + path.sep)) throw new Error('путь вне корня доски');
    return p;
  };

  // Последняя запись журнала карточки — latest() доски (время заголовка, затем место в файле). Ошибка чтения или
  // разбора журнала (EBUSY, EPERM, исключение parseLog) карточку не трогает: прежняя последняя запись, свой счётчик
  // (вердикт Голема на В4: при ручном зеркале выпавшая карточка не вернулась бы днями).
  function lastEntry(code, id) {
    if (!parseLog || !latest) return null;
    st.logRetry.delete(id);
    try {
      let text;
      try { text = fs.readFileSync(path.resolve(ROOT, code, `${id}.log.md`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const best = latest(parseLog(text));
      if (!best || !Number.isFinite(best.ms)) return null;
      // line и author — строка доски проекта (2.5): первая строка тела до 120 знаков, автор plane не показывается
      const first = String(best.body ?? '').split('\n').find((l) => l.trim()) ?? '';
      const line = first.length > 120 ? first.slice(0, 119) + '…' : first;
      return { at: new Date(best.ms).toISOString(), key: `${best.date} ${best.time} ${best.off} · ${best.as} · ${best.kind}`, mark: yesMark(best.body), line, author: best.as === 'plane' ? null : best.as };
    } catch (e) {
      st.logErrors++; st.lastLogError = `журнал ${id}: ${e.code ?? 'разбор'}`;
      st.logRetry.add(id); // перечитать на следующем проходе, даже если файлы не менялись (круг 2 Голема, мелочь 7)
      return st.cards.get(id)?.last ?? null;
    }
  }

  // Читает одну шапку в cards/bad. Нет файла — карточка убирается; иная ошибка чтения — наверх.
  function loadCard(code, id, cards, bad) {
    let text;
    try {
      text = fs.readFileSync(fileOf(code, id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { cards.delete(id); bad.delete(id); st.logRetry.delete(id); return; }
      throw e;
    }
    let header;
    try {
      header = parseCard(text.replace(/\r\n/g, '\n')).header;
    } catch (e) {
      cards.delete(id);
      bad.add(id);
      st.logRetry.delete(id); // битую шапку не перечитываем каждые 5 с (круг 3 Голема, мелочь 1)
      st.errors++; st.lastError = `шапка ${id}`;
      return;
    }
    // связи (§1.3 спеки доски: хранятся один раз) — для встречной стороны в карточке (2.6, В5)
    const links = { parent: header.parent || null, blocks: header.blocks ?? [], blockedBy: header.blocked_by ?? [], relates: header.relates ?? [] };
    cards.set(id, { id, code, status: header.status, title: header.title, updated: header.updated, markB: header.mark_b, label: Array.isArray(header.labels) && header.labels.length ? header.labels[0] : null, links, last: lastEntry(code, id) });
    bad.delete(id);
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
      const m = f.match(/^([A-Z]{2,6})\/(\1-\d+)(?:\.log)?\.md$/); // шапка или журнал — перечитать карточку
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
        if (head === st.head) { if (st.logRetry.size) loadChanged(retryFiles()); ok(); return; }
        if (!st.head) { loadAll(); st.head = head; ok(); return; }
        let changed = null;
        try {
          changed = (await git(ROOT, ['diff', '--name-only', '--no-renames', `${st.head}..${head}`])).split(/\r?\n/).filter(Boolean);
        } catch (e) {
          fail(e); // diff не удался (старый HEAD ушёл после перезаписи истории и т. п.) — полное чтение
        }
        if (changed) loadChanged([...changed, ...retryFiles()]); else loadAll();
        st.head = head;
        ok();
      } catch (e) { fail(e); } finally { st.busy = false; }
    },
    codes: () => st.projects.slice(),
    hasCode: (code) => st.projects.some((p) => p.code === code),
    // номер карточки сверяется с файлами доски (1.4): файл есть (шапка разобрана или битая)
    hasCard: (id) => st.cards.has(id) || st.badHeaders.has(id),
    // .mirror/index.json зеркала (вне git) — UUID Plane → номер (1.4); по mtime, ошибка — прежнее или null
    mirrorIndex() {
      const f = path.join(ROOT, '.mirror', 'index.json');
      try {
        const m = fs.statSync(f).mtimeMs;
        if (st.mirrorMtime !== m) { st.mirror = JSON.parse(fs.readFileSync(f, 'utf8')); st.mirrorMtime = m; }
      } catch { /* нет файла или не читается — прежнее значение */ }
      return st.mirror ?? null;
    },
    card: (id) => st.cards.get(id) ?? null,
    cardsList: () => [...st.cards.values()],
    // возраст зеркала (В-5): .mirror/status.json → lastOk (вне git, по mtime); нет файла — null
    mirrorStatus() {
      const f = path.join(ROOT, '.mirror', 'status.json');
      try {
        const m = fs.statSync(f).mtimeMs;
        if (st.statusMtime !== m) { st.mirrorStatus = JSON.parse(fs.readFileSync(f, 'utf8')); st.statusMtime = m; }
      } catch (e) { if (e.code === 'ENOENT') { st.mirrorStatus = null; st.statusMtime = null; } }
      const ok = st.mirrorStatus?.lastOk;
      if (typeof ok !== 'string' || !Number.isFinite(Date.parse(ok))) return null;
      const d = new Date(ok);
      const p2 = (n) => String(n).padStart(2, '0');
      return { lastOkAt: ok, label: `доска: зеркало Plane от ${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}` };
    },
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
    // Журнал карточки целиком для ленты (2.6, В5): записи parseLog доски; нет файла — []; ошибка чтения или разбора —
    // {entries: [], error} (ручка не падает). id уже проверен (lib/params.mjs); путь сверяется с корнем.
    readLog(id) {
      if (!parseLog) return { entries: [], error: null };
      const code = id.split('-')[0];
      const p = path.resolve(ROOT, code, `${id}.log.md`);
      if (!p.startsWith(ROOT + path.sep)) return { entries: [], error: 'путь' };
      try {
        return { entries: parseLog(fs.readFileSync(p, 'utf8')), error: null };
      } catch (e) {
        return { entries: [], error: e.code === 'ENOENT' ? null : (e.code ?? 'разбор') };
      }
    },
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError, badHeaders: st.badHeaders.size, head: st.head, cards: st.cards.size, logErrors: st.logErrors, lastLogError: st.lastLogError }),
  };
}
