// EXT-107 Р2 (спека витрины, раздел «EXT-107», Р2): событие «тред сжат». Строка памяти треда — «сжат ЧЧ:ММ · 800 тыс. →
// 16 тыс. · вручную» (или «· сам») обычным цветом, пока не прошло thresholds.compactShowH (12 ч); позже — прежнее бледное
// «сжат N раз». memory.lastCompact {at, trigger, pre, post, durationMs} | null. Тост — только при trigger auto (И-3 (а),
// слово Ивана 14.10), ключ compact|<время строки>|<preTokens>. Гейт Р2 — случаи 1–4.
// Фикстуры — вырезанные строки живых журналов (текст ответа под заглушкой, cwd/gitBranch/slug/entrypoint и
// preservedSegment/preservedMessages/preCompactDiscoveredTools убраны): ext107-compact-manual — 5a543d06 строки 1965
// (assistant с usage) и 1975 (compact_boundary manual 14.10 14:03:10Z, 800 537 → 16 423); ext107-compact-auto — 59af930c
// строки 3284 и 3305 (auto 30.08 20:18:31Z, 998 347 → 22 172); ext107-compact-auto-cont — a08ff646 строки 20 (то же сжатие,
// перенесённое в продолженный тред: новый sessionId, то же время) и 51 (первый ответ с usage после него).
// Пояс задан здесь, до первого Date: ЧЧ:ММ ожидаемого — из времени фикстуры через Intl с явным timeZone, не кодом под тестом.
process.env.TZ = 'Europe/Moscow';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSessionState, feedSession, memorySummary } from '../lib/journal-parse.mjs';
import { buildThreads } from '../lib/threads.mjs';
import * as notify from '../lib/notify.mjs'; // compactToastRows — новое (Р2): через пространство имён
import * as fmt from '../web/src/format.js'; // compactLine — новое (Р2)
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const lines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const src = (...p) => fs.readFileSync(path.join(ROOT, '..', ...p), 'utf8');
const MAN = lines('ext107-compact-manual.jsonl'); // [0] — assistant 14:01:01Z, [1] — compact_boundary manual 14:03:10Z
const AUTO = lines('ext107-compact-auto.jsonl'); // [0] — assistant, [1] — compact_boundary auto 20:18:31Z
const CONT = lines('ext107-compact-auto-cont.jsonl'); // [0] — то же сжатие с sessionId a08ff646, [1] — ответ после него
const HOUR = 3600000;
const atMs = (d) => Date.parse(d.timestamp);
const DEFAULTS = JSON.parse(src('config.default.json'));
const CW = DEFAULTS.contextWindow;
// ЧЧ:ММ по Москве — независимый расчёт (Intl с явным поясом), сверка с литералом спеки «17:03 для 14:03Z»
const msk = (iso) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

const board = { hasCard: () => false, hasCode: (c) => c === 'EXT', cardsList: () => [], card: () => null };
// Сбор как на сервере: разбор журнала → выжимка читателя (memorySummary по sessionId файла) → «Кто работает»
function run(ls, { sid = ls.find((d) => d.sessionId)?.sessionId, now, title = 'EXT · тред', compactShowH } = {}) {
  const st = newSessionState();
  for (const d of ls) feedSession(st, d);
  const sess = { sessionId: sid, lines: ls.length, thread: st.thread, memory: memorySummary(st, sid), okAt: new Date(now).toISOString() };
  const proc = { live: true, sessionId: sid, status: 'idle', statusUpdatedAt: new Date(now - HOUR).toISOString(), startedAt: '2026-08-01T00:00:00.000Z', observedAt: now, name: title };
  const o = { procs: [proc], sessions: [sess], board, now, contextWindow: CW, memoryWarnPct: 80 };
  if (compactShowH !== undefined) o.compactShowH = compactShowH;
  return buildThreads(o).threads[0];
}

test('фикстуры: assistant с usage перед compact_boundary; manual 800 537 → 16 423 в 14:03:10Z; auto и его перенос с новым sessionId', () => {
  assert.equal(MAN[0].type, 'assistant');
  assert.ok(MAN[0].message.usage.cache_read_input_tokens > 0);
  assert.equal(MAN[1].subtype, 'compact_boundary');
  assert.equal(MAN[1].timestamp, '2026-10-14T14:03:10.171Z');
  assert.deepEqual(MAN[1].compactMetadata, { trigger: 'manual', preTokens: 800537, durationMs: 92303, postTokens: 16423, cumulativeDroppedTokens: 784114 });
  assert.equal(msk(MAN[1].timestamp), '17:03', 'спека: TZ=Europe/Moscow → «17:03» для 14:03Z');
  assert.equal(AUTO[1].compactMetadata.trigger, 'auto');
  assert.equal(CONT[0].timestamp, AUTO[1].timestamp);
  assert.equal(CONT[0].compactMetadata.preTokens, AUTO[1].compactMetadata.preTokens);
  assert.notEqual(CONT[0].sessionId, AUTO[1].sessionId);
  assert.equal(CONT[0].sessionId, CONT[1].sessionId, 'перенесённое сжатие несёт sessionId нового файла');
});

