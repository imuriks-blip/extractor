// EXT-85: live check of the prev-end reader (read only, no vitrina): the same code as lib/prev-end.mjs reads the Windows
// System log through wevtutil (windowsHide) for the window [at, at + 15 min] and prints the events and the reason
// (shutdown - a shutdown event no later than 15 min after the end time; otherwise unknown; crash comes from console.log,
// not from this log, and is not checked here).
//   node probe/ext85-prevend.mjs [<at ISO>]
// Default at: the night of 08.10 - last stats line of pid 45132, 2026-10-08T19:23:00Z (22:23 local).
// Expected: shutdown (Winlogon 7002 and Kernel-Power 42 TargetState=6 at 19:30:41-43Z). With at 3 h earlier
// (2026-10-08T16:23:00Z) the same shutdown is out of the window: unknown.
import { readSystemEvents, classifyEnd, SHUTDOWN_WINDOW_MS } from '../lib/prev-end.mjs';

const at = Date.parse(process.argv[2] ?? '2026-10-08T19:23:00Z');
const from = at;
const to = at + SHUTDOWN_WINDOW_MS;
const t0 = Date.now();
try {
  const events = await readSystemEvents({ from, to });
  for (const e of events) console.log(new Date(e.at).toISOString(), e.provider, e.id, e.targetState === null ? '' : `TargetState=${e.targetState}`);
  console.log(`at ${new Date(at).toISOString()}, window .. ${new Date(to).toISOString()}: ${events.length} events, ${Date.now() - t0} ms`);
  console.log('reason:', classifyEnd(events, at));
} catch (e) {
  console.log(`read failed (${e.code ?? e.message}) -> reason: unknown`);
}
