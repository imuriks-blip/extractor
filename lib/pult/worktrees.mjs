// «Прибери отслужившие рабочие копии» (ПТ8б, EXT-83; спека пульта §1.3, §1.5, §1.7). Две части:
//  1) поиск кандидатов — только читающие вызовы git (обёртка чтения по форме вызова) и чтение файлов: `worktree list --porcelain`
//     у репозиториев реестра, на каждую копию — слита ли ветка, были ли у неё свои коммиты (reflog), чиста ли, что игнорируется,
//     стоит ли в ней живой тред, нет ли внутри ссылки (junction);
//  2) уборка — `git worktree remove <путь>` БЕЗ силы (по одной копии, ошибка — строка и дальше) и в конце `worktree prune` на
//     репозиторий; ветки не удаляются. Второй щелчок всегда: убирается только то, что было в списке первого щелчка И годно сейчас.
// Пишущая обёртка — lib/git-write.mjs (две формы вызова); сюда она приходит готовой.
import nodeFs from 'node:fs';
import path from 'node:path';
import { pidAlive } from '../processes.mjs';
import { CONFIRM_MS } from './words.mjs';

export const WT_MAX_AGE_DAYS = 14; // копия старше — отслужила и без закрытой карточки (по времени СОЗДАНИЯ папки, не mtime)
// игнорируемое, которое не жалко (спека §1.5 п.4) — путь от корня копии ЦЕЛИКОМ, как его пишет `status --ignored` (каталог — со слэшем)
export const WT_SAFE_IGNORED = ['node_modules/', 'dist/', 'web/dist/', '.venv/', '__pycache__/'];
export const WT_CACHE_MS = 30000; // список для страницы — кэш на 30 с с общим идущим вычислением
const WALK_DEPTH = 6;
const WALK_MAX = 20000;
const NM_NEST = 8; // вложенность node_modules внутри node_modules (file:-зависимости, .pnpm); глубже — «слишком глубокая»
const DAY_MS = 86400000;

// настройки уборки (config.json → pult.cleanup): maxAgeDays — положительное число, safeIgnored — непустой массив непустых строк; иначе умолчания
export function cleanupConfig(c) {
  const days = c?.maxAgeDays;
  const safe = c?.safeIgnored;
  return {
    maxAgeDays: typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : WT_MAX_AGE_DAYS,
    safeIgnored: Array.isArray(safe) && safe.length && safe.every((x) => typeof x === 'string' && x.trim()) ? safe : WT_SAFE_IGNORED,
  };
}

// путь для сравнения: слэши прямые, регистр не важен, хвостовой слэш прочь (Windows: C:\x и c:/X — одно и то же)
export const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (child, root) => { const c = normPath(child); const r = normPath(root); return !!r && (c === r || c.startsWith(`${r}/`)); };
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const errCode = (e) => (e?.code !== undefined && e?.code !== null ? String(e.code) : e?.name ?? 'ERR');

// `worktree list --porcelain`: блоки через пустую строку; первый — основной клон
export function parseList(text) {
  const out = [];
  for (const block of String(text).replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const wt = { path: null, branch: null, detached: false, locked: false, prunable: false, bare: false };
    for (const line of block.split('\n')) {
      const i = line.indexOf(' ');
      const k = i < 0 ? line : line.slice(0, i);
      const v = i < 0 ? '' : line.slice(i + 1);
      if (k === 'worktree') wt.path = v;
      else if (k === 'branch') wt.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') wt.detached = true;
      else if (k === 'locked') wt.locked = true;
      else if (k === 'prunable') wt.prunable = true;
      else if (k === 'bare') wt.bare = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

// `reflog show <ветка>` (новые сверху): сообщения записей. Строка: «<хеш> [(украшения) ]<ветка>@{N}: <сообщение>»
export function reflogMessages(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^[0-9a-f]+ (?:\([^)]*\) )?\S+@\{\d+\}: (.*)$/);
    if (m) out.push(m[1]);
  }
  return out;
}
// свои коммиты: после первой (самой старой) записи — «branch: Created from …» — есть запись, сообщение которой НАЧИНАЕТСЯ с «commit»
export const hasOwnCommits = (messages) => messages.slice(0, -1).some((m) => m.startsWith('commit'));

