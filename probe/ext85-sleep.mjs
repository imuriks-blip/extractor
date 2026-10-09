// EXT-85 probe: what happens to a node process of the vitrina when the machine "sleeps" (card EXT-85, takt A).
// Not part of the vitrina: server.mjs is not changed, this file is loaded next to it.
//
// Two ways to run (both write JSON lines to the file given by --ext85-out=<path>):
//   1. observer inside the vitrina (preload, the vitrina code itself is untouched):
//        node --import file:///.../probe/ext85-sleep.mjs <root>/server.mjs --console-log --ext85-out=<file>
//      server.mjs only looks for --console-log in argv, the extra flag is ignored by it.
//   2. control: a bare node process with the same observer and nothing else:
//        node probe/ext85-sleep.mjs --ext85-control --ext85-out=<file>
//
// Lines: start (pid, ppid, node version, mode); pulse every 30 s (pid, upS = process uptime, gapS = wall-clock seconds
// since the previous pulse - a sleep shows as a big gap); beforeExit; exit (code); signal (name) for SIGINT, SIGTERM,
// SIGHUP, SIGBREAK; uncaught (error name and stack frames, no message text - it may carry journal text, as in
// lib/console-log.mjs). A process killed from outside (TerminateProcess, end of the user session) writes nothing:
// its file just stops - the last pulse is the upper bound of the death time.
//
// Behaviour is kept as without the observer: the pulse timer is unref'ed in the preload (it does not keep the vitrina
// alive); for a signal that has no other listener the default action is repeated after the line (exit 128 + number),
// because a listener alone would cancel the default termination on Windows (SIGHUP, SIGBREAK, SIGINT).
import fs from 'node:fs';

const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const out = flag('ext85-out');
const control = process.argv.includes('--ext85-control');
const PULSE_MS = 30000;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGBREAK: 21, SIGTERM: 15 };

function write(kind, extra = {}) {
  if (!out) return;
  try {
    fs.appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), kind, pid: process.pid, ...extra }) + '\n');
  } catch { /* the probe must not break the process it watches */ }
}

write('start', { ppid: process.ppid, node: process.version, mode: control ? 'control' : 'preload' });

let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  write('pulse', { upS: Math.round(process.uptime()), gapS: Math.round((now - last) / 1000) });
  last = now;
}, PULSE_MS);
if (!control) timer.unref();

process.on('beforeExit', (code) => write('beforeExit', { code }));
process.on('exit', (code) => write('exit', { code, upS: Math.round(process.uptime()) }));
for (const [sig, num] of Object.entries(SIGNALS)) {
  process.on(sig, () => {
    write('signal', { signal: sig });
    if (process.listenerCount(sig) === 1) process.exit(128 + num);
  });
}
// monitor only: does not change what node does with the error (the vitrina's own handler still exits 1)
process.on('uncaughtExceptionMonitor', (e, origin) => {
  const frames = String(e?.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => l.trim());
  write('uncaught', { name: e?.name ?? typeof e, origin, frames });
});
