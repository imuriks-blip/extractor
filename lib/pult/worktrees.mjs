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
export const WT_SAFE_IGNORED = ['node_modules', 'dist', '.venv', '__pycache__']; // игнорируемые каталоги, которые не жалко (имя последнего сегмента)
export const WT_CACHE_MS = 30000; // список для страницы — кэш на 30 с с общим идущим вычислением
const WALK_NOGO = new Set(['node_modules', 'dist', '.venv', '__pycache__', '.git']); // внутрь не заходим (сам каталог lstat'им)
const WALK_DEPTH = 6;
const WALK_MAX = 20000;
const DAY_MS = 86400000;

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

// обход копии в поисках ссылки (symlink/junction): рекурсивное удаление на Windows может пройти по junction в чужую папку.
// lstat ловит и junction (libuv отдаёт его как ссылку). → {link} | {big} | {error} | null
export function findLink(root, { fs = nodeFs, depth = WALK_DEPTH, max = WALK_MAX } = {}) {
  const stack = [[root, 0]];
  let count = 0;
  while (stack.length) {
    const [dir, d] = stack.pop();
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return { error: errCode(e) }; }
    for (const name of names) {
      if (++count > max) return { big: true };
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { return { error: errCode(e) }; }
      if (st.isSymbolicLink()) return { link: p };
      if (st.isDirectory() && d < depth && !WALK_NOGO.has(name.toLowerCase())) stack.push([p, d + 1]);
    }
  }
  return null;
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
  const safe = new Set(safeIgnored.map((s) => s.toLowerCase()));

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
      // (1) не заперта, папка есть
      if (wt.locked) return no('заперта (locked)');
      if (wt.prunable || !fs.existsSync(wt.path)) return no('папки нет — это дело prune');
      // (2) ветка слита и отслужила
      if (wt.detached || !wt.branch) return no('HEAD отсоединён');
      try { await git(repo, ['merge-base', '--is-ancestor', wt.branch, 'main']); } catch (e) {
        if (e?.code === 1) return no('ветка не слита в main');
        return no(`не проверить: ${errCode(e)}`);
      }
      const own = hasOwnCommits(reflogMessages(await git(repo, ['reflog', 'show', wt.branch])));
      const st = row.card ? board?.card?.(row.card)?.status ?? null : null;
      const closed = st === 'done' || st === 'cancelled';
      let served = own && closed;
      if (!served) {
        let age = null;
        try { age = now() - birthOf(wt.path); } catch { age = null; }
        if (age !== null && age >= maxAgeDays * DAY_MS) served = true;
        else if (age === null) return no('не проверить: время создания папки');
        else if (!own) return no(`свежая ветка без своих коммитов, копии нет ${maxAgeDays} дней`);
        else return no(`${row.card ? `карточка ${row.card}` : 'карточка не найдена по ветке'} не закрыта${st ? ` (${st})` : ''}, копии нет ${maxAgeDays} дней`);
      }
      // (3) чистая, (4) игнорируемое — только безопасное
      const s = parseStatus(await git(wt.path, ['status', '--porcelain', '--ignored']));
      if (s.dirty.length) return no(`не чистая: ${s.dirty.length} изм.`);
      const lastSeg = (p) => String(p).replace(/\/+$/, '').split('/').pop().toLowerCase();
      const odd = s.ignored.filter((p) => !(p.endsWith('/') && safe.has(lastSeg(p))));
      if (odd.length) { row.ignored = odd; return no(`есть игнорируемые: ${odd.join(', ')} — разбери руками`); }
      // (5) живой тред в копии; без cwd — по карточке
      if (sessions.error) return no(`не проверить: ${sessions.error}`);
      if (sessions.live.some((x) => x.cwd && inside(x.cwd, wt.path))) return no('в ней стоит живой тред');
      if (sessions.live.some((x) => !x.cwd) && row.card && threadsNow().some((t) => t?.card === row.card)) return no('в ней стоит живой тред (по карточке)');
      // (6) ссылка внутри
      const link = findLink(wt.path, { fs });
      if (link?.error) return no(`не проверить: ${link.error}`);
      if (link?.big) return no('слишком большая — разбери руками');
      if (link?.link) return no('внутри ссылка — разбери руками');
      row.eligible = true;
      row.reason = own && closed ? `слита, карточка ${row.card} закрыта, чистая` : `слита, копии больше ${maxAgeDays} дней, чистая`;
      return row;
    } catch (e) {
      return no(`не проверить: ${errCode(e)}`);
    }
  }

  // уникальные копии по нормализованному пути; основной клон (первая запись) не кандидат и в список не идёт
  async function compute(project) {
    const rows = [];
    const seenWt = new Set();
    let sessions;
    try { sessions = { live: sessionsDir ? readSessions({ dir: sessionsDir, fs, isAlive }) : null, error: sessionsDir ? null : 'SESSIONS' }; } catch (e) { sessions = { live: [], error: errCode(e) }; }
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
  function list(project = null) {
    const key = project ?? '*';
    const c = cache.get(key);
    if (c?.promise) return c.promise;
    if (c?.rows && now() - c.at < cacheMs) return Promise.resolve(c.rows);
    const promise = compute(project).catch((e) => [{ repo: null, path: null, branch: null, card: null, eligible: false, reason: `не проверить: ${errCode(e)}`, ignored: [] }])
      .then((rows) => { cache.set(key, { at: now(), rows }); return rows; });
    cache.set(key, { at: c?.at ?? 0, rows: c?.rows ?? null, promise });
    return promise;
  }

  // ---- действие cleanup ----
  let running = false;
  const brief = (r) => ({ repo: mask(r.repo), path: mask(r.path), branch: mask(r.branch ?? ''), card: r.card });

  async function act(ctx) {
    const { id, project, confirm, step } = ctx;
    const refused = (refusal, message) => ({ outcome: 'refused', refusal, message });
    if (!gitWrite) return { outcome: 'error', message: 'уборка не подключена: нет пишущей обёртки git', result: { code: 'NOT_CONNECTED' } };
    if (running) return refused('cleanup-running', 'уборка уже идёт — подожди');
    let listed = null;
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
        try {
          await gitWrite(row.repo, ['worktree', 'remove', row.path]); // путь — из списка git, не из ввода; без --force
          removed.push(row); repos.add(row.repo);
          step({ step: 'worktree-remove', path: mask(row.path), branch: mask(row.branch ?? ''), result: { ok: true } });
        } catch (e) {
          const line = mask(String(e?.stderr || e?.message || '').split(/\r?\n/).find((x) => x.trim()) ?? '').trim();
          errors.push({ path: row.path, line: `${errCode(e)}${line ? ` ${line}` : ''}` });
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
      const listedKeys = new Set(listed.map((c) => normPath(c.path)));
      const fresher = eligible.filter((r) => !listedKeys.has(normPath(r.path))).length;
      const why = skipped.length ? ` (почему: ${mask(groupReasons(skipped.map((s) => s.reason)))})` : '';
      const errs = errors.length ? `; ошибок ${errors.length}: ${errors.map((e) => `${baseName(e.path)} — ${e.line}`).map(mask).join('; ')}` : '';
      const tail = fresher ? `; новых кандидатов ${fresher} не трогал — они не были в списке` : '';
      return { outcome: errors.length ? 'partial' : 'ok', message: `убрано ${removed.length}, пропущено ${skipped.length}${why}${errs}${tail}`,
        result: { removed: removed.length, skipped: skipped.length, errors: errors.length } };
    } finally {
      if (owner) running = false;
    }
  }

  return { list, compute, act, isRunning: () => running };
}
