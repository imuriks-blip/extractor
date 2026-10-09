// EXT-85 takt B: live check of the prev-end reader (read only, no vitrina): the same code as lib/prev-end.mjs reads the
// Windows System log through wevtutil (windowsHide) for a window and prints the events and the reason.
//   node probe/ext85-prevend.mjs [<from ISO> <to ISO>]
// Default window: the night of 08.10 - from the last stats line of pid 45132 (22:23 local) to the next logon (09.10 19:26 local).
// Expected: shutdown (Winlogon 7002 and Kernel-Power 42 TargetState=6 at 22:30:41-43 local on 08.10).
import { readSystemEvents, classifyEnd } from '../lib/prev-end.mjs';

const from = Date.parse(process.argv[2] ?? '2026-10-08T22:23:00+03:00');
const to = Date.parse(process.argv[3] ?? '2026-10-09T19:26:00+03:00');
const t0 = Date.now();
try {
  const events = await readSystemEvents({ from, to });
  for (const e of events) console.log(new Date(e.at).toISOString(), e.provider, e.id, e.targetState === null ? '' : `TargetState=${e.targetState}`);
  console.log(`window ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}: ${events.length} events, ${Date.now() - t0} ms`);
  console.log('reason:', classifyEnd(events, { from, to }));
} catch (e) {
  console.log(`read failed (${e.code ?? e.message}) -> reason: unknown`);
}
