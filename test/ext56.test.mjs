// EXT-56: «Такт без ответа» закрывает и запись `⏸` в журнале карточки доски (§2.3 спеки витрины, абзац
// «⏸ получен засчитывается и по доске»); `plane.py comment <html> <ID>` — вызов записи на доску (§1.4).
// Фикстуры выдуманные; ожидания — из данных, положенных в тест.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { newSessionState, feedSession, parseBoardWrite } from '../lib/journal-parse.mjs';
import { buildMarks } from '../lib/waiting.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const RULES = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).boardWriteTools;

const T0 = Date.parse('2026-10-02T10:00:00Z');
const MIN = 60000;
const TH = { taktYellowMin: 60, taktRedMin: 180 };
const SID = '56565656-0000-4000-8000-000000000056';
const iso = (ms) => new Date(ms).toISOString();

function entry(ms, kind, body) {
  const d = new Date(ms + 3 * 3600000).toISOString();
  return `### ${d.slice(0, 10)} ${d.slice(11, 16)} +03:00 · plane · ${kind}\n\n${body}\n\n`;
}

async function boardWith(logs, fsx = fs) {
  const dir = makeBoard(tmpDir('e56-'), { codes: ['EXT'], cards: [{ id: 'EXT-7', status: 'in-progress', title: 'Карточка' }] });
  for (const [id, entries] of Object.entries(logs)) fs.writeFileSync(path.join(dir, 'EXT', `${id}.log.md`), entries.join(''));
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest, fs: fsx });
  await board.init();
  return board;
}

const sess = (writes) => ({ sessionId: SID, ivan: { lastAt: null, cards: {} }, runs: [], partials: [], boardWrites: writes, thread: {} });
const on = (ms) => ({ at: iso(ms), refs: ['EXT-7'], firstLine: '▶ выдан: terminus · ext-7 · правка', tool: 't' });
const takts = (board, writes) => (buildMarks({ procs: [{ sessionId: SID, live: true, startedAt: T0 - 600 * MIN }], sessions: [sess(writes)], board, now: T0, thresholds: TH }).bySession[SID] ?? []).filter((m) => m.kind === 'takt');

test('EXT-56: ▶ в журнале треда, ⏸ только в журнале карточки доски и новее — такта нет', async () => {
  const board = await boardWith({ 'EXT-7': [entry(T0 - 200 * MIN, '▶', '▶ выдан: terminus · ext-7 · правка'), entry(T0 - 100 * MIN, '⏸', '⏸ получен: terminus · ext-7 · готово')] });
  assert.deepEqual(takts(board, [on(T0 - 200 * MIN)]), []);
});

test('EXT-56: ⏸ в доске старше ▶ из журнала — такт есть', async () => {
  const board = await boardWith({ 'EXT-7': [entry(T0 - 300 * MIN, '⏸', '⏸ получен: terminus · ext-7 · прошлый такт')] });
  assert.deepEqual(takts(board, [on(T0 - 200 * MIN)]).map((m) => [m.card, m.level]), [['EXT-7', 'red']]);
});

test('EXT-56: в журнале карточки нет записи ⏸ (только коммент) или журнала нет — такт есть', async () => {
  const withComment = await boardWith({ 'EXT-7': [entry(T0 - 100 * MIN, 'коммент', '⏸ получен — в теле коммента, вид записи не ⏸')] });
  assert.deepEqual(takts(withComment, [on(T0 - 200 * MIN)]).map((m) => m.card), ['EXT-7']);
  const noLog = await boardWith({});
  assert.deepEqual(takts(noLog, [on(T0 - 200 * MIN)]).map((m) => m.card), ['EXT-7']);
});

test('EXT-56: журнал карточки не читается (EBUSY) — прежнее правило по журналу треда, без ошибки', async () => {
  const fsx = { ...fs, readFileSync: (p, ...a) => { if (String(p).endsWith('.log.md')) throw Object.assign(new Error('заперт'), { code: 'EBUSY' }); return fs.readFileSync(p, ...a); } };
  const board = await boardWith({ 'EXT-7': [entry(T0 - 100 * MIN, '⏸', '⏸ получен: terminus · ext-7 · готово')] }, fsx);
  assert.ok(board.state().logErrors >= 1, 'ошибка журнала посчитана');
  assert.deepEqual(takts(board, [on(T0 - 200 * MIN)]).map((m) => m.card), ['EXT-7'], '▶ без ⏸ по журналу — такт');
  assert.deepEqual(takts(board, [on(T0 - 200 * MIN), { ...on(T0 - 150 * MIN), firstLine: '⏸ получен: terminus · ext-7 · готово' }]), [], '⏸ по журналу — закрыт, как было');
});

