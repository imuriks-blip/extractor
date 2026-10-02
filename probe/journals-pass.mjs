// Живой проход читателя журналов по всем журналам машины (В2, гейт Г2). Только чтение ~/.claude/projects;
// индекс — во временный каталог (или --index <каталог>). Печатает только числа и id — без текстов.
// node probe/journals-pass.mjs [--root <каталог проектов>] [--index <каталог индекса>]
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = arg('--root', path.join(os.homedir(), '.claude', 'projects'));
const indexDir = arg('--index', fs.mkdtempSync(path.join(os.tmpdir(), 'vitrina-index-')));
const rules = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.default.json'), 'utf8')).boardWriteTools;

let peak = 0;
const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
const r = createJournalReader({ root, indexDir, rules, indexWriteEveryS: Number(arg('--every', 60)) });
const t0 = performance.now();
await r.refresh();
const firstPassLines = r.state().lastPassLines;
const t1 = performance.now();
await r.refresh();
const t2 = performance.now();
clearInterval(tick);
peak = Math.max(peak, process.memoryUsage().rss);

const st = r.state();
const ss = r.sessions();
const mb = (b) => (b / 1048576).toFixed(0) + ' МБ';
const sum = (f) => ss.reduce((a, s) => a + f(s), 0);
const per = ss.map((s) => ({
  id: s.sessionId.slice(0, 8), project: s.project.slice(0, 32), lines: s.lines,
  runs: s.runs.length, zakhods: s.runs.reduce((a, x) => a + (x.zakhods?.length ?? 0), 0), cont: s.runs.reduce((a, x) => a + x.continuations, 0),
  partial: s.partials.length, alive: s.runs.filter((x) => x.alive).length, writes: s.boardWrites.length, ivan: s.ivan.count,
}));
console.log(`журналов: ${st.files} (сессий ${ss.length}, субагентов ${st.files - ss.length}); строк: ${st.lines}; ошибок чтения: ${st.errors}`);
console.log(`непонятых строк по версиям: ${JSON.stringify(st.unknown)}`);
console.log(`запусков субагентов: ${sum((s) => s.runs.length)}; заходов: ${per.reduce((a, p) => a + p.zakhods, 0)}; продолжений: ${per.reduce((a, p) => a + p.cont, 0)}; PARTIAL: ${sum((s) => s.partials.length)}; без итога (живые по журналу): ${st.runsOpen}`);
console.log(`записей на доску (успешных): ${sum((s) => s.boardWrites.length)}; неуспешных: ${sum((s) => s.boardWritesFailed)}; сообщений Ивана: ${sum((s) => s.ivan.count)}`);
const marked = /^(?:▶|⏸)️?/;
console.log(`  из них первая строка не с ▶/⏸: ${sum((s) => s.boardWrites.filter((w) => !marked.test(w.firstLine)).length)}`);
console.log(`индекс: ${st.indexBytes} байт, запись ${st.indexWriteMs} мс, записей за два прохода: ${st.indexWrites}; первый проход прочёл строк: ${firstPassLines}`);
console.log(`время: полный проход ${(t1 - t0).toFixed(0)} мс, повторный (хвосты) ${(t2 - t1).toFixed(0)} мс; память: пик RSS ${mb(peak)}, heapUsed ${mb(process.memoryUsage().heapUsed)}; индекс ${mb(fs.statSync(path.join(indexDir, 'journals.json')).size)}`);
console.log('\nтоп-10 сессий по запускам:');
console.table(per.sort((a, b) => b.runs - a.runs || b.lines - a.lines).slice(0, 10));
console.log('PARTIAL (сессия · агент · где · тормоз · время):');
for (const s of ss) for (const p of s.partials) console.log(`  ${s.sessionId} · ${p.agentId} · ${p.where} · ${p.limit} · ${p.at}`);
console.log('живые по журналу (без итога):');
for (const s of ss) for (const x of s.runs.filter((y) => y.alive)) console.log(`  ${s.sessionId} · ${x.agentId} · ${x.agentType} · заходов ${x.zakhods?.length ?? '-'} · ходов в текущем ${x.currentZakhod ?? '-'}`);
