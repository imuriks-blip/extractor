// Подменный mirror.mjs для пробы ПТ8 (EXT-75): кладётся во ВРЕМЕННУЮ доску как tools/mirror.mjs рядом с копией настоящего
// tools/mirror-hidden.js (JScript-обёртка запускает node с <папка обёртки>\mirror.mjs). В Plane не ходит и в доску ничего не
// пишет, кроме её .mirror/. Формат — как у настоящего (tools/mirror.mjs доски, только прочитан): run.lock {pid,kind,at,boot,status},
// .mirror/runs.log «<ISO> · начало|конец · <вид> · pid N [· код C · S с · запросов R]», пульс .mirror/status.json progress
// {phase, cards_done, cards_total, kind, requests, rpm, at, started_at}, итог без progress с lastOk/lastFullOk/lastError.
// Длительность и исход — tools/fake-mirror.json рядом: {seconds, total, exit, error}. Свой pid и ppid — .mirror/fake-pid.json
// (для пробы: цепочка родителей, окна процесса).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const kind = argv.includes('--full') ? 'full' : 'changed';
const root = path.resolve(val('--root') ?? '.');
const here = path.dirname(fileURLToPath(import.meta.url));
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(here, 'fake-mirror.json'), 'utf8')); } catch { /* значения по умолчанию */ }
const seconds = Number(cfg.seconds ?? 30);
const total = Number(cfg.total ?? 60);
const exitCode = Number(cfg.exit ?? 0);
const dir = path.join(root, '.mirror');
fs.mkdirSync(dir, { recursive: true });
const runs = path.join(dir, 'runs.log');
const statusFile = path.join(dir, 'status.json');
const line = (t) => fs.appendFileSync(runs, `${new Date().toISOString()} · ${t}\n`);
const bootTime = () => Math.round(Date.now() - os.uptime() * 1000);

const lockFile = path.join(dir, 'run.lock');
try {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind, at: new Date().toISOString(), boot: bootTime(), status: statusFile }), { flag: 'wx' });
} catch {
  line(`пропущен · ${kind} · pid ${process.pid} · код 0 · зеркало уже идёт — этот проход пропущен`);
  process.exit(0);
}
fs.writeFileSync(path.join(dir, 'fake-pid.json'), JSON.stringify({ pid: process.pid, ppid: process.ppid, kind, argv, at: new Date().toISOString() }));
line(`начало · ${kind} · pid ${process.pid}`);

const t0 = Date.now();
const startedAt = new Date(t0).toISOString();
const atomic = (data) => { const tmp = `${statusFile}.board-tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n'); fs.renameSync(tmp, statusFile); };
const prev = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return {}; } };
let requests = 0;
const beat = () => {
  const f = Math.min(1, (Date.now() - t0) / (seconds * 1000));
  const phase = f < 0.05 ? 'projects' : f < 0.55 ? 'cards' : f < 0.85 ? 'comments' : f < 0.95 ? 'relations' : 'write';
  requests = Math.round(f * 2200);
  const state = { phase, cards_done: Math.round(f * total) };
  if (phase !== 'projects') state.cards_total = total; // cards_total — только когда стало известно
  const at = new Date().toISOString();
  atomic({ ...prev(), at, progress: { ...state, kind, requests, rpm: 23, at, started_at: startedAt } });
};
beat();
const timer = setInterval(beat, 1000);
setTimeout(() => {
  clearInterval(timer);
  const ok = exitCode === 0;
  const okAt = new Date().toISOString();
  const p = prev();
  const next = { ...p, at: okAt, kind };
  delete next.progress;
  if (ok) { next.done = total; next.lastOk = okAt; if (kind === 'full') next.lastFullOk = okAt; delete next.lastError; } else next.lastError = cfg.error ?? 'подменный сбой пробы ПТ8';
  atomic(next);
  try { fs.unlinkSync(lockFile); } catch { /* нет */ }
  line(`конец · ${kind} · pid ${process.pid} · код ${exitCode} · ${Math.round((Date.now() - t0) / 1000)} с · запросов ${requests}`);
  process.exit(exitCode);
}, seconds * 1000);
