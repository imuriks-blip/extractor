// Читатель журналов (спека витрины 1.2, 1.3; гейт п.3): потоковый разбор, индекс смещений в своём каталоге,
// хвосты, счётчик непонятых строк по версиям. Источник — временная копия из вырезанных строк живой формы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeFs from 'node:fs';
import { createJournalReader, indexFingerprint } from '../lib/journal-reader.mjs';
import { feedSession } from '../lib/journal-parse.mjs';
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

// ---------- правки по вердикту Голема (EXT-26, круг 1) ----------

const strip = (ss) => ss.map(({ file, ...x }) => x);

test('Критично 1: ошибка записи индекса (rename) не роняет проход — errors 1, данные целы; исправный рядом', async () => {
  const t = tree();
  const ok = reader(t.root);
  await ok.refresh();
  assert.equal(ok.state().errors, 0);
  const eperm = Object.assign(new Error('занят'), { code: 'EPERM' });
  const badFs = { ...nodeFs, renameSync: () => { throw eperm; } };
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), rules: RULES, fs: badFs });
  await assert.doesNotReject(r.refresh());
  assert.equal(r.state().errors, 1);
  assert.equal(r.state().lastError, 'EPERM');
  assert.deepEqual(strip(r.sessions()), strip(ok.sessions()), 'прежние данные целы');
});

test('Критично 1: refresh() не отклоняется ни при какой ошибке прохода (каталог источника пропал)', async () => {
  const r = reader(path.join(tmpDir('gone-'), 'нет-такого'));
  await assert.doesNotReject(r.refresh());
  assert.equal(r.state().errors, 1);
});

test('Важно 1: смена правил boardWriteTools или разбора — полный пересбор индекса; те же — только хвост', async () => {
  const t = tree();
  const indexDir = tmpDir('index-');
  const r1 = reader(t.root, indexDir);
  await r1.refresh();
  const same = reader(t.root, indexDir);
  await same.refresh();
  assert.equal(same.state().lastPassLines, 0);
  const other = createJournalReader({ root: t.root, indexDir, rules: RULES.slice(0, 1) });
  await other.refresh();
  assert.equal(other.state().lastPassLines, other.state().lines, 'правила другие — перечитано всё');
  assert.notEqual(indexFingerprint('a', RULES), indexFingerprint('b', RULES), 'отпечаток зависит от текста разбора');
  assert.equal(indexFingerprint('a\r\nb', RULES), indexFingerprint('a\nb', RULES), 'концы строк checkout не влияют');
});

test('Важно 2: поток упал посреди файла — повторный проход дочитывает, без двойного счёта', async () => {
  const t = tree();
  let fail = true;
  const flakyFs = {
    ...nodeFs,
    createReadStream: (f, o) => (async function* () {
      let i = 0;
      for await (const c of nodeFs.createReadStream(f, { ...o, highWaterMark: 4096 })) {
        if (fail && f === t.main && i++ === 2) throw Object.assign(new Error('сбой'), { code: 'EIO' });
        yield c;
      }
    })(),
  };
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), rules: RULES, fs: flakyFs });
  await r.refresh();
  assert.equal(r.state().errors, 1);
  fail = false;
  await r.refresh();
  const whole = reader(tree().root);
  await whole.refresh();
  assert.equal(r.state().lines, whole.state().lines);
  assert.deepEqual(strip(r.sessions()), strip(whole.sessions()));
});

test('Важно 2: исключение разбора на строке — строка «непонятая», проход идёт дальше и не повторяется', async () => {
  const t = tree();
  let calls = 0;
  const feeders = { session: (st, d, o) => { if (++calls === 5) throw new Error('сбой разбора'); return feedSession(st, d, o); } };
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), rules: RULES, feeders });
  await r.refresh();
  assert.equal(Object.values(r.state().unknown).reduce((a, b) => a + b, 0), 1);
  assert.equal(r.state().errors, 0);
  const n = r.state().lines;
  await r.refresh();
  assert.equal(r.state().lines, n);
  assert.ok(r.sessions()[0].runs.find((x) => x.agentId === GOLEM), 'строки после сбойной разобраны');
});

