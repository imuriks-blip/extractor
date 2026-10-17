// Дорожная карта цеха на витрине (EXT-103 Т2; спека Vault extractor/SPEC-extractor-roadmap.md, раздел 3, 2.2).
// Читатель карт <КОД>/<КОД>.map.md и планов <КОД>/<ID>.plan.md доски — разбор roadmap.mjs доски (один парсер на доску и
// витрину, импорт по config.paths.boardLib с запасным путём: модуля нет — lib null, ручка «карта недоступна»).
// Перечитка — вслед за читателем доски: полный проход при его полном чтении, по изменённым файлам — при смене HEAD.
// Ошибка разбора файла — прежний удачный разбор и признак ошибки (не пустота, спека витрины 2.7), счётчик parseErrors.
// Своих данных у витрины нет; статусы карточек — из читателя доски на запрос; следы — из второго входа проверки следа.
import nodeFs from 'node:fs';
import path from 'node:path';

export const ROADMAP_OFF = 'карта недоступна: модуль доски не найден';
const keyOf = (p) => path.resolve(String(p)).toLowerCase();
const baseOf = (p) => path.basename(String(p).replace(/[\\/]+$/, ''));
const FILE_RE = /^([A-Z]{2,6})\/([^/]+\.(?:map|plan)\.md)$/;

// Таблица имён репозиториев следа (2.2): весь реестр — репозитории кодов, общие, корень Vault. Имя — имя папки; любой путь,
// равный корню Vault (paths.vault, иначе vault_root; без регистра), — «Vault». Два разных пути с одним именем — clashes.
export function repoNames(reg, vault = null) {
  const root = vault || reg?.vaultRoot || null;
  const rootKey = root ? keyOf(root) : null;
  const byName = new Map(); // имя → [путь…] (разные пути)
  const add = (p) => {
    if (typeof p !== 'string' || !p) return;
    const k = keyOf(p);
    const name = k === rootKey ? 'Vault' : baseOf(p);
    const list = byName.get(name) ?? [];
    if (!list.some((x) => keyOf(x) === k)) list.push(p);
    byName.set(name, list);
  };
  for (const c of reg?.codes ?? []) for (const p of c.repos ?? []) add(p);
  for (const p of reg?.sharedRepos ?? []) add(p);
  if (root) add(root);
  const clashes = [...byName].filter(([, l]) => l.length > 1).map(([n]) => n).sort();
  return { byName, clashes };
}

// Таблица имён — одна на значение реестра (читатель реестра отдаёт тот же объект, пока файл не менялся) и путь Vault:
// state() и проход следа её не перестраивают на каждый вызов (Мелочь 2 ревью Голема на Т2)
const namesMemo = new WeakMap();
export function repoNamesOf(reg, vault = null) {
  if (!reg || typeof reg !== 'object') return repoNames(reg, vault);
  let byVault = namesMemo.get(reg);
  if (!byVault) { byVault = new Map(); namesMemo.set(reg, byVault); }
  const k = vault ?? '';
  if (!byVault.has(k)) byVault.set(k, repoNames(reg, vault));
  return byVault.get(k);
}

