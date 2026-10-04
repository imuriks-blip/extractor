// Память треда (EXT-49, спека витрины 2.1 «Память треда»): сколько занято — последняя строка assistant главного треда
// с message.usage (input + cache_creation + cache_read), после compact_boundary без ответа — postTokens; окно — по
// модели из contextWindow (самое длинное совпадение начала имени); порог thresholds.memoryWarnPct; сжатия — строки
// compact_boundary текущей сессии (sessionId строки = sessionId файла). Журналы — подставные, без текстов переписки;
// ожидаемые значения посчитаны вручную из чисел, положенных в строки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildThreads, memoryOf } from '../lib/threads.mjs';
import { loadConfig } from '../lib/config.mjs';
import { tmpDir } from './helpers.mjs';

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.default.json'), 'utf8'));
const SID = 'eeeeeeee-4900-4000-8000-000000000001';
const OLD = 'eeeeeeee-4900-4000-8000-000000000000'; // прежняя сессия продолженного треда
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (m) => new Date(Date.parse('2026-10-04T10:00:00Z') + m * 60000).toISOString();

function asst({ m = 0, model = 'claude-opus-5-5', inp = 0, cc = 0, cr = 0, out = 5000, side = false, sid = SID, uuid = uid() } = {}) {
  return JSON.stringify({ type: 'assistant', uuid, sessionId: sid, timestamp: at(m), isSidechain: side, version: '2.1.300',
    message: { id: `msg_${uuid.slice(-4)}`, model, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ок' }],
      usage: { input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out } } });
}
const compact = ({ m = 0, pre = 700000, post = 13000, sid = SID, uuid = uid() } = {}) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, sessionId: sid,
  timestamp: at(m), isSidechain: false, version: '2.1.300', compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post } });
const user = ({ m = 0, sid = SID } = {}) => JSON.stringify({ type: 'user', uuid: uid(), sessionId: sid, timestamp: at(m), isSidechain: false, version: '2.1.300', message: { role: 'user', content: 'да' } });

function tree(lines, sid = SID) {
  const root = tmpDir('mem-j-');
  const proj = path.join(root, 'C--x');
  fs.mkdirSync(proj);
  const file = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return { root, file };
}
async function memOfLines(lines, sid = SID) {
  const t = tree(lines, sid);
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('mem-i-') });
  await r.refresh();
  return r.sessions().find((s) => s.sessionId === sid).memory;
}

const CW = { 'claude-opus-5-5': 1000000 };

test('обычный ответ: tokens — сумма трёх полей usage (output не входит), модель и время ответа', async () => {
  const mem = await memOfLines([user({ m: 0 }), asst({ m: 1, inp: 5, cc: 1000, cr: 2000, out: 777 }), user({ m: 2 }), asst({ m: 3, inp: 3, cc: 20000, cr: 359997 })]);
  assert.deepEqual(mem, { tokens: 380000, model: 'claude-opus-5-5', at: at(3), compactions: 0 });
});

test('процент и порог: 790 000 из 1 000 000 — 79 %, не жёлтое; 800 000 — 80 %, жёлтое; 380 000 — 38 %', () => {
  const o = { contextWindow: CW, warnPct: 80 };
  const m = (tokens) => memoryOf({ tokens, model: 'claude-opus-5-5', at: at(0), compactions: 0 }, o);
  assert.deepEqual(m(790000), { tokens: 790000, window: 1000000, pct: 79, model: 'claude-opus-5-5', at: at(0), compactions: 0, warn: false });
  assert.deepEqual(m(800000), { tokens: 800000, window: 1000000, pct: 80, model: 'claude-opus-5-5', at: at(0), compactions: 0, warn: true });
  assert.equal(m(799999).pct, 79, 'процент — целая часть: 79,9999 % — ещё 79 и не жёлтое');
  assert.equal(m(799999).warn, false);
  assert.deepEqual([m(380000).pct, m(380000).warn], [38, false]);
});

test('строка субагента (isSidechain) с большим usage не перебивает главный тред', async () => {
  const mem = await memOfLines([asst({ m: 1, cr: 300000 }), asst({ m: 2, cr: 950000, side: true })]);
  assert.equal(mem.tokens, 300000);
  assert.equal(mem.at, at(1));
});

test('после compact_boundary без ответа — postTokens и время сжатия; после ответа — снова usage', async () => {
  const before = [asst({ m: 1, cr: 760000 }), compact({ m: 2, pre: 762435, post: 12258 })];
  const a = await memOfLines(before);
  assert.deepEqual(a, { tokens: 12258, model: 'claude-opus-5-5', at: at(2), compactions: 1 });
  const b = await memOfLines([...before, user({ m: 3 }), asst({ m: 4, cc: 30000, cr: 12000 })]);
  assert.deepEqual(b, { tokens: 42000, model: 'claude-opus-5-5', at: at(4), compactions: 1 });
});

test('копия цепочки после /compact (те же uuid, EXT-41) не возвращает прежний usage', async () => {
  const u1 = uid();
  const mem = await memOfLines([asst({ m: 1, cr: 760000, uuid: u1 }), compact({ m: 2, post: 12000 }), asst({ m: 1, cr: 760000, uuid: u1 })]);
  assert.equal(mem.tokens, 12000);
});

test('сжатия прежней сессии продолженного треда не считаются — только строки со своим sessionId', async () => {
  const mem = await memOfLines([
    asst({ m: 1, cr: 700000, sid: OLD }), compact({ m: 2, sid: OLD }), asst({ m: 3, cr: 700000, sid: OLD }), compact({ m: 4, sid: OLD }),
    asst({ m: 5, cr: 50000 }), compact({ m: 6, post: 9000 }), asst({ m: 7, cr: 60000 }),
  ]);
  assert.equal(mem.compactions, 1);
  assert.equal(mem.tokens, 60000);
});

