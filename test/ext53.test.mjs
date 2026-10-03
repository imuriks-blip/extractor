// EXT-53 (вердикт Голема на В10, Важно 1 и 2): счётчики дрейфа разбора журналов в /api/health → readers.journals.drift,
// runsOpen раздельно (runsLive / runsSilent), строка stats ещё и в data/vitrina/stats.log со своей ротацией (гейт Г4).
// Фикстуры — выдуманные строки живой формы, тексты обезличены («<текст>»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { createStatsLog, STATS_KEEP_LINES } from '../lib/server-log.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SID = '11111111-2222-4333-8444-555555555555';
const AG = 'a0123456789abcdef';
const T0 = Date.parse('2026-10-04T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// ---------- строки журнала сессии ----------
const callLine = (name, id, at = T0, input = { prompt: '<текст>', subagent_type: 'terminus', description: '<текст>' }) => ({
  type: 'assistant', uuid: uid(), timestamp: iso(at),
  message: { id: `msg_${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const resultLine = (id, tr, at = T0, extra = {}) => ({
  type: 'user', uuid: uid(), timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '<текст>', ...extra }] }, toolUseResult: tr,
});
const note = ({ id = AG, tu = 'toolu_A', status = 'completed', type = null, at = T0 } = {}) => ({
  type: 'user', uuid: uid(), timestamp: iso(at), origin: { kind: 'task-notification' },
  message: { role: 'user', content: ['<task-notification>', id ? `<task-id>${id}</task-id>` : '', tu ? `<tool-use-id>${tu}</tool-use-id>` : '', type ? `<task-type>${type}</task-type>` : '', status ? `<status>${status}</status>` : '', '<summary><текст></summary>', '</task-notification>'].filter(Boolean).join('\n') },
});
const ivan = (kind = 'human', at = T0) => ({ type: 'user', uuid: uid(), timestamp: iso(at), origin: { kind }, message: { role: 'user', content: '<текст>' } });
// запуск агента AG: вызов Agent и ответ async_launched
const launch = (at = T0) => [callLine('Agent', 'toolu_A', at), resultLine('toolu_A', { status: 'async_launched', agentId: AG }, at)];

function feed(lines) {
  const st = newSessionState();
  for (const d of lines) feedSession(st, d);
  return st;
}
const driftOf = (lines) => feed(lines).drift ?? {};

// ---------- счётчики разбора: незнакомая форма +1, знакомая 0 ----------

test('дрейф: статус уведомления вне END_STATUSES — +1 по значению; знакомый статус и уведомление без статуса — 0', () => {
  assert.deepEqual(driftOf([...launch(), note({ status: 'zzz-new' })]).noteStatus, { 'zzz-new': 1 });
  assert.equal(driftOf([...launch(), note({ status: 'completed' })]).noteStatus, undefined);
  assert.equal(driftOf([...launch(), note({ status: null })]).noteStatus, undefined, 'уведомление без <status> (живая форма event) — не дрейф');
});

test('дрейф: уведомление без <task-id> — +1 по <task-type> (нет — «—»); с id запуска — 0', () => {
  assert.deepEqual(driftOf([...launch(), note({ id: null })]).noteNoId, { '—': 1 });
  assert.deepEqual(driftOf([...launch(), note({ id: null, type: 'zzz-type' })]).noteNoId, { 'zzz-type': 1 });
  const ok = driftOf([...launch(), note()]);
  assert.equal(ok.noteNoId, undefined);
  assert.equal(ok.noteForeignId, undefined);
});

test('дрейф: id уведомления не среди запусков — agentCall, если tool-use-id одного из стартов запуска, иначе other', () => {
  assert.deepEqual(driftOf([...launch(), note({ id: 'a9999999999999999', tu: 'toolu_A' })]).noteForeignId, { agentCall: 1 });
  assert.deepEqual(driftOf([...launch(), note({ id: 'b77777777', tu: 'toolu_B' })]).noteForeignId, { other: 1 });
  assert.equal(driftOf([...launch(), note({ id: AG, tu: 'toolu_A' })]).noteForeignId, undefined);
});

test('дрейф: незнакомый toolUseResult.status у результата Agent — +1 по значению; нет статуса — «—»; completed и async_launched — 0', () => {
  assert.deepEqual(driftOf([callLine('Agent', 'toolu_A'), resultLine('toolu_A', { status: 'queued', agentId: AG })]).resultStatus, { queued: 1 });
  assert.deepEqual(driftOf([callLine('Agent', 'toolu_A'), resultLine('toolu_A', { agentId: AG })]).resultStatus, { '—': 1 });
  assert.equal(driftOf([callLine('Agent', 'toolu_A'), resultLine('toolu_A', { status: 'completed', agentId: AG })]).resultStatus, undefined);
  assert.equal(driftOf(launch()).resultStatus, undefined);
});

test('дрейф: результат как у запуска агента (agentId или async_launched) у инструмента с другим именем — +1 по имени; Agent и Task — 0', () => {
  assert.deepEqual(driftOf([callLine('Spawn', 'toolu_S'), resultLine('toolu_S', { status: 'async_launched', agentId: AG })]).launchName, { Spawn: 1 });
  assert.deepEqual(driftOf([callLine('Spawn', 'toolu_S'), resultLine('toolu_S', { status: 'async_launched' })]).launchName, { Spawn: 1 });
  assert.equal(driftOf(launch()).launchName, undefined);
  assert.equal(driftOf([callLine('Task', 'toolu_T'), resultLine('toolu_T', { status: 'async_launched', agentId: AG })]).launchName, undefined);
  assert.equal(driftOf([callLine('Bash', 'toolu_X', T0, { command: 'ls' }), resultLine('toolu_X', { stdout: '' })]).launchName, undefined, 'обычный инструмент — 0');
});

test('дрейф: незнакомый origin.kind — +1 по значению (строка и вложение); human, task-notification, coordinator, peer — 0', () => {
  assert.deepEqual(driftOf([ivan('robot')]).originKind, { robot: 1 });
  const att = { type: 'attachment', uuid: uid(), timestamp: iso(T0), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<текст>', origin: { kind: 'robot2' } } };
  assert.deepEqual(driftOf([att]).originKind, { robot2: 1 });
  assert.equal(driftOf([ivan('human'), ivan('task-notification'), ivan('coordinator'), ivan('peer')]).originKind, undefined);
});

test('дрейф: повтор той же строки (тот же uuid, копия цепочки после /compact) — 0', () => {
  const lines = [...launch(), note({ status: 'zzz-new' }), ivan('robot')];
  const st = feed([...lines, ...lines]);
  assert.deepEqual(st.drift.noteStatus, { 'zzz-new': 1 });
  assert.deepEqual(st.drift.originKind, { robot: 1 });
});

test('дрейф: значение обрезано до 40 знаков; в словаре не больше 20 значений, остальное — «другие»', () => {
  const long = 'x'.repeat(100);
  const d = driftOf([ivan(long)]).originKind;
  assert.deepEqual(Object.keys(d).map((k) => [...k].length), [40]);
  const many = driftOf(Array.from({ length: 25 }, (_, i) => ivan(`k${i}`))).originKind;
  assert.equal(Object.keys(many).length, 21);
  assert.equal(many['другие'], 5);
  assert.equal(many.k0, 1);
});

// ---------- читатель: /api/health → readers.journals.drift, рестарт, журнал без запуска ----------

function tree(sessionLines, agents = {}) {
  const root = tmpDir('ext53-');
  const proj = path.join(root, 'C--proj');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  const main = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(main, sessionLines.map((d) => JSON.stringify(d) + '\n').join(''));
  const files = {};
  for (const [id, lines] of Object.entries(agents)) {
    files[id] = path.join(proj, SID, 'subagents', `agent-${id}.jsonl`);
    fs.writeFileSync(files[id], lines.map((d) => JSON.stringify(d) + '\n').join(''));
  }
  return { root, main, files };
}
const agentLine = (at, kind = null) => ({ type: 'assistant', isSidechain: true, uuid: uid(), timestamp: iso(at), ...(kind ? { origin: { kind } } : {}), message: { id: `m${n}`, role: 'assistant', content: [{ type: 'text', text: '<текст>' }] } });

test('читатель: drift в state() — счётчики сессий и журналов субагентов, agentLaunchErrors, журнал субагента без запуска', async () => {
  const lines = [...launch(), note({ status: 'zzz-new' }), callLine('Agent', 'toolu_E'), resultLine('toolu_E', {}, T0, { is_error: true })];
  const t = tree(lines, { [AG]: [agentLine(T0), agentLine(T0, 'robot')], aorphan0000000000: [agentLine(T0)] });
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), now: () => new Date(T0) });
  await r.refresh();
  const d = r.state().drift;
  assert.deepEqual(d.noteStatus, { 'zzz-new': 1 });
  assert.deepEqual(d.originKind, { robot: 1 }, 'origin.kind журнала субагента — тоже');
  assert.equal(d.agentLaunchErrors, 1);
  assert.equal(d.orphanAgentJournals, 1);
  // исправный случай: у журнала субагента есть запуск, ошибок запуска нет
  const ok = tree(launch(), { [AG]: [agentLine(T0)] });
  const r2 = createJournalReader({ root: ok.root, indexDir: tmpDir('index-'), now: () => new Date(T0) });
  await r2.refresh();
  assert.deepEqual(r2.state().drift, { noteStatus: {}, noteNoId: {}, noteForeignId: {}, resultStatus: {}, launchName: {}, originKind: {}, agentLaunchErrors: 0, orphanAgentJournals: 0 });
});

test('читатель: журнал субагента, чей вызов Agent ещё без результата (toolUseId из .meta.json среди ждущих), — не «без запуска»', async () => {
  const t = tree([callLine('Agent', 'toolu_P')], { [AG]: [agentLine(T0)] });
  fs.writeFileSync(t.files[AG].replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'terminus', toolUseId: 'toolu_P' }));
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), now: () => new Date(T0) });
  await r.refresh();
  assert.equal(r.state().drift.orphanAgentJournals, 0);
});

test('читатель: рестарт из индекса — счёт сохранён, хвост не перечитан; дописанная строка той же формы — +1', async () => {
  const t = tree([...launch(), note({ status: 'zzz-new' }), ivan('robot')]);
  const indexDir = tmpDir('index-');
  const r1 = createJournalReader({ root: t.root, indexDir, now: () => new Date(T0) });
  await r1.refresh();
  r1.flush();
  const r2 = createJournalReader({ root: t.root, indexDir, now: () => new Date(T0) });
  await r2.refresh();
  assert.equal(r2.state().lastPassLines, 0);
  assert.deepEqual(r2.state().drift, r1.state().drift);
  assert.deepEqual(r2.state().drift.originKind, { robot: 1 });
  fs.appendFileSync(t.main, JSON.stringify(ivan('robot')) + '\n');
  await r2.refresh({ full: true }); // полный обход: горячесть журнала по mtime не зависит от подменённых часов
  assert.deepEqual(r2.state().drift.originKind, { robot: 2 });
});

// ---------- runsOpen = runsLive + runsSilent ----------

test('runsSilent: живой запуск без событий дольше порога — без вестей; новая строка журнала субагента — снова живой', async () => {
  let clock = T0 + 10 * 60000;
  const t = tree(launch(T0), { [AG]: [agentLine(T0 + 5 * 60000)] });
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), now: () => new Date(clock), runSilentMin: 30 });
  await r.refresh();
  let s = r.state();
  assert.deepEqual([s.runsOpen, s.runsLive, s.runsSilent], [1, 1, 0], 'событие 5 мин назад — живой');
  clock = T0 + 36 * 60000;
  s = r.state();
  assert.deepEqual([s.runsOpen, s.runsLive, s.runsSilent], [1, 0, 1], 'последняя строка агента 31 мин назад — без вестей');
  fs.appendFileSync(t.files[AG], JSON.stringify(agentLine(T0 + 35 * 60000)) + '\n');
  await r.refresh({ full: true });
  s = r.state();
  assert.deepEqual([s.runsOpen, s.runsLive, s.runsSilent], [1, 1, 0], 'новая строка агента — живой');
});

test('runsSilent: событие запуска в журнале сессии (SendMessage) — свежая весть; порог по умолчанию 30 мин', async () => {
  let clock = T0 + 40 * 60000;
  const send = [callLine('SendMessage', 'toolu_M', T0 + 39 * 60000, { to: AG, message: '<текст>' }), resultLine('toolu_M', { success: true }, T0 + 39 * 60000)];
  const t = tree([...launch(T0), ...send]);
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), now: () => new Date(clock) });
  await r.refresh();
  assert.deepEqual([r.state().runsLive, r.state().runsSilent], [1, 0]);
  clock = T0 + 39 * 60000 + 30 * 60000 + 1000;
  assert.deepEqual([r.state().runsLive, r.state().runsSilent], [0, 1]);
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'config.default.json'), 'utf8'));
  assert.equal(c.thresholds.runSilentMin, 30);
});

// ---------- uuidKeys (EXT-41: рост множества прочитанных uuid) ----------

test('uuidKeys: число ключей во множествах прочитанных uuid; повтор строки не добавляет', async () => {
  const lines = [...launch(), ivan('human')];
  const t = tree([...lines, ...lines]);
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('index-'), now: () => new Date(T0) });
  await r.refresh();
  assert.equal(r.uuidKeys(), 3);
});

// ---------- stats.log: своя ротация, ≥ 7 суток при шаге 10 мин ----------

test('stats.log: после переполнения держит не меньше 7 суток строк при шаге 10 мин (1008), последние — целы', () => {
  assert.ok(STATS_KEEP_LINES >= 7 * 24 * 6);
  const f = path.join(tmpDir('stats-'), 'stats.log');
  const log = createStatsLog(f);
  const total = STATS_KEEP_LINES * 2 + 7;
  for (let i = 1; i <= total; i++) log.writeLine(`2026-10-04T00:00:00.000Z stats rss=${i}`);
  const kept = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.ok(kept.length >= 7 * 24 * 6, `строк ${kept.length}`);
  assert.ok(kept.length < total, 'ротация была');
  assert.equal(kept.at(-1), `2026-10-04T00:00:00.000Z stats rss=${total}`);
  const first = Number(kept[0].match(/rss=(\d+)/)[1]);
  assert.deepEqual(kept.map((l) => Number(l.match(/rss=(\d+)/)[1])), Array.from({ length: kept.length }, (_, i) => first + i), 'подряд, без дыр');
});
