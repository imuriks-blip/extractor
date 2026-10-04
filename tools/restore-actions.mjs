// Восстановление журнала действий пульта из суточной копии (EXT-50):
//   node tools/restore-actions.mjs <копия> [--to <путь>] [--data-dir <папка>]
// Печатаются число строк и id последней JSON-строки; строки не JSON — их число и номера, восстановлению они не мешают:
// копия пишется как есть, байт в байт (записанное сверяется по SHA-256). По умолчанию пишется <папка данных>/actions.restored.log — живой actions.log не трогается.
// --to <путь> (например data/vitrina/actions.log) — только если витрина не отвечает на своём порту
// (GET http://127.0.0.1:<port>/api/health; порт — из config.json с умолчаниями, как читает server.mjs); отвечает — отказ.
// Файл, который --to заменяет, не пропадает: уходит рядом под именем …replaced-<время>.
// --data-dir — только для другой папки данных (по умолчанию <репозиторий>/data/vitrina; тесты).
// Коды: 0 готово · 1 копия не читается · 2 неверный вызов · 3 витрина отвечает — отказ · 4 запись не удалась.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectLog } from '../lib/backup.mjs';
import { readConfig } from '../lib/config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PROBE_MS = 3000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// отвечает ли кто-то по HTTP на порту: любой HTTP-ответ — да; отказ соединения, обрыв, тишина — нет
export function answers({ port, host = HOST, timeoutMs = PROBE_MS }) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/api/health', headers: { host: `${host}:${port}` }, timeout: timeoutMs }, (res) => {
      res.resume();
      end(true);
      req.destroy();
    });
    req.on('timeout', () => { end(false); req.destroy(); });
    req.on('error', () => end(false));
  });
}

function parseArgs(argv) {
  const o = { copy: null, to: null, dataDir: path.join(ROOT, 'data', 'vitrina') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '--data-dir') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a}: нужен путь` };
      if (a === '--to') o.to = v; else o.dataDir = path.resolve(v);
    } else if (a.startsWith('--')) return { error: `неизвестный флаг ${a}` };
    else if (o.copy === null) o.copy = a;
    else return { error: `лишний аргумент ${a}` };
  }
  if (o.copy === null) return { error: 'нужна копия: node tools/restore-actions.mjs <копия> [--to <путь>]' };
  return o;
}

const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

export async function main(argv, { out = console.log, err = console.error, probe = answers, now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (o.error) { err(o.error); return 2; }
  let buf;
  try { buf = fs.readFileSync(path.resolve(o.copy)); } catch (e) { err(`копия не читается: ${e.code ?? e.message}`); return 1; }
  const info = inspectLog(buf);
  out(`копия ${path.basename(o.copy)} · строк: ${info.lines} · последний id: ${info.lastId ?? '—'}`);
  // битые строки восстановлению не мешают: копия верна журналу, каким он был, — восстанавливается как есть
  if (!info.ok) {
    const more = info.badLines.length > 20 ? ` и ещё ${info.badLines.length - 20}` : '';
    out(`битых строк: ${info.badLines.length} (строки ${info.badLines.slice(0, 20).join(', ')}${more}) — восстанавливаются как есть`);
  }

  const target = o.to ? path.resolve(o.to) : path.join(o.dataDir, 'actions.restored.log');
  if (o.to) {
    let port;
    try { port = readConfig({ dataDir: o.dataDir, defaults: JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8')) }).port; } catch (e) { err(`порт витрины не прочитан (${e.message}) — --to не выполняется`); return 4; }
    if (await probe({ port })) { err(`витрина отвечает на ${HOST}:${port} — отказ: сначала остановить витрину (tools/vitrina-stop.ps1), потом --to`); return 3; }
  }

  const tmp = `${target}.${process.pid}.tmp`;
  let aside = null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, buf);
    // живой файл не теряется: заменяемый --to уходит рядом; не легла новая — старый возвращается
    if (o.to && fs.existsSync(target)) { aside = `${target}.replaced-${stamp(now())}`; fs.renameSync(target, aside); }
    try { fs.renameSync(tmp, target); } catch (e) { if (aside) fs.renameSync(aside, target); throw e; }
    if (sha256(fs.readFileSync(target)) !== sha256(buf)) throw new Error('записанный файл не совпал с копией');
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* временного файла нет */ }
    err(`запись не удалась: ${e.code ?? e.message}`);
    return 4;
  }
  out(`записано: ${target}`);
  if (aside) out(`прежний файл сохранён: ${aside}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
