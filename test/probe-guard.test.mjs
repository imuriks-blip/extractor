// Охранник проб (EXT-65, починка): отказ из папки живой витрины и на порту 4317; рабочая копия рядом — пропуск.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveRefusal } from '../probe/guard-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('охранник: живая папка в разных написаниях — отказ', () => {
  for (const p of ['C:/projects/extractor', 'C:\\projects\\extractor', 'C:\\Projects\\Extractor', 'c:/projects/extractor/', 'C:\\projects\\extractor\\', 'c:/projects//extractor', 'C:/projects/extractor/probe/..', 'C:/projects/x/../extractor']) {
    assert.match(liveRefusal(p, 4383) ?? '', /живой витрины/, p);
  }
});

test('охранник: соседняя папка с общим началом имени — пропуск (не префикс-совпадение)', () => {
  for (const p of ['C:/projects/extractor-ext65', 'C:\\projects\\extractor-ext65\\', 'C:/projects/extractor2', 'C:/projects/extractor/../extractor-ext65', 'D:/projects/extractor']) {
    assert.equal(liveRefusal(p, 4383), null, p);
  }
});

test('охранник: порт 4317 — отказ (числом и строкой), другие порты — пропуск', () => {
  assert.match(liveRefusal('C:/projects/extractor-ext65', 4317) ?? '', /порт живой витрины/);
  assert.match(liveRefusal('C:/projects/extractor-ext65', '4317') ?? '', /порт живой витрины/);
  for (const port of [4381, 4382, 4383]) assert.equal(liveRefusal('C:/projects/extractor-ext65', port), null);
});

test('охранник: пробы вызывают его после констант, раньше любой записи', () => {
  for (const f of ['pt6-drive', 'pt6b-drive', 'pt6v-drive']) {
    const src = fs.readFileSync(path.join(HERE, '..', 'probe', `${f}.mjs`), 'utf8');
    const g = src.indexOf('guardLive(REPO, PORT)');
    assert.ok(g > 0, `${f}: вызов охранника`);
    assert.match(src, /import \{ guardLive \} from '\.\/guard-live\.mjs'/);
    const firstWrite = src.search(/writeFileSync|unlinkSync|appendFileSync|mkdtempSync|rmSync|mkdirSync/);
    assert.ok(firstWrite > g, `${f}: охранник раньше первой записи`);
  }
});

test('охранник: guardLive завершает процесс кодом 1 с сообщением (живая папка, порт 4317); из соседней копии — проходит', () => {
  const mod = JSON.stringify(new URL('../probe/guard-live.mjs', import.meta.url).href);
  const run = (root, port) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { guardLive } from ${mod}; guardLive(${JSON.stringify(root)}, ${port}); console.log('прошёл')`], { encoding: 'utf8', windowsHide: true });
  const live = run('C:\\Projects\\Extractor\\', 4383);
  assert.equal(live.status, 1); assert.match(live.stderr, /живой витрины/); assert.doesNotMatch(live.stdout, /прошёл/);
  const port = run('C:/projects/extractor-ext65', 4317);
  assert.equal(port.status, 1); assert.match(port.stderr, /порт живой витрины/);
  const ok = run('C:/projects/extractor-ext65', 4383);
  assert.equal(ok.status, 0); assert.match(ok.stdout, /прошёл/);
});
