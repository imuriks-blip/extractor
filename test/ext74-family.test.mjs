// EXT-74: «Общий файл» — не показываются пары (спека витрины §2.3, «Не показываются пары», приёмка EXT-74).
// (1) Семья прораба: тред A с запуском `node … foreman-launch.mjs --cwd <P>` и треды, стартовавшие в <P> в пределах
// thresholds.foremanStartMin (10 мин) после вызова, — у пары из одной семьи отсеиваются только пути под <P>.
// (2) Файла нет: из общих путей пары отсеиваются те, которых нет на диске (функция существования параметром).
// Журналы подставные, во временной папке; время — NOW. Ожидаемые значения — из спеки и того, что положено в журнал.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { newSessionState, feedSession, launchCwds } from '../lib/journal-parse.mjs';
import { buildWorkers } from '../lib/waiting.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const H = 3600000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const iso = (t) => new Date(t).toISOString();
const A = '11111111-1111-4111-8111-111111111111'; // дирижёр
const B = '22222222-2222-4222-8222-222222222222'; // прораб
const C = '33333333-3333-4333-8333-333333333333'; // третий / второй прораб
const D = '44444444-4444-4444-8444-444444444444';
const PROJECT = 'C--projects-app';

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const call = (sid, id, tool, input, time) => JSON.stringify({ type: 'assistant', uuid: uid(), sessionId: sid, timestamp: time,
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool, input }] } });
const result = (sid, id, time, content = 'ok') => JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
let eid = 0;
const edit = (sid, file, time) => { const id = `e${++eid}-${sid.slice(0, 4)}`; return [call(sid, id, 'Edit', { file_path: file }, time), result(sid, id, time)]; };
// вызов оболочки (Bash или PowerShell) с ответом «запущено» — как у фонового запуска прораба
let bid = 0;
const shell = (sid, command, time, tool = 'Bash') => { const id = `b${++bid}-${sid.slice(0, 4)}`; return [call(sid, id, tool, { command }, time), result(sid, id, time, 'Command running in background')]; };
const LAUNCHER = 'C:\\projects\\_foreman\\foreman-launch.mjs';
const launchCmd = (cwdArg) => `node ${LAUNCHER} --card EXT-74 --project EXT ${cwdArg} --task C:\\t\\tz.md`;
const launch = (sid, cwdArg, time, tool) => shell(sid, launchCmd(cwdArg), time, tool);
// начало журнала сессии: четыре служебные строки без cwd (со временем раньше старта — старт берётся не с них),
// пятая — первая строка с полем cwd, её время — старт сессии
const opening = (sid, cwd, start) => [
  ...['enqueue', 'dequeue', 'enqueue', 'dequeue'].map((op, i) => JSON.stringify({ type: 'queue-operation', operation: op, sessionId: sid, timestamp: iso(Date.parse(start) - (30 - i) * MIN) })),
  JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: start, cwd, isMeta: true, message: { role: 'user', content: 'ТЗ прораба' } }),
];
// субагент: вызов Agent и результат с agentId
const agentLaunch = (sid, aid, time) => [
  call(sid, `L-${aid}`, 'Agent', { subagent_type: 'terminus', description: 'такт', prompt: 'сделай' }, time),
  JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time, toolUseResult: { agentId: aid, status: 'async_launched' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `L-${aid}`, content: `agentId: ${aid}` }] } }),
];

