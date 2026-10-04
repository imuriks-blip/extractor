// EXT-60: жёлтая пометка «Общий файл» — два треда правят один файл в окне thresholds.collisionWindowH. Правка — вызов
// Edit / MultiEdit / Write / NotebookEdit с tool_result без ошибки (журнал треда или его субагентов); пара — по пути
// после нормализации; пометка — каждому живому участнику. Журналы подставные, во временной папке; время — NOW.
// Ожидаемые значения — из спеки и из того, что положено в журнал, а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createJournalReader, indexFingerprint } from '../lib/journal-reader.mjs';
import { newSessionState, feedSession, normPath, editKey, EDIT_KEEP_MS, EDIT_RESERVE_MS, EDIT_WINDOW_H } from '../lib/journal-parse.mjs';
import { buildWorkers, buildMarks, shortRootsOf, COLLISION_IGNORE } from '../lib/waiting.mjs';
import { isRedMark } from '../lib/threads.mjs';
import { loadConfig } from '../lib/config.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const H = 3600000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'C--projects-app';

// ---------- подставные журналы ----------

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const call = (sid, id, tool, input, time, extra = {}) => JSON.stringify({ type: 'assistant', uuid: uid(), sessionId: sid, timestamp: time, ...extra,
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool, input }] } });
const result = (sid, id, time, { error = false, extra = {} } = {}) => JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time, ...extra,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'Error: файл не найден' : 'ok', ...(error ? { is_error: true } : {}) }] } });
// правка с результатом: ok (по умолчанию) или с ошибкой
function edit(sid, n, tool, file, time, opts = {}) {
  const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  // id вызова уникален, как у настоящих tool_use id: одинаковый id в двух сессиях — копия строки (ключ копии, EXT-60)
  const id = `t${n}-${sid.slice(0, 8)}`;
  return [call(sid, id, tool, { [field]: file }, time, opts.callExtra), result(sid, id, time, opts)];
}
const title = (sid, text) => JSON.stringify({ type: 'custom-title', sessionId: sid, customTitle: text });
// запуск субагента: вызов Agent и результат с agentId (тогда журнал субагента привязан к запуску сессии)
const launch = (sid, aid, time) => [
  call(sid, `L-${aid}`, 'Agent', { subagent_type: 'terminus', description: 'правка', prompt: 'сделай' }, time),
  JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time, toolUseResult: { agentId: aid, status: 'async_launched' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `L-${aid}`, content: `agentId: ${aid}` }] } }),
];