// ---------- 1: поломка ----------

test('1 (поломка): manual 800 537 → 16 423, сейчас +1 ч — lastCompact заполнен; строка «сжат 17:03 · 800 тыс. → 16 тыс. · вручную» не бледная', () => {
  const now = atMs(MAN[1]) + HOUR;
  const t = run(MAN, { now });
  assert.deepEqual(t.memory.lastCompact, { at: MAN[1].timestamp, trigger: 'manual', pre: 800537, post: 16423, durationMs: 92303 });
  assert.equal(t.memory.compactions, 1);
  assert.equal(t.memory.tokens, 16423, 'память после сжатия — postTokens (§2.1, прежнее правило)');
  const line = fmt.compactLine?.(t.memory, now);
  assert.deepEqual(line, { text: `сжат ${msk(MAN[1].timestamp)} · 800 тыс. → 16 тыс. · вручную`, faint: false });
  assert.equal(line.text, 'сжат 17:03 · 800 тыс. → 16 тыс. · вручную');
});

test('1: «Цех» и окно проекта — строка памяти из compactLine, класс faint только по её признаку; окно проекта берёт Thread из Ceh.jsx', () => {
  const ceh = src('web', 'src', 'Ceh.jsx');
  assert.match(ceh, /compactLine\(/, 'Memory строит строку сжатия через compactLine');
  assert.doesNotMatch(ceh, /<span className="faint">сжат /, 'прежняя бледная надпись без условия убрана');
  assert.match(src('web', 'src', 'Project.jsx'), /import \{[^}]*\bThread\b[^}]*\} from '\.\/Ceh\.jsx'/);
});

// ---------- 2: ещё поломка ----------

test('2 (ещё поломка): auto — тост ровно один; повтор цикла, рестарт, копия в журнале продолженного треда — без нового тоста', () => {
  const now = atMs(AUTO[1]) + 30 * 60000; // 20:48Z = 23:48 МСК, тот же день
  const t = run(AUTO, { now, title: 'EXT · дирижёр' });
  assert.equal(t.memory.lastCompact.trigger, 'auto');
  assert.equal(fmt.compactLine?.(t.memory, now)?.text, `сжат ${msk(AUTO[1].timestamp)} · 998 тыс. → 22 тыс. · сам`);
  // через местную полночь (00:18 МСК 31.08) — с датой, как у прочих «ЧЧ:ММ» витрины (hm): «сжат 30.08 23:18 …»
  assert.equal(fmt.compactLine?.(t.memory, atMs(AUTO[1]) + HOUR)?.text, `сжат 30.08 ${msk(AUTO[1].timestamp)} · 998 тыс. → 22 тыс. · сам`);
  const rows = notify.compactToastRows?.([t]);
  assert.deepEqual(rows, [{ key: `compact|${AUTO[1].timestamp}|998347`, title: 'EXT · дирижёр сжат', body: `998 тыс. → 22 тыс. токенов, ${msk(AUTO[1].timestamp)}`, group: 'compact' }]);

  const file = path.join(tmpDir('ext107-compact-'), 'notified.json');
  const shown = [];
  const mk = () => notify.createNotifier({ file, show: (r) => shown.push(r) });
  const n1 = mk();
  assert.equal(n1.cycle(rows), 1);
  assert.equal(n1.cycle(notify.compactToastRows([run(AUTO, { now: now + 60000, title: 'EXT · дирижёр' })])), 0, 'повтор цикла');
  const n2 = mk(); // рестарт: тот же notified.json
  assert.equal(n2.cycle(notify.compactToastRows([t])), 0, 'рестарт');
  const cont = run(CONT, { now: now + 120000, title: 'EXT · дирижёр (продолжение)' });
  assert.equal(cont.memory.lastCompact?.at, AUTO[1].timestamp, 'перенесённое сжатие — своё');
  assert.equal(n2.cycle(notify.compactToastRows([cont])), 0, 'копия в продолженном треде');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'EXT · дирижёр сжат');
});

