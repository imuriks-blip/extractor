// EXT-84: экран «Расход» (спека пульта §6) — объём из журналов (usage строк ассистента), предупреждение, остаток из
// виденного rate_limit_event, GET /api/usage. Фикстуры — во временной папке; ожидания — из чисел, положенных в фикстуру.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { createUsage, buildUsage, NO_USAGE, dayKey } from '../lib/usage.mjs';
import { createRateLimitReader, NOTE_NONE } from '../lib/rate-limit.mjs';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);

const H = 3600000;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const board = { hasCode: (c) => ['EXT', 'BW'].includes(c), hasCard: () => false, mirrorIndex: () => null };
let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
// usage в форме живого журнала: четыре числа (in, out, cacheRead, cacheWrite)
const us = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens_details: { thinking_tokens: 0 } });
const asst = (id, ms, usage, extra = {}) => ({ type: 'assistant', uuid: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, timestamp: iso(ms), sessionId: 's', isSidechain: false, version: '2.1.0',
  message: { id, role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage }, ...extra });
const jl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

// дерево журналов: <корень>/<проект>/<sid>.jsonl и <sid>/subagents/agent-<id>.{jsonl,meta.json}
function world() {
  const root = tmpDir('usage-j-');
  const proj = path.join(root, 'C--proj');
  fs.mkdirSync(proj, { recursive: true });
  return {
    root,
    session(sid, rows) { fs.writeFileSync(path.join(proj, `${sid}.jsonl`), jl(rows)); return path.join(proj, `${sid}.jsonl`); },
    append(sid, rows) { fs.appendFileSync(path.join(proj, `${sid}.jsonl`), jl(rows)); },
    agent(sid, id, rows, type = null) {
      const d = path.join(proj, sid, 'subagents');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `agent-${id}.jsonl`), jl(rows));
      if (type) fs.writeFileSync(path.join(d, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: 'd' }));
    },
  };
}
const rd = (root, indexDir = tmpDir('usage-i-')) => createJournalReader({ root, indexDir, now: () => new Date(NOW) });
async function payload(w, { reader, rateLimit = null, titleOf = () => null, cfg = {} } = {}) {
  const r = reader ?? rd(w.root);
  await r.refresh();
  const usage = createUsage({ journals: r, rateLimit, board, titleOf, now: () => NOW, cfg, cacheMs: 0 });
  usage.tick(); // как опрос витрины: признак «прораб» ставит он, не ручка
  return usage.payload();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('(а) одно сообщение — несколько строк с одним message.id и той же usage: считается один раз', async () => {
  const w = world();
  const t = NOW - 2 * H;
  w.session('sa', [asst('msg_1', t, us(10, 20, 300, 4)), asst('msg_1', t + 500, us(10, 20, 300, 4)), asst('msg_1', t + 900, us(10, 20, 300, 4)), asst('msg_2', t + 5000, us(1, 2, 3, 4))]);
  const p = await payload(w);
  // 10+20+300+4 один раз + 1+2+3+4
  assert.equal(p.today.total, 334 + 10);
  assert.deepEqual([p.today.in, p.today.out, p.today.cacheRead, p.today.cacheWrite], [11, 22, 303, 8]);
});

test('(б) продолжение треда копирует прежние строки в новый файл: дубль message.id между файлами — один раз, владелец — прежний файл', async () => {
  const w = world();
  const t = NOW - 3 * H;
  w.session('s-old', [asst('msg_a', t, us(100, 0, 0, 0)), asst('msg_b', t + 1000, us(0, 50, 0, 0))]);
  await sleep(30); // файл копии создан позже: bornMs у владельца раньше
  // копия: те же строки (id, время), sessionId у строки другой; плюс своя новая реплика
  w.session('s-new', [asst('msg_a', t, us(100, 0, 0, 0), { sessionId: 's-new' }), asst('msg_b', t + 1000, us(0, 50, 0, 0), { sessionId: 's-new' }), asst('msg_c', t + 2000, us(7, 0, 0, 0), { sessionId: 's-new' })]);
  const p = await payload(w);
  assert.equal(p.today.total, 100 + 50 + 7, 'копия не удваивает');
  const by = Object.fromEntries(p.byThread.week.map((r) => [r.sessionId, r.total]));
  assert.deepEqual(by, { 's-old': 150, 's-new': 7 }, 'сообщения копии — у прежнего файла, новая реплика — у нового');
});

test('строка без message.id: ключ — uuid строки; без uuid — «файл#номер строки»; не теряется и не удваивается', async () => {
  const w = world();
  const t = NOW - H;
  const noId = (ms, usage, uuid) => { const r = asst('x', ms, usage); delete r.message.id; if (uuid === null) delete r.uuid; else if (uuid) r.uuid = uuid; return r; };
  const same = noId(t, us(5, 0, 0, 0), '11111111-1111-4111-8111-111111111111');
  w.session('sn', [same, noId(t + 10, us(0, 6, 0, 0), null), noId(t + 20, us(0, 6, 0, 0), null)]);
  // вторая копия той же строки (тот же uuid) в другой сессии — не удваивается
  w.session('sn2', [{ ...same, sessionId: 'sn2' }]);
  const p = await payload(w);
  assert.equal(p.today.total, 5 + 6 + 6, 'две строки без id и uuid — обе считаются (разные номера строк); строка с uuid — один раз');
});

test('сутки — по местному времени: граница полуночи, в трёх поясах (TZ задаётся в тесте)', () => {
  const was = process.env.TZ;
  try {
    // [пояс, UTC-момент последней секунды вчерашних суток, первой секунды сегодняшних] при now = 2026-10-08T10:00Z
    const cases = [['Asia/Tokyo', '2026-10-07T14:59:59Z', '2026-10-07T15:00:01Z', '2026-10-07', '2026-10-08'],
      ['America/Los_Angeles', '2026-10-08T06:59:59Z', '2026-10-08T07:00:01Z', '2026-10-07', '2026-10-08'],
      ['Europe/Riga', '2026-10-07T20:59:59Z', '2026-10-07T21:00:01Z', '2026-10-07', '2026-10-08']];
    for (const [tz, before, after, dayA, dayB] of cases) {
      process.env.TZ = tz;
      const nowMs = Date.parse('2026-10-08T10:00:00Z');
      const rec = (at, n) => ({ t: Date.parse(at), in: n, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main' });
      const p = buildUsage({ records: [rec(before, 1), rec(after, 10)], nowMs });
      const byDay = Object.fromEntries(p.days.map((d) => [d.date, d.total]));
      assert.equal(byDay[dayA], 1, `${tz}: секунда до полуночи — вчера`);
      assert.equal(byDay[dayB], 10, `${tz}: секунда после — сегодня`);
      assert.equal(p.today.date, dayB);
      assert.equal(p.today.total, 10);
      assert.equal(p.days.length, 7);
      assert.equal(p.week.total, 11);
    }
    // исправный: полдень внутри суток — одни сутки в любом поясе
    process.env.TZ = 'Europe/Riga';
    assert.equal(dayKey(Date.parse('2026-10-08T09:00:00Z')), '2026-10-08');
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test('тред без проекта — отдельный ключ; тред с кодом в названии — свой проект (§1.4 витрины)', async () => {
  const w = world();
  const t = NOW - H;
  w.session('s-ext', [{ type: 'custom-title', customTitle: 'EXT · расход', sessionId: 's-ext' }, asst('m1', t, us(10, 0, 0, 0))]);
  w.session('s-none', [{ type: 'custom-title', customTitle: 'просто разговор', sessionId: 's-none' }, asst('m2', t, us(3, 0, 0, 0))]);
  const p = await payload(w);
  const proj = Object.fromEntries(p.byProject.week.map((r) => [String(r.project), r]));
  assert.equal(proj.EXT.total, 10);
  assert.equal(proj.null.total, 3);
  assert.equal(proj.null.label, 'без проекта');
  const th = Object.fromEntries(p.byThread.week.map((r) => [r.sessionId, r]));
  assert.equal(th['s-ext'].title, 'EXT · расход');
  assert.equal(th['s-ext'].project, 'EXT');
  assert.equal(th['s-none'].project, null);
});

test('субагент считается отдельно от главной сессии, имя типа — из .meta.json', async () => {
  const w = world();
  const t = NOW - H;
  w.session('sm', [asst('main1', t, us(100, 0, 0, 0)), asst('side-in-session', t + 5, us(0, 0, 0, 9), { isSidechain: true })]);
  w.agent('sm', 'abc123', [asst('ag1', t + 10, us(0, 40, 0, 0), { isSidechain: true }), asst('ag1', t + 11, us(0, 40, 0, 0), { isSidechain: true }), asst('side-in-session', t + 5, us(0, 0, 0, 9), { isSidechain: true })], 'terminus');
  const p = await payload(w);
  const ag = Object.fromEntries(p.byAgent.week.map((r) => [r.agent, r]));
  assert.equal(ag.main.total, 100);
  assert.equal(ag.main.label, 'главная сессия');
  assert.equal(ag.terminus.total, 40 + 9, 'сообщение субагента, лежащее и в журнале сессии, — один раз, у субагента');
  assert.equal(ag.terminus.label, 'Терминус');
  assert.equal(p.week.total, 149);
});

test('прораб — сессия из семьи запуска (по журналу дирижёра); признак запоминается в индексе', async () => {
  const w = world();
  const t = NOW - H;
  const cwd = 'C:\\work\\copy-1';
  const launch = { type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: iso(t), sessionId: 'conductor', isSidechain: false, version: '2.1.0', cwd: 'C:\\work\\main',
    message: { id: 'c1', role: 'assistant', model: 'm', stop_reason: 'tool_use', usage: us(5, 0, 0, 0),
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `node C:\\tools\\foreman-launch.mjs --card X-1 --cwd ${cwd}` } }] } };
  w.session('conductor', [launch]);
  w.session('foreman1', [{ type: 'user', uuid: 'bbbbbbbb-0000-4000-8000-000000000001', timestamp: iso(t + 60000), sessionId: 'foreman1', cwd, version: '2.1.0', message: { role: 'user', content: 'старт' } }, asst('f1', t + 70000, us(0, 0, 0, 77))]);
  const idx = tmpDir('usage-i-');
  const r = rd(w.root, idx);
  const p = await payload(w, { reader: r });
  const ag = Object.fromEntries(p.byAgent.week.map((x) => [x.agent, x.total]));
  assert.deepEqual(ag, { main: 5, foreman: 77 });
  r.flush(); // штатная остановка: признак (dirty) записан в индекс
  // индекс пережил рестарт: признак на месте
  const r2 = rd(w.root, idx);
  await r2.refresh();
  assert.equal(r2.usageRecords(0).find((x) => x.sessionId === 'foreman1').agent, 'foreman');
});

test('остаток: событие в прогоне — поля, возраст на момент ответа; нет события и пустая папка — null и строка', async () => {
  const runs = tmpDir('usage-runs-');
  const mk = (name, lines, mtimeS) => { const d = path.join(runs, name); fs.mkdirSync(d); const f = path.join(d, 'stream.jsonl'); fs.writeFileSync(f, lines.map((l) => `${l}\n`).join('')); fs.utimesSync(f, mtimeS, mtimeS); };
  const ev = (five, seven, st = 'allowed') => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: st, resetsAt: 1791331200, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: five, resetsAt: 1791331200 }, seven_day: { utilization: seven, resetsAt: 1791810000 } } }, uuid: 'u' });
  const nowS = NOW / 1000;
  mk('old', [ev(0.1, 0.1)], nowS - 5000);
  mk('new', [ev(0.2, 0.3), JSON.stringify({ type: 'assistant', message: { id: 'z' } }), ev(0.41, 0.79, 'allowed_warning'), '{"type":"system"}'], nowS - 120);
  mk('nothing', [JSON.stringify({ type: 'system' })], nowS - 10);
  let clock = NOW;
  const rl = createRateLimitReader({ dir: runs, maxRuns: 10, everyMs: 30000, now: () => clock });
  const a = rl.get();
  assert.equal(a.note, null);
  assert.equal(a.remaining.fiveHour.utilization, 0.41, 'последнее событие самого свежего прогона, где оно есть');
  assert.equal(a.remaining.sevenDay.utilization, 0.79);
  assert.equal(a.remaining.fiveHour.resetsAt, new Date(1791331200 * 1000).toISOString());
  assert.equal(a.remaining.status, 'allowed_warning');
  assert.equal(a.remaining.ageSec, 120);
  assert.equal(a.remaining.eventAt, iso((nowS - 120) * 1000));
  clock += 20000; // меньше 30 с — скан не повторяется, возраст растёт
  assert.equal(rl.get().remaining.ageSec, 140);
  // maxRuns = 1: смотрится только самый свежий прогон («nothing»), событий в нём нет
  const one = createRateLimitReader({ dir: runs, maxRuns: 1, now: () => NOW }).get();
  assert.equal(one.remaining, null);
  assert.equal(one.note, NOTE_NONE);
  // папки нет
  assert.equal(createRateLimitReader({ dir: path.join(runs, 'нет'), now: () => NOW }).get().note, NOTE_NONE);
});