// дерево ~/.claude/projects: <проект>/<сессия>.jsonl и <сессия>/subagents/agent-<id>.jsonl; journals: { sid: [строки], 'sid/agent': [строки] }
function tree(journals) {
  const root = tmpDir('collisions-');
  const proj = path.join(root, PROJECT);
  fs.mkdirSync(proj, { recursive: true });
  for (const [k, ls] of Object.entries(journals)) {
    const [sid, aid] = k.split('/');
    const file = aid ? path.join(proj, sid, 'subagents', `agent-${aid}.jsonl`) : path.join(proj, `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ls.map((l) => l + '\n').join(''));
  }
  return { root, file: (sid) => path.join(proj, `${sid}.jsonl`), agent: (sid, aid) => path.join(proj, sid, 'subagents', `agent-${aid}.jsonl`) };
}
const mkReader = (root, extra = {}) => createJournalReader({ root, indexDir: tmpDir('index-'), ...extra });

const proc = (sid, name) => ({ pid: Number(sid[0]), sessionId: sid, name, live: true, startedAt: NOW - 20 * H, status: 'busy', observedAt: NOW, statusUpdatedAt: NOW });
const board = { hasCard: () => false, card: () => null, hasCode: (c) => c === 'EXT', hasBoard: true };
// живые треды названы кодом проекта (правило (1) проекта) — пометка «Старые правила» не мешает: момента правил нет
async function workers(t, { procs = [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')], thresholds = {}, collisions = null, shortRoots = [], reader = null } = {}) {
  const r = reader ?? mkReader(t.root);
  await r.refresh();
  return buildWorkers({ procs, sessions: r.sessions(), board, now: NOW, thresholds, collisions, shortRoots });
}
const marksOf = (w, sid) => w.threads.find((x) => x.sessionId === sid)?.marks ?? [];
const collisions = (w, sid) => marksOf(w, sid).filter((m) => m.kind === 'collision');

const FILE = 'C:\\projects\\app\\src\\main.js';

// ---------- нормализация ----------

test('normPath: абсолютный путь, «.» и «..» раскрыты, разделитель «/»; Windows — через win32, относительный — null', () => {
  assert.equal(normPath('C:\\a\\..\\b\\.\\c.txt'), 'C:/b/c.txt');
  assert.equal(normPath('c:/A//B/./x.JS'), 'c:/A/B/x.JS');
  assert.equal(normPath('\\\\srv\\share\\d\\..\\x.md'), '//srv/share/x.md');
  assert.equal(normPath('/home/u/../v/x.js'), '/home/v/x.js');
  for (const bad of ['src/x.js', './x.js', '', null, undefined, 42, 'C:x.js']) assert.equal(normPath(bad), null, String(bad));
  assert.equal(editKey(normPath('C:\\Proj\\X.JS')), editKey(normPath('c:/proj/./x.js')));
});

// ---------- разбор: что считается правкой ----------

const feedAll = (lines, opts) => { const st = newSessionState(); for (const l of lines) feedSession(st, JSON.parse(l), opts); return st; };
const editsIn = (st) => Object.values(st.edits ?? {}).map((e) => [e.p, e.at]);

test('разбор: Edit, MultiEdit, Write, NotebookEdit — правка по времени строки вызова; Bash и Read — нет', () => {
  const ls = [
    ...edit(A, 1, 'Edit', 'C:\\p\\a.js', at(5 * H)),
    ...edit(A, 2, 'MultiEdit', 'C:\\p\\b.js', at(4 * H)),
    ...edit(A, 3, 'Write', 'C:\\p\\c.js', at(3 * H)),
    ...edit(A, 4, 'NotebookEdit', 'C:\\p\\d.ipynb', at(2 * H)),
    ...[call(A, 't5', 'Bash', { command: 'echo 1 > C:\\p\\e.js' }, at(H)), result(A, 't5', at(H))],
    ...[call(A, 't6', 'Read', { file_path: 'C:\\p\\f.js' }, at(H)), result(A, 't6', at(H))],
  ];
  assert.deepEqual(editsIn(feedAll(ls)).sort(), [['C:/p/a.js', at(5 * H)], ['C:/p/b.js', at(4 * H)], ['C:/p/c.js', at(3 * H)], ['C:/p/d.ipynb', at(2 * H)]]);
});

test('разбор: результат с ошибкой, вызов без результата, результат до вызова — не правка', () => {
  const ls = [
    ...edit(A, 1, 'Edit', 'C:\\p\\err.js', at(5 * H), { error: true }),
    call(A, 't2', 'Write', { file_path: 'C:\\p\\interrupted.js' }, at(4 * H)), // результата нет вовсе
    result(A, 't3', at(3 * H)), // результат чужого вызова
    ...edit(A, 4, 'Edit', 'C:\\p\\ok.js', at(2 * H)),
  ];
  assert.deepEqual(editsIn(feedAll(ls)), [['C:/p/ok.js', at(2 * H)]]);
});

test('разбор: один путь в разных видах — одна запись с последним временем; повтор цепочки (uuid) не двоит', () => {
  const ls = [...edit(A, 1, 'Edit', 'C:\\P\\X.js', at(6 * H)), ...edit(A, 2, 'Write', 'c:/p/./x.JS', at(2 * H))];
  const st = feedAll([...ls, ...ls]);
  assert.deepEqual(editsIn(st), [['c:/p/x.JS', at(2 * H)]]);
});

test('разбор: хранятся правки не старше срока (окно + запас) от самой поздней правки журнала; срок — EDIT_KEEP_MS', () => {
  assert.equal(EDIT_KEEP_MS, EDIT_WINDOW_H * H + EDIT_RESERVE_MS);
  const ls = [...edit(A, 1, 'Edit', 'C:\\p\\old.js', at(30 * H)), ...edit(A, 2, 'Edit', 'C:\\p\\mid.js', at(14 * H)), ...edit(A, 3, 'Edit', 'C:\\p\\new.js', at(1 * H))];
  assert.deepEqual(editsIn(feedAll(ls)).map((e) => e[0]).sort(), ['C:/p/mid.js', 'C:/p/new.js'], 'по умолчанию 13 ч: 30 ч назад — уже нет, 14 ч назад — ещё в пределах от последней правки (13 ч)');
  assert.deepEqual(editsIn(feedAll(ls, { editKeepMs: 2 * H })).map((e) => e[0]), ['C:/p/new.js'], 'срок из настройки');
});

// ---------- пометка ----------

test('два треда правят один файл (Edit и Write) в окне → у каждого живого пометка с другим тредом; форма — по спеке', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)), [B]: edit(B, 1, 'Write', FILE.toLowerCase().replace(/\\/g, '/'), at(1 * H)) });
  const w = await workers(t, { shortRoots: ['C:\\projects\\app'] });
  const a = collisions(w, A);
  const b = collisions(w, B);
  assert.deepEqual(a, [{
    kind: 'collision', other: { sessionId: B, title: 'EXT · второй', closed: false },
    files: [{ path: 'c:/projects/app/src/main.js', short: 'src/main.js', mineAt: at(3 * H), otherAt: at(1 * H) }], at: at(1 * H),
  }]);
  assert.deepEqual(b, [{
    kind: 'collision', other: { sessionId: A, title: 'EXT · первый', closed: false },
    files: [{ path: 'c:/projects/app/src/main.js', short: 'src/main.js', mineAt: at(1 * H), otherAt: at(3 * H) }], at: at(1 * H),
  }]);
  assert.equal('more' in a[0], false, 'поля more нет, пока файлов не больше пяти');
});

test('исправный случай: разные файлы — пометок нет', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', 'C:\\projects\\app\\a.js', at(H)), [B]: edit(B, 1, 'Edit', 'C:\\projects\\app\\b.js', at(H)) });
  const w = await workers(t);
  assert.deepEqual(marksOf(w, A), []);
  assert.deepEqual(marksOf(w, B), []);
});

test('один тред и его субагент правят один файл → пометки нет (один владелец); правка субагента чужого файла — столкновение владельца', async () => {
  const t = tree({
    [A]: [...launch(A, 'aaa1', at(5 * H)), ...edit(A, 1, 'Edit', FILE, at(4 * H))],
    [`${A}/aaa1`]: edit(A, 1, 'Write', FILE, at(2 * H)),
  });
  const alone = await workers(t, { procs: [proc(A, 'EXT · первый')] });
  assert.deepEqual(marksOf(alone, A), [], 'владелец один — столкновения нет');
  // второй тред правит тот файл, который трогал только субагент первого: правка субагента — правка владельца
  const t2 = tree({
    [A]: launch(A, 'aaa1', at(5 * H)),
    [`${A}/aaa1`]: edit(A, 1, 'Write', FILE, at(2 * H)),
    [B]: edit(B, 1, 'Edit', FILE, at(1 * H)),
  });
  const w = await workers(t2);
  assert.equal(collisions(w, A).length, 1);
  assert.equal(collisions(w, A)[0].other.sessionId, B);
  assert.equal(collisions(w, A)[0].files[0].mineAt, at(2 * H), 'время — правки субагента');
  assert.equal(collisions(w, B).length, 1);
});

test('правки субагента второго треда тоже его: A и субагент B правят один файл → столкновение A с B', async () => {
  const t = tree({
    [A]: edit(A, 1, 'Edit', FILE, at(2 * H)),
    [B]: launch(B, 'bbb1', at(5 * H)),
    [`${B}/bbb1`]: edit(B, 1, 'Edit', FILE, at(H)),
  });
  const w = await workers(t);
  assert.equal(collisions(w, A)[0]?.other.sessionId, B);
  assert.equal(collisions(w, B)[0]?.other.sessionId, A);
});

test('регистр и разделители одного пути — столкновение; рабочая копия (другой корень) — нет', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', 'C:\\Projects\\App\\src\\Main.js', at(2 * H)), [B]: edit(B, 1, 'Edit', 'c:/projects/APP/./src/../src/main.JS', at(H)) });
  const w = await workers(t);
  assert.equal(collisions(w, A).length, 1);
  assert.equal(collisions(w, A)[0].files.length, 1);
  const copy = tree({ [A]: edit(A, 1, 'Edit', 'C:\\projects\\app\\src\\main.js', at(2 * H)), [B]: edit(B, 1, 'Edit', 'C:\\projects\\app-wt\\src\\main.js', at(H)) });
  const w2 = await workers(copy);
  assert.deepEqual(marksOf(w2, A), []);
  assert.deepEqual(marksOf(w2, B), []);
});

test('правка с ошибкой в tool_result не считается: столкновения нет; без результата — тоже', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(2 * H)), [B]: edit(B, 1, 'Edit', FILE, at(H), { error: true }) });
  const w = await workers(t);
  assert.deepEqual(marksOf(w, A), []);
  assert.deepEqual(marksOf(w, B), []);
  const noResult = tree({ [A]: edit(A, 1, 'Edit', FILE, at(2 * H)), [B]: [call(B, 't1', 'Edit', { file_path: FILE }, at(H))] });
  const w2 = await workers(noResult);
  assert.deepEqual(marksOf(w2, A), []);
});

test('окно: правка старше collisionWindowH — пометки нет; граница (ровно окно) — есть; окно из настройки', async () => {
  const mk = (ageA, ageB) => tree({ [A]: edit(A, 1, 'Edit', FILE, at(ageA)), [B]: edit(B, 1, 'Edit', FILE, at(ageB)) });
  // 12 ч по умолчанию: ровно 12 ч назад ещё считается, на миллисекунду старше — нет
  assert.equal(collisions(await workers(mk(12 * H, H)), A).length, 1, 'ровно на границе');
  assert.equal(collisions(await workers(mk(12 * H + 1, H)), A).length, 0, 'на мс старше окна (тред A)');
  assert.equal(collisions(await workers(mk(H, 12 * H + 1)), A).length, 0, 'на мс старше окна (тред B)');
  assert.equal(collisions(await workers(mk(H, 12 * H + 1)), B).length, 0, 'у второго участника — то же');
  // настройка окна: 3 ч — правка 4 ч назад уже не считается; 24 ч — правка 20 ч назад считается
  assert.equal(collisions(await workers(mk(4 * H, H), { thresholds: { collisionWindowH: 3 } }), A).length, 0);
  assert.equal(collisions(await workers(mk(20 * H, H), { thresholds: { collisionWindowH: 24 }, reader: mkReader(mk(20 * H, H).root, { editKeepMs: 24 * H + EDIT_RESERVE_MS }) }), A).length, 1);
  // пометка снимается сама: те же правки, часы ушли вперёд
  const t = mk(2 * H, H);
  const r = mkReader(t.root);
  await r.refresh();
  const later = (hours) => buildWorkers({ procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')], sessions: r.sessions(), board, now: NOW + hours * H });
  assert.equal(collisions(later(0), A).length, 1);
  assert.equal(collisions(later(10), A).length, 1, 'через 10 ч правке A ровно 12 ч — граница, ещё считается');
  assert.equal(collisions(later(11), A).length, 0, 'через 11 ч правке A 13 ч — старше окна, пометка снялась сама');
});

test('ignore по умолчанию: Temp\\claude и .claude\\projects не считаются; свой ignore в config заменяет умолчание целиком', async () => {
  const tmp = 'C:\\Users\\imuri\\AppData\\Local\\Temp\\claude\\task\\out.txt';
  const proj = 'C:\\Users\\imuri\\.claude\\projects\\x\\memory.md';
  const gen = 'C:\\projects\\app\\generated\\g.js';
  const t = tree({
    [A]: [...edit(A, 1, 'Write', tmp, at(2 * H)), ...edit(A, 2, 'Write', proj, at(2 * H)), ...edit(A, 3, 'Write', gen, at(2 * H))],
    [B]: [...edit(B, 1, 'Write', tmp.toLowerCase().replace(/\\/g, '/'), at(H)), ...edit(B, 2, 'Write', proj, at(H)), ...edit(B, 3, 'Write', gen, at(H))],
  });
  const byDefault = await workers(t);
  assert.deepEqual(collisions(byDefault, A)[0].files.map((f) => f.path), [normPath(gen)], 'остались только generated: оба служебных пути — в ignore');
  // свой список: только «\\generated\\» — умолчание заменено, Temp\\claude и .claude\\projects снова считаются
  const own = await workers(t, { collisions: { ignore: ['\\generated\\'] } });
  // путь показывается как в более поздней правке пары (у B он записан строчными)
  assert.deepEqual(collisions(own, A)[0].files.map((f) => f.path.toLowerCase()).sort(), [normPath(proj), normPath(tmp)].map((x) => x.toLowerCase()).sort());
  // пустая строка в списке не выключает все пути
  const blank = await workers(t, { collisions: { ignore: ['', '/generated/'] } });
  assert.equal(collisions(blank, A)[0].files.length, 2);
  // не массив — умолчание
  assert.deepEqual(collisions(await workers(t, { collisions: { ignore: 'generated' } }), A)[0].files.map((f) => f.path), [normPath(gen)]);
  assert.deepEqual(COLLISION_IGNORE, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8')).collisions.ignore, 'умолчание в коде и в config.default.json одно');
});

test('второй тред закрыт → пометка у живого, other.closed true, название — custom-title журнала; у закрытого пометок нет', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(2 * H)), [C]: [title(C, 'Закрытый тред'), ...edit(C, 1, 'Edit', FILE, at(H))] });
  const w = await workers(t, { procs: [proc(A, 'EXT · первый')] });
  assert.deepEqual(collisions(w, A), [{
    kind: 'collision', other: { sessionId: C, title: 'Закрытый тред', closed: true },
    files: [{ path: normPath(FILE), short: normPath(FILE), mineAt: at(2 * H), otherAt: at(H) }], at: at(H),
  }]);
  assert.equal(w.threads.length, 1);
  assert.deepEqual(w.closed.flatMap((c) => c.marks.filter((m) => m.kind === 'collision')), [], 'на закрытом треде пометка не ставится');
});

test('закрытые треды между собой пометок не дают', async () => {
  const t = tree({ [B]: edit(B, 1, 'Edit', FILE, at(2 * H)), [C]: edit(C, 1, 'Edit', FILE, at(H)) });
  const w = await workers(t, { procs: [proc(A, 'EXT · первый')] });
  assert.deepEqual(w.threads.flatMap((x) => x.marks), []);
});

test('7 общих файлов с одним тредом → одна пометка: files 5 (самые свежие), more 2, at — самое позднее', async () => {
  const files = Array.from({ length: 7 }, (_, i) => `C:\\projects\\app\\f${i + 1}.js`);
  const t = tree({
    [A]: files.flatMap((f, i) => edit(A, i + 1, 'Edit', f, at((9 - i) * H))),
    [B]: files.flatMap((f, i) => edit(B, i + 1, 'Edit', f, at((8 - i) * H))),
  });
  const w = await workers(t, { shortRoots: ['C:/projects/app'] });
  const m = collisions(w, A);
  assert.equal(m.length, 1, 'одна пометка на пару');
  assert.equal(m[0].files.length, 5);
  assert.equal(m[0].more, 2);
  assert.deepEqual(m[0].files.map((f) => f.short), ['f7.js', 'f6.js', 'f5.js', 'f4.js', 'f3.js']);
  assert.equal(m[0].at, at(2 * H), 'самое позднее из времён пары: f7 у B — 2 ч назад');
  // 5 файлов ровно — more нет
  const five = tree({ [A]: files.slice(0, 5).flatMap((f, i) => edit(A, i + 1, 'Edit', f, at(3 * H))), [B]: files.slice(0, 5).flatMap((f, i) => edit(B, i + 1, 'Edit', f, at(2 * H))) });
  const m5 = collisions(await workers(five), A);
  assert.equal(m5[0].files.length, 5);
  assert.equal('more' in m5[0], false);
});

test('три живых треда на одном файле: каждому — по пометке на каждую пару (две), по времени пары, при равенстве — по sessionId', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)), [B]: edit(B, 1, 'Edit', FILE, at(2 * H)), [C]: edit(C, 1, 'Edit', FILE, at(H)) });
  const w = await workers(t, { procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй'), proc(C, 'EXT · третий')] });
  assert.deepEqual(collisions(w, A).map((m) => m.other.sessionId), [C, B]);
  assert.deepEqual(collisions(w, B).map((m) => m.other.sessionId), [C, A]);
  // у C своя правка — самая поздняя в обеих парах (at равны): порядок — по sessionId
  assert.deepEqual(collisions(w, C).map((m) => m.other.sessionId), [A, B]);
});

test('прежняя сессия живого десктопного треда — тот же тред: сам с собой не сталкивается', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)), [C]: edit(C, 1, 'Edit', FILE, at(H)) });
  const r = mkReader(t.root);
  await r.refresh();
  const w = buildWorkers({ procs: [{ ...proc(A, 'EXT · первый'), hostSessionId: 'local_a' }], desktop: (h) => (h === 'local_a' ? { title: 'EXT · рабочий', priorCliSessionIds: [C] } : null), sessions: r.sessions(), board, now: NOW });
  assert.deepEqual(marksOf(w, A), [], 'C — прежняя сессия треда A: один тред');
});

test('название живого другого треда — десктопное, если есть', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(2 * H)), [B]: edit(B, 1, 'Edit', FILE, at(H)) });
  const r = mkReader(t.root);
  await r.refresh();
  const w = buildWorkers({ procs: [proc(A, 'EXT · первый'), { ...proc(B, 'имя процесса'), hostSessionId: 'local_b' }], desktop: (h) => (h === 'local_b' ? { title: 'EXT · десктоп Б' } : null), sessions: r.sessions(), board, now: NOW });
  assert.equal(collisions(w, A)[0].other.title, 'EXT · десктоп Б');
});

// ---------- short ----------

test('short: от корня репозитория кода или общего, от vault_root; самый длинный корень; иначе полный путь', async () => {
  const reg = { codes: [{ code: 'EXT', repos: ['C:\\projects\\app'] }], sharedRepos: ['C:/projects'], vaultRoot: 'C:\\Users\\imuri\\Vault\\' };
  const roots = shortRootsOf(reg);
  assert.deepEqual(roots, ['C:\\projects\\app', 'C:/projects', 'C:\\Users\\imuri\\Vault\\']);
  const files = ['C:\\projects\\app\\lib\\x.mjs', 'C:\\projects\\other\\y.md', 'C:\\Users\\imuri\\Vault\\unorbis\\z.md', 'D:\\elsewhere\\w.txt', 'C:\\projects\\appendix\\q.txt'];
  const t = tree({ [A]: files.flatMap((f, i) => edit(A, i + 1, 'Edit', f, at(2 * H))), [B]: files.flatMap((f, i) => edit(B, i + 1, 'Edit', f, at(H))) });
  const m = collisions(await workers(t, { shortRoots: roots }), A)[0];
  const short = Object.fromEntries(m.files.map((f) => [f.path, f.short]));
  assert.deepEqual(short, {
    'C:/projects/app/lib/x.mjs': 'lib/x.mjs', // корень app длиннее общего C:/projects
    'C:/projects/other/y.md': 'other/y.md',
    'C:/Users/imuri/Vault/unorbis/z.md': 'unorbis/z.md',
    'D:/elsewhere/w.txt': 'D:/elsewhere/w.txt', // корня нет — полный путь
    'C:/projects/appendix/q.txt': 'appendix/q.txt', // «app» — не корень для «appendix»: общий C:/projects
  });
});

// ---------- ответ /api/ceh: доска, реестр, приложение ----------

// list — что отдаёт threads.list() (итог buildWorkers); ответ /api/ceh разобранным JSON и сырой текст
async function cehOf(list) {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека' }] });
  gitInitCommit(dir);
  const bd = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await bd.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const threads = { list: () => list(bd), state: () => ({ processes: null, desktop: null }) };
  const app = await buildApp({ port: 4317, board: bd, registry: createRegistryReader(regFile), threads, scan });
  const res = await app.inject({ method: 'GET', url: '/api/ceh', headers: { host: '127.0.0.1:4317' } });
  return { json: res.json(), body: res.body };
}

// ---------- не красная ----------

test('пометка жёлтая: isRedMark ложь, тред не поднимается, счётчик красных пометок /api/ceh (marksCount) её не считает', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(2 * H)), [B]: edit(B, 1, 'Edit', FILE, at(H)) });
  const w = await workers(t, { procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')] });
  assert.equal(collisions(w, A).length, 1);
  assert.equal(collisions(w, A).every((m) => !isRedMark(m)), true);
  // настоящий marksCount (lib/ceh.mjs через /api/ceh): две жёлтые пометки — 0; добавленная красная — 1 (счётчик живой)
  const yellow = await cehOf(() => w);
  assert.equal(yellow.json.workers.threads.flatMap((x) => x.marks).filter((m) => m.kind === 'collision').length, 2);
  assert.equal(yellow.json.workers.marksCount, 0, 'жёлтая «Общий файл» в счётчик не входит');
  const withRed = { ...w, threads: w.threads.map((x) => (x.sessionId === A ? { ...x, marks: [...x.marks, { kind: 'oldRules', at: at(H) }] } : x)) };
  assert.equal((await cehOf(() => withRed)).json.workers.marksCount, 1, 'красная — входит');
  assert.equal(isRedMark({ kind: 'collision' }), false);
  assert.equal(isRedMark({ kind: 'oldRules' }), true, 'прежние пометки красные, как были');
  assert.equal(isRedMark({ kind: 'takt', level: 'yellow' }), false);
  // порядок тредов: у обоих пометка, но она не красная — идут по состоянию и времени (как без пометки)
  const plain = await workers(tree({ [A]: edit(A, 1, 'Edit', 'C:\\x\\a.js', at(2 * H)), [B]: edit(B, 1, 'Edit', 'C:\\x\\b.js', at(H)) }));
  assert.deepEqual(w.threads.map((x) => x.sessionId), plain.threads.map((x) => x.sessionId));
  assert.equal(w.waiting.count, plain.waiting.count, 'в «Ждёт меня» не входит');
});

// ---------- хвост, индекс, отпечаток ----------

test('дописанный хвост журнала — пересчёт без перечитывания с начала; итог как у прохода целиком', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)), [B]: edit(B, 1, 'Edit', 'C:\\projects\\app\\other.js', at(2 * H)) });
  const r = mkReader(t.root);
  await r.refresh();
  assert.deepEqual(marksOf(buildWorkers({ procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')], sessions: r.sessions(), board, now: NOW }), A), []);
  const before = r.state().lines;
  const tail = edit(B, 2, 'Write', FILE, at(H));
  // половина строки вызова — не читается; дописана целиком — читается один раз
  fs.appendFileSync(t.file(B), tail[0].slice(0, 30));
  await r.refresh();
  assert.equal(r.state().lines, before);
  fs.appendFileSync(t.file(B), tail[0].slice(30) + '\n' + tail[1] + '\n');
  await r.refresh();
  assert.equal(r.state().lines - before, 2, 'дочитан только хвост: вызов и результат');
  const w = buildWorkers({ procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')], sessions: r.sessions(), board, now: NOW });
  assert.equal(collisions(w, A).length, 1, 'после хвоста — столкновение');
  const whole = mkReader(t.root);
  await whole.refresh();
  const strip = (ss) => ss.map(({ file, okAt, ...x }) => x);
  assert.deepEqual(strip(r.sessions()), strip(whole.sessions()));
});

test('индекс переживает рестарт: правки в нём, перечитывать нечего; новый хвост — только хвост', async () => {
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)), [B]: edit(B, 1, 'Edit', FILE, at(2 * H)) });
  const indexDir = tmpDir('index-');
  const r1 = createJournalReader({ root: t.root, indexDir });
  await r1.refresh();
  r1.flush();
  const r2 = createJournalReader({ root: t.root, indexDir });
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 0, 'после рестарта ничего не перечитано');
  const w = buildWorkers({ procs: [proc(A, 'EXT · первый'), proc(B, 'EXT · второй')], sessions: r2.sessions(), board, now: NOW });
  assert.equal(collisions(w, A).length, 1, 'пометка из индекса');
  fs.appendFileSync(t.file(A), edit(A, 2, 'Write', 'C:\\projects\\app\\new.js', at(H)).map((l) => l + '\n').join(''));
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 2);
});

test('отпечаток индекса зависит от срока хранения правок: окно изменилось — пересбор; то же — только хвост', async () => {
  assert.notEqual(indexFingerprint('p', [], [], 13 * H), indexFingerprint('p', [], [], 25 * H));
  assert.equal(indexFingerprint('p', [], []), indexFingerprint('p', [], [], EDIT_KEEP_MS), 'умолчание — EDIT_KEEP_MS');
  const t = tree({ [A]: edit(A, 1, 'Edit', FILE, at(3 * H)) });
  const indexDir = tmpDir('index-');
  const r1 = createJournalReader({ root: t.root, indexDir });
  await r1.refresh();
  r1.flush();
  const same = createJournalReader({ root: t.root, indexDir });
  await same.refresh();
  assert.equal(same.state().lastPassLines, 0);
  const wider = createJournalReader({ root: t.root, indexDir, editKeepMs: 48 * H });
  await wider.refresh();
  assert.equal(wider.state().lastPassLines, wider.state().lines, 'другое окно — перечитано всё');
});

test('смена текста разбора — тот же пересбор (отпечаток включает journal-parse.mjs)', () => {
  assert.notEqual(indexFingerprint('разбор 1', []), indexFingerprint('разбор 2', []));
});

// ---------- маска ----------

const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';

test('маска: строки пометки (название другого треда, пути) идут через маску ответа /api/ceh, как у прочих пометок', async () => {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека' }] });
  gitInitCommit(dir);
  const bd = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await bd.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const secretFile = `C:\\projects\\app\\token ${SECRET}.txt`;
  const t = tree({ [A]: edit(A, 1, 'Edit', secretFile, at(2 * H)), [B]: edit(B, 1, 'Edit', secretFile, at(H)) });
  const r = mkReader(t.root);
  await r.refresh();
  const threads = {
    list: () => buildWorkers({ procs: [proc(A, 'EXT · первый'), proc(B, `EXT · ключ ${SECRET}`)], sessions: r.sessions(), board: bd, now: NOW }),
    state: () => ({ processes: null, desktop: null }),
  };
  const app = await buildApp({ port: 4317, board: bd, registry: createRegistryReader(regFile), threads, scan });
  const res = await app.inject({ method: 'GET', url: '/api/ceh', headers: { host: '127.0.0.1:4317' } });
  const body = res.body;
  assert.equal(body.includes(SECRET), false, 'секрет в ответе');
  const mark = res.json().workers.threads.find((x) => x.sessionId === A).marks.find((m) => m.kind === 'collision');
  assert.ok(mark, 'пометка в ответе');
  assert.match(mark.other.title, /\[скрыто: /);
  assert.match(mark.files[0].path, /\[скрыто: /);
});

// Вердикт Голема, Важно 1: в пометке чужой тред и чужие пути — строгая сеть (6.2), а не сеть треда-владельца.
// Признак — id флоу по слову-признаку: сеть проекта EXT его прощает (класс 4), строгая (IPTV) — нет (класс 5).
const FLOW_ID = '1a2b3c4d5e6f7g8h';

test('маска пометки — строгой сетью: id флоу по признаку в пути и названии другого треда скрыт, хотя сеть треда EXT его прощает', async () => {
  const flowFile = `C:\\projects\\app\\flow id ${FLOW_ID}.txt`;
  const t = tree({ [A]: edit(A, 1, 'Edit', flowFile, at(2 * H)), [B]: edit(B, 1, 'Edit', flowFile, at(H)) });
  const r = mkReader(t.root);
  await r.refresh();
  const procs = [proc(A, `EXT · первый flow id ${FLOW_ID}`), proc(B, `EXT · второй flow id ${FLOW_ID}`)];
  const { json } = await cehOf((bd) => buildWorkers({ procs, sessions: r.sessions(), board: bd, now: NOW }));
  const a = json.workers.threads.find((x) => x.sessionId === A);
  // исправный случай рядом: свой текст треда EXT — сетью проекта, признак виден (сеть треда действительно мягче)
  assert.equal(a.project, 'EXT');
  assert.equal(a.title, `EXT · первый flow id ${FLOW_ID}`, 'своё название треда — сетью EXT, id флоу виден');
  const mark = a.marks.find((m) => m.kind === 'collision');
  assert.ok(mark, 'пометка в ответе');
  assert.equal(mark.other.title, 'EXT · второй flow id [скрыто: сеть3]');
  assert.equal(mark.files[0].path, 'C:/projects/app/flow id [скрыто: сеть3].txt');
  assert.equal(mark.files[0].short, mark.files[0].path, 'корней нет — короткий путь полный, тоже под строгой маской');
});

// ---------- правки только своей сессии (вердикт Голема, Важно 2) ----------
// Продолженный тред (resume, сжатие, десктопное продолжение) несёт в своём файле копии строк прежних сессий с их sessionId
// (те же uuid). Правка сессии — только из строк со своим sessionId; без десктопной связи иначе вышло бы «правит и <он же>».
const OWN = 'C:\\projects\\app\\own.js'; // своя правка продолженного треда — другой файл

test('копия строк прежней сессии в журнале нового треда (без десктопной связи) — не его правка: пометки «сам с собой» нет', async () => {
  const prev = edit(C, 1, 'Edit', FILE, at(3 * H)); // правка прежней сессии C — строки с sessionId C
  const t = tree({ [C]: prev, [A]: [...prev, ...edit(A, 2, 'Edit', OWN, at(H))] });
  const w = await workers(t, { procs: [proc(A, 'EXT · первый')] });
  assert.deepEqual(collisions(w, A), [], 'копия правки C в файле A — не правка A');
});

test('исправный случай рядом: настоящий другой тред с той же правкой — пометка есть; своя правка того же файла после продолжения — тоже', async () => {
  const prev = edit(C, 1, 'Edit', FILE, at(3 * H));
  const t = tree({ [C]: prev, [A]: [...prev, ...edit(A, 2, 'Edit', OWN, at(H))], [B]: edit(B, 1, 'Write', FILE, at(2 * H)) });
  const w = await workers(t);
  assert.deepEqual(collisions(w, A), [], 'у A — только копия правки C');
  assert.deepEqual(collisions(w, B).map((m) => [m.other.sessionId, m.other.closed]), [[C, true]], 'B правит тот же файл, что закрытый C; A не в паре');
  // A сам (своей строкой) правит тот же файл — столкновение и с B, и с C
  const t2 = tree({ [C]: prev, [A]: [...prev, ...edit(A, 2, 'Edit', FILE, at(H))], [B]: edit(B, 1, 'Write', FILE, at(2 * H)) });
  const w2 = await workers(t2);
  assert.deepEqual(collisions(w2, A).map((m) => m.other.sessionId).sort(), [B, C].sort());
  assert.deepEqual(collisions(w2, A).find((m) => m.other.sessionId === C).files[0].mineAt, at(H), 'время — своей строки A');
});

// Вторая форма копий (живые журналы 04.10: 1 950 id вызовов правки в 2+ файлах сессий, у копий sessionId переписан на
// новый, uuid и время строки те же). Ключ копии — id вызова (tool_use id): правка с id, который есть у правки другой
// сессии, — копия; не считается у той сессии, чей файл появился позже (время создания файла; при равенстве — меньший
// sessionId — раньше). Решение дирижёра по развилке п.6 (вариант а).
const rewrite = (lines, sid) => lines.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: sid }));
const pause = () => new Promise((r) => setTimeout(r, 30));
// журнал сессии, появившийся позже прочих (файл создаётся после паузы)
async function addLater(t, sid, lines) { await pause(); fs.writeFileSync(t.file(sid), lines.map((l) => l + '\n').join('')); }

test('копия правки с переписанным sessionId в файле новой сессии (без десктопной связи) — пометки «сам с собой» нет; у настоящего другого треда — одна пометка', async () => {
  const prev = edit(C, 1, 'Edit', FILE, at(3 * H));
  const t = tree({ [C]: prev, [B]: edit(B, 1, 'Write', FILE, at(2 * H)) });
  await addLater(t, A, [...rewrite(prev, A), ...edit(A, 2, 'Edit', OWN, at(H))]);
  const w = await workers(t);
  assert.deepEqual(collisions(w, A), [], 'копия правки C (id вызова тот же) — не правка A');
  assert.deepEqual(collisions(w, B).map((m) => m.other.sessionId), [C], 'B — с C, не с копией в A');
});

test('копия правки плюс своя новая правка того же пути после продолжения — пометка с настоящим другим тредом есть, время — своей правки', async () => {
  const prev = edit(C, 1, 'Edit', FILE, at(5 * H));
  const t = tree({ [C]: prev, [B]: edit(B, 1, 'Write', FILE, at(4 * H)) });
  await addLater(t, A, [...rewrite(prev, A), ...edit(A, 2, 'Edit', FILE, at(H))]);
  const w = await workers(t);
  const withB = collisions(w, A).find((m) => m.other.sessionId === B);
  assert.ok(withB, 'своя новая правка A (новый id вызова) — столкновение с B');
  assert.equal(withB.files[0].mineAt, at(H));
  assert.equal(collisions(w, B).find((m) => m.other.sessionId === A)?.files[0].otherAt, at(H));
});

test('форк: обе ветки после форка правят один путь новыми вызовами — пометка у обеих, время — новых правок', async () => {
  const base = edit(A, 1, 'Edit', FILE, at(5 * H)); // общая история до форка
  const t = tree({ [A]: [...base, ...edit(A, 2, 'Edit', FILE, at(2 * H))] });
  await addLater(t, B, [...rewrite(base, B), ...edit(B, 3, 'Edit', FILE, at(H))]);
  const w = await workers(t);
  assert.deepEqual(collisions(w, A).map((m) => [m.other.sessionId, m.files[0].mineAt, m.files[0].otherAt]), [[B, at(2 * H), at(H)]]);
  assert.deepEqual(collisions(w, B).map((m) => [m.other.sessionId, m.files[0].mineAt, m.files[0].otherAt]), [[A, at(H), at(2 * H)]]);
});

test('субагент продолженного треда: копия запуска в журнале нового треда не делает его вторым владельцем — у другого треда одна пометка, не две', async () => {
  const start = launch(C, 'ccc1', at(5 * H)); // запуск в прежней сессии C; журнал субагента — в C/subagents
  const t = tree({
    [C]: start,
    [`${C}/ccc1`]: edit(C, 1, 'Write', FILE, at(3 * H)),
    [A]: [...start, ...edit(A, 2, 'Edit', OWN, at(H))], // продолжение: копия строк запуска
    [B]: edit(B, 1, 'Edit', FILE, at(2 * H)),
  });
  const w = await workers(t);
  assert.deepEqual(collisions(w, B).map((m) => m.other.sessionId), [C], 'правка субагента — владельцу C, по своей сессии');
  assert.deepEqual(collisions(w, A), [], 'A — не владелец субагента C');
  // журнала своей сессии C нет (только каталог субагента) — запасной путь по agentId даёт единственного владельца: A
  const orphan = tree({
    [`${C}/ccc1`]: edit(C, 1, 'Write', FILE, at(3 * H)),
    [A]: [...start, ...edit(A, 2, 'Edit', OWN, at(H))],
    [B]: edit(B, 1, 'Edit', FILE, at(2 * H)),
  });
  const w2 = await workers(orphan);
  assert.deepEqual(collisions(w2, B).map((m) => m.other.sessionId), [A], 'второго владельца нет — правка субагента у A');
});

// ---------- образцы ----------

test('образцы web/fixtures: пометка collision в ceh.json и project-EXT.json — ключи как у настоящей (fixtures.test.mjs сверяет только первую пометку)', async () => {
  const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'fixtures', f), 'utf8'));
  const sampleOf = (j) => j.workers.threads.flatMap((x) => x.marks).filter((m) => m.kind === 'collision');
  const files = Array.from({ length: 7 }, (_, i) => `C:\\projects\\app\\f${i + 1}.js`);
  const t = tree({ [A]: files.flatMap((f, i) => edit(A, i + 1, 'Edit', f, at(3 * H))), [B]: files.flatMap((f, i) => edit(B, i + 1, 'Edit', f, at(H))) });
  const real = collisions(await workers(t, { shortRoots: ['C:/projects/app'] }), A)[0];
  const keys = (o) => Object.keys(o).sort();
  const ceh = sampleOf(load('ceh.json'));
  const proj = sampleOf(load('project-EXT.json'));
  assert.equal(ceh.length, 1);
  assert.equal(proj.length, 1);
  assert.deepEqual(keys(ceh[0]), keys(real), 'ceh.json: ключи пометки (с more)');
  assert.deepEqual(keys(ceh[0].other), keys(real.other));
  assert.deepEqual(keys(ceh[0].files[0]), keys(real.files[0]));
  assert.equal(ceh[0].files.length, 5);
  assert.equal(ceh[0].more, 2);
  const { more, ...noMore } = real;
  assert.deepEqual(keys(proj[0]), keys(noMore), 'project-EXT.json: ключи пометки (без more)');
  assert.deepEqual(keys(proj[0].files[0]), keys(real.files[0]));
});

// ---------- настройки ----------

test('настройки: умолчания в config.default.json; живой config сливается по ключам, массив ignore заменяется целиком', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  assert.equal(defaults.thresholds.collisionWindowH, EDIT_WINDOW_H);
  assert.match(defaults.collisions._comment, /ЗАМЕНЯЕТ/, 'в образце настройки — пояснение про замену массива');
  const data = tmpDir('cfg-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ thresholds: { collisionWindowH: 6 }, collisions: { ignore: ['\\\\generated\\\\'] } }));
  const c = loadConfig({ dataDir: data, defaults });
  assert.equal(c.thresholds.collisionWindowH, 6);
  assert.equal(c.thresholds.taktYellowMin, 60, 'прочие пороги — из умолчаний');
  assert.deepEqual(c.collisions.ignore, ['\\\\generated\\\\'], 'массив заменён, а не дополнен умолчанием');
  assert.equal(c.collisions._comment, defaults.collisions._comment, 'объект сливается по ключам');
});
