// Читатель git репозиториев (спека витрины 1.2, 1.4, 2.5, 2.6, 2.7; такт В5). Только через обёртку git-read.
// Опрос (раз в pollMs.git, 2.8) проходит репозитории реестра: board_codes → repos и board_shared_repos.
//  - репозиторий проекта: `worktree list --porcelain` → рабочие копии; у каждой `status --porcelain` → число
//    незакоммиченных (маячок, 3.2); общие репозитории в маячок не идут (1.4) — у них ни worktree list, ни status;
//  - кроме репозитория доски (его коммиты зеркала перечисляют десятки номеров, 2.6): `log --all` с темой и телом →
//    коммиты, где есть номер карточки (регулярка 1.4 — cardsIn разбора журналов, одно место правды). Рабочие копии
//    делят с основным клоном объекты и ветки, поэтому один `log --all` основного клона видит и их коммиты — каждый раз.
// Ручки берут данные только из последнего прохода: на запрос git не зовётся. Ошибка — прежние данные репозитория,
// failingSince — с первого сбоя подряд, readAt — время последнего удачного прохода (2.7).
// EXT-37 (нагрузка покоя): подсказка «в репозитории что-то менялось» — fs.watch (recursive) на корень каждой рабочей
// копии репозитория проекта и на .git общего репозитория. Наблюдатель — только подсказка, правду даёт страховка:
//  - событий с прошлого прохода нет — репозиторий пропускается (git не зовётся; это удачное наблюдение, readAt — сейчас);
//  - событие в рабочей копии (не в .git) — status только этой копии;
//  - событие в .git (кроме .git/objects) или имя неизвестно — полный проход репозитория;
//  - полное чтение каждого репозитория — раз в fullEveryMs (5 мин), что бы ни было; у каждого своя фаза (место в
//    порядке реестра, равномерно по 5 минутам): за проход 30 с — около 1/10 репозиториев, а не все разом;
//  - новый (и переставленный после падения) наблюдатель — флаг «грязно»: правка между status и постановкой
//    наблюдателя видна на следующем проходе;
//  - ошибка или закрытие наблюдателя — репозиторий опрашивается по-старому, каждый проход (раз в pollMs.git).
// Свои запуски (--no-optional-locks: status не пишет index) наблюдателя не будят — тест на живом fs.watch.
import nodeFs from 'node:fs';
import path from 'node:path';
import { cardsIn } from './journal-parse.mjs';

const US = '\x1f';
const RS = '\x1e';
// полный хеш · источник (ветка, через которую git дошёл до коммита) · время коммита · тема · тело
const FORMAT = `--format=%H${US}%S${US}%cI${US}%s${US}%b${RS}`;
export const NOT_DESCRIBED = 'проект не описан в реестре';

const keyOf = (p) => path.resolve(p).toLowerCase();
const nameOf = (p) => path.basename(String(p).replace(/[\\/]+$/, ''));

// `worktree list --porcelain`: блоки через пустую строку; первый — основной клон
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text).replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const wt = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(' ');
      const k = i < 0 ? line : line.slice(0, i);
      const v = i < 0 ? '' : line.slice(i + 1);
      if (k === 'worktree') wt.path = v;
      else if (k === 'branch') wt.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') wt.branch = null;
      else if (k === 'bare') wt.bare = true;
      else if (k === 'prunable') wt.prunable = true;
    }
    if (wt.path) out.push({ path: wt.path, branch: wt.branch ?? null, bare: !!wt.bare, prunable: !!wt.prunable });
  }
  return out;
}

export const countPorcelain = (text) => String(text).split(/\r?\n/).filter((l) => l.trim()).length;

const branchOf = (src) => String(src ?? '').replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/remotes\//, '') || null;

// Коммиты с номерами карточек: {full, hash (7), at, subject, branch, cards}; без номеров — не хранятся
export function parseCommits(text) {
  const out = [];
  for (const rec of String(text).split(RS)) {
    const parts = rec.replace(/^\r?\n/, '').split(US);
    if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0])) continue;
    const [full, src, at, subject, body] = parts;
    const cards = cardsIn(`${subject}\n${body}`);
    if (cards.length) out.push({ full, hash: full.slice(0, 7), at, subject, branch: branchOf(src), cards });
  }
  return out;
}

