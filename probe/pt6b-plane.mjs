// Обёртка пробы ПТ6 над настоящим plane.py (только EXT-68/EXT-69): пишет каждый вызов и вывод в pt6b-plane-calls.log
// (jsonl), код выхода и потоки отдаёт как есть. Витрина зовёт её как `node pt6-plane.mjs <args>` (pult.python = node).
// Карточки кроме EXT-68/EXT-69 — отказ без вызова: страховка от записи не туда.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ref = args.find((a, i) => i > 0 && /^[A-Z]{2,6}-\d+$/.test(a));
if (!['EXT-68'].includes(ref)) { process.stderr.write(`обёртка пробы: ${ref} не разрешена\n`); process.exit(1); }
const r = spawnSync('python', ['C:/projects/_plane-rest/plane.py', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
fs.appendFileSync(path.join(HERE, 'pt6b-plane-calls.log'), JSON.stringify({ at: new Date().toISOString(), args, code: r.status, stdout: r.stdout, stderr: String(r.stderr ?? '').slice(0, 300) }) + '\n');
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 1);