test('мелочь 3–4: тип и описание — сначала .meta.json, потом вызов Agent; .meta.json, появившийся позже, дочитывается', async () => {
  const t = tree();
  const meta = path.join(t.root, 'C--Users-imuri-Documents-Obsidian-Vault', SID, 'subagents', `agent-${GOLEM}.meta.json`);
  const saved = fs.readFileSync(meta, 'utf8');
  fs.unlinkSync(meta);
  const r = reader(t.root);
  await r.refresh();
  let run = r.sessions()[0].runs.find((x) => x.agentId === GOLEM);
  assert.equal(run.agentType, 'golem', 'без .meta.json — из вызова');
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(saved), agentType: 'golem-из-meta', description: 'описание-из-meta' }));
  await r.refresh();
  run = r.sessions()[0].runs.find((x) => x.agentId === GOLEM);
  assert.equal(run.agentType, 'golem-из-meta');
  assert.equal(run.description, 'описание-из-meta');
});

test('мелочь 6: версия непонятой строки — только вида N.N.N, иначе «?»', async () => {
  const t = tree([...MAIN, '{"type":"zzz","version":"<не версия>"}', '{"version":"x y z","type":']);
  const r = reader(t.root);
  await r.refresh();
  assert.deepEqual(r.state().unknown, { '?': 2 });
});

// ---------- решение дирижёра 02.10: индекс пишется не чаще раза в N с и при штатной остановке ----------

test('индекс: не чаще раза в интервал; «убийство» без записи и рестарт — числа как у одного прохода', async () => {
  const t = tree(MAIN.slice(0, 20));
  const indexDir = tmpDir('index-');
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const now = () => new Date(clock);
  const r1 = createJournalReader({ root: t.root, indexDir, rules: RULES, now, indexWriteEveryS: 60 });
  await r1.refresh();
  const written = fs.statSync(path.join(indexDir, 'journals.json')).mtimeMs;
  const size1 = fs.statSync(path.join(indexDir, 'journals.json')).size;
  fs.appendFileSync(t.main, MAIN.slice(20).map((l) => l + '\n').join(''));
  clock += 10000;
  await r1.refresh();
  assert.equal(fs.statSync(path.join(indexDir, 'journals.json')).size, size1, 'через 10 с индекс не переписан');
  assert.ok(written);
  // процесс «убит» без записи: r1 брошен. Рестарт дочитывает от записанного смещения.
  const r2 = createJournalReader({ root: t.root, indexDir, rules: RULES, now, indexWriteEveryS: 60 });
  await r2.refresh();
  const whole = reader(tree().root);
  await whole.refresh();
  assert.equal(r2.state().lines, whole.state().lines);
  assert.deepEqual(strip(r2.sessions()), strip(whole.sessions()));
});

test('индекс: через интервал — запись; flush() при остановке — запись сразу', async () => {
  const t = tree(MAIN.slice(0, 20));
  const indexDir = tmpDir('index-');
  const file = path.join(indexDir, 'journals.json');
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const r = createJournalReader({ root: t.root, indexDir, rules: RULES, now: () => new Date(clock), indexWriteEveryS: 60 });
  await r.refresh();
  const s1 = fs.statSync(file).size;
  fs.appendFileSync(t.main, MAIN.slice(20, 30).map((l) => l + '\n').join(''));
  clock += 61000;
  await r.refresh();
  const s2 = fs.statSync(file).size;
  assert.notEqual(s2, s1, 'через 61 с — записан');
  fs.appendFileSync(t.main, MAIN.slice(30).map((l) => l + '\n').join(''));
  clock += 1000;
  await r.refresh();
  assert.equal(fs.statSync(file).size, s2);
  r.flush();
  assert.notEqual(fs.statSync(file).size, s2, 'flush пишет сразу');
  const r2 = reader(t.root, indexDir);
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 0);
});

test('config.default.json: интервал записи индекса — настройка', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'config.default.json'), 'utf8'));
  assert.equal(c.indexWriteEveryS, 60);
});
