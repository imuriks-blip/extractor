// Вызов board.mjs из процесса витрины — режим live (спека пульта §3.3 пп.3, 5, 6; EXT-91).
// node <boardRoot>/tools/board.mjs --as ivan --root <boardRoot> <команда> … — аргументы массивом, windowsHide; --as первым,
// --root всегда (без него board пишет в каталог над своим tools/ — В10); окружение — витрины без ключа Plane и без
// CLAUDECODE / CLAUDE_CODE_* (иначе board поставит трейлер Board-Session чужой сессии — М2); таймаут 60 с — процесс
// снимается деревом по своему pid (taskkill /T /F /PID); одна очередь записей на сервер.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { createPlaneQueue } from './queue.mjs';

export const BOARD_TIMEOUT_MS = 60000;

// окружение порождаемого board: без ключа и адреса Plane, без признаков сессии Claude
export function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (/^plane_/i.test(k) || /^claudecode$/i.test(k) || /^claude_code_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// снятие дерева процессов по своему pid; не вышло — хотя бы сам процесс (child.kill делает вызывающий)
export function killTree(pid) {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    let t = null;
    try {
      const k = nodeSpawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
      t = setTimeout(end, 5000);
      k.once('error', end);
      k.once('close', end);
    } catch { end(); }
  });
}

// board-вывод: строки «⚠ …» (не отправлено на GitHub, грязное дерево, конфликт) — не исход; исход — строки после всех «⚠»
export function parseOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  let lastW = -1;
  lines.forEach((l, i) => { if (l.startsWith('⚠')) lastW = i; });
  return { warnings: lines.filter((l) => l.startsWith('⚠')), outcome: lines.slice(lastW + 1) };
}

// Исход вызова → вид: ok · busy (3) · conflict (4) · secret · encoding · rule (иной код 1) · bad-call (код 2 до записи) ·
// unclear (таймаут, нет кода, код 2 «ошибка board:» — исключение могло случиться после коммита) · not-run (не запустился)
export function classify(r) {
  const { warnings, outcome } = parseOutput(r.stdout);
  const stderrLine = String(r.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const first = outcome[0] ?? stderrLine;
  const base = { warnings, ms: r.ms ?? null };
  if (r.spawnError) return { kind: 'not-run', code: null, line: String(r.spawnError), ...base };
  if (r.timedOut) return { kind: 'unclear', code: null, line: 'таймаут', ...base };
  if (r.code === null || r.code === undefined) return { kind: 'unclear', code: null, line: first || 'нет кода выхода', ...base };
  if (r.code === 0) return { kind: 'ok', code: 0, line: outcome.at(-1) ?? '', ...base };
  if (r.code === 3) return { kind: 'busy', code: 3, line: first, ...base };
  if (r.code === 4) return { kind: 'conflict', code: 4, line: first, ...base };
  if (r.code === 1) {
    if (!first) return { kind: 'unclear', code: 1, line: 'код 1 без строки исхода', ...base };
    if (/^похоже на секрет:/.test(first)) return { kind: 'secret', code: 1, line: first, ...base };
    if (/испорченн\S* кодировк/.test(first)) return { kind: 'encoding', code: 1, line: first, ...base };
    return { kind: 'rule', code: 1, line: first, ...base };
  }
  if (r.code === 2) return { kind: /^ошибка board:/.test(first) ? 'unclear' : 'bad-call', code: 2, line: first, ...base };
  return { kind: 'unclear', code: r.code, line: first, ...base };
}

// → {run(args) → Promise<{code, stdout, stderr, ms, timedOut?, spawnError?}>}; args — после «--as ivan --root <корень>»
export function createBoardRunner({ root, script = null, node = process.execPath, spawn = nodeSpawn, kill = killTree, timeoutMs = BOARD_TIMEOUT_MS, env = process.env }) {
  const boardJs = script ?? path.join(root, 'tools', 'board.mjs');
  const exec = (args) => new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const err = [];
    let done = false;
    let timer = null;
    let timedOut = false; // таймаут уже снимает: close от taskkill (код 1) — не исход board (EXT-112, то же правило, что в board-sync)
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ms: Date.now() - t0, ...v }); } };
    let child;
    try {
      child = spawn(node, [boardJs, '--as', 'ivan', '--root', root, ...args], { windowsHide: true, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { end({ code: null, spawnError: typeof e?.code === 'string' ? e.code : 'SPAWN' }); return; }
    timer = setTimeout(async () => {
      timedOut = true;
      try { await kill(child.pid); } catch { /* не вышло — ниже child.kill */ }
      try { child.kill(); } catch { /* уже мёртв */ }
      end({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    child.once('error', (e) => end({ code: null, spawnError: typeof e?.code === 'string' ? e.code : 'SPAWN' }));
    child.once('close', (code) => { if (!timedOut) end({ code }); });
  });
  const queue = createPlaneQueue({ run: exec });
  return { run: (args) => queue.push(args), state: queue.state };
}