// наблюдатель по умолчанию: fs.watch recursive, не держит процесс; onFail — ошибка или закрытие не по нашей воле
export function fsWatch(dir, { onEvent, onFail }) {
  let closing = false;
  const w = nodeFs.watch(dir, { recursive: true, persistent: false }, (type, name) => onEvent(name == null ? null : String(name)));
  w.on('error', (e) => { if (!closing) onFail(e); });
  w.on('close', () => { if (!closing) onFail(new Error('closed')); });
  return { close() { closing = true; w.close(); } };
}

const normRel = (name) => String(name).replace(/\\/g, '/');
// событие под .git/objects (новые объекты без смены ссылок) — не повод
const isObjects = (rel) => rel === 'objects' || rel.startsWith('objects/');
const closeQuiet = (w) => { try { w.handle?.close(); } catch { /* уже закрыт */ } w.handle = null; };

// ignore — каталоги, чьи события не повод (свой data/vitrina: server.log и индекс пишутся каждые несколько секунд и
// будили бы репозиторий витрины каждый проход)
export function createGitReader({ git, registry, boardRoot, now = () => Date.now(), watch = fsWatch, fullEveryMs = 5 * 60000, ignore = [] }) {
  const boardKey = boardRoot ? keyOf(boardRoot) : null;
  const ignored = ignore.map((d) => keyOf(d) + path.sep);
  const isIgnored = (dir, name) => ignored.length > 0 && ignored.some((d) => keyOf(path.join(dir, name)).startsWith(d));
  const repos = new Map(); // ключ пути → {path, worktrees, commits, lastOkAt, failingSince, lastError, наблюдатели}
  // logRuns / logSkipped — проходы log и пропуски по неизменным вершинам; firstPassMs / lastPassMs — время прохода;
  // quietSkips — репозиторий пропущен по тишине наблюдателя; wtStatusOnly — status одной копии вместо полного чтения;
  // fullReads — полные чтения репозитория; watchFailed (state) — репозитории без наблюдателя (опрос по-старому)
  const st = { lastOkAt: null, errors: 0, lastError: null, passes: 0, logRuns: 0, logSkipped: 0, wtErrors: 0, firstPassMs: null, lastPassMs: null, quietSkips: 0, wtStatusOnly: 0, fullReads: 0 };
  let running = null;
  let closed = false;
  let current = new Set(); // ключи репозиториев реестра последнего прохода
  const phases = new Map(); // ключ → фаза полного чтения, мс в пределах fullEveryMs
  const iso = () => new Date(now()).toISOString();
  // номер окна fullEveryMs со сдвигом на фазу репозитория: полное чтение — когда окно сменилось
  const windowOf = (k, t) => Math.floor((t - (phases.get(k) ?? 0)) / fullEveryMs);
  const fullDue = (k, r) => windowOf(k, now()) > windowOf(k, r.lastFullAt);
  const slot = (p) => {
    const k = keyOf(p);
    if (!repos.has(k)) repos.set(k, { path: p, worktrees: null, commits: null, tips: null, lastOkAt: null, failingSince: null, lastError: null, watchers: new Map(), gitDirty: true, lastFullAt: -Infinity });
    return repos.get(k);
  };
  const broken = (r) => r.watchers.size === 0 || [...r.watchers.values()].some((w) => !w.handle);

  // Наблюдатели репозитория: проект — корень каждой рабочей копии (основной клон видит и свой .git — ссылки, HEAD
  // и index всех копий); общий — только его .git. Лишние закрываются, упавшие пересоздаются на следующем полном чтении.
  function syncWatchers(r, { project }) {
    if (closed) return;
    const want = new Map();
    if (project) { for (const wt of r.worktrees ?? []) if (!wt.missing) want.set(keyOf(wt.path), { dir: wt.path, main: keyOf(wt.path) === keyOf(r.path) }); }
    else want.set(keyOf(path.join(r.path, '.git')), { dir: path.join(r.path, '.git'), gitDir: true });
    for (const [k, w] of r.watchers) if (!want.has(k)) { closeQuiet(w); r.watchers.delete(k); }
    for (const [k, spec] of want) {
      const old = r.watchers.get(k);
      // живой — оставить; упавший — опрос по-старому до полного прохода раз в fullEveryMs, потом новая попытка
      if (old && (old.handle || now() - old.failedAt < fullEveryMs)) continue;
      const w = { ...spec, dirty: false, handle: null, failedAt: null };
      const onEvent = (name) => {
        if (name == null) { r.gitDirty = true; return; }
        if (isIgnored(spec.dir, name)) return;
        const rel = normRel(name);
        if (spec.gitDir) { if (!isObjects(rel)) r.gitDirty = true; return; }
        if (spec.main && (rel === '.git' || rel.startsWith('.git/'))) { if (!isObjects(rel.slice(5))) r.gitDirty = true; return; }
        w.dirty = true;
      };
      const onFail = () => { if (r.watchers.get(k) === w && w.handle) { closeQuiet(w); w.failedAt = now(); } };
      try { w.handle = watch(spec.dir, { onEvent, onFail }); } catch { w.handle = null; w.failedAt = now(); }
      // правка между чтением и постановкой наблюдателя ему не видна — следующий проход перечитывает (Важно 1 Голема):
      // копия — status; основной клон и .git общего — полное чтение (ссылки могли смениться в той же щели)
      if (w.handle) { if (spec.gitDir || spec.main) r.gitDirty = true; else w.dirty = true; }
      r.watchers.set(k, w);
    }
  }

  // status только копий с событиями (ссылки и список копий не менялись)
  async function readDirtyWorktrees(r) {
    for (const w of r.watchers.values()) {
      if (!w.dirty) continue;
      w.dirty = false;
      const wt = (r.worktrees ?? []).find((x) => keyOf(x.path) === keyOf(w.dir));
      if (!wt) { r.gitDirty = true; continue; }
      st.wtStatusOnly++;
      try { wt.dirty = countPorcelain(await git(wt.path, ['status', '--porcelain'])); wt.error = null; } catch (e) {
        wt.error = e.code ?? 'ERR';
        st.wtErrors++; st.errors++; st.lastError = `${nameOf(wt.path)}: ${wt.error}`;
      }
    }
    r.lastOkAt = iso();
  }

  async function readRepo(p, { project, shared }) {
    const r = slot(p);
    // флаги — до запуска git: событие посреди чтения поставит их снова, следующий проход перечитает
    r.gitDirty = false;
    for (const w of r.watchers.values()) w.dirty = false;
    st.fullReads++;
    try {
      let worktrees = r.worktrees;
      if (project) {
        const list = parseWorktrees(await git(p, ['worktree', 'list', '--porcelain']));
        worktrees = [];
        for (const wt of list) {
          if (wt.bare) continue;
          // рабочая копия без папки (prunable) — строка без числа; сбой status одной копии — её строка с error,
          // репозиторий и его лента читаются дальше (вердикт Голема на В5)
          let dirty = null;
          let error = null;
          if (!wt.prunable) {
            try { dirty = countPorcelain(await git(wt.path, ['status', '--porcelain'])); } catch (e) {
              error = e.code ?? 'ERR';
              st.wtErrors++; st.errors++; st.lastError = `${nameOf(wt.path)}: ${error}`;
            }
          }
          worktrees.push({ name: nameOf(wt.path), path: wt.path, branch: wt.branch, dirty, missing: wt.prunable, error });
        }
      }
      let commits = r.commits;
      let tips = r.tips;
      if ((project || shared) && keyOf(p) !== boardKey) {
        // вершины веток (без stash) не сменились — log по всей истории не нужен, коммиты прежние (вердикт Голема на В5).
        // Коммит на отсоединённом HEAD рабочей копии вершин не меняет — его увидит следующий log (смена любой ветки).
        tips = await git(p, ['rev-parse', '--exclude=refs/stash', '--all']);
        if (commits && tips === r.tips) st.logSkipped++;
        else {
          // stash — не ветка: его служебные коммиты («WIP on …») повторяли бы тему коммита
          commits = parseCommits(await git(p, ['log', '--exclude=refs/stash', '--all', '--source', FORMAT]));
          st.logRuns++;
        }
      }
      Object.assign(r, { worktrees, commits, tips, lastOkAt: iso(), failingSince: null, lastError: null, lastFullAt: now() });
    } catch (e) {
      r.failingSince ??= iso();
      r.lastError = e.code ?? 'ERR';
      st.errors++; st.lastError = `${nameOf(p)}: ${r.lastError}`;
    }
    syncWatchers(r, { project });
  }

  // репозиторий за проход: полное чтение, status грязных копий или пропуск по тишине
  async function visit(p, kind) {
    const r = slot(p);
    if (r.lastOkAt == null || r.failingSince || broken(r) || r.gitDirty || fullDue(keyOf(p), r)) return readRepo(p, kind);
    if (kind.project && [...r.watchers.values()].some((w) => w.dirty)) {
      await readDirtyWorktrees(r);
      if (r.gitDirty) await readRepo(p, kind); // копии нет в списке — полное чтение
      return;
    }
    st.quietSkips++;
    r.lastOkAt = iso();
  }

  async function pass() {
    const t0 = Date.now();
    const reg = registry.get();
    const project = new Set();
    for (const c of reg.codes) for (const p of c.repos) project.add(keyOf(p));
    const seen = new Set();
    const todo = [];
    for (const c of reg.codes) for (const p of c.repos) if (!seen.has(keyOf(p))) { seen.add(keyOf(p)); todo.push([p, { project: true, shared: false }]); }
    for (const p of reg.sharedRepos) if (!seen.has(keyOf(p))) { seen.add(keyOf(p)); todo.push([p, { project: false, shared: true }]); }
    current = seen;
    todo.forEach(([p], i) => phases.set(keyOf(p), Math.floor(((i + 0.5) * fullEveryMs) / todo.length)));
    for (const [p, kind] of todo) await visit(p, kind);
    // репозитории, ушедшие из реестра, — без наблюдателей
    for (const [k, r] of repos) if (!seen.has(k)) { for (const w of r.watchers.values()) closeQuiet(w); r.watchers.clear(); }
    st.passes++;
    st.lastPassMs = Date.now() - t0;
    st.firstPassMs ??= st.lastPassMs;
    if (todo.every(([p]) => !slot(p).failingSince)) st.lastOkAt = iso();
  }

  // свежесть набора репозиториев для серой строки 2.7: самое старое удачное чтение, самый ранний идущий сбой
  function freshness(list) {
    const ok = list.map((r) => r.lastOkAt);
    const fail = list.map((r) => r.failingSince).filter(Boolean).sort();
    return { readAt: ok.length && ok.every(Boolean) ? ok.sort()[0] : (ok.filter(Boolean).sort()[0] ?? null), failingSince: fail[0] ?? null };
  }

  return {
    // один проход за раз: опрос не наслаивается
    refresh() { running ??= pass().finally(() => { running = null; }); return running; },
    beacon(code) {
      const entry = registry.get().codes.find((c) => c.code === code);
      if (!entry) return { described: false, message: NOT_DESCRIBED, repos: [], readAt: null, failingSince: null };
      const list = entry.repos.map((p) => slot(p));
      const rows = [];
      for (const r of list) {
        // ещё не прочитан или ни разу не удался — строка репозитория без ветки и числа
        if (!r.worktrees) rows.push({ name: nameOf(r.path), path: r.path, branch: null, dirty: null, missing: false, error: null });
        else rows.push(...r.worktrees);
      }
      return { described: true, message: null, repos: rows, ...freshness(list) };
    },
    commitsFor(id) {
      const code = id.split('-')[0];
      const reg = registry.get();
      const own = reg.codes.find((c) => c.code === code)?.repos ?? [];
      // свой — репозиторий только этого кода и не общий; общий или чужой (есть у другого кода) — строгая сеть маски
      const foreign = new Set([...reg.codes.filter((c) => c.code !== code).flatMap((c) => c.repos), ...reg.sharedRepos].map(keyOf));
      const list = [];
      const seen = new Set();
      for (const p of [...own, ...reg.sharedRepos]) {
        if (keyOf(p) === boardKey || seen.has(keyOf(p))) continue;
        seen.add(keyOf(p));
        list.push(slot(p));
      }
      const commits = [];
      const hashes = new Set();
      for (const r of list) {
        for (const c of r.commits ?? []) {
          if (!c.cards.includes(id) || hashes.has(c.full)) continue;
          hashes.add(c.full);
          commits.push({ hash: c.hash, at: c.at, subject: c.subject, repo: nameOf(r.path), branch: c.branch, own: !foreign.has(keyOf(r.path)) });
        }
      }
      return { commits, ...freshness(list) };
    },
    state() {
      const failing = [...repos.values()].filter((r) => r.failingSince).length;
      return { lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError, repos: repos.size, failing, passes: st.passes, logRuns: st.logRuns, logSkipped: st.logSkipped, wtErrors: st.wtErrors, firstPassMs: st.firstPassMs, lastPassMs: st.lastPassMs };
    },
    // счётчики подсказки наблюдателя (EXT-37) — для строки stats в server.log; форма /api/health не меняется
    quiet() {
      const watchFailed = [...repos].filter(([k, r]) => current.has(k) && r.lastOkAt && broken(r)).length;
      return { passes: st.passes, quietSkips: st.quietSkips, wtStatusOnly: st.wtStatusOnly, fullReads: st.fullReads, watchFailed };
    },
    // остановка сервера и тестов: закрыть наблюдатели
    close() { closed = true; for (const r of repos.values()) { for (const w of r.watchers.values()) closeQuiet(w); r.watchers.clear(); } },
  };
}
