// «Замерить остаток» (EXT-87, спека пульта §6 п.2): одна короткая сессия claude.exe -p, из потока берётся первое событие
// rate_limit_event. Это ЕДИНСТВЕННЫЙ запуск Claude витрины. Устройство — по фактам пробы (probe/ext87-measure.mjs):
//  - бинарник — наибольшая версия из двух мест (пакет десктопа и обычный профиль); нет — «Claude не найден»;
//  - запуск — константа (MEASURE_ARGS), тело запроса на неё не влияет; settings.json с disableAllHooks пишет витрина;
//  - окружение — витрины без CLAUDECODE и CLAUDE_CODE_* (вход обновляет сам Claude, как в обычном терминале);
//  - процесс дочерний, НЕ отсоединённый, без окна; поток читается из канала, копия — last-stream.jsonl;
//  - потолок 60 с — снятие деревом по СВОЕМУ pid (taskkill /T /F /PID); при stop() витрины — то же;
//  - удача: last.json (атомарно) + строка в log.jsonl; неудача: строка с ok:false, last.json не трогается;
//  - раз в 5 мин: повтор отвечает прежним результатом (reused), без запуска; идущий замер — отказ measure-running.
// Время события — время получения строки (процесс не отсоединён: строка приходит на лету).
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const MEASURE_PROMPT = 'Ответь одним словом: ок';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const CEILING_MS = 60000;
export const REUSE_MS = 5 * 60000;
export const MAX_BUDGET_USD = '0.2';
export const AUTH_MESSAGE = 'вход Claude истёк — войди в Claude в обычном терминале';

// Папка сессии в ~/.claude/projects по cwd — правило Claude: каждый не буквенно-цифровой знак — «-»
export const sessionDirName = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const VERSION_RE = /^\d+(\.\d+)*$/;
const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
};

// claude.exe наибольшей версии в двух местах (спека §6 п.2): пакет десктопа и профиль. env — шов (тесты)
export function findClaudeBin({ env = process.env, fs = nodeFs } = {}) {
  const roots = [];
  if (env.LOCALAPPDATA) {
    const pk = path.join(env.LOCALAPPDATA, 'Packages');
    try {
      for (const e of fs.readdirSync(pk, { withFileTypes: true })) {
        if (e.isDirectory() && /^Claude_/.test(e.name)) roots.push(path.join(pk, e.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    } catch { /* пакета нет */ }
  }
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude', 'claude-code'));
  const found = [];
  for (const root of roots) {
    let versions = [];
    try { versions = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && VERSION_RE.test(d.name)).map((d) => d.name); } catch { continue; }
    for (const v of versions) {
      let hashes = [];
      try { hashes = fs.readdirSync(path.join(root, v), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const h of hashes) {
        const exe = path.join(root, v, h, 'claude.exe');
        try { found.push({ v, exe, mtimeMs: fs.statSync(exe).mtimeMs }); } catch { /* нет программы в этой папке */ }
      }
    }
  }
  found.sort((a, b) => cmpVersion(b.v, a.v) || b.mtimeMs - a.mtimeMs);
  return found[0]?.exe ?? null;
}

// окружение процесса замера: окружение витрины без переменных сессии десктопа
export function measureEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_.*)$/i.test(k)));
}

// запуск — константа в коде; меняется только путь настроек и модель (настройка pult.measure.model)
export function measureArgs({ model, settingsFile }) {
  return ['-p', MEASURE_PROMPT, '--model', model, '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--settings', settingsFile, '--setting-sources', 'project', '--no-session-persistence',
    '--max-budget-usd', MAX_BUDGET_USD, '--include-hook-events'];
}

// снять дерево своего процесса по pid запуска; никогда по имени
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* уже нет */ } }
}