// ветка карточки `<код строчными>-<N>-…` → `<КОД>-<N>`
export function cardOfBranch(branch) {
  const m = String(branch ?? '').match(/^([a-z]{2,6})-(\d+)-/);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

// `status --porcelain --ignored`: строки «!! путь» — игнорируемое, остальные — изменения (в том числе неотслеживаемые)
export function parseStatus(text) {
  const dirty = [];
  const ignored = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const rest = raw.slice(3).replace(/^"(.*)"$/, '$1');
    if (raw.startsWith('!! ')) ignored.push(rest); else dirty.push(rest);
  }
  return { dirty, ignored };
}

// дети каталога: lstat каждого (ссылка — сразу {link}); каталог-ребёнок — в onDir(путь, имя), его ненулевой ответ — итог.
// ctx.count — счётчик записей, общий для всего обхода копии
function kids(d, ctx, onDir = null) {
  let names;
  try { names = ctx.fs.readdirSync(d); } catch (e) { return { error: errCode(e) }; }
  for (const n of names) {
    if (++ctx.count > ctx.max) return { big: true };
    const p = path.join(d, n);
    let st;
    try { st = ctx.fs.lstatSync(p); } catch (e) { return { error: errCode(e) }; }
    if (st.isSymbolicLink()) return { link: p };
    if (onDir && st.isDirectory()) { const r = onDir(p, n); if (r) return r; }
  }
  return null;
}

// node_modules (неглубоко): дети и дети @scope; у каждого пакета — его вложенный node_modules (file:-зависимости), у .pnpm —
// <пакет@версия>/node_modules — тем же порядком; в остальные подпапки пакетов не идём (принятое ограничение)
function nmLinks(dir, ctx, nest = 0) {
  const nested = (pkg) => {
    const q = path.join(pkg, 'node_modules');
    if (++ctx.count > ctx.max) return { big: true };
    let st;
    try { st = ctx.fs.lstatSync(q); } catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? null : { error: errCode(e) }; }
    if (st.isSymbolicLink()) return { link: q };
    if (!st.isDirectory()) return null;
    return nest + 1 > NM_NEST ? { deep: true } : nmLinks(q, ctx, nest + 1);
  };
  return kids(dir, ctx, (p, n) => {
    if (n.startsWith('@') || n.toLowerCase() === '.pnpm') return kids(p, ctx, (pp) => nested(pp));
    return nested(p);
  });
}

// .venv (неглубоко): дети; дети Scripts/ (Windows) и bin/ (posix); дети Lib/ и Lib/site-packages — туда ложатся пакеты
// и ссылки editable-установок. Полный обход .venv упёрся бы в потолок записей у любой живой среды — копия не убиралась бы никогда
function venvLinks(dir, ctx) {
  return kids(dir, ctx, (p, n) => {
    const k = n.toLowerCase();
    if (k === 'lib') return kids(p, ctx, (pp, nn) => (nn.toLowerCase() === 'site-packages' ? kids(pp, ctx) : null));
    if (k === 'scripts' || k === 'bin') return kids(p, ctx);
    return null;
  });
}

// обход копии в поисках ссылки (symlink/junction): `git worktree remove` даже без --force стирает содержимое цели junction
// (проба EXT-83). lstat ловит и junction (libuv отдаёт его как ссылку). dist, __pycache__ и прочие каталоги — обходятся (до
// глубины 6), node_modules и .venv — неглубоко (nmLinks, venvLinks), .git не обходится. → {link} | {big} | {deep} | {error} | null
export function findLink(root, { fs = nodeFs, depth = WALK_DEPTH, max = WALK_MAX } = {}) {
  const ctx = { fs, count: 0, max };
  const stack = [[root, 0]];
  let deep = false; // остались каталоги глубже предела — «ссылок нет» утверждать нельзя
  while (stack.length) {
    const [dir, d] = stack.pop();
    const r = kids(dir, ctx, (p, name) => {
      const k = name.toLowerCase();
      if (k === 'node_modules') return nmLinks(p, ctx);
      if (k === '.venv') return venvLinks(p, ctx);
      if (k === '.git') return null;
      if (d < depth) stack.push([p, d + 1]); else deep = true;
      return null;
    });
    if (r) return r;
  }
  return deep ? { deep: true } : null;
}

