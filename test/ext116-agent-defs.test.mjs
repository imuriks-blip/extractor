// EXT-116 Т1, гейт п.7 (спека витрины, «EXT-116 — окно «агенты»», Р2): определения агентов — кроме maxTurns ещё model
// из шапки и признак def: файла нет (ENOENT) — def: false и запись убрана из кэша; другая ошибка stat или чтения —
// прежнее из кэша, без прежнего — def: null; имя не по правилу — null без чтения диска. Сигнатура maxTurns(name) — прежняя.
// Определения — временная папка; живые ~/.claude/agents не читаются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentDefs } from '../lib/agent-defs.mjs';
import { tmpDir } from './helpers.mjs';

// подменённый fs: настоящий диск, но stat и чтение можно заставить падать кодом; счётчик обращений
function seamFs() {
  const s = { stat: null, read: null, calls: 0 };
  const err = (code) => Object.assign(new Error(code), { code });
  s.fs = {
    statSync: (p) => { s.calls++; if (s.stat) throw err(s.stat); return fs.statSync(p); },
    readFileSync: (p, enc) => { s.calls++; if (s.read) throw err(s.read); return fs.readFileSync(p, enc); },
  };
  return s;
}
const head = (lines) => `---\n${lines.join('\n')}\n---\nтело\n`;

test('п.7 (в): model из шапки рядом с maxTurns; нет model — def: true, model: null, maxTurns как раньше', () => {
  const dir = tmpDir('defs-');
  fs.writeFileSync(path.join(dir, 'golem.md'), head(['name: golem', 'model: opus', 'maxTurns: 40']));
  fs.writeFileSync(path.join(dir, 'clap.md'), head(['name: clap', 'maxTurns: 40']));
  fs.writeFileSync(path.join(dir, 'demon.md'), '---\r\nname: demon\r\nmodel: "sonnet"\r\nmaxTurns: 60\r\n---\r\nmodel: opus\r\n');
  const defs = createAgentDefs({ dir });
  assert.deepEqual(defs.read('golem'), { def: true, maxTurns: 40, model: 'opus' });
  assert.deepEqual(defs.read('clap'), { def: true, maxTurns: 40, model: null });
  assert.deepEqual(defs.read('demon'), { def: true, maxTurns: 60, model: 'sonnet' }, 'кавычки сняты, model вне шапки не в счёт');
  assert.equal(defs('golem'), 40, 'maxTurns(name) — прежняя сигнатура');
  assert.equal(defs('clap'), 40);
});

test('п.7 (а): определение было прочитано, файл исчез (ENOENT) — def: false, maxTurns → null, запись из кэша убрана', () => {
  const dir = tmpDir('defs-');
  const f = path.join(dir, 'golem.md');
  fs.writeFileSync(f, head(['name: golem', 'model: opus', 'maxTurns: 40']));
  const s = seamFs();
  const defs = createAgentDefs({ dir, fs: s.fs });
  assert.equal(defs('golem'), 40);
  fs.unlinkSync(f);
  assert.equal(defs('golem'), null, 'прежнее из кэша не отдаётся');
  assert.deepEqual(defs.read('golem'), { def: false });
  // запись убрана: следующая ошибка не ENOENT уже не находит прежнего — «не читается», а не прежние 40
  s.stat = 'EACCES';
  assert.deepEqual(defs.read('golem'), { def: null });
  assert.equal(defs('golem'), null);
});

test('п.7 (б): ошибка stat не ENOENT после удачного чтения — прежние maxTurns и model; без прежнего — def: null', () => {
  const dir = tmpDir('defs-');
  fs.writeFileSync(path.join(dir, 'golem.md'), head(['name: golem', 'model: opus', 'maxTurns: 40']));
  fs.writeFileSync(path.join(dir, 'clap.md'), head(['name: clap', 'model: inherit', 'maxTurns: 40']));
  const s = seamFs();
  const defs = createAgentDefs({ dir, fs: s.fs });
  assert.equal(defs('golem'), 40);
  s.stat = 'EACCES';
  assert.deepEqual(defs.read('golem'), { def: true, maxTurns: 40, model: 'opus' });
  assert.equal(defs('golem'), 40);
  assert.deepEqual(defs.read('clap'), { def: null }, 'та же ошибка без прежнего');
  assert.equal(defs('clap'), null);
  // ошибка чтения (stat удался, файл сменился) — так же
  s.stat = null; s.read = 'EBUSY';
  fs.writeFileSync(path.join(dir, 'golem.md'), head(['name: golem', 'model: opus', 'maxTurns: 41']));
  fs.utimesSync(path.join(dir, 'golem.md'), new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(defs.read('golem'), { def: true, maxTurns: 40, model: 'opus' });
  assert.deepEqual(defs.read('clap'), { def: null });
});

test('п.7 (б): имя не по ^[a-z0-9-]+$ — null без чтения диска', () => {
  const s = seamFs();
  const defs = createAgentDefs({ dir: tmpDir('defs-'), fs: s.fs });
  for (const n of ['../golem', 'Golem', 'go lem', '', null, 42]) {
    assert.equal(defs.read(n), null, String(n));
    assert.equal(defs(n), null, String(n));
  }
  assert.equal(s.calls, 0, 'диск не тронут');
  // исправный: имя по правилу, файла нет — диск спрошен, def: false
  assert.deepEqual(defs.read('nobody'), { def: false });
  assert.ok(s.calls > 0);
});