function writeAtomic(fs, file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const win = (w) => (w && typeof w === 'object' ? { utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null } : null);
const pct = (w) => (w && Number.isFinite(w.utilization) ? `${Math.round(w.utilization * 100)} %` : '—');
const tokensOf = (u) => (u && typeof u === 'object' ? ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((n, k) => n + (Number.isFinite(u[k]) ? u[k] : 0), 0) : 0);

export function describe(last) {
  const reset = last.fiveHour && Number.isFinite(last.fiveHour.resetsAt) ? ` · сброс ${hhmm(last.fiveHour.resetsAt * 1000)}` : '';
  return `5 ч: ${pct(last.fiveHour)}${reset} · 7 дн: ${pct(last.sevenDay)} · замер ${hhmm(Date.parse(last.at))}`;
}

// dir — data/vitrina/measure (там же cwd сессии); launch/findBin/kill/now/ceilingMs — швы тестов (настоящий claude.exe в тестах не зовётся)
export function createMeasure({ dir, model = DEFAULT_MODEL, findBin = () => findClaudeBin(), launch = (bin, args, opts) => spawn(bin, args, opts), kill = killTree,
  now = Date.now, ceilingMs = CEILING_MS, reuseMs = REUSE_MS, env = process.env, log = { write() {} }, fs = nodeFs } = {}) {
  const lastFile = path.join(dir, 'last.json');
  const logFile = path.join(dir, 'log.jsonl');
  const streamFile = path.join(dir, 'last-stream.jsonl');
  const settingsFile = path.join(dir, 'settings.json');
  let run = null; // {at, pid, done}
  let stopping = false;

  function last() {
    try {
      const j = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
      return j && typeof j.at === 'string' && Number.isFinite(Date.parse(j.at)) ? j : null;
    } catch { return null; }
  }
  const rows = () => {
    try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
  };
  const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  // замеры сегодня (местные сутки): count — удачные; стоимость и токены — по всем строкам (неудача тоже могла стоить)
  function today(nowMs = now()) {
    const k = dayOf(nowMs);
    const out = { count: 0, costUsd: 0, tokens: 0 };
    for (const r of rows()) {
      if (!Number.isFinite(Date.parse(r.at)) || dayOf(Date.parse(r.at)) !== k) continue;
      if (r.ok === true) out.count++;
      if (Number.isFinite(r.costUsd)) out.costUsd += r.costUsd;
      if (Number.isFinite(r.tokens)) out.tokens += r.tokens;
    }
    out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
    return out;
  }
  const addRow = (row) => { try { fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`); } catch (e) { log.write('error', { route: 'measure-log', code: typeof e?.code === 'string' ? e.code : 'ERR' }); } };
  const fail = (reason, extra = {}) => {
    addRow({ at: new Date(now()).toISOString(), ok: false, reason, ...extra });
    return { outcome: 'error', message: `замер не удался: ${reason}` };
  };

  async function measureOnce() {
    try { fs.mkdirSync(dir, { recursive: true }); writeAtomic(fs, settingsFile, JSON.stringify({ disableAllHooks: true })); } catch (e) {
      return fail(`не записать настройки замера (${typeof e?.code === 'string' ? e.code : 'ERR'})`);
    }
    let bin = null;
    try { bin = findBin(); } catch { bin = null; }
    if (!bin) return fail('Claude не найден');
    if (stopping) return fail('витрина останавливается');
    let child;
    try {
      child = launch(bin, measureArgs({ model, settingsFile }), { cwd: dir, env: measureEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return fail(`Claude не запустился (${typeof e?.code === 'string' ? e.code : 'ERR'})`); }
    run.pid = child.pid;
    let ws = null;
    try { ws = fs.createWriteStream(streamFile); ws.on('error', () => {}); } catch { ws = null; }
    let ev = null; let res = null; let hooks = 0; let authFail = false; let spawnErr = null; let timedOut = false; let buf = ''; let tail = '';
    const onLine = (line) => {
      if (!line.trim()) return;
      ws?.write(`${line}\n`);
      if (/Failed to authenticate|authentication_error/i.test(line)) authFail = true;
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'rate_limit_event' && j.rate_limit_info && !ev) ev = { at: now(), info: j.rate_limit_info };
      else if (j.type === 'result') res = j;
      else if (j.type === 'system' && j.subtype === 'hook_started') hooks++;
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } });
    child.stderr?.on('data', (d) => { tail = (tail + d).slice(-2000); });
    await new Promise((resolve) => {
      let grace = null;
      const finish = () => { clearTimeout(timer); clearTimeout(grace); resolve(); };
      const timer = setTimeout(() => { timedOut = true; kill(child.pid); grace = setTimeout(finish, 3000); }, ceilingMs);
      run.kill = () => { kill(child.pid); };
      child.on('error', (e) => { spawnErr = e; finish(); });
      child.on('close', finish);
    });
    if (buf) onLine(buf);
    if (/Failed to authenticate/i.test(tail)) authFail = true;
    if (ws) await new Promise((r) => ws.end(r));
    if (hooks > 0) log.write('error', { route: 'measure', code: 'HOOKS', events: hooks });
    if (stopping) return fail('витрина останавливается');
    if (spawnErr) return fail(`Claude не запустился (${typeof spawnErr.code === 'string' ? spawnErr.code : 'ERR'})`);
    if (authFail) return fail(AUTH_MESSAGE);
    if (timedOut) return fail(`превышен потолок ${Math.round(ceilingMs / 1000)} с, процесс снят`);
    if (!ev) return fail('в ответе Claude нет события лимита');
    const w = ev.info.unifiedWindows ?? {};
    const saved = { at: new Date(ev.at).toISOString(), fiveHour: win(w.five_hour), sevenDay: win(w.seven_day), status: typeof ev.info.status === 'string' ? ev.info.status : null,
      costUsd: Number.isFinite(res?.total_cost_usd) ? res.total_cost_usd : null, usage: res?.usage ?? null };
    try { writeAtomic(fs, lastFile, JSON.stringify(saved)); } catch (e) { return fail(`результат не записался (${typeof e?.code === 'string' ? e.code : 'ERR'})`); }
    addRow({ at: saved.at, ok: true, costUsd: saved.costUsd, tokens: tokensOf(saved.usage) });
    return { outcome: 'ok', message: describe(saved), result: { costUsd: saved.costUsd } };
  }

  // проверка и запоминание — синхронно, до первого await (два нажатия разом — один замер)
  async function act() {
    if (run) return { outcome: 'refused', refusal: 'measure-running', message: `замер уже идёт (с ${hhmm(run.at)})` };
    const prev = last();
    if (prev && now() - Date.parse(prev.at) < reuseMs && now() >= Date.parse(prev.at)) {
      return { outcome: 'ok', message: `замер был в ${hhmm(Date.parse(prev.at))}: ${describe(prev)}`, extra: { reused: true } };
    }
    const cur = { at: now(), pid: null, kill: null, done: null };
    run = cur;
    cur.done = (async () => {
      try { return await measureOnce(); } catch (e) { return fail(`сбой витрины (${typeof e?.code === 'string' ? e.code : 'ERR'})`); } finally { run = null; }
    })();
    return cur.done;
  }

  // штатная остановка витрины: идущий замер снимается тем же путём (деревом по своему pid)
  async function stop() {
    stopping = true;
    const cur = run;
    if (cur) { cur.kill?.(); await cur.done.catch(() => {}); }
  }

  return { act, stop, last, today, running: () => !!run };
}
