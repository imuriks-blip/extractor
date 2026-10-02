// Отрицательный контроль П.4: по одной отключает проверки (а)–(г) пульта (P4_OFF) и прогоняет pult.test.mjs.
// Зрячесть: при отключённой проверке X должны упасть ровно тесты с меткой «(X)» в имени, и ни один другой;
// при всех включённых — ни один. Выход 1, если не так.  node probe/p4/blind.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'pult.test.mjs');
const LABEL = { '': null, a: '(а)', b: '(б)', c: '(в)', d: '(г)' };

let bad = 0;
for (const [off, label] of Object.entries(LABEL)) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env: { ...process.env, P4_OFF: off }, encoding: 'utf8', windowsHide: true });
  const all = [...r.stdout.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map((m) => ({ ok: m[1] === 'ok', name: m[2] }));
  const failed = all.filter((t) => !t.ok).map((t) => t.name);
  const expected = label ? all.map((t) => t.name).filter((n) => n.startsWith(label)) : [];
  const same = failed.length === expected.length && failed.every((n) => expected.includes(n)) && all.length > 0;
  if (!same) bad++;
  console.log(`P4_OFF=${off || '-'}  тестов ${all.length}, красных ${failed.length}, ожидалось ${expected.length} ${label ?? '(ни одного)'} → ${same ? 'ЗРЯЧИЙ' : 'НЕ СОВПАЛО'}`);
  for (const n of failed) console.log(`    красный: ${n}`);
  for (const n of expected.filter((n) => !failed.includes(n))) console.log(`    НЕ покраснел: ${n}`);
}
process.exit(bad ? 1 : 0);
