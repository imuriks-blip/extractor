// «Правила перечитаны» (EXT-54, спека витрины 2.3): тред по старым правилам, который после момента «правила
// обновлены» сам прочитал (Read в журнале сессии, результат без ошибки) каждый файл набора rulesReread.files, —
// без красной пометки oldRules, с серой строкой «правила перечитаны ДД.ММ ЧЧ:ММ». Фикстура — обезличенные строки
// журнала дирижёра 2fea3135 (03.10): Read протокола 10:16 и CLAUDE.md Vault 10:32 — до момента 13:37 по Риге,
// оба снова в 14:01 — после.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildMarks, buildWorkers } from '../lib/waiting.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const LINES = fs.readFileSync(path.join(FX, 'rules-reread.jsonl'), 'utf8').split('\n').filter(Boolean);
const lines = () => LINES.map((l) => JSON.parse(l));
const SID = '2fea3135-c7db-442b-9907-4d619949881d';
const VAULT = 'C:\\Users\\imuri\\Documents\\Obsidian Vault';
const PROTO = `${VAULT}\\unorbis\\_meta\\Субагенты Claude Code.md`;
const RULES_MD = `${VAULT}\\CLAUDE.md`;
// набор — как его соберёт start.mjs из config.default.json (пути относительно vault_root), разделитель и регистр — другие
const SET = ['c:/users/imuri/documents/obsidian vault/CLAUDE.md', 'C:/Users/imuri/Documents/Obsidian Vault/unorbis/_meta/Субагенты Claude Code.md'];
// момент «правила обновлены» — 03.10 13:37 по Риге
const MOMENT = '2026-10-03T10:37:00.000Z';
// времена строк вызова Read в фикстуре (не результата): протокол 14:01:41, CLAUDE.md 14:01:43 по Риге
const READ_PROTO = '2026-10-03T11:01:41.381Z';
const READ_RULES = '2026-10-03T11:01:43.100Z';

function parse(ls, set = SET) {
  const st = newSessionState();
  for (const d of ls) feedSession(st, d, { reread: set });
  return st;
}
// тред EXT — проект по названию (правило (1)): цеховой
const procs = [{ pid: 1, sessionId: SID, name: 'EXT', live: true, startedAt: Date.parse('2026-10-02T08:00:00Z'), status: 'busy', observedAt: Date.parse('2026-10-03T11:05:00Z'), statusUpdatedAt: Date.parse('2026-10-03T11:05:00Z') }];
const board = { hasCard: (id) => id === 'EXT-6', card: () => null, hasCode: (c) => c === 'EXT' };
const NOW = Date.parse('2026-10-03T11:05:00Z');
const marks = (st, rulesAt = MOMENT, set = SET) => buildMarks({ procs, sessions: [{ sessionId: SID, ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: st.thread, reread: st.reread }], board, now: NOW, rulesAt, reread: set });
// строка результата Read — с ошибкой, в форме живых журналов (0f46083c, 03.07: tool_result is_error, toolUseResult — строка)
const asError = (d) => {
  const e = structuredClone(d);
  e.message.content[0].is_error = true;
  e.toolUseResult = '<текст>';
  return e;
};
const callOf = (d) => d.message.content[0].input?.file_path;

test('EXT-54 разбор: последнее успешное чтение каждого файла набора — время строки вызова; путь без учёта регистра и разделителя', () => {
  const st = parse(lines());
  const got = Object.values(st.reread ?? {}).sort();
  assert.deepEqual(got, [READ_PROTO, READ_RULES]);
});

test('EXT-54 пометка: оба файла прочитаны после момента — пометки oldRules нет, строка «перечитаны» — самое позднее чтение', () => {
  const m = marks(parse(lines()));
  assert.equal(m.bySession[SID], undefined, 'пометок нет');
  assert.equal(m.rulesReread[SID], READ_RULES);
  assert.equal(m.rulesFresh[SID], false, 'тред по-прежнему открыт до момента — не «правила свежие»');
});

test('EXT-54 пометка: прочитан один файл из двух после момента — пометка есть, строки нет', () => {
  // без последнего вызова CLAUDE.md и его результата: CLAUDE.md прочитан только в 10:32, до момента
  const ls = lines().filter((d, i, a) => !(i >= 6 && (callOf(d) === RULES_MD || d.message.content[0].tool_use_id === a[6].message.content[0].id)));
  assert.equal(ls.length, 6);
  const m = marks(parse(ls));
  assert.deepEqual(m.bySession[SID], [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }]);
  assert.equal(m.rulesReread[SID] ?? null, null);
});

test('EXT-54 пометка: оба файла прочитаны только до момента — пометка есть', () => {
  const m = marks(parse(lines().slice(0, 4)));
  assert.deepEqual(m.bySession[SID], [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }]);
  assert.equal(m.rulesReread[SID] ?? null, null);
});

test('EXT-54 разбор: чтение с ошибкой в результате не в счёт', () => {
  const ls = lines();
  ls[7] = asError(ls[7]); // результат последнего Read CLAUDE.md
  const st = parse(ls);
  const m = marks(st);
  assert.deepEqual(m.bySession[SID], [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }]);
  assert.equal(m.rulesReread[SID] ?? null, null);
  assert.deepEqual(Object.values(st.reread).sort(), ['2026-10-03T10:32:20.181Z', READ_PROTO], 'у CLAUDE.md осталось прежнее, удачное чтение');
});

test('EXT-54 разбор: строка субагента (isSidechain) не в счёт', () => {
  const ls = lines().map((d, i) => (i >= 4 ? { ...d, isSidechain: true } : d));
  assert.equal(marks(parse(ls)).bySession[SID]?.[0]?.kind, 'oldRules');
});

