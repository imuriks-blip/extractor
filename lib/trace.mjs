// Проверка следа рядом с «Принять» (спека пульта §1.4а, EXT-48): гейт закрытия (протокол цеха, пп. 9 и 11) смотрит
// витрина, а не память Ивана. Только для карточек в Review.
//  - запись-контракт — последняя запись журнала карточки со строкой «Доставка»; после неё ещё записи — laterRecords;
//  - пять строк контракта (у CAR — ещё «Пост», жёлтым), «Кто решил» — одна из четырёх фраз;
//  - хеши из «Доставки» — слова из 7–40 знаков [0-9a-f] с цифрой и буквой; каждый ищется в репозиториях проекта по
//    реестру, общих репозиториях реестра и Vault (paths.vault, иначе vault_root реестра): есть ли, предок main (или
//    master, если main нет), предок origin/main — та ссылка, что есть на машине (git fetch витрина не делает).
// git — только в refresh() (опрос читателя git, start.mjs); peek() — для ручек, git не зовёт (В5 витрины).
// Кэш — на (репозиторий, хеш): найден ли — навсегда (не найден — до notFoundMs), в main — по вершине main, отправлен —
// по вершине origin/main. Вершины читаются файлами .git (ссылка или packed-refs) без процесса git: проход без перемен
// git не зовёт. Ошибка git — «не удалось проверить» (жёлтое), не кэшируется; репозиторий пропускается до следующего
// прохода (отсрочка, как у читателя git).
import nodeFs from 'node:fs';
import path from 'node:path';

export const CONTRACT_LINES = ['Что изменилось в системе', 'Откат', 'Остаточный риск', 'Доставка', 'Знание'];
export const POST_LINE = 'Пост';
export const WHO = ['слово Ивана', 'коммент Ивана', 'вердикт Голема', 'решение дирижёра'];
const OID = /^[0-9a-f]{40}$/;
const keyOf = (p) => path.resolve(p).toLowerCase();
const nameOf = (p) => path.basename(String(p).replace(/[\\/]+$/, ''));
const fold = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

// ---------- разбор контракта ----------

// строка без разметки в начале: теги, маркер списка, *, _, `, ~ — затем нижний регистр, ё → е
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const bare = (line) => String(line).replace(/<[^>]*>/g, '').replace(/^\s+/, '').replace(ITEM, '').replace(/^[\s*_`~]+/, '');
function lineHead(line) {
  return fold(bare(line));
}
// цитата (М2 Голема): «>» в начале строки или после снятия разметки, либо тег blockquote — чужие слова, не контракт
const isQuote = (line) => /^\s*(?:<blockquote\b|>)/i.test(String(line)) || bare(line).startsWith('>');
const ownLines = (body) => String(body ?? '').split(/\r?\n/).filter((l) => !isQuote(l));
// строка начинается с имени, за именем — не буква и не цифра (граница явная, без \b: кириллица)
const startsWithName = (line, name) => {
  const h = lineHead(line);
  const n = fold(name);
  return h.startsWith(n) && !/[\p{L}\p{N}]/u.test(h.charAt(n.length));
};
// другие написания строки: «Что изменилось» без «в системе» (с двоеточием или без) — та же строка (слово Ивана 04.10)
const ALIASES = { 'Что изменилось в системе': ['Что изменилось'] };
const isNamed = (line, name) => [name, ...(ALIASES[name] ?? [])].some((n) => startsWithName(line, n));
export const hasLine = (body, name) => ownLines(body).some((l) => isNamed(l, name));
const isContractLine = (line) => [...CONTRACT_LINES, POST_LINE].some((n) => isNamed(line, n));

// текст «Доставки» (В1 Голема). Строка «Доставка» — и:
//  - пункт списка: вложенные пункты и строки с отступом больше, чем у пункта (EXT-43), до пункта того же или меньшего
//    уровня; строка без отступа сразу за пунктом — продолжение абзаца пункта;
//  - отдельная строка без текста после имени («**Доставка**», ASTRO-22): всё ниже, через пустые строки, до следующей
//    строки контракта;
//  - строка с текстом: её абзац (до пустой строки).
// Всегда — до заголовка или следующей строки контракта. Цитаты пропускаются.
const indentOf = (l) => String(l).match(/^\s*/)[0].replace(/\t/g, '    ').length;
export function deliveryText(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => !isQuote(l) && startsWithName(l, 'Доставка'));
  if (i < 0) return null;
  const item = ITEM.test(lines[i]);
  const rest = lineHead(lines[i]).slice('доставка'.length).replace(/^[\s*_`~:.—-]+/, '');
  const block = !item && !rest;
  const base = indentOf(lines[i]);
  const out = [lines[i]];
  let blank = false;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim()) { blank = true; if (block || item) continue; break; }
    if (/^\s*#/.test(l) || (!isQuote(l) && isContractLine(l))) break;
    if (isQuote(l)) { blank = false; continue; }
    if (item) {
      if (indentOf(l) > base) { out.push(l); blank = false; continue; }
      if (!blank && !ITEM.test(l)) { out.push(l); continue; }
      break;
    }
    out.push(l);
    blank = false;
  }
  return out.join('\n');
}