test('2: сервер подаёт строки сжатия в цикл тостов (start.mjs) отдельно от «Ждёт меня»', () => {
  // по коду, не по комментариям (ревью Голема, Мелочь 1): строки «Кто работает» того же расчёта — в цикл тостов;
  // срок — config.thresholds → buildWorkers → buildThreads({ compactShowH: th.compactShowH })
  const code = (f) => src('lib', f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const s = code('start.mjs');
  assert.match(s, /\.\.\.compactToastRows\(\s*c\.workers\?\.threads\s*\)/);
  assert.match(s, /buildWorkers\(\{[^;]*?thresholds: config\.thresholds \?\? \{\}/);
  assert.match(code('waiting.mjs'), /buildThreads\(\{[^;]*?compactShowH: th\.compactShowH \}\)/);
});

// ---------- 3: исправный ----------
// Регрессы: на коде до правки (e60aff5) зелёные. Поля lastCompact там нет (`?? null`), функций Р2 нет: тоста нет
// (`?? []`), бледная надпись «сжат N раз» живёт в Ceh.jsx — проверяется по исходнику; после правки — через compactLine.
const faintLine = (m, now) => (fmt.compactLine
  ? fmt.compactLine(m, now)
  : (/<span className="faint">сжат \{m\.compactions\} \{timesWord\(m\.compactions\)\}<\/span>/.test(src('web', 'src', 'Ceh.jsx')) && m.compactions > 0 ? { text: `сжат ${m.compactions} раз`, faint: true } : null));
const toasts = (threads) => notify.compactToastRows?.(threads) ?? [];

test('3 (исправный): журнал без compact_boundary — lastCompact null, строки нет, без тоста', () => {
  const now = atMs(MAN[0]) + HOUR;
  const t = run(MAN.slice(0, 1), { now });
  assert.equal(t.memory.lastCompact ?? null, null);
  assert.equal(t.memory.compactions, 0);
  assert.equal(faintLine(t.memory, now), null);
  assert.deepEqual(toasts([t]), []);
});

test('3 (исправный): сжатие старше 12 ч — lastCompact null, бледное «сжат 1 раз»; manual в срок — без тоста; нечисловой или ≤ 0 срок — умолчание', () => {
  const late = atMs(MAN[1]) + 13 * HOUR;
  const t = run(MAN, { now: late });
  assert.equal(t.memory.lastCompact ?? null, null);
  assert.equal(t.memory.compactions, 1);
  assert.deepEqual(faintLine(t.memory, late), { text: 'сжат 1 раз', faint: true });
  for (const h of [0, -1, 'x', null]) assert.equal(run(MAN, { now: late, compactShowH: h }).memory.lastCompact ?? null, null, `compactShowH ${h}`);
  assert.deepEqual(toasts([run(MAN, { now: atMs(MAN[1]) + HOUR })]), [], 'manual — тоста нет (И-3 (а))');
});

test('3 (исправный): сжатие чужой сессии (строка с прежним sessionId) — не своё: lastCompact null, счёт 0', () => {
  const foreign = structuredClone(MAN);
  foreign[1].sessionId = 'ffffffff-0000-4000-8000-000000000000';
  const t = run(foreign, { sid: MAN[0].sessionId, now: atMs(MAN[1]) + HOUR });
  assert.equal(t.memory.lastCompact ?? null, null);
  assert.equal(t.memory.compactions, 0);
});

// ---------- 1а: настройка срока (новое — красное до правки) ----------

test('1а: compactShowH — умолчание 12 в config.default.json; 24 — держит 13 ч; нечисловое при 11 ч — умолчание держит', () => {
  assert.equal(DEFAULTS.thresholds.compactShowH, 12);
  const late = atMs(MAN[1]) + 13 * HOUR;
  assert.equal(run(MAN, { now: late, compactShowH: 24 }).memory.lastCompact?.at, MAN[1].timestamp);
  // нечисловое или ≤ 0 — умолчание 12 ч: сжатие 11 ч назад держится (без «> 0» срок 0 или −1 его бы снял — ревью Голема, Важно 1)
  for (const h of ['x', 0, -1]) assert.equal(run(MAN, { now: atMs(MAN[1]) + 11 * HOUR, compactShowH: h }).memory.lastCompact?.at, MAN[1].timestamp, `compactShowH ${h}`);
});

// ---------- 4: край ----------

test('4 (край): строка без compactMetadata — «сжат 17:03» без чисел и без способа, не падение; без тоста', () => {
  const ls = structuredClone(MAN);
  delete ls[1].compactMetadata;
  const now = atMs(ls[1]) + HOUR;
  const t = run(ls, { now });
  assert.deepEqual(t.memory.lastCompact, { at: ls[1].timestamp, trigger: null, pre: null, post: null, durationMs: null });
  assert.deepEqual(fmt.compactLine?.(t.memory, now), { text: 'сжат 17:03', faint: false });
  assert.deepEqual(notify.compactToastRows?.([t]), []);
});