// Важно 1 Голема: на живых журналах (a08ff646) строка compact_boundary, перенесённая из прежней сессии при продолжении
// треда, несёт sessionId НОВОЙ сессии (время прежнее, parentUuid: null). Решение дирижёра (а): такое сжатие — своё,
// разговор тот же; счёт его включает
test('сжатие, перенесённое в журнал продолженного треда с sessionId новой сессии, засчитывается — разговор тот же', async () => {
  const mem = await memOfLines([
    compact({ m: 1, pre: 998347, post: 22172 }), asst({ m: 2, cr: 80000 }), compact({ m: 3, post: 9000 }), asst({ m: 4, cr: 40000 }),
  ]);
  assert.equal(mem.compactions, 2);
  assert.equal(mem.tokens, 40000);
});

test('неизвестная модель — тысячи без процента и без порога', () => {
  const mem = memoryOf({ tokens: 950000, model: 'claude-haiku-4-5-20251001', at: at(0), compactions: 0 }, { contextWindow: CW, warnPct: 80 });
  assert.deepEqual(mem, { tokens: 950000, window: null, pct: null, model: 'claude-haiku-4-5-20251001', at: at(0), compactions: 0, warn: false });
});

test('окно — самое длинное совпадение начала имени модели', () => {
  const cw = { claude: 100000, 'claude-opus': 200000, 'claude-opus-5-5': 1000000 };
  const w = (model) => memoryOf({ tokens: 100000, model, at: at(0), compactions: 0 }, { contextWindow: cw, warnPct: 80 }).window;
  assert.equal(w('claude-opus-5-5'), 1000000);
  assert.equal(w('claude-opus-4-8'), 200000);
  assert.equal(w('claude-sonnet-5-5'), 100000);
  assert.equal(w('gpt-x'), null);
});

test('журнал без usage — memory: null и у треда, и в выжимке', async () => {
  const mem = await memOfLines([user({ m: 0 })]);
  assert.equal(mem, null);
  assert.equal(memoryOf(null, { contextWindow: CW, warnPct: 80 }), null);
});

test('строка с нулевым usage (<synthetic> — ошибка API, не чтение модели) не перебивает прежний ответ', async () => {
  const mem = await memOfLines([asst({ m: 1, cr: 400000 }), asst({ m: 2, model: '<synthetic>', out: 0 })]);
  assert.deepEqual(mem, { tokens: 400000, model: 'claude-opus-5-5', at: at(1), compactions: 0 });
});

test('хвост дописан — пересчёт по одному хвосту, без перечитывания с начала; итог как у прохода целиком', async () => {
  const head = [user({ m: 0 }), asst({ m: 1, cr: 100000 }), user({ m: 2 })];
  const tail = [asst({ m: 3, cr: 200000 }), compact({ m: 4, post: 11000 })];
  const t = tree(head);
  const r = createJournalReader({ root: t.root, indexDir: tmpDir('mem-i-') });
  await r.refresh();
  assert.equal(r.sessions()[0].memory.tokens, 100000);
  fs.appendFileSync(t.file, tail.map((l) => l + '\n').join(''));
  await r.refresh();
  assert.equal(r.state().lastPassLines, tail.length, 'дочитан только хвост');
  assert.deepEqual(r.sessions()[0].memory, { tokens: 11000, model: 'claude-opus-5-5', at: at(4), compactions: 1 });
  assert.deepEqual(r.sessions()[0].memory, await memOfLines([...head, ...tail]));
});

test('у треда «Кто работает» — memory {tokens, window, pct, model, at, compactions, warn}; без usage — null', () => {
  const board = { hasCode: () => false, hasCard: () => false };
  const now = Date.parse(at(10));
  const procs = [{ pid: 1, sessionId: SID, live: true, status: 'idle', startedAt: now - 3600000, observedAt: now }, { pid: 2, sessionId: OLD, live: true, status: 'idle', startedAt: now - 3600000, observedAt: now }];
  const sess = (sessionId, memory) => ({ sessionId, ivan: { cards: {} }, boardWrites: [], runs: [], thread: { lastAt: at(5) }, memory });
  const w = buildThreads({ procs, sessions: [sess(SID, { tokens: 820000, model: 'claude-opus-5-5', at: at(5), compactions: 2 }), sess(OLD, null)], board, now, contextWindow: CW, memoryWarnPct: 80 });
  const bySid = Object.fromEntries(w.threads.map((t) => [t.sessionId, t.memory]));
  assert.deepEqual(bySid[SID], { tokens: 820000, window: 1000000, pct: 82, model: 'claude-opus-5-5', at: at(5), compactions: 2, warn: true });
  assert.equal(bySid[OLD], null);
});

test('настройки: contextWindow и thresholds.memoryWarnPct в умолчаниях; объект contextWindow живого config.json сливается по ключам', () => {
  assert.deepEqual(DEFAULTS.contextWindow, { 'claude-opus-5-5': 1000000 });
  assert.equal(DEFAULTS.thresholds.memoryWarnPct, 80);
  const dir = tmpDir('mem-cfg-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4349, thresholds: { staleMin: 20 }, contextWindow: { 'claude-sonnet-5-5': 200000 } }));
  const c = loadConfig({ dataDir: dir, defaults: DEFAULTS });
  assert.deepEqual(c.contextWindow, { 'claude-opus-5-5': 1000000, 'claude-sonnet-5-5': 200000 });
  assert.equal(c.thresholds.memoryWarnPct, 80);
  assert.equal(c.thresholds.staleMin, 20);
});