// кандидаты в хеши — целые слова (буквы любого алфавита, цифры, «_» и «-» — части слова: «2fea3135-c7db» и «W-…-20e9»
// не хеши) из 7–40 знаков [0-9a-f]. С цифрой и буквой — хеш (strong): не найден — красное. Из одних цифр или одних
// букв a–f (К1 Голема: живой 2743963) — слабый кандидат: ищется так же, не найден нигде — молча отбрасывается
// («1234567», «decade»). Адреса (`схема://…`) вынимаются до разбора: поддомен развёртывания — не коммит; так же доменные
// имена и имена файлов без схемы — слово, за которым точка и латинская буква (d572ff8e.unorbis-car-web.pages.dev,
// CAR-235; правка дирижёра). «2e2f446.» в конце фразы — хеш.
export function candidatesIn(text) {
  const out = [];
  const plain = String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').replace(/[\p{L}\p{N}_-]+(?:\.[a-z][\p{L}\p{N}_-]*)+/giu, ' ');
  for (const w of plain.split(/[^\p{L}\p{N}_-]+/u)) {
    if (/^[0-9a-f]{7,40}$/.test(w) && !out.some((x) => x.hash === w)) out.push({ hash: w, weak: !(/[0-9]/.test(w) && /[a-f]/.test(w)) });
  }
  return out;
}
export const hashesIn = (text) => candidatesIn(text).filter((c) => !c.weak).map((c) => c.hash);

