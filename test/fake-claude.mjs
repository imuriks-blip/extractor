// Подменный claude.exe для тестов замера (EXT-87): настоящий Claude в npm test не вызывается никогда.
// Запускается через node: node fake-claude.mjs <аргументы замера>. Поведение — переменная FAKE_MODE, след — файл FAKE_OUT.
//   ok       — событие лимита (5 ч 0.69, 7 дн 0.34), ответ, result со стоимостью и usage
//   hooks    — то же, но с событием hook_started
//   noevent  — только result, события лимита нет
//   nowindows — событие лимита без unifiedWindows
//   auth     — result с ошибкой входа
//   slow     — как ok, но result через 500 мс (замер «идёт»)
//   hang     — ничего не пишет и не выходит; порождает внука (его pid — в FAKE_PIDS)
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.FAKE_MODE ?? 'ok';
const out = process.env.FAKE_OUT;
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
    claudeEnv: Object.keys(process.env).filter((k) => /^CLAUDE/i.test(k)).sort(),
    settings: (() => { const i = process.argv.indexOf('--settings'); try { return JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')); } catch { return null; } })(),
  }));
}
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Number(process.env.FAKE_RESET ?? 1791331200), rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.69, resetsAt: Number(process.env.FAKE_RESET ?? 1791331200) }, seven_day: { utilization: 0.34, resetsAt: 1791810000 } } } };
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ок', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 }, ...extra });

if (mode === 'hang') {
  // FAKE_GPIPE (EXT-112): внук держит канал-метку теста (живость и уборка — по ней, не по pid); pids пишутся, когда
  // метка уже отвечает, — файл pids значит «внук был жив», и проверка «снят» не проходит даром
  const gpipe = process.env.FAKE_GPIPE;
  const code = gpipe ? `require('net').createServer((s) => { s.on('error', () => {}); s.on('data', () => process.exit(0)); s.write(String(process.pid)); }).listen(${JSON.stringify(gpipe)});` : 'setInterval(() => {}, 1000)';
  // внук отсоединён (EXT-112): иначе libuv держит его в задании родителя, и он умирает со снятием одного ребёнка —
  // проверка «снят деревом» не отличала бы taskkill /T от снятия одного процесса
  const g = spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached: true, windowsHide: true });
  const writePids = () => { if (process.env.FAKE_PIDS) fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ child: process.pid, grandchild: g.pid })); };
  if (!gpipe) writePids();
  else {
    const net = await import('node:net');
    const probe = () => { const c = net.connect(gpipe); c.once('connect', () => { c.destroy(); writePids(); }); c.once('error', () => { c.destroy(); setTimeout(probe, 50); }); };
    probe();
  }
  setInterval(() => {}, 1000);
} else if (mode === 'noevent') {
  send({ type: 'system', subtype: 'init' });
  send(result());
} else if (mode === 'auth') {
  send({ type: 'system', subtype: 'init' });
  send(result({ subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' }));
  process.exitCode = 1;
} else {
  send({ type: 'system', subtype: 'init' });
  if (mode === 'hooks') send({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' });
  send(mode === 'nowindows' ? { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } : event);
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'ок' }] } });
  if (mode === 'slow') setTimeout(() => send(result()), 500); else send(result());
}
