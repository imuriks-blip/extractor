// ПТ6в, такт 1 (EXT-65, «Перечитать правила»; спека пульта §1.3, §1.7, §1.8, §2.2–2.6, §2.8, §3.4, §4.3, §4.4 п.4, строка ПТ6в §7;
// спека витрины §1.2 «Сообщение Ивана», §2.3 «Не перечитаны»). Сервер: поле missing у пометки oldRules, действие reread, форма
// звонка 2.6, разбор журнала. Ожидания — из спеки и из того, что положено в тест, не из кода под тестом.
// Настоящий plane.py не запускается (подменный fake-plane.mjs); Plane при reread не пишется вовсе — это проверяется.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { restoreIntents } from '../lib/pult/routes.mjs';
import { ringText, ringLine, RING_HEAD } from '../lib/pult/bell.mjs';
import { newSessionState, feedSession, pathKey } from '../lib/journal-parse.mjs';
import { buildMarks, buildWorkers } from '../lib/waiting.mjs';
import { createRulesMoment, parseChronicle } from '../lib/rules-moment.mjs';
import { BOARD_LIB, tmpDir, makeBoard, writeCard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
let intents = 6500;
const nextIntent = () => sid(++intents);
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';

// набор из трёх файлов, как у config.default.json, но в своих путях; vault_root и «домашняя папка» — свои
const VAULT = 'C:\\Users\\imuri\\Documents\\Obsidian Vault';
const HOME = 'C:\\Users\\imuri';
const P_RULES = `${VAULT}\\CLAUDE.md`;
const P_PROTO = `${VAULT}\\unorbis\\_meta\\Субагенты Claude Code.md`;
const P_LAYER = `${HOME}\\.claude\\CLAUDE.md`;
const SET = [P_RULES, P_PROTO, P_LAYER];
const MOMENT = '2026-10-05T10:00:00.000Z';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const T_RULES = '2026-10-05T11:00:00.000Z'; // Read после момента
const T_OLD = '2026-10-05T09:00:00.000Z'; // Read до момента — не в счёт

// ---------------- 1. missing у пометки oldRules (спека витрины §2.3, «В ручках») ----------------

const proc = (sessionId, name = 'EXT') => ({ pid: 1, sessionId, name, live: true, startedAt: Date.parse('2026-10-05T08:00:00Z'), status: 'idle', observedAt: NOW, statusUpdatedAt: NOW });
const boardStub = { hasCard: (id) => id === 'EXT-6', card: () => null, hasCode: (c) => c === 'EXT' };
const sessOf = (sessionId, reread, o = {}) => ({ sessionId, ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: {}, reread, ...o });
const keyOf = pathKey;
const readsOf = (...pairs) => Object.fromEntries(pairs.map(([p, t]) => [keyOf(p), t]));
const marksOf = (sessions, o = {}) => buildMarks({ procs: sessions.map((s) => proc(s.sessionId)), sessions, board: boardStub, now: NOW, rulesAt: MOMENT, reread: SET, vaultRoot: VAULT, homeDir: HOME, ...o });

test('missing: пометка называет ровно непрочитанные файлы набора, в порядке набора; короткое имя — от vault_root или с «~/», путь полный', () => {
  const s = sessOf(sid(1), readsOf([P_PROTO, T_RULES])); // прочитан только протокол
  const [mark] = marksOf([s]).bySession[sid(1)];
  assert.equal(mark.kind, 'oldRules');
  assert.equal(mark.rulesUpdatedAt, MOMENT);
  assert.deepEqual(mark.missing, [{ path: P_RULES, short: 'CLAUDE.md' }, { path: P_LAYER, short: '~/.claude/CLAUDE.md' }]);
});

test('missing: чтение до момента не в счёт; ничего не прочитано — все три; прочитаны все после момента — пометки нет вовсе', () => {
  const stale = sessOf(sid(1), readsOf([P_RULES, T_OLD], [P_PROTO, T_OLD], [P_LAYER, T_RULES]));
  assert.deepEqual(marksOf([stale]).bySession[sid(1)][0].missing.map((x) => x.path), [P_RULES, P_PROTO]);
  assert.deepEqual(marksOf([sessOf(sid(1), {})]).bySession[sid(1)][0].missing.map((x) => x.path), SET);
  const all = sessOf(sid(1), readsOf([P_RULES, T_RULES], [P_PROTO, T_RULES], [P_LAYER, T_RULES]));
  assert.equal(marksOf([all]).bySession[sid(1)], undefined, 'исправный рядом: всё прочитано — пометки нет');
});

test('missing: набор выключен (пуст) — поля нет, прежняя пометка', () => {
  const [mark] = marksOf([sessOf(sid(1), {})], { reread: [] }).bySession[sid(1)];
  assert.deepEqual(mark, { kind: 'oldRules', rulesUpdatedAt: MOMENT });
  assert.equal('missing' in mark, false);
});

test('missing доходит до строки «Кто работает» (buildWorkers → marks треда), у треда без проекта пометки нет', () => {
  const w = buildWorkers({ procs: [proc(sid(1)), proc(sid(2), 'Поиск билетов Рига–Малага')], desktop: () => null, sessions: [sessOf(sid(1), {}), sessOf(sid(2), {})], board: boardStub, maxTurns: () => 90, now: NOW, thresholds: {},
    rulesAt: MOMENT, reread: SET, vaultRoot: VAULT, home: HOME });
  const by = Object.fromEntries(w.threads.map((t) => [t.sessionId, t]));
  assert.equal(by[sid(1)].marks[0].missing.length, 3);
  assert.deepEqual(by[sid(2)].marks, []);
});

test('строка хроники «правила обновлены»: текст после «правила обновлены:» — note момента (звонок 2.6 называет правку)', async () => {
  const dir = tmpDir('chron-');
  fs.writeFileSync(path.join(dir, '2026-10.md'), '04.10 · цех · правила обновлены: старое · EXT-1 · aaaaaaa\n05.10 · цех · правила обновлены: перечитывать правила кнопкой — новый раздел в протоколе · EXT-65 · bbbbbbb\n');
  const NOTE = 'перечитывать правила кнопкой — новый раздел в протоколе · EXT-65 · bbbbbbb'; // всё после двоеточия, как в строке
  assert.equal(parseChronicle([{ name: '2026-10.md', text: fs.readFileSync(path.join(dir, '2026-10.md'), 'utf8') }]).note, NOTE);
  const m = createRulesMoment({ dir, git: async () => '2026-10-05T10:00:00+00:00', repos: ['r'], vaultRepo: null });
  await m.refresh();
  assert.equal(m.get().note, NOTE);
});

// ---------------- 2. Форма звонка (§2.6) ----------------

const rereadWord = (o = {}) => ({ id: 'W-261005-120000-a1b2', at: '2026-10-05T09:00:00.000Z', action: 'reread', card: null, word: 'перечитай правила', paths: [P_RULES, P_LAYER], note: 'кнопка «перечитать» — новый раздел', ...o });
const otherWord = (o = {}) => ({ id: 'W-261005-115900-c3d4', at: '2026-10-05T08:59:00.000Z', action: 'yes', card: 'EXT-7', word: 'да', q: { at: '2026-10-04T09:00:00.000Z', head: 'можно?' }, ...o });
const REREAD_HEAD = 'Слово Ивана · кнопка витрины. Это слово Ивана, как в чате: перечитай правила цеха — прочитай целиком инструментом Read, не поиском и не диффом, каждый файл ниже. '
  + 'Правка, из-за которой просьба: «кнопка «перечитать» — новый раздел» — если она легла и в другой файл правил цеха (Vault `CLAUDE.md`, `unorbis/_meta/`, `~/.claude/`), прочитай и его. '
  + 'Ничего не меняй. Ответь строкой «правила перечитаны»; если до звонка ты ждал ответа Ивана — закончи ответ тем же вопросом.';

test('2.6: звонок «перечитать» — своя форма: фраза, строка слова «без карточки · «перечитай правила»», полные пути по строке; фразы о Б-деле нет', () => {
  const t = ringText([rereadWord()]);
  assert.equal(t, [REREAD_HEAD, `W-261005-120000-a1b2 · ${hhmm('2026-10-05T09:00:00.000Z')} · без карточки · «перечитай правила»`, P_RULES, P_LAYER].join('\n'));
  assert.ok(!t.includes('Б-дел'), 'без фразы о Б-деле');
});

test('2.6: без строки хроники фраза о правке опускается; остальной текст прежний', () => {
  const t = ringText([rereadWord({ note: null })]);
  assert.ok(!t.includes('Правка, из-за которой'));
  assert.ok(t.startsWith('Слово Ивана · кнопка витрины. Это слово Ивана, как в чате: перечитай правила цеха'));
  assert.ok(t.includes('Ничего не меняй. Ответь строкой «правила перечитаны»'));
});

test('2.6, 2.5: вместе с другими словами — отдельным блоком после них; строки слов — как были', () => {
  const t = ringText([rereadWord(), otherWord()]);
  assert.equal(t, [RING_HEAD, ringLine(otherWord()), REREAD_HEAD, `W-261005-120000-a1b2 · ${hhmm('2026-10-05T09:00:00.000Z')} · без карточки · «перечитай правила»`, P_RULES, P_LAYER].join('\n'));
});

// ---------------- 3. Разбор журнала (§1.8 «Разбор журнала») ----------------

const ringJournalLine = (text, o = {}) => ({ parentUuid: null, isSidechain: false, type: 'user', uuid: sid(77), timestamp: '2026-10-05T09:02:00.000Z',
  message: { role: 'user', content: `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${text}\n</system-reminder>` },
  origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', userType: 'external', entrypoint: 'claude-desktop', sessionId: sid(1), version: '2.1.286', ...o });
const askLine = { type: 'assistant', uuid: sid(70), timestamp: '2026-10-05T08:59:00.000Z', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово. Сливать?' }] }, version: '2.1.286' };

test('разбор: звонок «перечитать» — не сообщение Ивана: счётчик, вопрос треда (строка (а)) и время слова не тронуты; «прочитано» даёт', () => {
  const st = newSessionState();
  feedSession(st, askLine);
  const keep = (t) => ({ ...t, lastAt: null }); // lastAt — время любой строки журнала, не слова Ивана
  const before = keep(structuredClone(st.thread));
  assert.equal(st.thread.endTurnQ, true);
  feedSession(st, ringJournalLine(ringText([rereadWord()])));
  assert.equal(st.ivan.count, 0, 'счётчик сообщений Ивана');
  assert.equal(st.ivan.lastAt ?? null, null, 'время слова Ивана (им снимается PARTIAL)');
  assert.deepEqual(keep(st.thread), before, 'вопрос треда не снят');
  assert.equal(st.rings['W-261005-120000-a1b2'], '2026-10-05T09:02:00.000Z', 'статус «прочитано» — по форме звонка');
});

test('разбор: исправный рядом — звонок со словом «да» — сообщение Ивана; звонок со словом и «перечитай» — тоже', () => {
  const a = newSessionState();
  feedSession(a, askLine);
  feedSession(a, ringJournalLine(ringText([otherWord()])));
  assert.equal(a.ivan.count, 1);
  assert.equal(a.thread.endTurnQ, null);
  const b = newSessionState();
  feedSession(b, askLine);
  feedSession(b, ringJournalLine(ringText([rereadWord(), otherWord()])));
  assert.equal(b.ivan.count, 1, 'есть слово кроме «перечитай» — сообщение Ивана, как раньше');
  assert.equal(b.thread.endTurnQ, null);
  assert.deepEqual(Object.keys(b.rings).sort(), ['W-261005-115900-c3d4', 'W-261005-120000-a1b2']);
});

test('разбор: строка слова с карточкой или с припиской после «перечитай правила» — не «перечитать»: сообщение Ивана (метка не подделывается куском строки)', () => {
  const t = (line) => { const st = newSessionState(); feedSession(st, ringJournalLine(`${RING_HEAD}\n${line}`)); return st.ivan.count; };
  assert.equal(t('W-261005-120000-a1b2 · 12:00 · без карточки · «перечитай правила»'), 0, 'образец');
  assert.equal(t('W-261005-120000-a1b2 · 12:00 · EXT-7 · «перечитай правила»'), 1, 'карточка');
  assert.equal(t('W-261005-120000-a1b2 · 12:00 · без карточки · «да» · в ответ на: записей не было · перечитай правила'), 1, 'другое слово');
  assert.equal(t('W-261005-120000-a1b2 · 12:00 · без карточки · «перечитай правила» · и ещё что-то'), 1, 'приписка');
});

test('разбор: PARTIAL снимается словом Ивана, а звонок «перечитать» его не снимает (фикстура разбора: у фоновой сессии PARTIAL вживую не получить)', () => {
  const partials = [{ agentId: 'a1', at: '2026-10-05T08:00:00.000Z', limit: 90, where: 'Agent' }];
  const run = { agentId: 'a1', agentType: 'terminus', cards: ['EXT-6'], starts: ['2026-10-05T07:00:00.000Z'], lastText: null, left: null, alive: false };
  const live = (st) => buildMarks({ procs: [proc(sid(1))], sessions: [sessOf(sid(1), {}, { ivan: st.ivan, runs: [run], partials, thread: st.thread })], board: boardStub, now: NOW, thresholds: {} }).bySession[sid(1)] ?? [];
  const a = newSessionState();
  feedSession(a, ringJournalLine(ringText([rereadWord()])));
  assert.equal(live(a).filter((m) => m.kind === 'partial').length, 1, 'PARTIAL висит (В-3) после звонка «перечитать»');
  const b = newSessionState();
  feedSession(b, ringJournalLine(ringText([otherWord()])));
  assert.equal(live(b).filter((m) => m.kind === 'partial').length, 0, 'исправный: слово Ивана снимает');
});

// ---------------- 4. Действие reread (§1.8) ----------------

const boardDir = makeBoard(tmpDir('reread-board-'), { codes: ['EXT'], cards: [{ id: 'EXT-20', status: 'in-progress', title: 'Обычная' }] });
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-20.log.md'), '### 2026-10-03 12:00 +03:00 · plane · коммент\n\nтекст\n');
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: '2026-10-05T09:30:00.000Z' }));
const regFile = path.join(tmpDir('reread-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

const missing2 = [{ path: P_RULES, short: 'CLAUDE.md' }, { path: P_PROTO, short: 'unorbis/_meta/Субагенты Claude Code.md' }];
const oldMark = (o = {}) => ({ kind: 'oldRules', rulesUpdatedAt: MOMENT, missing: missing2, ...o });
const thread = (id, o = {}) => ({ sessionId: sid(id), title: `тред ${id}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), marks: [oldMark()], rulesReread: null, ...o });

async function setup({ threads = [thread(801)], bell = true, words = false, note = 'кнопка «перечитать» — новый раздел', sessions = () => [], clock = { t: NOW } } = {}) {
  const data = tmpDir('reread-data-');
  const pdir = tmpDir('reread-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'In Progress', comments: [], clock: '2026-10-05T09:20:00.123456Z' }));
  const web = tmpDir('reread-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const bellDir = path.join(data, 'bell');
  const live = { threads };
  const threadsApi = { list: () => ({ threads: live.threads, subagentsCount: 0, unknownStatus: {} }), rulesNote: () => note, state: () => ({ processes: { lastOkAt: '2026-10-05T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions };
  const spawnCalls = [];
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, threads: threadsApi, journals,
    pult: { enabled: true, words, bell, bellDir, actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir, python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: (...a) => { spawnCalls.push(a); throw new Error('запуск процесса при reread не нужен'); }, now: () => clock.t } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const bellLog = (o) => fs.appendFileSync(path.join(bellDir, 'bell.log'), JSON.stringify({ at: new Date(clock.t).toISOString(), ...o }) + '\n');
  const signals = () => (fs.existsSync(bellDir) ? fs.readdirSync(bellDir, { recursive: true }).filter((f) => String(f).endsWith('.ring')) : []);
  return { app, press, get, lines, live, bellDir, bellLog, signals, clock, stateFile, spawnCalls,
    bellGet: (s) => app.inject({ method: 'GET', url: `/api/bell/${s}`, headers: { host: `127.0.0.1:${PORT}` } }).then((x) => x.json()),
    planeState: () => fs.readFileSync(stateFile, 'utf8') };
}
const RR = (id = 801) => ({ action: 'reread', session: sid(id) });

test('reread: тред со старыми правилами — звонок положен; текст — по форме 2.6 с ровно missing; Plane не тронут; pult.words = false не мешает', async () => {
  const s = await setup();
  const plane0 = s.planeState();
  const r = await s.press(RR());
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.match(b.message, /положено — тред услышит, когда закончит ход/);
  const got = await s.bellGet(sid(801));
  assert.deepEqual(got.ids, [b.id]);
  const lines = got.text.split('\n');
  assert.ok(lines[0].startsWith('Слово Ивана · кнопка витрины. Это слово Ивана, как в чате: перечитай правила цеха'));
  assert.ok(lines[0].includes('«кнопка «перечитать» — новый раздел»'));
  assert.equal(lines[1], `${b.id} · ${hhmm(new Date(NOW).toISOString())} · без карточки · «перечитай правила»`);
  assert.deepEqual(lines.slice(2), [P_RULES, P_PROTO], 'пути — ровно missing, посчитанный сервером');
  assert.equal(s.signals().length, 1);
  assert.equal(s.planeState(), plane0, 'Plane не пишется');
  assert.equal(s.spawnCalls.length, 0, 'ни plane.py, ни зеркало не запускались');
  // слово «да» при words = false — 503, а reread шёл
  const yes = await s.press({ action: 'yes', card: 'EXT-20', q: { at: null } });
  assert.equal(yes.statusCode, 503);
});

test('reread: actions.log — asked (action, session, project треда из пометки, missing, без карточки и текста), ring-queued, done; «Мои слова» по проекту показывают его', async () => {
  const s = await setup();
  const b = (await s.press(RR())).json();
  const mine = s.lines().filter((l) => l.id === b.id);
  assert.deepEqual(mine.map((l) => l.step), ['asked', 'ring-queued', 'done']);
  const asked = mine[0];
  assert.equal(asked.action, 'reread');
  assert.equal(asked.session, sid(801));
  assert.equal(asked.project, 'EXT', 'проект — из пометки треда: иначе GET /api/actions?project= и MCP words его не покажут');
  assert.deepEqual(asked.missing, [P_RULES, P_PROTO]);
  assert.equal(asked.card, undefined);
  assert.equal(asked.text, undefined);
  assert.equal(mine[1].target.sessionId, sid(801));
  const rows = await s.get('/api/actions?project=EXT');
  const row = rows.find((x) => x.id === b.id);
  assert.equal(row.action, 'reread');
  assert.equal(row.ring, 'положено');
  assert.equal(row.status, 'done');
  assert.ok((await s.get(`/api/actions?session=${sid(801)}`)).some((x) => x.id === b.id));
});

test('reread: тот же intentId — прежний исход, второго звонка нет', async () => {
  const s = await setup();
  const k = nextIntent();
  const a = (await s.press(RR(), k)).json();
  const again = (await s.press(RR(), k)).json();
  assert.equal(again.id, a.id);
  assert.equal(s.signals().length, 1);
  assert.equal(s.lines().filter((l) => l.step === 'asked').length, 1);
});

test('reread: вход ровно {action, intentId, session} — любое другое поле (missing, пути, q, confirm, text, card, …) — 400, звонка и строк журнала нет', async () => {
  const s = await setup();
  const extra = { missing: ['x'], paths: [P_LAYER], path: P_LAYER, files: [P_LAYER], q: { at: null }, confirm: 'W-261005-120000-a1b2', text: 'правило', card: 'EXT-20',
    pick: sid(801), project: 'EXT', title: 't', kind: 'changed', rowKey: 'k', until: '1h', note: 'x', unknown: 1 };
  for (const [k, v] of Object.entries(extra)) {
    const r = await s.press({ ...RR(), [k]: v });
    assert.equal(r.statusCode, 400, k);
  }
  assert.equal((await s.press({ action: 'reread' })).statusCode, 400, 'session обязателен');
  assert.equal((await s.press({ action: 'reread', session: 'не-uuid' })).statusCode, 400);
  assert.equal(s.lines().length, 0);
  assert.equal(s.signals().length, 0);
  assert.equal((await s.press(RR())).statusCode, 200, 'исправный рядом — ровно три поля проходят');
});

test('reread: отказы §1.8 — 200 с outcome refused и именем в actions.log; ни сигналов, ни ring-queued', async () => {
  const cases = [
    ['thread-closed', { threads: [thread(802)] }, RR(801)],
    ['no-mark', { threads: [thread(801, { marks: [] })] }, RR(801)],
    ['reread-off', { threads: [thread(801, { marks: [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }] })] }, RR(801)],
    ['already-read', { threads: [thread(801, { marks: [], rulesReread: '2026-10-05T11:00:00.000Z' })] }, RR(801)],
    ['bell-off', { bell: false }, RR(801)],
  ];
  for (const [name, opts, body] of cases) {
    const s = await setup(opts);
    const r = await s.press(body);
    assert.equal(r.statusCode, 200, `${name}: не 409`);
    assert.equal(r.json().outcome, 'refused', name);
    const mine = s.lines().filter((l) => l.id === r.json().id);
    assert.equal(mine.at(-1).step, 'refused', name);
    assert.equal(mine.at(-1).refusal, name);
    assert.ok(!mine.some((l) => l.step === 'ring-queued'), name);
    assert.equal(s.signals().length, 0, name);
  }
});

test('reread: пометка без поля missing (набор выключен) и пометка с пустым missing — не звонок', async () => {
  const s = await setup({ threads: [thread(801, { marks: [oldMark({ missing: [] })] })] });
  const r = await s.press(RR());
  assert.equal(r.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'already-read');
  assert.equal(s.signals().length, 0);
});

test('reread: пометки других видов не считаются: у треда только красный PARTIAL — no-mark', async () => {
  const s = await setup({ threads: [thread(801, { marks: [{ kind: 'partial' }] })] });
  const r = await s.press(RR());
  assert.equal(r.json().outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'no-mark');
});

test('reread: коды отказов — в таблице сервера с 200 и после рестарта (restoreIntents), иначе незнакомое имя дало бы 409', async () => {
  const at = new Date(NOW).toISOString();
  for (const name of ['thread-closed', 'no-mark', 'reread-off', 'already-read', 'queued', 'bell-off']) {
    const k = nextIntent();
    const m = restoreIntents([{ id: 'W-261005-120000-0001', step: 'asked', at, client: { intentId: k } }, { id: 'W-261005-120000-0001', step: 'refused', at, refusal: name }], NOW);
    assert.equal((await m.get(k).promise).code, 200, name);
  }
  // исправный рядом: незнакомое имя — 409, как было
  const k = nextIntent();
  const m = restoreIntents([{ id: 'W-261005-120000-0002', step: 'asked', at, client: { intentId: k } }, { id: 'W-261005-120000-0002', step: 'refused', at, refusal: 'нет-такого' }], NOW);
  assert.equal((await m.get(k).promise).code, 409);
});

test('reread queued: второе нажатие, пока слово положено, — отказ queued с id прежнего и его статусом; один звонок; доставлено моложе 10 минут — тоже', async () => {
  const s = await setup();
  const first = (await s.press(RR())).json();
  const r2 = await s.press(RR());
  assert.equal(r2.statusCode, 200);
  const b2 = r2.json();
  assert.equal(b2.outcome, 'refused');
  assert.equal(b2.prev.id, first.id);
  assert.equal(b2.prev.status, 'положено');
  assert.ok(b2.message.includes(first.id));
  assert.equal(s.lines().filter((l) => l.step === 'ring-queued').length, 1, 'второго звонка нет');
  assert.equal(s.signals().length, 1);
  assert.equal((await s.bellGet(sid(801))).ids.length, 1);
  // ждущий прозвонил; такт записал ring-delivered; Read в журнале ещё не видно
  s.bellLog({ sid: sid(801), event: 'ring', ids: [first.id] });
  await s.app.pult.tick();
  s.clock.t = NOW + 9 * 60000;
  const r3 = await s.press(RR());
  assert.equal(r3.json().outcome, 'refused');
  assert.equal(r3.json().prev.status, 'доставлено');
  assert.equal(s.lines().filter((l) => l.step === 'ring-queued').length, 1);
  // исправный рядом: доставлено старше 10 минут, а Read не виден — звонок снова разрешён
  s.clock.t = NOW + 11 * 60000;
  const r4 = await s.press(RR());
  assert.equal(r4.json().outcome, 'ok', JSON.stringify(r4.json()));
  assert.equal(s.lines().filter((l) => l.step === 'ring-queued').length, 2);
});

test('reread queued: другой тред не мешает; «прочитано» (форма звонка в журнале) снимает запрет, пока пометка ещё стоит', async () => {
  const reads = {};
  const s = await setup({ threads: [thread(801), thread(802)], sessions: () => [{ sessionId: sid(801), rings: reads }] });
  const a = (await s.press(RR(801))).json();
  assert.equal((await s.press(RR(802))).json().outcome, 'ok', 'второй тред — свой звонок');
  assert.equal((await s.press(RR(801))).json().outcome, 'refused');
  reads[a.id] = '2026-10-05T12:01:00.000Z'; // тред прочёл звонок, но файлы прочёл не все — пометка осталась
  const again = (await s.press(RR(801))).json();
  assert.equal(again.outcome, 'ok', JSON.stringify(again));
});

test('reread: «сброшено перезапуском» / «не доставлено: тред закрыт» запрет не держат (слова в памяти нет)', async () => {
  const s = await setup();
  const a = (await s.press(RR())).json();
  s.lines(); // журнал
  // отозвать слово так, как это делает витрина: шаг withdrawn у действия
  fs.appendFileSync(path.join(path.dirname(s.bellDir), 'actions.log'), JSON.stringify({ id: a.id, step: 'withdrawn', at: new Date(NOW).toISOString(), action: 'reread', reason: 'restart' }) + '\n');
  // слово ещё в памяти этого запуска, но статус по журналу — «сброшено перезапуском»: запрета нет
  const r = await s.press(RR());
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
});

test('reread: звонок выключен — отказ bell-off 200, а не 503; сигналов нет, шагов ring-* нет', async () => {
  const s = await setup({ bell: false });
  const r = await s.press(RR());
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.ok(!s.lines().some((l) => String(l.step).startsWith('ring-')));
  assert.equal(s.signals().length, 0);
});

test('reread: строка хроники в звонке — по маске витрины (секрет не уходит треду)', async () => {
  const s = await setup({ note: `правка с ключом ${SECRET} внутри` });
  const b = (await s.press(RR())).json();
  assert.equal(b.outcome, 'ok');
  const t = (await s.bellGet(sid(801))).text;
  assert.ok(!t.includes(SECRET), 'секрета в тексте звонка нет');
  assert.ok(t.includes('Правка, из-за которой просьба:'));
});

test('reread: строка хроники длиннее 300 знаков — обрезается до 300', async () => {
  const s = await setup({ note: 'п'.repeat(500) });
  await s.press(RR());
  const t = (await s.bellGet(sid(801))).text;
  const m = t.match(/«(п+)…?»/);
  assert.ok(m, t.slice(0, 200));
  assert.ok([...m[1]].length <= 300);
});

test('reread: ни одна GET-ручка по-прежнему не меняет состояние: два GET /api/bell подряд — одинаковый ответ, actions.log не растёт', async () => {
  const s = await setup();
  await s.press(RR());
  const n = s.lines().length;
  const a = await s.bellGet(sid(801));
  const b = await s.bellGet(sid(801));
  assert.deepEqual(a, b);
  assert.equal(s.lines().length, n);
});