test('EXT-54 пометка: новый момент «правила обновлены» после чтения — снова пометка', () => {
  const later = '2026-10-03T12:00:00.000Z';
  const m = marks(parse(lines()), later);
  assert.deepEqual(m.bySession[SID], [{ kind: 'oldRules', rulesUpdatedAt: later }]);
  assert.equal(m.rulesReread[SID] ?? null, null);
});

test('EXT-54 разбор: незавершённый вызов (результат в следующем хвосте) и состояние через JSON — как проход целиком', () => {
  const ls = lines();
  const st = parse(ls.slice(0, 7)); // вызов CLAUDE.md 14:01 есть, результата ещё нет
  const back = JSON.parse(JSON.stringify(st));
  feedSession(back, ls[7], { reread: SET });
  assert.deepEqual(back.reread, parse(ls).reread);
  assert.equal(marks(back).rulesReread[SID], READ_RULES);
});

test('EXT-54 читатель: состояние переживает рестарт из индекса; журнал субагента не в счёт; смена набора — пересбор', async () => {
  const root = tmpDir('journals-');
  const proj = path.join(root, 'C--Users-imuri-Documents-Obsidian-Vault');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  const main = path.join(proj, `${SID}.jsonl`);
  // в журнале сессии — только чтения до момента; чтения после — в журнале субагента
  fs.writeFileSync(main, LINES.slice(0, 4).map((l) => l + '\n').join(''));
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-a1.jsonl'), LINES.slice(4).map((l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true, agentId: 'a1' }) + '\n').join(''));
  const indexDir = tmpDir('index-');
  const r1 = createJournalReader({ root, indexDir, reread: SET });
  await r1.refresh();
  const s1 = r1.sessions().find((x) => x.sessionId === SID);
  assert.deepEqual(Object.values(s1.reread).sort(), ['2026-10-03T10:16:09.937Z', '2026-10-03T10:32:20.181Z'], 'чтения субагента не в счёт');
  r1.flush();
  // дописаны чтения после момента; новый процесс с тем же индексом
  fs.appendFileSync(main, LINES.slice(4).map((l) => l + '\n').join(''));
  const r2 = createJournalReader({ root, indexDir, reread: SET });
  await r2.refresh();
  const s2 = r2.sessions().find((x) => x.sessionId === SID);
  assert.deepEqual(Object.values(s2.reread).sort(), [READ_PROTO, READ_RULES]);
  assert.equal(r2.state().lines, LINES.length + 4, 'после рестарта прочитан только хвост');
  // набор сменился (один файл) — полный пересбор: в состоянии только он
  const r3 = createJournalReader({ root, indexDir, reread: [PROTO] });
  await r3.refresh();
  assert.deepEqual(Object.values(r3.sessions().find((x) => x.sessionId === SID).reread), [READ_PROTO]);
});

test('EXT-54 «Кто работает»: строка «перечитаны» — поле треда, не пометка: не в marks и не в «Ждёт меня»', () => {
  const st = parse(lines());
  const sessions = [{ sessionId: SID, ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: st.thread, reread: st.reread }];
  const w = buildWorkers({ procs, desktop: () => null, sessions, board, maxTurns: () => 90, now: NOW, thresholds: {}, rulesAt: MOMENT, reread: SET });
  const t = w.threads.find((x) => x.sessionId === SID);
  assert.equal(t.rulesReread, READ_RULES);
  assert.deepEqual(t.marks, []);
  assert.deepEqual(w.waiting, []);
  // исправный рядом: без набора — прежнее поведение, пометка oldRules
  const w0 = buildWorkers({ procs, desktop: () => null, sessions, board, maxTurns: () => 90, now: NOW, thresholds: {}, rulesAt: MOMENT });
  const t0 = w0.threads.find((x) => x.sessionId === SID);
  assert.equal(t0.rulesReread, null);
  assert.deepEqual(t0.marks, [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }]);
});

test('EXT-54 тред без проекта (правило (3)) — без «Старых правил» и без «перечитаны»; проект по карточкам — пометка есть', () => {
  const opened = Date.parse('2026-10-02T08:00:00Z');
  const proc = (sessionId, name) => ({ pid: 2, sessionId, name, live: true, startedAt: opened, status: 'idle', observedAt: NOW, statusUpdatedAt: NOW });
  const st = parse(lines()); // перечитал оба файла — но без проекта строки «перечитаны» нет
  const at = '2026-10-03T09:00:00.000Z';
  const sessions = [
    { sessionId: 's-none', ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: {}, reread: {} },
    { sessionId: 's-none-read', ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: {}, reread: st.reread },
    { sessionId: 's-cards', ivan: { cards: { 'EXT-6': { n: 2, firstAt: at, lastAt: at } } }, runs: [], partials: [], boardWrites: [], thread: {}, reread: {} },
  ];
  const w = buildWorkers({ procs: [proc('s-none', 'Поиск билетов Рига–Малага'), proc('s-none-read', 'Ещё тред'), proc('s-cards', 'Без кода в названии')], desktop: () => null, sessions, board, maxTurns: () => 90, now: NOW, thresholds: {}, rulesAt: MOMENT, reread: SET });
  const by = Object.fromEntries(w.threads.map((t) => [t.sessionId, t]));
  assert.equal(by['s-none'].project, null);
  assert.deepEqual(by['s-none'].marks, [], 'без проекта — пометки нет');
  assert.equal(by['s-none-read'].rulesReread, null, 'без проекта — строки «перечитаны» нет');
  assert.deepEqual(by['s-none-read'].marks, []);
  assert.equal(by['s-cards'].projectBy, 'cards');
  assert.deepEqual(by['s-cards'].marks, [{ kind: 'oldRules', rulesUpdatedAt: MOMENT }], 'проект по карточкам — цеховой, пометка есть');
});
