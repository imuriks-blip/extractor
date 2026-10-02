// В3 (EXT-27): десктопный индекс и определения агентов — на временных каталогах живой формы
// (local_<id>.json на глубине 3 от корня, как в %APPDATA%\Claude\claude-code-sessions; шапка агента с maxTurns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDesktopIndex } from '../lib/desktop-index.mjs';
import { createAgentDefs } from '../lib/agent-defs.mjs';
import { tmpDir } from './helpers.mjs';

function deskRoot(title, mtime) {
  const root = tmpDir('desk-');
  const d = path.join(root, 'u1', 'o1');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'local_h1.json');
  fs.writeFileSync(f, JSON.stringify({ sessionId: 'local_h1', cliSessionId: 'c1', title, lastActivityAt: 1, isArchived: false, priorCliSessionIds: ['p1'], cwd: 'x', model: 'y' }));
  fs.utimesSync(f, mtime, mtime);
  fs.writeFileSync(path.join(d, 'other.json'), '{}');
  return root;
}

test('десктопный индекс: local_*.json на глубине 3, нужные поля; запись в двух корнях — более свежая по mtime', () => {
  const ix = createDesktopIndex({ roots: [deskRoot('EXT · старое', new Date('2026-10-01')), deskRoot('EXT · новое', new Date('2026-10-02')), path.join(tmpDir('none-'), 'нет')] });
  ix.refresh();
  assert.deepEqual(ix.get('local_h1'), { sessionId: 'local_h1', cliSessionId: 'c1', title: 'EXT · новое', lastActivityAt: 1, isArchived: false, priorCliSessionIds: ['p1'] });
  assert.equal(ix.get('local_zz'), null);
  assert.equal(ix.state().files, 2);
  assert.equal(ix.state().errors, 0, 'несуществующий корень — не ошибка (MSIX может не быть)');
});

test('определения агентов: maxTurns из шапки; нет файла или поля — null; имя с путём не читается', () => {
  const dir = tmpDir('agents-');
  fs.writeFileSync(path.join(dir, 'golem.md'), '---\r\nname: golem\r\nmaxTurns: 40\r\n---\r\nтело maxTurns: 99\r\n');
  fs.writeFileSync(path.join(dir, 'clap.md'), '---\nname: clap\n---\nmaxTurns: 40\n');
  const maxTurns = createAgentDefs({ dir });
  assert.equal(maxTurns('golem'), 40);
  assert.equal(maxTurns('clap'), null, 'maxTurns вне шапки не в счёт');
  assert.equal(maxTurns('nobody'), null);
  assert.equal(maxTurns('../golem'), null);
});
