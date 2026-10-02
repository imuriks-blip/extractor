// Отрицательный контроль защиты пульта (ПТ1, EXT-39): по одной выключает проверки guard.mjs (PULT_OFF подменяет
// набор проверок в test/pult.test.mjs) и прогоняет файл. Зрячесть: при выключенной проверке X краснеет хотя бы
// один тест с меткой «[X]» в имени; при всех включённых — ни один. Выход 1, если не так.  node test/pult-blind.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from '../lib/pult/guard.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pult.test.mjs');
let bad = 0;
for (const off of ['', ...CHECKS.map((c) => c.name)]) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env: { ...process.env, PULT_OFF: off }, encoding: 'utf8', windowsHide: true });
  const all = [...r.stdout.matchAll(/^# Subtest: (.+)$|^(not ok|ok) \d+ - (.+)$/gm)].filter((m) => m[2]).map((m) => ({ ok: m[2] === 'ok', name: m[3] }));
  const failed = all.filter((t) => !t.ok).map((t) => t.name);
  const own = failed.filter((n) => n.startsWith(`[${off}]`));
  const good = all.length > 0 && (off ? own.length > 0 : failed.length === 0);
  if (!good) bad++;
  console.log(`PULT_OFF=${off || '-'}  тестов ${all.length}, красных ${failed.length} (своих [${off || '-'}]: ${own.length}) → ${good ? 'ЗРЯЧИЙ' : 'СЛЕПОЙ'}`);
  for (const n of failed) console.log(`    красный: ${n}`);
}
process.exit(bad ? 1 : 0);
