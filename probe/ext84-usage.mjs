// EXT-84, такт 3: проба «Расхода» на настоящих журналах машины. Только чтение; индекс на диск НЕ пишется (скретч-читатель).
// Считает тем же кодом, что сервер: createJournalReader({scratch}).usageRecords → buildUsage; остаток — createRateLimitReader.
// Запуск руками: node probe/ext84-usage.mjs   (в npm test не входит)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildUsage } from '../lib/usage.mjs';
import { createRateLimitReader } from '../lib/rate-limit.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8'));
const root = path.join(os.homedir(), '.claude', 'projects');
const runsDir = cfg.pult?.usage?.foremanRuns ?? 'C:/projects/_foreman/runs';

let files = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files++; } };
walk(root);

const reader = createJournalReader({ root, indexDir: path.join(os.tmpdir(), 'ext84-usage-noindex'), rules: cfg.boardWriteTools ?? [], scratch: true });
await reader.refresh({ full: true });
const nowMs = Date.now();
const records = reader.usageRecords(0);
const u = buildUsage({ records, nowMs, lost: reader.usageLost() });
const rl = createRateLimitReader({ dir: runsDir }).get();

console.log(`сейчас: ${new Date(nowMs).toString()}`);
console.log('(1) итоги по дням, местные сутки; ввод / вывод / чтение кэша / запись кэша / сумма');
for (const d of u.days) {
  console.log(`${d.date}  ввод ${d.in}  вывод ${d.out}  чтение кэша ${d.cacheRead}  запись кэша ${d.cacheWrite}  сумма ${d.total}${d.date === u.today.date ? '  (сегодня, день идёт — неполный)' : ''}`);
}
const w = u.week;
console.log(`ИТОГО ${w.from}..${w.to}  ввод ${w.in}  вывод ${w.out}  чтение кэша ${w.cacheRead}  запись кэша ${w.cacheWrite}  сумма ${w.total}`);
console.log('(2) последний rate_limit_event прогонов');
if (rl.remaining) console.log(JSON.stringify(rl.remaining, null, 2));
else console.log(`нет (${rl.note})`);
console.log(`(3) файлов .jsonl в журналах: ${files}; записей usage (после снятия дублей): ${records.length}; строк без времени/ключа: ${u.unplaced}`);