// lib — модуль roadmap.mjs доски ({ parseMap, parsePlan, roadmapFile }) или null (не загрузился: libError — причина)
export function createRoadmapReader({ root, lib = null, libError = null, registry = null, vault = null, fs = nodeFs }) {
  const ROOT = path.resolve(root);
  const ok = !!(lib && typeof lib.parseMap === 'function' && typeof lib.parsePlan === 'function' && typeof lib.roadmapFile === 'function');
  // файл (относительный путь доски) → { kind, code, id, value (последний удачный разбор), errors (текущие ошибки разбора) }
  const files = new Map();
  let codes = new Set(); // коды projects.md последнего полного чтения: loadChanged берёт только их (Мелочь 3 ревью)
  const st = { lastOkAt: null, parseErrors: 0, lastError: ok ? null : (libError || ROADMAP_OFF) };

  function loadFile(rel) {
    const m = rel.match(FILE_RE);
    const f = m && lib.roadmapFile(m[1], m[2]);
    if (!f) return;
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep)) return;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') { files.delete(rel); return; }
      st.lastError = `${rel}: ${e.code ?? 'чтение'}`;
      return; // прежнее значение остаётся
    }
    const r = f.kind === 'map' ? lib.parseMap(text, { code: f.code }) : lib.parsePlan(text, { id: f.id });
    const prev = files.get(rel);
    if (r.errors.length) {
      st.parseErrors++;
      st.lastError = `${rel}: строка ${r.errors[0].line}: ${r.errors[0].msg}`;
      files.set(rel, { ...f, value: prev?.value ?? null, errors: r.errors });
      return;
    }
    files.set(rel, { ...f, value: f.kind === 'map' ? r.map : r.plan, warnings: r.warnings, errors: [] });
  }

  const done = () => { st.lastOkAt = new Date().toISOString(); };
  return {
    available: () => ok,
    // полное чтение (старт, projects.md изменился, diff не удался): коды — из projects.md доски
    loadAll(projects) {
      if (!ok) return;
      codes = new Set((projects ?? []).map((p) => p.code));
      const seen = new Set();
      for (const { code } of projects ?? []) {
        let names = [];
        try { names = fs.readdirSync(path.join(ROOT, code)); } catch (e) { if (e.code !== 'ENOENT') { st.lastError = `${code}: ${e.code}`; continue; } }
        for (const n of names) if (lib.roadmapFile(code, n)) { seen.add(`${code}/${n}`); loadFile(`${code}/${n}`); }
      }
      for (const rel of [...files.keys()]) if (!seen.has(rel)) files.delete(rel);
      done();
    },
    // изменённые файлы доски (diff --name-only): только карты и планы
    loadChanged(changed) {
      if (!ok) return;
      for (const rel of changed ?? []) { const m = rel.match(FILE_RE); if (m && codes.has(m[1])) loadFile(rel); }
      done();
    },
    // { value, errors } карты проекта; нет файла — null
    map(code) {
      const e = files.get(`${code}/${code}.map.md`);
      return e ? { value: e.value, errors: e.errors } : null;
    },
    plan(id) {
      const e = files.get(`${id.split('-')[0]}/${id}.plan.md`);
      return e ? { value: e.value, errors: e.errors } : null;
    },
    mapCodes: () => [...files.values()].filter((e) => e.kind === 'map').map((e) => e.code),
    // цели второго входа проверки следа (раздел 3): следы-коммиты и номера карточек (следы, «Карточки», идеи, [>])
    targets() {
      const commits = new Set();
      const cards = new Set();
      const traceCards = new Set();
      for (const e of files.values()) {
        if (!e.value) continue;
        if (e.kind === 'map') {
          for (const c of e.value.cards) cards.add(c.id);
          for (const i of e.value.ideas) if (i.card) cards.add(i.card);
          continue;
        }
        for (const it of e.value.items) {
          if (it.card) cards.add(it.card);
          if (!it.trace) continue;
          for (const p of it.trace.split(', ')) (p.includes('@') ? commits : traceCards).add(p);
        }
      }
      return { commits: [...commits], cards: [...cards], traceCards: [...traceCards] };
    },
    state() {
      const vals = [...files.values()];
      const names = registry ? repoNamesOf(registry.get(), vault) : { clashes: [] };
      return { available: ok, lastOkAt: st.lastOkAt, maps: vals.filter((e) => e.kind === 'map').length, plans: vals.filter((e) => e.kind === 'plan').length,
        broken: vals.filter((e) => e.errors.length).length, parseErrors: st.parseErrors, lastError: st.lastError, repoNameClashes: names.clashes };
    },
  };
}

// ---------- дерево для ручек ----------

const CLOSED = new Set(['done', 'cancelled']);
const ACTIVE = new Set(['in-progress', 'review']);
// [>] и идея со ссылкой — статус с карточки (спека 1 п.2, 2.2)
const markOfCard = (s) => (s === 'done' ? 'x' : s === 'cancelled' ? '-' : ACTIVE.has(s) ? '~' : s ? ' ' : null);
const ideaOfCard = (s) => (s === 'done' ? 'сделана' : s === 'cancelled' ? 'стала карточкой · карточка снята' : ACTIVE.has(s) ? 'в работе' : 'стала карточкой');
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function planTree(reader, board, trace, id) {
  const p = reader.plan(id);
  if (!p) return null;
  const items = (p.value?.items ?? []).map((it) => {
    const cardStatus = it.card ? board.card(it.card)?.status ?? null : null;
    const shownMark = it.mark === '>' ? markOfCard(cardStatus) : it.mark;
    const traces = it.trace ? it.trace.split(', ').map((part) => ({ part, ...(trace.peekRoad?.(part) ?? { state: null, label: 'проверяю след…', reasons: [] }) })) : [];
    // [>] сделан по карточке — след её контракта
    const cardTrace = it.mark === '>' && cardStatus === 'done' ? trace.peekRoad?.(it.card) ?? null : null;
    return { depth: it.depth, mark: it.mark, shownMark, num: it.num, text: it.text, card: it.card || null, cardStatus, cardTrace, wait: it.wait || null, why: it.why || null, traces };
  });
  // «сделано X из Y»: снятые ([-] и [>] снятой карточки) в Y не входят — одно правило с planTotals доски (EXT-103, ревью Голема Т3)
  return { id, items, summary: { done: items.filter((i) => i.shownMark === 'x').length, total: items.filter((i) => i.shownMark !== '-').length }, broken: p.errors.length ? { errors: p.errors } : null };
}