// кто решил — первая по тексту из четырёх фраз (без регистра и разметки, без цитат), в каноническом написании; нет — null
export function whoIn(body) {
  const t = fold(ownLines(body).join('\n').replace(/[*_`~]/g, '').replace(/\s+/g, ' '));
  let best = null;
  for (const w of WHO) {
    const i = t.indexOf(fold(w));
    if (i >= 0 && (best === null || i < best.i)) best = { i, w };
  }
  return best?.w ?? null;
}

// «A новее B» — время заголовка, затем место в файле (§1.4 спеки доски, как latest() доски)
const newer = (a, b) => (a.ms !== b.ms ? a.ms > b.ms : a.index > b.index);
// контракт — запись со строкой «Доставка» и ещё хоть одной из пяти: поздняя «Доставка … обновлена» без прочих строк —
// не контракт, а запись после него (CAR-235; решение дирижёра 04.10). Не обязательно «Знание»: контракт без неё — «нет
// строки: «Знание»», а не «контракта нет»
const isContract = (body) => hasLine(body, 'Доставка') && CONTRACT_LINES.some((n) => n !== 'Доставка' && hasLine(body, n));
// запись-контракт и число записей после неё
export function findContract(entries) {
  let best = null;
  for (const e of entries ?? []) if (Number.isFinite(e.ms) && isContract(e.body) && (!best || newer(e, best))) best = e;
  if (!best) return null;
  return { entry: best, later: (entries ?? []).filter((e) => Number.isFinite(e.ms) && newer(e, best)).length };
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ---------- вершины ссылок файлами ----------

// oid ссылки (refs/heads/main …) из .git репозитория: файл ссылки, затем packed-refs; null — ссылки нет;
// undefined — файлами не прочесть (.git — файл рабочей копии, reftable, сбой чтения) — пусть скажет git
export function refTip(root, ref, fs = nodeFs) {
  const gd = path.join(root, '.git');
  try { if (!fs.statSync(gd).isDirectory()) return undefined; } catch { return undefined; }
  try {
    const v = fs.readFileSync(path.join(gd, ...ref.split('/')), 'utf8').trim();
    return OID.test(v) ? v : undefined;
  } catch (e) { if (e.code !== 'ENOENT') return undefined; }
  try {
    for (const line of fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [oid, name] = line.split(' ');
      if (name === ref && OID.test(oid)) return oid;
    }
    return null;
  } catch (e) { return e.code === 'ENOENT' ? null : undefined; }
}

// ---------- проверка ----------

const exitOf = (e) => (typeof e?.code === 'number' ? e.code : null);
class GitFail extends Error {}

// git — обёртка чтения (git-read.mjs); registry — реестр; board — читатель доски; vault — путь Vault (настройка
// paths.vault; нет — vault_root реестра)
export function createTraceChecker({ git, registry, board, vault = null, fs = nodeFs, now = Date.now, notFoundMs = 5 * 60000, refsFallbackMs = 5 * 60000 }) {
  const results = new Map(); // карточка → {lastKey, value}
  const commits = new Map(); // `${репо}|${хеш}` → {found, full, at, inMain: {tip, v}, pushed: {tip, v}}
  const fallbackTips = new Map(); // репо → {at, tips} — ссылки, прочитанные git (файлами не вышло)
  const st = { passes: 0, lastOkAt: null, errors: 0, lastError: null };
  let running = null;

  const reposOf = (code) => {
    const reg = registry.get();
    const list = [...(reg.codes.find((c) => c.code === code)?.repos ?? []), ...reg.sharedRepos, ...[vault ?? reg.vaultRoot].filter(Boolean)];
    const seen = new Set();
    return list.filter((p) => !seen.has(keyOf(p)) && seen.add(keyOf(p)));
  };

  // вызов git: код 1 — ответ «нет» (rev-parse --verify --quiet, merge-base --is-ancestor); иное — сбой
  const ask = async (repo, args, pass) => {
    try { return { yes: true, out: await git(repo, args) }; } catch (e) {
      if (exitOf(e) === 1) return { yes: false, out: '' };
      st.errors++; st.lastError = `${nameOf(repo)}: ${e?.code ?? 'ERR'}`;
      pass.failed.add(keyOf(repo));
      throw new GitFail();
    }
  };

  // вершины main/master и origin/<база> репозитория — раз за проход; файлами, иначе git (не чаще refsFallbackMs)
  async function tipsOf(repo, pass) {
    const k = keyOf(repo);
    if (pass.tips.has(k)) return pass.tips.get(k);
    const REFS = ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
    let v = REFS.map((r) => refTip(repo, r, fs));
    if (v.some((x) => x === undefined)) {
      const fb = fallbackTips.get(k);
      if (fb && now() - fb.at < refsFallbackMs) v = fb.tips;
      else {
        v = [];
        for (const r of REFS) { const a = await ask(repo, ['rev-parse', '--verify', '--quiet', r], pass); v.push(a.yes ? a.out.trim() : null); }
        fallbackTips.set(k, { at: now(), tips: v });
      }
    }
    const [main, master, oMain, oMaster] = v;
    const base = main || !master ? 'main' : 'master';
    const tips = { base, main: base === 'main' ? main : master, origin: base === 'main' ? oMain : oMaster };
    pass.tips.set(k, tips);
    return tips;
  }

  // один хеш в одном репозитории → {found, inMain, pushed, noMain, base} (null — не проверялось); сбой git — GitFail.
  // merge-base — по снятым вершинам (oid), не по именам ссылок (М5 Голема): ответ — про те самые вершины, что в кэше
  async function checkIn(repo, hash, pass) {
    if (pass.failed.has(keyOf(repo))) throw new GitFail();
    const ck = `${keyOf(repo)}|${hash}`;
    let c = commits.get(ck);
    if (!c || (!c.found && now() - c.at >= notFoundMs)) {
      const a = await ask(repo, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`], pass);
      c = { found: a.yes, full: a.yes ? a.out.trim() : null, at: now(), inMain: null, pushed: null };
      commits.set(ck, c);
    }
    if (!c.found) return { found: false, inMain: null, pushed: null, base: null };
    const t = await tipsOf(repo, pass);
    // сначала origin/<база>: предок — доставлен, даже если локальный main основного клона отстаёт (карточку закрывают
    // из рабочей копии и отправляют оттуда; слово Ивана 04.10)
    if (t.origin && c.pushed?.tip !== t.origin) c.pushed = { tip: t.origin, v: (await ask(repo, ['merge-base', '--is-ancestor', c.full, t.origin], pass)).yes };
    if (t.origin && c.pushed.v) return { found: true, inMain: true, pushed: true, base: t.base };
    // ни main, ни master — своя причина, не «git не ответил» (М3 Голема)
    if (!t.main) return { found: true, inMain: null, pushed: null, noMain: true, base: t.base };
    if (c.inMain?.tip !== t.main) c.inMain = { tip: t.main, v: (await ask(repo, ['merge-base', '--is-ancestor', c.full, t.main], pass)).yes };
    if (!c.inMain.v) return { found: true, inMain: false, pushed: null, base: t.base };
    return { found: true, inMain: true, pushed: t.origin ? false : null, base: t.base };
  }

  // хеш по всем репозиториям: отправлен где-нибудь — ok; иначе найден где-нибудь — лучший из найденных (в main — лучше,
  // чем на ветке; ветка — лучше, чем репозиторий без main), даже если другой репозиторий упал (М4 Голема); не найден
  // нигде, но кто-то упал — «не удалось проверить» с именами упавших; не найден нигде — «не найден»
  async function checkHash(hash, repos, pass) {
    const found = [];
    const failed = [];
    for (const repo of repos) {
      let r;
      try { r = await checkIn(repo, hash, pass); } catch (e) { if (e instanceof GitFail) { failed.push(nameOf(repo)); continue; } throw e; }
      if (r.found && r.pushed === true) return { hash, repo: nameOf(repo), found: true, inMain: true, pushed: true };
      if (r.found) found.push({ ...r, repo: nameOf(repo) });
    }
    const best = found.find((x) => x.inMain) ?? found.find((x) => x.inMain === false) ?? found[0];
    if (best) return { hash, repo: best.repo, found: true, inMain: best.inMain, pushed: best.pushed, base: best.base, noMain: !!best.noMain };
    if (failed.length) return { hash, repo: null, found: null, inMain: null, pushed: null, failed };
    return { hash, repo: null, found: false, inMain: null, pushed: null };
  }

  async function compute(card, entries, pass) {
    const code = card.code;
    const reasons = [];
    const add = (level, codeR, text) => reasons.push({ level, code: codeR, text });
    const k = findContract(entries);
    if (!k) {
      add('bad', 'no-contract', 'контракта закрытия нет');
      return finish({ reasons, lines: [], who: null, commits: [], contractAt: null, laterRecords: 0 });
    }
    const body = k.entry.body;
    const lines = CONTRACT_LINES.filter((n) => hasLine(body, n));
    const missing = CONTRACT_LINES.filter((n) => !lines.includes(n));
    if (missing.length) add('bad', 'no-lines', `нет строки: ${missing.map((n) => `«${n}»`).join(', ')}`);
    const post = hasLine(body, POST_LINE);
    if (post) lines.push(POST_LINE);
    else if (code === 'CAR') add('warn', 'no-post', 'нет строки «Пост» — нужна, если карточка выкачена');
    const who = whoIn(body);
    if (!who) add('bad', 'no-who', 'не назван, кто решил');
    const cands = candidatesIn(deliveryText(body));
    const repos = cands.length ? reposOf(code) : [];
    const list = [];
    for (const { hash: h, weak } of cands) {
      const r = await checkHash(h, repos, pass);
      // слабый кандидат (одни цифры или одни буквы a–f), не найденный нигде, — не хеш: ни строки, ни причины (К1)
      if (weak && r.found === false) continue;
      const { failed, base, noMain, ...row } = r;
      list.push(row);
      if (r.found === null) add('warn', 'git-error', `коммит ${h}: не удалось проверить — git не ответил (${failed.join(', ')})`);
      else if (!r.found) add('bad', 'not-found', `коммит ${h} не найден`);
      else if (noMain) add('warn', 'no-main', `${h}: в ${r.repo} нет ветки main или master`);
      else if (!r.inMain) add('bad', 'not-in-main', `${h} не в ${base} (${r.repo})`);
      else if (r.pushed === false) add('bad', 'not-pushed', `${h} не отправлен (${r.repo})`);
      else if (r.pushed === null) add('warn', 'no-origin', `${h} в ${base}, но origin/${base} на машине нет (${r.repo}) — отправку не проверить`);
    }
    if (!list.length) add('info', 'no-commits', 'след без коммитов — проверь глазами');
    if (k.later) add('info', 'later', `после контракта — ещё ${k.later} ${plural(k.later, 'запись', 'записи', 'записей')}`);
    return finish({ reasons, lines, who, commits: list, contractAt: new Date(k.entry.ms).toISOString(), laterRecords: k.later });
  }

  // итог: bad > warn > none (хешей нет) > ok; причины — красные, жёлтые, серые; label — для значка, hint — что сверено
  function finish({ reasons, lines, who, commits: list, contractAt, laterRecords }) {
    const rank = { bad: 0, warn: 1, info: 2 };
    reasons.sort((a, b) => rank[a.level] - rank[b.level]); // сортировка устойчива: внутри уровня — порядок проверок
    const loud = reasons.filter((r) => r.level !== 'info');
    const state = loud.some((r) => r.level === 'bad') ? 'bad' : loud.length ? 'warn' : contractAt && !list.length ? 'none' : 'ok';
    const label = state === 'ok' ? 'след проверен' : state === 'none' ? 'след без коммитов — проверь глазами'
      : loud[0].text + (loud.length > 1 ? ` · ещё ${loud.length - 1}` : '');
    const hint = contractAt ? `сверено: ${lines.length} ${plural(lines.length, 'строка', 'строки', 'строк')}, кто решил — ${who ?? 'не назван'}, коммитов ${list.length}` : null;
    return { state, label, hint, reasons, checked: { lines, who, commits: list }, contractAt, laterRecords };
  }

  async function pass() {
    const p = { tips: new Map(), failed: new Set() };
    const review = board.cardsList().filter((c) => c.status === 'review');
    const ids = new Set(review.map((c) => c.id));
    for (const id of [...results.keys()]) if (!ids.has(id)) results.delete(id);
    for (const card of review) {
      const lastKey = card.last?.key ?? null;
      const log = board.readLog ? board.readLog(card.id) : { entries: [], error: null };
      // журнал не прочитался — прежний итог остаётся (пустота запрещена, 2.7), следующий проход перечитает
      if (log.error && results.has(card.id)) continue;
      results.set(card.id, { lastKey, value: await compute(card, log.entries ?? [], p) });
    }
    st.passes++;
    if (!p.failed.size) st.lastOkAt = new Date(now()).toISOString();
  }

  return {
    // один проход за раз: опрос не наслаивается
    refresh() { running ??= pass().finally(() => { running = null; }); return running; },
    // для ручек: итог, если карточка в Review и её последняя запись та же, что при расчёте; иначе null («проверяю след…»)
    peek(id) {
      const card = board.card(id);
      const r = results.get(id);
      if (!card || card.status !== 'review' || !r || r.lastKey !== (card.last?.key ?? null)) return null;
      return r.value;
    },
    state: () => ({ ...st, cards: results.size, commits: commits.size }),
  };
}
