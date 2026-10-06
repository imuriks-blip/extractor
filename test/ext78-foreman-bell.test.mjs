// EXT-78: сессия прораба — не кандидат звонка (спека пульта §2.3, «Сессия прораба — не кандидат»).
// Звонок «по карточке» и «по проекту» не будит тред, узнанный как прораб (правило старта EXT-74: старейшая сессия треда
// стартовала в папке <P> запуска в пределах thresholds.foremanStartMin после вызова; дирижёр — не прораб). Адресный звонок
// строки (а) (session) — как был. Журналы подставные, во временной папке; ожидаемое — из спеки и того, что положено в журнал.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildWorkers } from '../lib/waiting.mjs';
import { pickThread } from '../lib/pult/bell.mjs';
import { tmpDir } from './helpers.mjs';

const MIN = 60000;
const H = 3600000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const iso = (t) => new Date(t).toISOString();
const A = '11111111-1111-4111-8111-111111111111'; // дирижёр
const B = '22222222-2222-4222-8222-222222222222'; // прораб
const C = '33333333-3333-4333-8333-333333333333'; // тред проекта
const PROJECT = 'C--projects-app';

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const call = (sid, id, tool, input, time) => JSON.stringify({ type: 'assistant', uuid: uid(), sessionId: sid, timestamp: time,
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool, input }] } });
const result = (sid, id, time, content = 'ok') => JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
let bid = 0;
const shell = (sid, command, time) => { const id = `b${++bid}-${sid.slice(0, 4)}`; return [call(sid, id, 'Bash', { command }, time), result(sid, id, time, 'Command running in background')]; };
const LAUNCHER = 'C:\\projects\\_foreman\\foreman-launch.mjs';
const launchCmd = (extra = '') => `node ${LAUNCHER} --card EXT-78 --project EXT --cwd ${P} --task C:\\t\\tz.md${extra}`;
const opening = (sid, cwd, start) => [
  JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: start, cwd, isMeta: true, message: { role: 'user', content: 'ТЗ' } }),
];
// слово Ивана с карточкой — так у треда появляется card (threads.mjs, cardOf)
const ivanSays = (sid, time) => JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: time, message: { role: 'user', content: 'EXT-78 вперёд' } });
const P = 'C:\\w\\x';
const L = 3 * H; // вызов запуска — 3 ч назад
const started = (msAfterLaunch) => at(L - msAfterLaunch);

const proc = (sid, name) => ({ pid: Number(sid[0]), sessionId: sid, name, live: true, startedAt: NOW - 20 * H, status: 'busy', observedAt: NOW, statusUpdatedAt: NOW });
const board = { hasCard: (id) => id === 'EXT-78', card: () => null, hasCode: (c) => c === 'EXT', hasBoard: true };

function tree(journals) {
  const root = tmpDir('ext78-');
  const proj = path.join(root, PROJECT);
  fs.mkdirSync(proj, { recursive: true });
  for (const [sid, ls] of Object.entries(journals)) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), ls.map((l) => l + '\n').join(''));
  return root;
}
async function workers(journals, procs, thresholds = {}) {
  const r = createJournalReader({ root: tree(journals), indexDir: tmpDir('index-') });
  await r.refresh();
  return buildWorkers({ procs, sessions: r.sessions(), board, now: NOW, thresholds, exists: () => true });
}
const row = (w, sid) => w.threads.find((t) => t.sessionId === sid);

// дирижёр A запускает прораба на <P>; прораб B стартует в <P> через bStart после вызова; C — другая папка, тот же проект
const scene = ({ cmd = launchCmd(), bStart = MIN, bCwd = P } = {}) => ({
  [A]: [...opening(A, 'C:\\other', at(20 * H)), ivanSays(A, at(19 * H)), ...shell(A, cmd, at(L))],
  [B]: [...opening(B, bCwd, started(bStart)), ivanSays(B, at(L - 20 * MIN))],
  [C]: opening(C, 'C:\\elsewhere', at(10 * H)),
});
const PROCS = [proc(A, 'EXT-78 · дирижёр'), proc(B, 'EXT-78 · прораб'), proc(C, 'EXT · проект')];