function tree(journals) {
  const root = tmpDir('ext74-');
  const proj = path.join(root, PROJECT);
  fs.mkdirSync(proj, { recursive: true });
  for (const [k, ls] of Object.entries(journals)) {
    const [sid, aid] = k.split('/');
    const file = aid ? path.join(proj, sid, 'subagents', `agent-${aid}.jsonl`) : path.join(proj, `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ls.map((l) => l + '\n').join(''));
  }
  return { root };
}
const proc = (sid, name, extra = {}) => ({ pid: Number(sid[0]), sessionId: sid, name, live: true, startedAt: NOW - 20 * H, status: 'busy', observedAt: NOW, statusUpdatedAt: NOW, ...extra });
const board = { hasCard: () => false, card: () => null, hasCode: (c) => c === 'EXT', hasBoard: true };
const ALL = [proc(A, 'EXT · дирижёр'), proc(B, 'EXT · прораб'), proc(C, 'EXT · третий')];
const yes = () => true;
async function workers(journals, { procs = ALL, thresholds = {}, exists = yes, now = NOW, desktop = undefined } = {}) {
  const r = createJournalReader({ root: tree(journals).root, indexDir: tmpDir('index-') });
  await r.refresh();
  return buildWorkers({ procs, sessions: r.sessions(), board, now, thresholds, exists, desktop });
}
const others = (w, sid) => (w.threads.find((x) => x.sessionId === sid)?.marks ?? []).filter((m) => m.kind === 'collision').map((m) => m.other.sessionId).sort();

const P = 'C:\\w\\x';
const F = 'C:\\w\\x\\src\\a.js'; // общий файл под <P>
const L = 3 * H; // вызов запуска — 3 ч назад
const started = (msAfterLaunch) => at(L - msAfterLaunch);

// дирижёр A запускает прораба на <P> (или без запуска), оба правят F; прораб B стартует через минуту
const pair = ({ cmd = launchCmd(`--cwd ${P}`), tool = 'Bash', bStart = MIN, bCwd = P, file = F } = {}) => ({
  [A]: [...(cmd === null ? [] : shell(A, cmd, at(L), tool)), ...edit(A, file, at(H))],
  [B]: [...opening(B, bCwd, started(bStart)), ...edit(B, file, at(2 * H))],
});

// ---------- (1) основной случай ----------

test('EXT-74 (1): дирижёр с запуском прораба на <P>, прораб стартовал через минуту в <P> (cwd в пятой строке), общий файл под <P> → пометки нет ни у кого', async () => {
  const w = await workers(pair());
  assert.deepEqual(others(w, A), []);
  assert.deepEqual(others(w, B), []);
});

test('EXT-74 (1), исправный рядом: тот же журнал без строки запуска → пометка у обоих', async () => {
  const w = await workers(pair({ cmd: null }));
  assert.deepEqual(others(w, A), [B]);
  assert.deepEqual(others(w, B), [A]);
});

// ---------- (2) формы <P> ----------

test('EXT-74 (2): формы --cwd — C:/w/x, "C:\\w\\x", \'C:\\w\\x\', C:\\w\\x\\, --cwd=C:\\w\\x → семья; C:\\w\\y → пометка', async () => {
  for (const arg of ['--cwd C:/w/x', '--cwd "C:\\w\\x"', "--cwd 'C:\\w\\x'", '--cwd C:\\w\\x\\', '--cwd=C:\\w\\x', '--cwd="C:\\w\\x"']) {
    const w = await workers(pair({ cmd: launchCmd(arg) }));
    assert.deepEqual(others(w, A), [], arg);
    assert.deepEqual(others(w, B), [], arg);
  }
  const wy = await workers(pair({ cmd: launchCmd('--cwd C:\\w\\y') }));
  assert.deepEqual(others(wy, A), [B], 'запуск на другую папку — не семья');
  assert.deepEqual(others(wy, B), [A]);
});

test('EXT-74 (2): разбор команды — <P> нормализован, хвостовой разделитель снят; иные формы не распознаются', () => {
  for (const arg of ['--cwd C:/w/x', '--cwd "C:\\w\\x"', "--cwd 'C:\\w\\x'", '--cwd C:\\w\\x\\', '--cwd=C:\\w\\x', '--cwd C:/w/x/']) {
    assert.deepEqual(launchCwds(launchCmd(arg)), ['C:/w/x'], arg);
  }
  assert.deepEqual(launchCwds(launchCmd('--cwd "C:\\w\\with space"')), ['C:/w/with space'], 'путь с пробелом в кавычках');
  for (const arg of ['--cwd $wt', '--cwd ..\\x', '--cwd x', '']) assert.deepEqual(launchCwds(launchCmd(arg)), [], `не распознаётся: ${arg}`);
  assert.deepEqual(launchCwds('node.exe C:/projects/_foreman/foreman-launch.mjs --cwd C:\\a && node "C:\\projects\\_foreman\\foreman-launch.mjs" --cwd C:\\b'), ['C:/a', 'C:/b'], 'два запуска в одной команде — каждый свой');
});

// ---------- (3) запуск в журнале субагента ----------

test('EXT-74 (3): запуск в журнале субагента дирижёра → семья; исправный рядом: субагент без запуска → пометка', async () => {
  const j = (cmd) => ({
    [A]: [...agentLaunch(A, 'aaa1', at(L + 10 * MIN)), ...edit(A, F, at(H))],
    [`${A}/aaa1`]: shell(A, cmd, at(L)),
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))],
  });
  const w = await workers(j(launchCmd(`--cwd ${P}`)));
  assert.deepEqual(others(w, A), []);
  assert.deepEqual(others(w, B), []);
  const plain = await workers(j('git -C C:\\w\\x status'));
  assert.deepEqual(others(plain, A), [B]);
  assert.deepEqual(others(plain, B), [A]);
});

// ---------- (4) третий тред ----------

test('EXT-74 (4): третий тред правит тот же файл в <P> → пометка у третьего и у прораба (и у дирижёра — с третьим); дирижёр с прорабом — нет', async () => {
  const w = await workers({ ...pair(), [C]: [...opening(C, 'C:\\other', at(15 * H)), ...edit(C, F, at(30 * MIN))] });
  assert.deepEqual(others(w, A), [C]);
  assert.deepEqual(others(w, B), [C]);
  assert.deepEqual(others(w, C), [A, B]);
});

test('EXT-74 (4): третий тред со своим cwd = <P>, но открытый за час до запуска, — не семья: пометка есть', async () => {
  const w = await workers({ ...pair(), [C]: [...opening(C, P, at(L + H)), ...edit(C, F, at(30 * MIN))] });
  assert.deepEqual(others(w, C), [A, B]);
  assert.deepEqual(others(w, B), [C]);
});

// ---------- (5) два прораба одного дирижёра на одну <P> ----------

test('EXT-74 (5): перезапуск — два прораба одного дирижёра на одну <P> → пометки нет; исправный рядом: второй без своего запуска → пометка', async () => {
  const L2 = H;
  const j = (second) => ({
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...(second ? shell(A, launchCmd(`--cwd ${P}`), at(L2)) : [])],
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))],
    [C]: [...opening(C, P, at(L2 - MIN)), ...edit(C, F, at(30 * MIN))],
  });
  const w = await workers(j(true));
  assert.deepEqual(others(w, B), []);
  assert.deepEqual(others(w, C), []);
  const one = await workers(j(false));
  assert.deepEqual(others(one, B), [C]);
  assert.deepEqual(others(one, C), [B]);
});

// ---------- (6) правило старта ----------

test('EXT-74 (6): старт прораба за секунду до вызова или позже на 11 мин → пометка; ровно через 10 мин → семья', async () => {
  assert.deepEqual(others(await workers(pair({ bStart: -1000 })), B), [A], 'за секунду до вызова');
  assert.deepEqual(others(await workers(pair({ bStart: 11 * MIN })), B), [A], '+11 мин');
  assert.deepEqual(others(await workers(pair({ bStart: 10 * MIN })), B), [], 'ровно +10 мин — включительно');
  assert.deepEqual(others(await workers(pair({ bStart: 0 })), B), [], 'в ту же секунду');
});

test('EXT-74 (6): thresholds.foremanStartMin — настройка; нечисловое или ≤ 0 — умолчание 10', async () => {
  const j = pair({ bStart: 11 * MIN });
  assert.deepEqual(others(await workers(j, { thresholds: { foremanStartMin: 15 } }), B), [], '15 мин — +11 мин в семье');
  assert.deepEqual(others(await workers(pair({ bStart: 6 * MIN }), { thresholds: { foremanStartMin: 5 } }), B), [A], '5 мин — +6 мин не семья');
  for (const bad of ['15', 0, -5, null, NaN]) {
    assert.deepEqual(others(await workers(j, { thresholds: { foremanStartMin: bad } }), B), [A], `${bad} — умолчание 10: +11 мин не семья`);
    assert.deepEqual(others(await workers(pair({ bStart: 10 * MIN }), { thresholds: { foremanStartMin: bad } }), B), [], `${bad} — умолчание 10: +10 мин семья`);
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  assert.equal(defaults.thresholds.foremanStartMin, 10, 'в образце настройки');
});

// ---------- (6а) (6б) файлы вне <P> ----------

test('EXT-74 (6а): дирижёр и его прораб правят один файл вне <P> (хроника) → пометка у обоих; под <P> в той же паре — отсеян', async () => {
  const CHRON = 'C:\\v\\chron.md';
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...edit(A, F, at(H)), ...edit(A, CHRON, at(50 * MIN))],
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H)), ...edit(B, CHRON, at(40 * MIN))],
  };
  const w = await workers(j);
  const ma = w.threads.find((x) => x.sessionId === A).marks.filter((m) => m.kind === 'collision');
  assert.deepEqual(ma.map((m) => m.other.sessionId), [B]);
  assert.deepEqual(ma[0].files.map((f) => f.path), ['C:/v/chron.md'], 'под <P> отсеян, вне <P> — на месте');
  assert.deepEqual(others(w, B), [A]);
});

test('EXT-74 (6а): путь «под <P>» — с разделителем: C:\\w\\xy\\… не под C:\\w\\x', async () => {
  const w = await workers(pair({ file: 'C:\\w\\xy\\a.js' }));
  assert.deepEqual(others(w, A), [B]);
});

test('EXT-74 (6б): два прораба одного дирижёра на разные папки правят общий файл вне обеих → пометка; исправный рядом: каждый с дирижёром под своей папкой — нет', async () => {
  const P2 = 'C:\\w\\x2';
  const CHRON = 'C:\\v\\chron.md';
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...shell(A, launchCmd(`--cwd ${P2}`), at(L - 5 * MIN)), ...edit(A, F, at(H)), ...edit(A, 'C:\\w\\x2\\b.js', at(H))],
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H)), ...edit(B, CHRON, at(40 * MIN))],
    [C]: [...opening(C, P2, at(L - 6 * MIN)), ...edit(C, 'C:\\w\\x2\\b.js', at(2 * H)), ...edit(C, CHRON, at(30 * MIN))],
  };
  const w = await workers(j);
  assert.deepEqual(others(w, B), [C]);
  assert.deepEqual(others(w, C), [B]);
  assert.deepEqual(others(w, A), []);
});

test('EXT-74 (6б): два прораба на разные папки — общий файл под папкой одного из них тоже показывается (разные семьи)', async () => {
  const P2 = 'C:\\w\\x2';
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...shell(A, launchCmd(`--cwd ${P2}`), at(L - 5 * MIN))],
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))],
    [C]: [...opening(C, P2, at(L - 6 * MIN)), ...edit(C, F, at(30 * MIN))],
  };
  assert.deepEqual(others(await workers(j), B), [C]);
});

// ---------- (6в) отрезки команды ----------

test('EXT-74 (6в): --cwd в другом отрезке — не запуск; PowerShell `& "…node.exe" "…foreman-launch.mjs" --cwd` — запуск', async () => {
  for (const cmd of [
    `node ${LAUNCHER} --card X --task t; git -C C:\\w\\z status`,
    `node ${LAUNCHER} --card X --task t; echo --cwd ${P}`,
    `node ${LAUNCHER} --card X --task t && echo --cwd ${P}`,
    `node ${LAUNCHER} --card X --task t | tee --cwd ${P}`,
    `node ${LAUNCHER} --card X --task t\necho --cwd ${P}`,
  ]) {
    assert.deepEqual(launchCwds(cmd), [], JSON.stringify(cmd));
    assert.deepEqual(others(await workers(pair({ cmd })), B), [A], JSON.stringify(cmd));
  }
  const ps = `& "C:\\Program Files\\nodejs\\node.exe" "${LAUNCHER}" --cwd ${P}`;
  assert.deepEqual(launchCwds(ps), ['C:/w/x']);
  assert.deepEqual(others(await workers(pair({ cmd: ps, tool: 'PowerShell' })), B), [], 'PowerShell с оператором вызова');
  assert.deepEqual(launchCwds(`git -C C:\\w\\x pull; & node ${LAUNCHER} --cwd ${P}`), ['C:/w/x'], '& в начале отрезка после «;» — оператор вызова');
  assert.deepEqual(launchCwds(`cd C:\\w & node ${LAUNCHER} --cwd ${P}`), ['C:/w/x'], 'одиночный & посреди — разделитель');
  assert.deepEqual(launchCwds(`  NODE.EXE ${LAUNCHER} --cwd ${P} --minutes 60`), ['C:/w/x'], 'node.exe голым словом');
});

// ---------- (7) упоминание — не запуск ----------

test('EXT-74 (7): упоминание в тексте, разделитель внутри кавычек, --dry-run, Read файла foreman-launch.mjs → пометка', async () => {
  for (const cmd of [
    `git commit -m "EXT-74 foreman-launch --cwd ${P}"`,
    `git commit -m "fix; node ${LAUNCHER} --cwd ${P}"`,
    `git commit -m 'fix && node ${LAUNCHER} --cwd ${P}'`,
    launchCmd(`--cwd ${P} --dry-run`),
    `echo node ${LAUNCHER} --cwd ${P}`,
  ]) {
    assert.deepEqual(launchCwds(cmd), [], cmd);
    assert.deepEqual(others(await workers(pair({ cmd })), B), [A], cmd);
  }
  const read = {
    [A]: [call(A, 'r1', 'Read', { file_path: LAUNCHER }, at(L)), result(A, 'r1', at(L)), ...edit(A, F, at(H))],
    [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))],
  };
  assert.deepEqual(others(await workers(read), B), [A], 'Read файла запуска — не запуск');
});

// ---------- (8) продолжение дирижёра ----------

test('EXT-74 (8): строка запуска только копией в журнале новой сессии дирижёра → семья; копия с переписанным sessionId — тоже', async () => {
  const orig = shell(D, launchCmd(`--cwd ${P}`), at(L)); // строки прежней сессии D; её файла нет
  for (const copy of [orig, orig.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: A }))]) {
    const w = await workers({ [A]: [...copy, ...edit(A, F, at(H))], [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))] });
    assert.deepEqual(others(w, A), []);
    assert.deepEqual(others(w, B), []);
  }
});

test('EXT-74 (8): запуск только в прежней сессии треда (десктопная связь), правит новая сессия → пометки нет; без связи → пометка', async () => {
  const j = { [D]: shell(D, launchCmd(`--cwd ${P}`), at(L)), [A]: edit(A, F, at(H)), [B]: [...opening(B, P, started(MIN)), ...edit(B, F, at(2 * H))] };
  const linked = [{ ...proc(A, 'EXT · дирижёр'), hostSessionId: 'local_a' }, proc(B, 'EXT · прораб')];
  const desktop = (h) => (h === 'local_a' ? { title: 'EXT · дирижёр', priorCliSessionIds: [D] } : null);
  const w = await workers(j, { procs: linked, desktop });
  assert.deepEqual(others(w, A), []);
  assert.deepEqual(others(w, B), []);
  const unlinked = await workers(j, { procs: [proc(A, 'EXT · дирижёр'), proc(B, 'EXT · прораб')] });
  assert.deepEqual(others(unlinked, A), [B]);
  assert.deepEqual(others(unlinked, B), [A], 'D — закрытый тред-дирижёр, A — чужой');
});

test('EXT-74 (8): cwd и старт — из старейшей сессии треда прораба (продолженный прораб: новая сессия стартовала через 2 ч)', async () => {
  const B2 = '55555555-5555-4555-8555-555555555555';
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...edit(A, F, at(H))],
    [B]: opening(B, P, started(MIN)),
    [B2]: [...opening(B2, P, started(2 * H)), ...edit(B2, F, at(30 * MIN))],
  };
  const linked = [proc(A, 'EXT · дирижёр'), { ...proc(B2, 'EXT · прораб'), hostSessionId: 'local_b' }];
  const desktop = (h) => (h === 'local_b' ? { title: 'EXT · прораб', priorCliSessionIds: [B] } : null);
  assert.deepEqual(others(await workers(j, { procs: linked, desktop }), B2), [], 'старт треда — у старейшей сессии B');
  assert.deepEqual(others(await workers(j, { procs: [proc(A, 'EXT · дирижёр'), proc(B2, 'EXT · прораб')] }), B2), [A], 'без связи B2 — свой тред, стартовал через 2 ч');
});

// ---------- (9) срок следа ----------

test('EXT-74 (9): запуск T0, правки прораба до T0+110 мин, дирижёра T0+10 ч и посторонняя T0+13,5 ч, сейчас T0+13,6 ч → пометки нет', async () => {
  const T0 = NOW - 13.6 * H;
  const t = (h) => iso(T0 + h * H);
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), t(0)), ...edit(A, F, t(10)), ...edit(A, 'C:\\v\\other.md', t(13.5))],
    [B]: [...opening(B, P, t(1 / 60)), ...edit(B, 'C:\\w\\x\\b.js', t(1)), ...edit(B, F, t(110 / 60))],
  };
  const w = await workers(j);
  assert.deepEqual(others(w, A), []);
  assert.deepEqual(others(w, B), []);
  const { [A]: aj, ...rest } = j;
  const noLaunch = await workers({ ...rest, [A]: aj.slice(2) });
  assert.deepEqual(others(noLaunch, B), [A], 'исправный рядом: без запуска — пометка');
});

test('EXT-74 (9): разбор хранит запуск окно + 24 ч от вызова — свежая правка не вытесняет его вместе с правками', () => {
  const st = newSessionState();
  const T0 = NOW - 14 * H;
  for (const l of [...shell(A, launchCmd(`--cwd ${P}`), iso(T0)), ...edit(A, F, iso(T0 + 10 * H)), ...edit(A, 'C:\\v\\o.md', iso(T0 + 13.5 * H))]) feedSession(st, JSON.parse(l));
  assert.deepEqual(Object.values(st.edits).map((e) => e.p).sort(), ['C:/v/o.md', 'C:/w/x/src/a.js'], 'правки — по своему сроку');
  assert.equal(Object.values(st.launches ?? {}).length, 1, 'запуск T0 на месте, хотя старше срока правок (13 ч от последней)');
});

test('EXT-74 (9): запуск старше окна + 24 ч не действует — пометка есть', async () => {
  const L0 = 37 * H; // окно 12 ч + 24 ч = 36 ч
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L0)), ...edit(A, F, at(H))],
    [B]: [...opening(B, P, at(L0 - MIN)), ...edit(B, F, at(2 * H))],
  };
  assert.deepEqual(others(await workers(j), B), [A]);
  const j35 = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(35 * H)), ...edit(A, F, at(H))],
    [B]: [...opening(B, P, at(35 * H - MIN)), ...edit(B, F, at(2 * H))],
  };
  assert.deepEqual(others(await workers(j35), B), [], 'исправный рядом: 35 ч — ещё действует');
});

// ---------- (10) файла нет ----------

const SEVEN = Array.from({ length: 7 }, (_, i) => `C:\\projects\\app\\f${i + 1}.js`);
const sevenJ = () => ({
  [A]: SEVEN.flatMap((f, i) => edit(A, f, at((9 - i) * H))),
  [B]: SEVEN.flatMap((f, i) => edit(B, f, at((8 - i) * H))),
});

test('EXT-74 (10): из 7 общих путей 3 «нет» (самые свежие) → 4 пути, more нет, at — по оставшимся', async () => {
  const gone = new Set(['f5.js', 'f6.js', 'f7.js']);
  const exists = (p) => !gone.has(path.basename(p));
  const w = await workers(sevenJ(), { exists });
  const m = w.threads.find((x) => x.sessionId === A).marks.filter((x) => x.kind === 'collision');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].files.map((f) => path.basename(f.path)), ['f4.js', 'f3.js', 'f2.js', 'f1.js']);
  assert.equal('more' in m[0], false);
  assert.equal(m[0].at, at(5 * H), 'f4 у B — 5 ч назад');
});

test('EXT-74 (10): все «нет» → пометки нет; все «есть» → прежнее поведение (5 и more 2)', async () => {
  const none = await workers(sevenJ(), { exists: () => false });
  assert.deepEqual(others(none, A), []);
  const all = await workers(sevenJ(), { exists: () => true });
  const m = all.threads.find((x) => x.sessionId === A).marks.find((x) => x.kind === 'collision');
  assert.equal(m.files.length, 5);
  assert.equal(m.more, 2);
  assert.equal(m.at, at(2 * H));
});

test('EXT-74 (10): существование проверяется раз за проход на путь и только у кандидатов пары', async () => {
  const calls = [];
  const exists = (p) => { calls.push(p); return true; };
  const j = { [A]: [...edit(A, F, at(3 * H)), ...edit(A, 'C:\\only\\a.js', at(3 * H))], [B]: edit(B, F, at(2 * H)), [C]: edit(C, F, at(H)) };
  await workers(j, { exists });
  assert.equal(calls.length, 1, `три треда на одном файле — одна проверка: ${JSON.stringify(calls)}`);
  assert.equal(calls[0].toLowerCase(), 'c:/w/x/src/a.js');
});

test('EXT-74 (10), (11): по умолчанию — fs.existsSync: настоящий файл даёт пометку (два живых треда без запуска), снесённый — нет', async () => {
  const dir = tmpDir('ext74-disk-');
  const real = path.join(dir, 'real.md');
  fs.writeFileSync(real, 'x');
  const ghost = path.join(dir, 'ghost.md');
  const r = createJournalReader({ root: tree({ [A]: [...edit(A, real, at(3 * H)), ...edit(A, ghost, at(3 * H))], [B]: [...edit(B, real, at(H)), ...edit(B, ghost, at(H))] }).root, indexDir: tmpDir('index-') });
  await r.refresh();
  // ignore пуст: временная папка тестов может лежать под Temp\claude\ (умолчание ignore)
  const w = buildWorkers({ procs: ALL.slice(0, 2), sessions: r.sessions(), board, now: NOW, collisions: { ignore: [] } });
  const m = w.threads.find((x) => x.sessionId === A).marks.filter((x) => x.kind === 'collision');
  assert.deepEqual(m.map((x) => x.files.map((f) => f.path)), [[real.replace(/\\/g, '/')]], 'пометка с существующим файлом; ghost.md отсеян');
});

test('EXT-74: отсев семьи — до обрезки: 7 общих, 5 самых свежих под <P> → 2 пути вне <P>, more нет', async () => {
  const files = [...Array.from({ length: 5 }, (_, i) => `C:\\w\\x\\p${i}.js`), 'C:\\v\\o1.md', 'C:\\v\\o2.md'];
  const j = {
    [A]: [...shell(A, launchCmd(`--cwd ${P}`), at(L)), ...files.map((f, i) => edit(A, f, at(i < 5 ? 30 * MIN : 2.5 * H))).flat()],
    [B]: [...opening(B, P, started(MIN)), ...files.map((f, i) => edit(B, f, at(i < 5 ? 20 * MIN : 2.6 * H))).flat()],
  };
  const m = (await workers(j)).threads.find((x) => x.sessionId === A).marks.filter((x) => x.kind === 'collision');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].files.map((f) => f.path).sort(), ['C:/v/o1.md', 'C:/v/o2.md']);
  assert.equal('more' in m[0], false);
  assert.equal(m[0].at, at(2.5 * H));
});