test('(в) stream.jsonl прогона в объём не попадает: тот же message.id в прогоне объём не удваивает; событие лимита — берётся', async () => {
  const w = world();
  const t = NOW - 2 * H;
  w.session('sv', [asst('msg_same', t, us(40, 0, 0, 0))]);
  const runs = tmpDir('usage-runs-');
  fs.mkdirSync(path.join(runs, 'r1'));
  const f = path.join(runs, 'r1', 'stream.jsonl');
  // EXT-87: остаток новой формы — событие должно быть свежим (30 мин) и окно не сменившимся: файл не старше 2 мин, resetsAt в будущем
  fs.writeFileSync(f, jl([asst('msg_same', t, us(40, 0, 0, 0)), asst('msg_other', t + 1, us(999, 0, 0, 0))]) + JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: NOW / 1000 + 3600 } } } }) + '\n');
  fs.utimesSync(f, NOW / 1000 - 120, NOW / 1000 - 120);
  const p = await payload(w, { rateLimit: createRateLimitReader({ dir: runs, now: () => NOW }) });
  assert.equal(p.week.total, 40, 'только журнал треда');
  assert.equal(p.remaining.source, 'foreman');
  assert.equal(p.remaining.fiveHour.utilization, 0.5);
  assert.deepEqual(p.remaining.sevenDay, { utilization: null, resetsAt: null, fresh: false }, 'окна нет в событии — null, не выдумка');
});