function cardNode(reader, board, trace, id) {
  const c = board.card(id);
  const status = c?.status ?? null;
  const kids = board.cardsList().filter((k) => k.links?.parent === id).sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]) || a.id.localeCompare(b.id));
  let childrenSummary = null;
  if (kids.length) {
    const closed = kids.filter((k) => CLOSED.has(k.status)).length;
    const active = kids.filter((k) => ACTIVE.has(k.status)).length;
    const waiting = kids.length - closed - active;
    childrenSummary = { closed, total: kids.length, active, waiting, label: `закрыто ${closed} из ${kids.length} · идёт ${active} · ждёт ${waiting}` };
  }
  // серая подсказка (1 п.7): все маленькие закрыты, большая ещё не закрыта
  const hint = childrenSummary && childrenSummary.closed === childrenSummary.total && status && !CLOSED.has(status) ? 'все маленькие закрыты' : null;
  return { id, code: id.split('-')[0], exists: !!c, title: c?.title ?? null, status,
    trace: status === 'done' ? trace.peekRoad?.(id) ?? null : null,
    children: kids.map((k) => ({ id: k.id, title: k.title, status: k.status })), childrenSummary, hint, plan: planTree(reader, board, trace, id) };
}

function mapTree(reader, board, trace, m) {
  const cards = { ahead: [], done: [], cancelled: [] };
  for (const { id } of m.cards) {
    const n = cardNode(reader, board, trace, id);
    (n.status === 'done' ? cards.done : n.status === 'cancelled' ? cards.cancelled : cards.ahead).push(n);
  }
  const ideas = m.ideas.map((i) => {
    const cardStatus = i.card ? board.card(i.card)?.status ?? null : null;
    return { n: i.n, status: i.status, shown: i.card ? ideaOfCard(cardStatus) : i.status, date: i.date, from: i.from, text: i.text, ask: i.ask || null, card: i.card || null, cardStatus,
      cardTrace: i.card && cardStatus === 'done' ? trace.peekRoad?.(i.card) ?? null : null, why: i.why || null };
  });
  const questions = m.questions.map((q) => ({ n: q.n, status: q.status, date: q.date, from: q.from, text: q.text, answer: q.answer || null, who: q.who || null }));
  return { where: m.where, questions, ideas, cards };
}

// «впереди» без повторов (раздел 3 «Вид»): карточка кода C в карте проекта P считается у P, если C = P или карты C нет
// либо в ней этой карточки нет; итог по цеху — число разных номеров
function aheadOf(reader, board, code) {
  const m = reader.map(code)?.value;
  if (!m) return [];
  return m.cards.map((c) => c.id).filter((id) => {
    const s = board.card(id)?.status;
    if (CLOSED.has(s)) return false;
    const own = id.split('-')[0];
    if (own === code) return true;
    return !(reader.map(own)?.value?.cards ?? []).some((c) => c.id === id);
  });
}

function countsOf(reader, board, code) {
  const m = reader.map(code)?.value;
  if (!m) return null;
  return { askOpen: m.questions.filter((q) => q.status === 'открыт').length, ideasDiscuss: m.ideas.filter((i) => i.status === 'обсуждаем').length, ahead: aheadOf(reader, board, code).length };
}

const brokenOf = (r, code) => (r?.errors?.length ? { file: `${code}/${code}.map.md`, errors: r.errors } : null);
const OFF = (reader) => ({ available: false, error: reader?.state().lastError || ROADMAP_OFF });

// GET /api/roadmap: проекты projects.md строками со счётчиками
export function roadmapAll({ reader, board }) {
  if (!reader?.available()) return { ...OFF(reader), projects: [], total: { ahead: 0 }, repoNameClashes: [] };
  const all = new Set();
  const projects = board.codes().map(({ code, name }) => {
    const r = reader.map(code);
    for (const id of aheadOf(reader, board, code)) all.add(id);
    return { code, name, hasMap: !!r, counts: countsOf(reader, board, code), where: r?.value?.where ?? null, broken: brokenOf(r, code) };
  });
  return { available: true, error: null, projects, total: { ahead: all.size }, repoNameClashes: reader.state().repoNameClashes };
}

// GET /api/roadmap/<КОД>: дерево карты проекта
export function roadmapOf({ reader, board, trace, code }) {
  const name = board.codes().find((p) => p.code === code)?.name ?? null;
  if (!reader?.available()) return { ...OFF(reader), code, name, hasMap: false, map: null, counts: null, broken: null };
  const r = reader.map(code);
  return { available: true, error: null, code, name, hasMap: !!r, map: r?.value ? mapTree(reader, board, trace, r.value) : null, counts: countsOf(reader, board, code), broken: brokenOf(r, code) };
}

// Р-10 (а): фаза и шаг строки «Цеха» из карты. null — карты нет (или модуль недоступен): строка — из Vault, как раньше.
// Битая карта — прежние фаза и шаг удачного разбора и текст ошибки (не откат на Vault молча).
export function whereOf(reader, code) {
  if (!reader?.available()) return null;
  const r = reader.map(code);
  if (!r) return null;
  const e = r.errors[0];
  return { phase: r.value?.where?.phase ?? null, next: r.value?.where?.next ?? null,
    error: e ? `карта ${code}: строка ${e.line}: ${e.msg}${r.errors.length > 1 ? ` · ещё ${r.errors.length - 1} ${plural(r.errors.length - 1, 'ошибка', 'ошибки', 'ошибок')}` : ''}` : null };
}
