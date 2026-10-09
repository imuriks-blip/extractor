// EXT-87 проба п.2–4: одна сессия замера остатка — claude.exe -p бинарником десктопа (findLatestBin прораба), без окна,
// потолок 60 с, поток stream-json — в файл, у каждой строки — время от старта. До и после — внешние следы хуков:
// очередь _vault-check/pending (только список), bell.log живой витрины (только чтение), замок <sid>.lock в папке звонка
// (только существование), процессы waiter.mjs (только список), журнал сессии в ~/.claude/projects (только список).
//
//   node probe/ext87-measure.mjs --case main|sources|hooks --keep <папка для stream.jsonl и summary.json>
//     main    — как в спеке: настройки пользователя грузятся, --settings {disableAllHooks:true + свои хуки-метки},
//               --no-session-persistence
//     sources — --setting-sources project (без настроек пользователя), {disableAllHooks:true + метки}, БЕЗ
//               --no-session-persistence (журнал «без флага»)
//     hooks   — исправный случай: --setting-sources project, {только свои хуки-метки, без disableAllHooks},
//               --no-session-persistence. Общие хуки (хроника, ждущий звонка) в нём не грузятся — источник user выключен.
//
// Хуки-метки — node <tmp>/mark.mjs <событие>: дописывают строку в <tmp>/markers/<событие>.txt (своя временная папка).
// Процесс снимается только свой: по pid из spawn, деревом taskkill /T /F.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { findLatestBin } from '../../_foreman/foreman-launch.mjs';

