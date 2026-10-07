// Проба EXT-83 (ПТ8б): запускается руками — `node probe/ext83-probe.mjs`; в npm test не входит. Пишет только в os.tmpdir() и убирает своё.
// Что проверяет — фактами на настоящей файловой системе Windows:
//  (а) копия с junction node_modules → в основной клон (настоящая папка с файлом-маркером): по правилу копия НЕ кандидат;
//  (б) что делает `git worktree remove` БЕЗ силы с такой копией — отказ? удалил ли саму ссылку? тронул ли цель? Два варианта:
//      (б1) junction перечислен в .gitignore копии, (б2) не перечислен. Цель — временная папка временного репозитория.
//      Цель оказалась тронута (маркер пропал) — СТОП: второй вариант не запускается;
//  (в) время создания папки: CreationTime выставлен на 15 дней назад (PowerShell, NTFS) — отражает ли его birthtimeMs; слитая и чистая
//      копия с таким временем — кандидат, без него — нет.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitRead } from '../lib/git-read.mjs';
import { createWorktrees } from '../lib/pult/worktrees.mjs';

const DAY = 86400000;
const fwd = (p) => p.replace(/\\/g, '/');
const G = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=probe', '-c', 'user.email=probe@probe', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const roots = [];
const sess = [];
const mkSess = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ext83-probe-sess-')); sess.push(d); return d; };
const out = [];
const say = (s) => { out.push(s); console.log(s); };

function mkRepo(gitignore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext83-probe-'));
  roots.push(root);
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  G(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, '.gitignore'), gitignore);
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  G(main, 'add', '.');
  G(main, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(main, 'node_modules'));
  fs.writeFileSync(path.join(main, 'node_modules', 'marker.txt'), 'жив');
  return { root, main };
}
function addCopy(r, branch, { merge = true } = {}) {
  const wt = path.join(r.root, `wt-${branch}`);
  G(r.main, 'worktree', 'add', '-q', '-b', branch, wt);
  G(wt, 'commit', '-q', '--allow-empty', '-m', `${branch} commit`);
  if (merge) G(r.main, 'merge', '-q', '--no-edit', branch);
  return wt;
}
const finder = (r, extra = {}) => createWorktrees({ registry: { get: () => ({ codes: [{ code: 'EXT', repos: [r.main] }] }) },
  board: { card: () => ({ status: 'done' }) }, git: createGitRead(), sessionsDir: mkSess(), ...extra });
const dropLink = (l) => { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* уже нет */ } } };

function removeProbe(label, gitignore, branch) {
  const r = mkRepo(gitignore);
  const wt = addCopy(r, branch);
  const link = path.join(wt, 'node_modules');
  const target = path.join(r.main, 'node_modules'); // цель — настоящая папка временного основного клона
  fs.symlinkSync(target, link, 'junction');
  say(`${label}: lstat(ссылка).isSymbolicLink = ${fs.lstatSync(link).isSymbolicLink()}; status копии = ${JSON.stringify(G(wt, 'status', '--porcelain', '--ignored'))}`);
  return { r, wt, link, target };
}