// сессии: ~/.claude/sessions/<pid>.json — только <число>.json, *.key не открываются никогда; читаем, не пишем
export function readSessions({ dir, fs = nodeFs, isAlive = pidAlive }) {
  const names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  const live = [];
  for (const n of names) {
    const pid = Number(n.slice(0, -5));
    if (!isAlive(pid)) continue;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { /* живой pid с нечитаемым файлом — ниже как «без cwd» */ }
    live.push({ pid, cwd: typeof j?.cwd === 'string' && j.cwd ? j.cwd : null });
  }
  return live;
}

const plural = (n, one, few, many) => { const a = n % 100; const b = n % 10; return a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const copies = (n) => `${n} ${plural(n, 'копию', 'копии', 'копий')}`;
const head = (reason) => String(reason).split(':')[0];
// «2× не чистая, не слита» — короткие причины, сгруппированные по началу (до двоеточия)
export function groupReasons(reasons) {
  const m = new Map();
  for (const r of reasons) m.set(head(r), (m.get(head(r)) ?? 0) + 1);
  return [...m].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(', ');
}

// registry — читатель реестра (get().codes[].repos); board — card(id).status; git — обёртка чтения; gitWrite — пишущая;
// threadsNow — живые треды (поле card, запасной путь без cwd); sessionsDir — папка сессий (шов теста); birthOf — время создания папки (шов)
export function createWorktrees({ registry, board = null, git, gitWrite = null, threadsNow = () => [], sessionsDir = null, fs = nodeFs, isAlive = pidAlive,
  birthOf = (p) => nodeFs.statSync(p).birthtimeMs, now = Date.now, maxAgeDays = WT_MAX_AGE_DAYS, safeIgnored = WT_SAFE_IGNORED, cacheMs = WT_CACHE_MS,
  readLines = () => [], mask = (t) => t, mirrorAt = () => null } = {}) {
  const safeKey = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const safe = new Set(safeIgnored.map(safeKey));
  // пути реестра (основные клоны всех проектов) — в кандидаты никогда, даже если git числит такой путь копией другого репозитория
  const registryPaths = () => new Set((registry?.get().codes ?? []).flatMap((c) => c.repos ?? []).map(normPath).filter(Boolean));

  const reposOf = (project) => {
    const seen = new Set();
    const out = [];
    for (const c of registry?.get().codes ?? []) {
      if (project && c.code !== project) continue;
      for (const r of c.repos) { const k = normPath(r); if (k && !seen.has(k)) { seen.add(k); out.push(r); } }
    }
    return out;
  };

  async function judge(wt, repo, sessions) {
    const row = { repo, path: wt.path, branch: wt.branch, card: cardOfBranch(wt.branch), eligible: false, reason: '', ignored: [] };
    const no = (reason) => { row.reason = reason; return row; };
    try {
      if (registryPaths().has(normPath(wt.path))) return no('основной клон проекта по реестру — не трогаю');
      // (1) не заперта, папка есть
      if (wt.locked) return no('заперта (locked)');
      if (wt.prunable || !fs.existsSync(wt.path)) return no('папки нет — это дело prune');
      // (2) ветка слита и отслужила
      if (wt.detached || !wt.branch) return no('HEAD отсоединён');
      // refs/heads/<ветка>: тег с тем же именем не подменяет ветку (форма белого списка та же: не флаг)
      const ref = `refs/heads/${wt.branch}`;
      try { await git(repo, ['merge-base', '--is-ancestor', ref, 'main']); } catch (e) {
        if (e?.code === 1) return no('ветка не слита в main');
        return no(`не проверить: ${errCode(e)}`);
      }
      const own = hasOwnCommits(reflogMessages(await git(repo, ['reflog', 'show', ref])));
      const st = row.card ? board?.card?.(row.card)?.status ?? null : null;
      const closed = st === 'done' || st === 'cancelled';
      let served = own && closed;
      if (!served) {
        let age = null;
        try { const b = birthOf(wt.path); age = Number.isFinite(b) && b > 0 ? now() - b : null; } catch { age = null; }
        if (age !== null && age >= maxAgeDays * DAY_MS) served = true;
        else if (age === null) return no('не проверить: время создания папки');
        else if (!own) return no(`свежая ветка без своих коммитов, копии нет ${maxAgeDays} дней`);
        else return no(`${row.card ? `карточка ${row.card}` : 'карточка не найдена по ветке'} не закрыта${st ? ` (${st})` : ''}, копии нет ${maxAgeDays} дней`);
      }
      // (3) чистая, (4) игнорируемое — только безопасное
      const s = parseStatus(await git(wt.path, ['status', '--porcelain', '--ignored', '--untracked-files=normal']));
      if (s.dirty.length) return no(`не чистая: ${s.dirty.length} изм.`);
      const odd = s.ignored.filter((p) => !safe.has(safeKey(p)));
      if (odd.length) { row.ignored = odd; return no(`есть игнорируемые: ${odd.join(', ')} — разбери руками`); }
      // (5) живой тред в копии — обе проверки всегда: по cwd из файла сессии И по карточке живого треда (треды стартуют в Vault
      // и работают в копии через git -C — cwd копию не покажет); сработала любая — не кандидат
      if (sessions.error) return no(`не проверить: ${sessions.error}`);
      if (sessions.live.some((x) => x.cwd && inside(x.cwd, wt.path))) return no('в ней стоит живой тред');
      if (row.card && threadsNow().some((t) => t?.card === row.card)) return no('в ней стоит живой тред (по карточке)');
      // файл живого треда без cwd, а у ветки нет номера — сверить нечем
      if (!row.card && sessions.live.some((x) => !x.cwd)) return no('не проверить: ветка без номера карточки, а есть живой тред без cwd');
      // (6) ссылка внутри
      const link = findLink(wt.path, { fs });
      if (link?.error) return no(`не проверить: ${link.error}`);
      if (link?.big) return no('слишком большая — разбери руками');
      if (link?.deep) return no('слишком глубокая — разбери руками');
      if (link?.link) return no('внутри ссылка — разбери руками');
      row.eligible = true;
      row.reason = own && closed ? `слита, карточка ${row.card} закрыта, чистая` : `слита, копии больше ${maxAgeDays} дней, чистая`;
      return row;
    } catch (e) {
      return no(`не проверить: ${errCode(e)}`);
    }
  }

  const sessionsNow = () => {
    try { return { live: sessionsDir ? readSessions({ dir: sessionsDir, fs, isAlive }) : null, error: sessionsDir ? null : 'SESSIONS' }; } catch (e) { return { live: [], error: errCode(e) }; }
  };
  // одна копия заново целиком (перед каждым remove): свежий worktree list её репозитория, свежие сессии, все условия judge
  async function rejudge(row) {
    const list = parseList(await git(row.repo, ['worktree', 'list', '--porcelain']));
    const wt = list.slice(1).find((x) => normPath(x.path) === normPath(row.path));
    if (!wt) return { ...row, eligible: false, reason: 'копии уже нет' };
    return judge(wt, row.repo, sessionsNow());
  }

  // уникальные копии по нормализованному пути; основной клон (первая запись) не кандидат и в список не идёт
  async function compute(project) {
    const rows = [];
    const seenWt = new Set();
    const sessions = sessionsNow();
    for (const repo of reposOf(project)) {
      let list;
      try { list = parseList(await git(repo, ['worktree', 'list', '--porcelain'])); } catch (e) {
        rows.push({ repo, path: repo, branch: null, card: null, eligible: false, reason: `не проверить: ${errCode(e)}`, ignored: [] });
        continue;
      }
      if (!list.length) continue;
      const main = list[0].path;
      seenWt.add(normPath(main));
      for (const wt of list.slice(1)) {
        const k = normPath(wt.path);
        if (seenWt.has(k)) continue;
        seenWt.add(k);
        rows.push(await judge(wt, main, sessions));
      }
    }
    return rows;
  }

  // GET /api/worktrees: кэш 30 с, одно общее идущее вычисление на ключ; ошибки — в reason строк, не 500
  const cache = new Map(); // ключ → {at, rows, promise}
  let epoch = 0; // поколение: уборка его двигает — вычисление, начатое раньше, в кэш не ложится и новым запросам не отдаётся
  const invalidate = () => { epoch += 1; cache.clear(); };
  function list(project = null) {
    const ep = epoch;
    const key = project ?? '*';
    const c = cache.get(key);
    if (c?.promise) return c.promise;
    if (c?.rows && now() - c.at < cacheMs) return Promise.resolve(c.rows);
    const promise = compute(project).catch((e) => [{ repo: null, path: null, branch: null, card: null, eligible: false, reason: `не проверить: ${errCode(e)}`, ignored: [] }])
      .then((rows) => { if (ep === epoch) cache.set(key, { at: now(), rows }); return rows; });
    cache.set(key, { at: c?.at ?? 0, rows: c?.rows ?? null, promise });
    return promise;
  }

  // ---- действие cleanup ----
  let running = false;
  const brief = (r) => ({ repo: mask(r.repo), path: mask(r.path), branch: mask(r.branch ?? ''), card: r.card });

  async function act(ctx) {
    const { id, project, confirm, step, paths = null } = ctx;
    const refused = (refusal, message) => ({ outcome: 'refused', refusal, message });
    if (!gitWrite) return { outcome: 'error', message: 'уборка не подключена: нет пишущей обёртки git', result: { code: 'NOT_CONNECTED' } };
    if (running) return refused('cleanup-running', 'уборка уже идёт — подожди');
    let listed = null;
    let unpicked = 0;
    let listedAll = null; // весь список первого щелчка (до выбора): снятая галочка — не «новый кандидат»
    let owner = false; // «идёт» держит только второй щелчок: первый (чтение) чужой флаг не трогает
    if (confirm) {
      const lines = readLines();
      const asked = lines.find((l) => l?.id === confirm && l.step === 'asked');
      const waited = lines.find((l) => l?.id === confirm && l.step === 'need-confirm');
      if (!asked || !waited || asked.action !== 'cleanup' || (asked.project ?? null) !== (project ?? null)) return refused('bad-confirm', 'подтверждение не от этого нажатия — нажми заново');
      const askedAt = Date.parse(asked.at);
      if (!Number.isFinite(askedAt) || now() - askedAt > CONFIRM_MS) return refused('confirm-expired', 'подтверждение просрочено (не дольше 5 минут) — нажми заново');
      if (lines.some((l) => l?.step === 'confirmed' && l.confirm === confirm && l.id !== id)) return refused('bad-confirm', 'это подтверждение уже использовано — нажми заново');
      listed = Array.isArray(waited.confirm?.candidates) ? waited.confirm.candidates.filter((c) => c && typeof c.path === 'string') : [];
      // выбор галочками (§1.3 «снятые галочки не трогаются»): пересечение выбранного со списком первого щелчка — шире списка не бывает
      if (Array.isArray(paths)) {
        const pick = new Set(paths.map(normPath));
        const all = listed.length;
        listedAll = listed;
        listed = listed.filter((c) => pick.has(normPath(c.path)));
        unpicked = all - listed.length;
      }
      step({ step: 'confirmed', confirm });
      running = true; owner = true; // до первого await: второй щелчок, пришедший следом, видит «идёт»
    }
    try {
      const fresh = await compute(project ?? null);
      const eligible = fresh.filter((r) => r.eligible);
      if (!confirm) {
        const skipped = fresh.filter((r) => !r.eligible);
        if (!eligible.length) {
          return { outcome: 'ok', message: `убирать нечего${skipped.length ? ` (${skipped.length} пропущено: ${mask(groupReasons(skipped.map((r) => r.reason)))})` : ' (рабочих копий нет)'}`, result: { removed: 0, skipped: skipped.length } };
        }
        const names = eligible.map((r) => baseName(r.path)).join(', ');
        return { outcome: 'need-confirm', message: `уберу ${copies(eligible.length)}: ${mask(names)}; ветки остаются`,
          confirm: { what: `«Прибери отслужившие рабочие копии»${project ? ` · ${project}` : ''}`, follows: `уберу ${copies(eligible.length)}: ${mask(names)}; ветки остаются`,
            mirrorAt: mirrorAt(), candidates: eligible.map(brief) } };
      }
      // второй щелчок: список — только из первого; убирается то, что в нём И годно сейчас
      const byPath = new Map(fresh.map((r) => [normPath(r.path), r]));
      const removed = [];
      const skipped = [];
      const errors = [];
      const repos = new Set();
      for (const cand of listed) {
        const row = byPath.get(normPath(cand.path));
        if (!row) { skipped.push({ path: cand.path, reason: 'копии уже нет в списке' }); continue; }
        if (!row.eligible) { skipped.push({ path: row.path, reason: row.reason }); continue; }
        // перед КАЖДЫМ remove — копия заново целиком (judge): ссылка, новый .env, вошедший тред могли появиться после пересчёта
        let again;
        try { again = await rejudge(row); } catch (e) { again = { eligible: false, reason: `не проверить: ${errCode(e)}` }; }
        if (!again.eligible) { skipped.push({ path: row.path, reason: again.reason }); continue; }
        try {
          await gitWrite(row.repo, ['worktree', 'remove', row.path]); // путь — из списка git, не из ввода; без --force
          removed.push(row); repos.add(row.repo);
          step({ step: 'worktree-remove', path: mask(row.path), branch: mask(row.branch ?? ''), result: { ok: true } });
        } catch (e) {
          const line = mask(String(e?.stderr || e?.message || '').split(/\r?\n/).find((x) => x.trim()) ?? '').trim();
          const code = e?.killed ? 'таймаут 180 с' : errCode(e); // убит по таймауту git-write: code у него null
          errors.push({ path: row.path, line: `${code}${line ? ` ${line}` : ''} — копия могла быть разрушена частично, проверь` });
          repos.add(row.repo); // prune и после неудачи — безвредно: чистит только записи о пропавших папках
          step({ step: 'worktree-remove', path: mask(row.path), branch: mask(row.branch ?? ''), result: { ok: false, code: errCode(e), line } });
        }
      }
      for (const repo of repos) {
        try { await gitWrite(repo, ['worktree', 'prune']); step({ step: 'worktree-prune', repo: mask(repo), result: { ok: true } }); } catch (e) {
          errors.push({ path: repo, line: `prune: ${errCode(e)}` });
          step({ step: 'worktree-prune', repo: mask(repo), result: { ok: false, code: errCode(e) } });
        }
      }
      const listedKeys = new Set((listedAll ?? listed).map((c) => normPath(c.path)));
      const fresher = eligible.filter((r) => !listedKeys.has(normPath(r.path))).length;
      const why = skipped.length ? ` (почему: ${mask(groupReasons(skipped.map((s) => s.reason)))})` : '';
      const errs = errors.length ? `; ошибок ${errors.length}: ${errors.map((e) => `${baseName(e.path)} — ${e.line}`).map(mask).join('; ')}` : '';
      const tail = `${unpicked ? `; не выбрано ${unpicked} — не трогал` : ''}${fresher ? `; новых кандидатов ${fresher} не трогал — они не были в списке` : ''}`;
      return { outcome: errors.length ? 'partial' : 'ok', message: `убрано ${removed.length}, пропущено ${skipped.length}${why}${errs}${tail}`,
        result: { removed: removed.length, removedNames: removed.map((r) => mask(baseName(r.path))), skipped: skipped.length, errors: errors.length } };
    } finally {
      invalidate(); // после любого исхода: список страницы считается заново
      if (owner) running = false;
    }
  }

  return { list, compute, act, isRunning: () => running };
}