// окно k (1…) — середина k-го полного 5-часового окна назад от NOW
const atWindow = (k, n) => ({ t: NOW - (k * 5 + 2.5) * H, in: n, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main' });
test('предупреждение: выше порога — warn; ниже — нет; пустые окна в медиану не идут; мало данных — нет предупреждения', () => {
  const prev = [1, 3, 5, 7, 9].map((k) => atWindow(k, 100)); // пять непустых окон по 100, между ними пустые
  const cur = (n) => ({ t: NOW - 1 * H, in: n, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main' });
  const hi = buildUsage({ records: [...prev, cur(200)], nowMs: NOW }).window5h;
  assert.equal(hi.enough, true);
  assert.equal(hi.median, 100);
  assert.equal(hi.total, 200);
  assert.equal(hi.warn, true);
  assert.match(hi.message, /выше обычного/);
  const lo = buildUsage({ records: [...prev, cur(140)], nowMs: NOW }).window5h;
  assert.equal(lo.warn, false, '140 < 1,5 × 100');
  const edge = buildUsage({ records: [...prev, cur(150)], nowMs: NOW }).window5h;
  assert.equal(edge.warn, false, 'ровно на пороге — «больше», не «не меньше»');
  const own = buildUsage({ records: [...prev, cur(120)], nowMs: NOW, cfg: { warnFactor: 1.1 } }).window5h;
  assert.equal(own.warn, true, 'порог — настройка pult.usage.warnFactor');
  const few = buildUsage({ records: [atWindow(1, 100), atWindow(2, 100), cur(100000)], nowMs: NOW }).window5h;
  assert.equal(few.enough, false);
  assert.equal(few.warn, false);
  assert.match(few.message, /мало данных/);
  // окно старше 33-го в медиану не входит
  const far = buildUsage({ records: [atWindow(34, 100), atWindow(1, 100), atWindow(2, 100), cur(1)], nowMs: NOW }).window5h;
  assert.equal(far.enough, false);
});

test('пустые журналы: ответ той же формы, нули, 7 дней, остаток null со строкой', async () => {
  const w = world();
  const empty = await payload(w);
  const full = (() => { const x = world(); x.session('sf', [asst('m', NOW - H, us(1, 1, 1, 1))]); return payload(x); })();
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(await full).sort());
  assert.equal(empty.today.total, 0);
  assert.equal(empty.week.total, 0);
  assert.equal(empty.days.length, 7);
  assert.ok(empty.days.every((d) => d.total === 0));
  assert.deepEqual(empty.byThread, { today: [], week: [] });
  assert.deepEqual(empty.top5h, []);
  assert.equal(empty.window5h.warn, false);
  assert.equal(empty.remaining, null);
  assert.equal(empty.remainingNote, NOTE_NONE);
  assert.deepEqual(Object.keys(NO_USAGE.payload()).sort(), Object.keys(empty).sort());
});

test('рестарт читателя дочитывает только хвост и не удваивает', async () => {
  const w = world();
  const t = NOW - 2 * H;
  w.session('st', [asst('m1', t, us(10, 0, 0, 0)), asst('m2', t + 1, us(20, 0, 0, 0))]);
  const idx = tmpDir('usage-i-');
  const r1 = rd(w.root, idx);
  assert.equal((await payload(w, { reader: r1 })).week.total, 30);
  w.append('st', [asst('m3', t + 2, us(5, 0, 0, 0)), asst('m3', t + 3, us(5, 0, 0, 0))]);
  const r2 = rd(w.root, idx);
  const p = await payload(w, { reader: r2 });
  assert.equal(r2.state().lastPassLines, 2, 'прочитан только хвост — две новые строки');
  assert.equal(p.week.total, 35, 'старое не пересчитано, дубль m3 — один раз');
  const r3 = rd(w.root, idx);
  assert.equal((await payload(w, { reader: r3 })).week.total, 35, 'и ещё раз без изменений');
  assert.equal(r3.state().lastPassLines, 0);
});

test('индекс не растёт за все годы: записи старше окна не хранятся', async () => {
  const w = world();
  w.session('so', [asst('old', NOW - 20 * 86400000, us(999, 0, 0, 0)), asst('new', NOW - H, us(1, 0, 0, 0))]);
  const idx = tmpDir('usage-i-');
  const r = rd(w.root, idx);
  const p = await payload(w, { reader: r });
  assert.equal(p.week.total, 1);
  const text = fs.readFileSync(path.join(idx, 'journals.json'), 'utf8');
  assert.equal(text.includes('"old"'), false);
  assert.equal(text.includes('"new"'), true);
});

test('топ тредов за 5 ч: пять, по убыванию; старше 5 ч — нет', () => {
  const rows = [];
  for (let i = 1; i <= 7; i++) rows.push({ t: NOW - H, in: i * 10, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: `s${i}`, agent: 'main' });
  rows.push({ t: NOW - 5 * H - 1000, in: 100000, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 'old', agent: 'main' });
  const p = buildUsage({ records: rows, nowMs: NOW });
  assert.deepEqual(p.top5h.map((r) => r.sessionId), ['s7', 's6', 's5', 's4', 's3']);
  assert.equal(p.top5h[0].total, 70);
});

test('GET /api/usage: ответ той же формы, название треда — под маской; ручка доступна при выключенном пульте', async () => {
  const w = world();
  const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
  w.session('sk', [{ type: 'custom-title', customTitle: `EXT токен ${SECRET}`, sessionId: 'sk' }, asst('mm', NOW - H, us(8, 0, 0, 0))]);
  const reader = rd(w.root);
  await reader.refresh();
  const usage = createUsage({ journals: reader, rateLimit: null, board, now: () => NOW, cacheMs: 0 });
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [] });
  gitInitCommit(dir);
  const bd = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await bd.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const app = await buildApp({ port: 4317, board: bd, registry: createRegistryReader(regFile), scan, usage, pult: { enabled: false } });
  const res = await app.inject({ method: 'GET', url: '/api/usage', headers: { host: '127.0.0.1:4317' } });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(JSON.stringify(j).includes(SECRET), false, 'секрет из названия скрыт');
  assert.match(j.byThread.week[0].title, /\[скрыто/);
  assert.equal(j.week.total, 8);
  // без читателя — пустой ответ той же формы
  const app2 = await buildApp({ port: 4317, board: bd, registry: createRegistryReader(regFile), scan });
  const r2 = await app2.inject({ method: 'GET', url: '/api/usage', headers: { host: '127.0.0.1:4317' } });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().week.total, 0);
  // POST не принимается (ручка чтения)
  const post = await app.inject({ method: 'POST', url: '/api/usage', headers: { host: '127.0.0.1:4317', 'content-type': 'application/json' }, payload: '{}' });
  assert.notEqual(post.statusCode, 200);
});