async function main() {
  // (а) правило
  {
    const p = removeProbe('(а)', 'node_modules/\n', 'ext-901-linked');
    const rows = await finder(p.r).compute(null);
    const row = rows.find((x) => fwd(x.path).toLowerCase() === fwd(p.wt).toLowerCase());
    say(`(а) копия с junction node_modules: eligible=${row.eligible}, reason="${row.reason}"`);
    dropLink(p.link);
    const rows2 = await finder(p.r).compute(null);
    say(`(а, контроль) та же копия без ссылки: eligible=${rows2.find((x) => fwd(x.path).toLowerCase() === fwd(p.wt).toLowerCase()).eligible}`);
  }
  // (а2) ссылка — прямой ребёнок node_modules и ребёнок @scope: только lstat-правило, ничего не удаляется
  for (const [label, rel] of [['прямой ребёнок', ['pkg']], ['ребёнок @scope', ['@sc', 'pkg']]]) {
    const r = mkRepo('node_modules/\n');
    const wt = addCopy(r, label === 'прямой ребёнок' ? 'ext-907-direct' : 'ext-908-scope');
    const tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'ext83-probe-tgt-'));
    roots.push(tgt);
    fs.mkdirSync(path.join(wt, 'node_modules', ...rel.slice(0, -1)), { recursive: true });
    const lnk = path.join(wt, 'node_modules', ...rel);
    fs.symlinkSync(tgt, lnk, 'junction');
    const row = (await finder(r).compute(null)).find((x) => fwd(x.path).toLowerCase() === fwd(wt).toLowerCase());
    say(`(а2) junction — ${label} node_modules: eligible=${row.eligible}, reason="${row.reason}"`);
    dropLink(lnk);
    const row2 = (await finder(r).compute(null)).find((x) => fwd(x.path).toLowerCase() === fwd(wt).toLowerCase());
    say(`(а2, контроль) без ссылки: eligible=${row2.eligible}`);
  }
  // (б) git worktree remove БЕЗ силы — РАЗРУШАЮЩИЙ шаг, по умолчанию ВЫКЛЮЧЕН (флаг --destructive). Факт уже снят 07.10 (б1): git remove
  // без силы прошёл по junction в .gitignore копии и стёр содержимое цели. Цель здесь всегда во временной папке os.tmpdir() временного репозитория.
  let stop = !process.argv.includes('--destructive');
  if (stop) say('(б) пропущено: нужен флаг --destructive (факт б1 уже есть: remove без силы стирает цель junction)');
  for (const [label, gi, branch] of [['(б1) junction в .gitignore копии', 'node_modules/\n', 'ext-902-ignored'], ['(б2) junction НЕ в .gitignore копии', '# ничего\n', 'ext-903-untracked']]) {
    if (stop) continue;
    const p = removeProbe(label, gi, branch);
    const marker = path.join(p.target, 'marker.txt');
    let res;
    try { G(p.r.main, 'worktree', 'remove', p.wt); res = { exit: 0, stderr: '' }; } catch (e) { res = { exit: e.status, stderr: String(e.stderr ?? '').trim().split(/\r?\n/)[0] }; }
    const facts = { exit: res.exit, stderr: res.stderr, копия_есть: fs.existsSync(p.wt), ссылка_есть: (() => { try { fs.lstatSync(p.link); return true; } catch { return false; } })(),
      цель_есть: fs.existsSync(p.target), маркер_цел: fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'жив' };
    say(`${label}: ${JSON.stringify(facts)}`);
    if (!facts.маркер_цел || !facts.цель_есть) { stop = true; say(`${label}: ЦЕЛЬ ТРОНУТА — СТОП, дальше не идём`); }
    if (fs.existsSync(p.link)) dropLink(p.link);
  }
  // (в) время создания папки
  {
    const r = mkRepo('node_modules/\n');
    const wtOld = path.join(r.root, 'wt-old');
    const wtNew = path.join(r.root, 'wt-new');
    G(r.main, 'worktree', 'add', '-q', '-b', 'ext-905-old', wtOld);
    G(r.main, 'worktree', 'add', '-q', '-b', 'ext-906-new', wtNew);
    const target = new Date(Date.now() - 15 * DAY);
    const iso = target.toISOString();
    const before = fs.statSync(wtOld).birthtimeMs;
    let setOk = true;
    try {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${fwd(wtOld)}').CreationTime = [datetime]::Parse('${iso}')`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { setOk = false; say(`(в) CreationTime выставить не удалось: ${String(e.stderr ?? e.message).trim().split(/\r?\n/)[0]}`); }
    if (setOk) {
      const after = fs.statSync(wtOld).birthtimeMs;
      say(`(в) birthtime до: ${new Date(before).toISOString()}; после: ${new Date(after).toISOString()}; ожидали ≈ ${iso}; дней назад: ${((Date.now() - after) / DAY).toFixed(2)}`);
      const rows = await finder(r, { board: { card: () => null } }).compute(null); // карточек нет: без возраста не уйдёт
      const f = (wt) => rows.find((x) => fwd(x.path).toLowerCase() === fwd(wt).toLowerCase());
      say(`(в) копия с CreationTime −15 дней, слитая и чистая, свежая ветка без коммитов: eligible=${f(wtOld).eligible} (${f(wtOld).reason})`);
      say(`(в, контроль) такая же, без выставленного времени: eligible=${f(wtNew).eligible} (${f(wtNew).reason})`);
      const mt = fs.statSync(wtNew).mtimeMs;
      fs.utimesSync(wtNew, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
      const rows2 = await finder(r, { board: { card: () => null } }).compute(null);
      say(`(в, контроль mtime) mtime папки сдвинут на −30 дней (был ${new Date(mt).toISOString()}): eligible=${rows2.find((x) => fwd(x.path).toLowerCase() === fwd(wtNew).toLowerCase()).eligible} — mtime ничего не решает`);
    }
  }
}

try { await main(); } catch (e) { say(`ОШИБКА пробы: ${e.stack}`); process.exitCode = 1; } finally {
  // уборка только своего: сначала ссылки (не рекурсивно), потом папки пробы
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        const l = path.join(root, name, 'node_modules');
        try { if (fs.lstatSync(l).isSymbolicLink()) dropLink(l); } catch { /* нет */ }
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) { console.log(`не убрано ${root}: ${e.code}`); }
  }
  for (const d of sess) { try { fs.rmdirSync(d); } catch { /* уже нет */ } }
}
