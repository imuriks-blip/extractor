// Читатель журналов (спека витрины 1.2, 1.3; гейт п.3): потоковый разбор, индекс смещений в своём каталоге,
// хвосты, счётчик непонятых строк по версиям. Источник — временная копия из вырезанных строк живой формы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const SID = '2fea3135-c7db-442b-9907-4d619949881d';
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'config.default.json'), 'utf8')).boardWriteTools;
const MAIN = fs.readFileSync(path.join(FX, `${SID}.jsonl`), 'utf8').split('\n').filter(Boolean);
const GOLEM = 'a42239d892036e800';

// Копия дерева ~/.claude/projects: <проект>/<сессия>.jsonl и <сессия>/subagents/agent-<id>.{jsonl,meta.json}
function tree(mainLines = MAIN) {
  const root = tmpDir('journals-');
  const proj = path.join(root, 'C--Users-imuri-Documents-Obsidian-Vault');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), mainLines.map((l) => l + '\n').join(''));
  for (const f of fs.readdirSync(path.join(FX, SID, 'subagents'))) fs.copyFileSync(path.join(FX, SID, 'subagents', f), path.join(proj, SID, 'subagents', f));
  return { root, main: path.join(proj, `${SID}.jsonl`) };
}
const reader = (root, indexDir = tmpDir('index-')) => createJournalReader({ root, indexDir, rules: RULES });
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out[p] = `${s.size}:${s.mtimeMs}`; } } };
  walk(dir);
  return out;
};

test('гейт п.3: незнакомый тип строки и битая JSON-строка — экран жив, непонятых +2, версия названа', async () => {
  const healthy = tree();
  const r0 = reader(healthy.root);
  await r0.refresh();
  assert.deepEqual(r0.state().unknown, {}, 'исправный случай: все строки вырезки понятны');
  const broken = tree([...MAIN.slice(0, 20), '{"type":"zzz-new-form","version":"9.9.9","sessionId":"x"}', '{"type":"user","version":"9.9.9","message":{"role":"us', ...MAIN.slice(20)]);
  const r = reader(broken.root);
  await r.refresh();
  assert.deepEqual(r.state().unknown, { '9.9.9': 2 });
  assert.equal(r.state().errors, 0);
  assert.ok(r.state().lastOkAt);
  const s = r.sessions().find((x) => x.sessionId === SID);
  assert.ok(s.runs.find((x) => x.agentId === GOLEM), 'данные после битых строк разобраны');
});

test('1.5 + 2.2: запуск соединён с журналом субагента — ходы по заходам, тип, живость', async () => {
  const t = tree();
  const r = reader(t.root);
  await r.refresh();
  const run = r.sessions().find((x) => x.sessionId === SID).runs.find((x) => x.agentId === GOLEM);
  assert.equal(run.agentType, 'golem');
  assert.deepEqual(run.zakhods, [3, 1, 2]);
  assert.equal(run.turns, 6);
  assert.equal(run.continuations, 2);
  assert.equal(run.alive, false);
  assert.equal(r.state().runsOpen, 0);
});

test('хвост: незаконченная строка не читается, дописанная — читается один раз; итог как у прохода целиком', async () => {
  const t = tree(MAIN.slice(0, 14));
  const r = reader(t.root);
  await r.refresh();
  const golemAfterSend = MAIN.slice(14, 19);
  const rest = MAIN.slice(19);
  // дописываем продолжение без итога и половину следующей строки
  fs.appendFileSync(t.main, golemAfterSend.map((l) => l + '\n').join('') + rest[0].slice(0, 40));
  await r.refresh();
  let run = r.sessions()[0].runs.find((x) => x.agentId === GOLEM);
  assert.equal(run.alive, true, 'продолжение без итога — живой');
  assert.equal(r.state().runsOpen, 1);
  const linesBefore = r.state().lines;
  fs.appendFileSync(t.main, rest[0].slice(40) + '\n' + rest.slice(1).map((l) => l + '\n').join(''));
  await r.refresh();
  assert.equal(r.state().lines - linesBefore, rest.length, 'дочитан только хвост');
  run = r.sessions()[0].runs.find((x) => x.agentId === GOLEM);
  assert.equal(run.alive, false);
  const whole = reader(tree().root);
  await whole.refresh();
  const strip = (ss) => ss.map(({ file, ...x }) => x);
  assert.deepEqual(strip(r.sessions()), strip(whole.sessions()));
});

test('индекс смещений: новый процесс с тем же индексом читает только новый хвост', async () => {
  const t = tree();
  const indexDir = tmpDir('index-');
  const r1 = reader(t.root, indexDir);
  await r1.refresh();
  assert.ok(fs.readdirSync(indexDir).length > 0, 'индекс записан');
  const r2 = reader(t.root, indexDir);
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 0, 'после рестарта — ничего не перечитано');
  assert.deepEqual(r2.sessions().map(({ file, ...x }) => x), r1.sessions().map(({ file, ...x }) => x));
  fs.appendFileSync(t.main, MAIN[2] + '\n');
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 1);
  // отрицательный контроль: без индекса (новый каталог) проход читает всё
  const r3 = reader(t.root, tmpDir('index-'));
  await r3.refresh();
  assert.equal(r3.state().lastPassLines, r2.state().lines);
  assert.equal(r2.state().lines, MAIN.length + 1 + 28 + 23); // вырезки: дирижёр + 1 дописанная, Голем 28, Бальд 23
});

test('файл стал короче (переписан) — разбор с начала, без двойного счёта', async () => {
  const t = tree();
  const r = reader(t.root);
  await r.refresh();
  fs.writeFileSync(t.main, MAIN.slice(0, 13).map((l) => l + '\n').join(''));
  await r.refresh();
  const s = r.sessions().find((x) => x.sessionId === SID);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].alive, true);
});

test('журналы только читаются: дерево источника после прохода не изменилось', async () => {
  const t = tree();
  const before = snapshot(t.root);
  const r = reader(t.root);
  await r.refresh();
  await r.refresh();
  assert.deepEqual(snapshot(t.root), before);
});