const { values } = parseArgs({ options: { case: { type: 'string' }, keep: { type: 'string' }, ceiling: { type: 'string' } } });
const CASE = values.case;
if (!['main', 'sources', 'hooks'].includes(CASE) || !values.keep) { console.error('нужны --case main|sources|hooks и --keep <папка>'); process.exit(2); }
const CEILING_MS = Number(values.ceiling ?? 60) * 1000;
const MODEL = 'claude-haiku-4-5-20251001';
const PROMPT = 'Ответь одним словом: ок';
const PENDING = 'C:/projects/_vault-check/pending';
const BELL_DIR = 'C:/projects/extractor/data/vitrina/bell';
const BELL_LOG = path.join(BELL_DIR, 'bell.log');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ext87-${CASE}-`));
const cwd = path.join(tmp, 'measure');
const markers = path.join(tmp, 'markers');
fs.mkdirSync(cwd); fs.mkdirSync(markers);
const fwd = (p) => p.replace(/\\/g, '/');
fs.writeFileSync(path.join(tmp, 'mark.mjs'),
  `import fs from 'node:fs';\nlet input='';process.stdin.on('data',d=>input+=d).on('end',()=>{fs.appendFileSync(${JSON.stringify(fwd(markers))}+'/'+process.argv[2]+'.txt',new Date().toISOString()+' '+input.slice(0,300)+'\\n');});\n`);
const markHook = (ev) => [{ hooks: [{ type: 'command', command: `node "${fwd(path.join(tmp, 'mark.mjs'))}" ${ev}`, timeout: 15 }] }];
const settings = { hooks: { SessionStart: markHook('SessionStart'), Stop: markHook('Stop'), SessionEnd: markHook('SessionEnd') } };
if (CASE !== 'hooks') settings.disableAllHooks = true;
const settingsFile = path.join(tmp, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const bin = findLatestBin(process.env.APPDATA);
const args = ['-p', PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
  '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', settingsFile];
if (CASE !== 'sources') args.push('--no-session-persistence');
if (CASE !== 'main') args.push('--setting-sources', 'project');

// --- внешние следы: снимок
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return `ERR ${e.code}`; } };
const stat = (f) => { try { const s = fs.statSync(f); return { size: s.size, mtime: s.mtime.toISOString() }; } catch { return null; } };
function waiters() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*waiter.mjs*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToString('o'))\" }"],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}
const projDirs = () => new Set(ls(PROJECTS));
function snapshot() {
  return { pending: ls(PENDING).map((n) => ({ n, ...stat(path.join(PENDING, n)) })), bellLog: stat(BELL_LOG), bellLines: (() => { try { return fs.readFileSync(BELL_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return null; } })(), waiters: waiters() };
}
const before = snapshot();
const projBefore = projDirs();

// --- запуск
const streamPath = path.join(tmp, 'stream.jsonl');
const stream = fs.createWriteStream(streamPath);
const timeline = [];
let sessionId = null, init = null, result = null, rle = [], hookEvents = [], timedOut = false, buf = '';
const t0 = Date.now();
const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const childPid = child.pid;
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const onLine = (line) => {
  if (!line.trim()) return;
  const ms = Date.now() - t0;
  stream.write(JSON.stringify({ _ms: ms }) + '\t' + line + '\n');
  let j; try { j = JSON.parse(line); } catch { timeline.push({ ms, type: 'unparsed' }); return; }
  timeline.push({ ms, type: j.type, subtype: j.subtype ?? j.hook_event_name ?? undefined });
  if (j.session_id) sessionId = j.session_id;
  if (j.type === 'system' && j.subtype === 'init') init = j;
  if (j.type === 'rate_limit_event') rle.push({ ms, info: j.rate_limit_info });
  if (j.type === 'system' && /hook/i.test(String(j.subtype))) hookEvents.push({ ms, subtype: j.subtype, name: j.hook_name ?? j.hook_event ?? j.hook_event_name });
  if (j.type === 'result') result = { ms, ...j };
};
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } });
const timer = setTimeout(() => { timedOut = true; spawnSync('taskkill', ['/T', '/F', '/PID', String(childPid)], { windowsHide: true, stdio: 'ignore' }); }, CEILING_MS);
const [code, signal] = await new Promise((r) => child.on('close', (c, s) => r([c, s])));
clearTimeout(timer);
if (buf) onLine(buf);
const wallMs = Date.now() - t0;
await new Promise((r) => stream.end(r));

// хвосты хуков (async Stop, SessionEnd) — подождать и снять след
await new Promise((r) => setTimeout(r, 15000));
const after = snapshot();
const bellSid = (() => { try { return fs.readFileSync(BELL_LOG, 'utf8').split('\n').filter((l) => sessionId && l.includes(sessionId)); } catch { return null; } })();
const newProj = [...projDirs()].filter((d) => !projBefore.has(d));
const journal = [];
for (const d of ls(PROJECTS)) {
  if (!Array.isArray(ls(path.join(PROJECTS, d)))) continue;
  for (const f of ls(path.join(PROJECTS, d))) if (sessionId && f.startsWith(sessionId)) journal.push(path.join(PROJECTS, d, f));
}
// свой ли процесс ещё жив (pid из spawn)
const alive = spawnSync('tasklist', ['/FI', `PID eq ${childPid}`, '/NH'], { windowsHide: true, encoding: 'utf8' }).stdout.includes(String(childPid));

const envNames = Object.keys(process.env).filter((k) => /^(CLAUDE|ANTHROPIC)/i.test(k)).sort();
const summary = {
  case: CASE, bin, args: args.map((a) => (a === '' ? '""' : a)), cwd, settings, envNames, childPid, code, signal, timedOut, wallMs, childStillAlive: alive,
  sessionId, init: init && { model: init.model, cwd: init.cwd, tools: init.tools, mcp_servers: init.mcp_servers, plugins: init.plugins, skillsCount: init.skills?.length, slashCount: init.slash_commands?.length, apiKeySource: init.apiKeySource, claude_code_version: init.claude_code_version, keys: Object.keys(init) },
  rateLimitEvents: rle, hookEvents,
  result: result && { ms: result.ms, subtype: result.subtype, is_error: result.is_error, result: result.result, duration_ms: result.duration_ms, duration_api_ms: result.duration_api_ms, num_turns: result.num_turns, total_cost_usd: result.total_cost_usd, usage: result.usage, modelUsage: result.modelUsage },
  timeline,
  markers: Object.fromEntries((ls(markers) || []).map((f) => [f, fs.readFileSync(path.join(markers, f), 'utf8').trim().split('\n').map((l) => l.slice(0, 120))])),
  traces: { pendingBefore: before.pending, pendingAfter: after.pending, bellLinesBefore: before.bellLines, bellLinesAfter: after.bellLines, bellLinesWithSid: bellSid, bellLockForSid: sessionId ? fs.existsSync(path.join(BELL_DIR, `${sessionId}.lock`)) : null, waitersBefore: before.waiters, waitersAfter: after.waiters },
  journal: { newProjectDirs: newProj, filesWithSid: journal },
  stderrTail: stderr.slice(-800),
};
fs.mkdirSync(values.keep, { recursive: true });
fs.copyFileSync(streamPath, path.join(values.keep, `${CASE}-stream.jsonl`));
fs.writeFileSync(path.join(values.keep, `${CASE}-summary.json`), JSON.stringify(summary, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
summary.tmpRemoved = !fs.existsSync(tmp);
console.log(JSON.stringify(summary, null, 2));