// ---------- plane.py comment в boardWriteTools ----------

let n = 0;
function feed(st, name, command, at, isError = false) {
  const id = `pc${++n}`;
  feedSession(st, { type: 'assistant', timestamp: iso(at), message: { id: `m${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: { command } }] } }, { rules: RULES });
  feedSession(st, { type: 'user', timestamp: iso(at + MIN), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } }, { rules: RULES });
}
const plainBoard = { hasCard: (id) => id === 'EXT-7', card: (id) => (id === 'EXT-7' ? { id, code: 'EXT', status: 'in-progress', title: 't' } : null) };

test('EXT-56: plane.py comment «⏸ получен» в журнале треда закрывает такт; тело — первый аргумент, карточка — второй', () => {
  const st = newSessionState();
  feed(st, 'Bash', `python C:/projects/_plane-rest/plane.py comment '<p>⏸ получен: terminus · ext-7 · готово</p>' EXT-7`, T0 - 150 * MIN);
  assert.equal(st.boardWrites.length, 1);
  assert.deepEqual(st.boardWrites[0].refs, ['EXT-7']);
  assert.equal(st.boardWrites[0].firstLine, '⏸ получен: terminus · ext-7 · готово');
  assert.deepEqual(takts(plainBoard, [on(T0 - 200 * MIN), ...st.boardWrites]), []);
  assert.deepEqual(takts(plainBoard, [on(T0 - 200 * MIN)]).map((m) => m.card), ['EXT-7'], 'исправный случай: без comment такт есть');
});

test('EXT-56: plane.py comment «▶ выдан» (PowerShell, двойные кавычки) открывает такт', () => {
  const st = newSessionState();
  feed(st, 'PowerShell', `& python C:\\projects\\_plane-rest\\plane.py comment "<p>▶ выдан: golem · ext-7 · ревью</p>" EXT-7`, T0 - 70 * MIN);
  assert.equal(st.boardWrites.length, 1);
  assert.deepEqual(takts(plainBoard, st.boardWrites).map((m) => [m.card, m.agent, m.level]), [['EXT-7', 'golem', 'yellow']]);
});

test('EXT-56: путь к plane.py в кавычках распознаётся (comment и close); без кавычек — как прежде', () => {
  const use = (command) => ({ type: 'tool_use', id: 'q', name: 'PowerShell', input: { command } });
  assert.equal(parseBoardWrite(use(`python "C:\\x y\\plane.py" comment '<p>⏸ получен: terminus · ext-7</p>' EXT-7`), RULES)?.firstLine, '⏸ получен: terminus · ext-7');
  assert.deepEqual(parseBoardWrite(use(`python 'C:\\x\\plane.py' close Review '<p>▶ выдан: golem · ext-7</p>' EXT-7`), RULES)?.refs, ['EXT-7']);
  assert.equal(parseBoardWrite(use(`python C:\\x\\plane.py comment '<p>a</p>' EXT-7`), RULES)?.firstLine, 'a');
  assert.equal(parseBoardWrite(use(`python "C:\\x\\plane.py" show EXT-7 --last`), RULES), null, 'show — не запись');
});

test('EXT-56: plane.py comment через переменную ($t) — ни ▶, ни ⏸; ошибкой не считается', () => {
  const use = (command) => ({ type: 'tool_use', id: 'x', name: 'Bash', input: { command } });
  const w = parseBoardWrite(use('t="<p>⏸ получен: terminus · ext-7 · готово</p>"; python plane.py comment "$t" EXT-7'), RULES);
  assert.deepEqual(w?.refs, ['EXT-7'], 'вызов записи распознан');
  assert.equal(w.firstLine, null, 'первая строка тела неизвестна');
  assert.equal(parseBoardWrite(use('python plane.py comment $t EXT-7'), RULES).firstLine, null);
  assert.equal(parseBoardWrite(use('python plane.py comment ${t} EXT-7'), RULES).firstLine, null);
  const st = newSessionState();
  feed(st, 'Bash', 'python plane.py comment $t EXT-7', T0 - 150 * MIN);
  assert.equal(st.boardWritesFailed, 0);
  assert.equal(takts(plainBoard, st.boardWrites).length, 0, 'не открывает');
  assert.equal(takts(plainBoard, [on(T0 - 200 * MIN), ...st.boardWrites]).length, 1, 'не закрывает');
});