test('EXT-78 (сквозной): прораб помечен foreman, звонок по карточке уходит треду проекта (а)', async () => {
  const w = await workers(scene(), PROCS);
  assert.equal(row(w, B).foreman, true);
  assert.equal(row(w, B).card, 'EXT-78', 'прораб — тот же по карточке, иначе тест ничего не проверяет');
  assert.equal('foreman' in row(w, C), false);
  assert.equal('foreman' in row(w, A), false);
  const r = pickThread({ threads: w.threads.filter((t) => t.sessionId !== A), card: 'EXT-78', now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.sessionId, C);
});

test('EXT-78 (б): только прораб по карточке и проекту → none', async () => {
  const w = await workers(scene(), [proc(B, 'EXT-78 · прораб')]);
  assert.equal(row(w, B).foreman, true);
  assert.deepEqual(pickThread({ threads: w.threads, card: 'EXT-78', now: NOW }), { kind: 'none', code: 'EXT' });
});

test('EXT-78 (б2): адресный звонок строки (а) прорабу — как был', async () => {
  const w = await workers(scene(), PROCS);
  const r = pickThread({ threads: w.threads, card: 'EXT-78', session: B, now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.by, 'row');
  assert.equal(r.target.sessionId, B);
});

test('EXT-78 (в): сессия в той же папке, стартовавшая позже foremanStartMin после вызова, — кандидат', async () => {
  const w = await workers(scene({ bStart: 11 * MIN }), [proc(B, 'EXT-78 · тред')]);
  assert.equal('foreman' in row(w, B), false);
  const r = pickThread({ threads: w.threads, card: 'EXT-78', now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.sessionId, B);
  // граница: в пределах настройки — прораб
  const w2 = await workers(scene({ bStart: 11 * MIN }), [proc(B, 'EXT-78 · тред')], { foremanStartMin: 12 });
  assert.equal(row(w2, B).foreman, true);
});

test('EXT-78 (г): запуск с --dry-run не делает тред прорабом', async () => {
  const w = await workers(scene({ cmd: launchCmd(' --dry-run') }), [proc(B, 'EXT-78 · тред')]);
  assert.equal('foreman' in row(w, B), false);
  assert.equal(pickThread({ threads: w.threads, card: 'EXT-78', now: NOW }).kind, 'one');
});

test('EXT-78 (д): сам дирижёр, запустивший прораба, — кандидат', async () => {
  const w = await workers(scene(), [proc(A, 'EXT-78 · дирижёр'), proc(B, 'EXT-78 · прораб')]);
  assert.equal('foreman' in row(w, A), false);
  const r = pickThread({ threads: w.threads, card: 'EXT-78', now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.sessionId, A);
});

// ---------- pickThread на готовых строках ----------
const th = (n, o = {}) => ({ sessionId: `0000000${n}-0000-4000-8000-000000000000`, title: `тред ${n}`, project: null, projectBy: null, card: null, state: 'idle', lastSeenAt: iso(NOW - MIN), ...o });

test('EXT-78 (а): прораб с той же карточкой и тред проекта → звонок треду проекта', () => {
  const r = pickThread({ threads: [th(1, { project: 'EXT', projectBy: 'title', card: 'EXT-78', foreman: true }), th(2, { project: 'EXT', projectBy: 'title' })], card: 'EXT-78', now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.sessionId, th(2).sessionId);
  assert.equal(r.target.by, 'project');
});

test('EXT-78 (б): только прораб по карточке и проекту → none; два прораба и один тред карточки → тред карточки', () => {
  assert.deepEqual(pickThread({ threads: [th(1, { project: 'EXT', projectBy: 'title', card: 'EXT-78', foreman: true })], card: 'EXT-78', now: NOW }), { kind: 'none', code: 'EXT' });
  const r = pickThread({ threads: [th(1, { project: 'EXT', card: 'EXT-78', foreman: true }), th(2, { project: 'EXT', card: 'EXT-78', foreman: true }), th(3, { project: 'EXT', card: 'EXT-78' })], card: 'EXT-78', now: NOW });
  assert.equal(r.kind, 'one');
  assert.equal(r.target.by, 'card');
  assert.equal(r.target.sessionId, th(3).sessionId);
});
