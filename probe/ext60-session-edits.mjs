// EXT-60, вердикт Голема Важно 2 — факты на живых журналах (только чтение ~/.claude; индекс — во временной папке).
// node probe/ext60-session-edits.mjs [часы=72] [папка lib=../lib]
// 1) сырой счёт: правки (Edit/MultiEdit/Write/NotebookEdit с результатом без ошибки) в окне, строка вызова которых несёт
//    sessionId, не равный id файла сессии (копии строк прежних сессий в продолженном треде); и запуски субагентов, чей
//    журнал найден только запасным путём по agentId при живом на диске журнале своей сессии;
// 2) пары «Общего файла» по buildWorkers из указанной папки lib (старый код — `git archive <база> lib`), живые — по
//    ~/.claude/sessions/*.json (поле sessionId), десктопной связи нет (как у независимого подсчёта дирижёра).
// Печатает числа, короткие id, пути и названия тредов; текстов сообщений нет.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOURS = Number(process.argv[2] || 72);
const LIB = path.resolve(process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'lib'));
const H = 3600000;
const NOW = Date.now();
const WIN = HOURS * H;
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const lib = (f) => import(pathToFileURL(path.join(LIB, f)).href);
const { createJournalReader } = await lib('journal-reader.mjs');
const { buildWorkers } = await lib('waiting.mjs');
const { EDIT_RESERVE_MS } = await lib('journal-parse.mjs');
const TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// ---------- 1) сырой счёт по файлам сессий ----------
const sessionFiles = new Map(); // id → файл
const agentDirs = new Map(); // agentId → [sessionId каталога]
for (const proj of fs.readdirSync(ROOT)) {
  const pd = path.join(ROOT, proj);
  if (!fs.statSync(pd).isDirectory()) continue;
  for (const f of fs.readdirSync(pd)) {
    if (f.endsWith('.jsonl')) { sessionFiles.set(f.slice(0, -6), path.join(pd, f)); continue; }
    const sd = path.join(pd, f, 'subagents');
    if (!fs.existsSync(sd)) continue;
    for (const a of fs.readdirSync(sd)) { const m = a.match(/^agent-(\w+)\.jsonl$/); if (m) (agentDirs.get(m[1]) ?? agentDirs.set(m[1], []).get(m[1])).push(f); }
  }
}
let editsAll = 0, editsForeign = 0;
const foreignFiles = new Set();
const fallbackRuns = []; // [файл, agentId, сессия журнала]
for (const [sid, file] of sessionFiles) {
  if (NOW - fs.statSync(file).mtimeMs > WIN) continue;
  const pend = new Map();
  const launches = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const c = d.message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b?.type === 'tool_use' && TOOLS.has(b.name)) pend.set(b.id, { s: d.sessionId, at: Date.parse(d.timestamp) });
      else if (b?.type === 'tool_result' && pend.has(b.tool_use_id)) {
        const e = pend.get(b.tool_use_id); pend.delete(b.tool_use_id);
        if (b.is_error === true || !(NOW - e.at <= WIN)) continue;
        editsAll++;
        if (e.s !== sid) { editsForeign++; foreignFiles.add(sid); }
      }
    }
    const aid = d.toolUseResult?.agentId;
    if (typeof aid === 'string') launches.add(aid);
  }
  for (const aid of launches) {
    const dirs = agentDirs.get(aid) ?? [];
    if (dirs.includes(sid) || dirs.length === 0) continue;
    if (dirs.some((x) => sessionFiles.has(x))) fallbackRuns.push([sid.slice(0, 8), aid.slice(0, 8), dirs.map((x) => x.slice(0, 8)).join('+')]);
  }
}
console.log(`окно ${HOURS} ч · lib ${LIB}`);
console.log(`правок без ошибки в журналах сессий: ${editsAll}; из них в строках с чужим sessionId: ${editsForeign} (файлов: ${foreignFiles.size})`);
console.log(`запусков субагентов, найденных только запасным путём при журнале своей сессии на месте: ${fallbackRuns.length}`);
for (const r of fallbackRuns.slice(0, 10)) console.log('   ', r.join(' · '));

// ---------- 2) пары «Общего файла» ----------
const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext60-probe-'));
const reader = createJournalReader({ root: ROOT, indexDir, editKeepMs: WIN + EDIT_RESERVE_MS });
await reader.refresh({ full: true });
const live = new Set();
const sd = path.join(os.homedir(), '.claude', 'sessions');
for (const f of fs.readdirSync(sd).filter((x) => x.endsWith('.json'))) { try { const s = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')).sessionId; if (s) live.add(s); } catch {} }
const procs = [...live].map((s, i) => ({ pid: i + 1, sessionId: s, name: s.slice(0, 8), live: true, startedAt: NOW - WIN, status: 'busy', observedAt: NOW, statusUpdatedAt: NOW }));
const board = { hasCard: () => false, card: () => null, hasCode: () => false, hasBoard: true };
const w = buildWorkers({ procs, sessions: reader.sessions(), board, now: NOW, thresholds: { collisionWindowH: HOURS } });
const byPath = new Map();
let marks = 0;
for (const t of w.threads) for (const m of t.marks ?? []) {
  if (m.kind !== 'collision') continue;
  marks++;
  for (const f of m.files) {
    const o = byPath.get(f.path.toLowerCase()) ?? byPath.set(f.path.toLowerCase(), new Map()).get(f.path.toLowerCase());
    o.set(t.sessionId, `${t.sessionId.slice(0, 8)} живой ${f.mineAt.slice(11, 16)}`);
    o.set(m.other.sessionId, `${m.other.sessionId.slice(0, 8)} ${m.other.closed ? 'закрыт' : 'живой'} ${f.otherAt.slice(11, 16)} «${String(m.other.title ?? '').slice(0, 40)}»`);
  }
}
console.log(`живых: ${live.size}; пометок collision: ${marks}; файлов в парах: ${byPath.size}`);
for (const [p, o] of byPath) { console.log(p); for (const v of o.values()) console.log('   ', v); }
for (const f of fs.readdirSync(indexDir)) fs.unlinkSync(path.join(indexDir, f));
fs.rmdirSync(indexDir);
