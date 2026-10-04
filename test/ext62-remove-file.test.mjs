// EXT-62: удаление файла без fs.rmSync — на Node 24.13 под Windows rmSync молча не удаляет файл, если кириллица
// в имени файла или в имени папки на пути (замер дирижёра 04.10: и `копии\actions-….sha256`, и `Словарь.md`).
// Ожидаемое — из того, что положено в тест: файл есть до, файла нет после.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeFile } from '../lib/remove-file.mjs';
import { createBackup } from '../lib/backup.mjs';
import { tmpDir } from './helpers.mjs';

test('removeFile: кириллица в имени файла и в папке — файл удалён; нет файла — не ошибка; не файл — ошибка', () => {
  const d = tmpDir('rm-');
  const sub = path.join(d, 'копии');
  fs.mkdirSync(sub);
  const cyrName = path.join(d, 'Словарь.md');
  const cyrDir = path.join(sub, 'actions-2026-10-01.log.sha256');
  const latin = path.join(d, 'a.md');
  for (const f of [cyrName, cyrDir, latin]) fs.writeFileSync(f, 'x');
  for (const f of [cyrName, cyrDir, latin]) {
    removeFile(f);
    assert.equal(fs.existsSync(f), false, `удалён: ${path.basename(f)}`);
  }
  assert.doesNotThrow(() => removeFile(cyrName), 'второй раз — файла нет, не ошибка');
  assert.throws(() => removeFile(sub), 'папка — не файл: ошибка, а не молчание');
  assert.equal(fs.existsSync(sub), true);
});

test('копия журнала в папке с кириллицей: ротация убирает старую копию вместе с эталоном, сирот .sha256 нет', () => {
  const data = tmpDir('bk62-');
  const file = path.join(data, 'actions.log');
  const dir = path.join(data, 'копии журнала');
  const clock = { d: new Date(2026, 9, 1, 12) };
  const b = createBackup({ file, dir, keep: 2, now: () => clock.d, log: { write() {} } });
  let n = 0;
  for (let day = 1; day <= 4; day++) {
    clock.d = new Date(2026, 9, day, 12);
    fs.appendFileSync(file, JSON.stringify({ id: `W-2610${String(day).padStart(2, '0')}-120000-a00${++n}`, step: 'asked', at: clock.d.toISOString() }) + '\n');
    assert.equal(b.run().status, 'ok', `день ${day}`);
  }
  const names = fs.readdirSync(dir).sort();
  const logs = names.filter((f) => /^actions-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  const shas = names.filter((f) => f.endsWith('.sha256'));
  assert.deepEqual(logs, ['actions-2026-10-03.log', 'actions-2026-10-04.log'], 'остались две последние копии');
  assert.deepEqual(shas, ['actions-2026-10-03.log.sha256', 'actions-2026-10-04.log.sha256'], 'эталоны только у оставшихся');
});
