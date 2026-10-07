// EXT-84, правки по вердикту Голема: маска названий тредов (§6.2), признак «прораб» вне ручки, хвост чтения события лимита,
// вычистка записей объёма, окна 5 ч в пределах 7 суток.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { createUsage, buildUsage } from '../lib/usage.mjs';
import { createRateLimitReader, lastEventIn } from '../lib/rate-limit.mjs';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const H = 3600000;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const us = (i) => ({ input_tokens: i, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const asst = (id, ms, usage, extra = {}) => ({ type: 'assistant', uuid: `00000000-0000-4000-8000-${String(++seq + 5000).padStart(12, '0')}`, timestamp: iso(ms), sessionId: 's', isSidechain: false, version: '2.1.0',
  message: { id, role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage }, ...extra });
const jl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
function world() {
  const root = tmpDir('usagefix-j-');
  const proj = path.join(root, 'C--proj');
  fs.mkdirSync(proj, { recursive: true });
  return { root, session(sid, rows) { fs.writeFileSync(path.join(proj, `${sid}.jsonl`), jl(rows)); return path.join(proj, `${sid}.jsonl`); } };
}
const board = { hasCode: (c) => ['EXT', 'BW'].includes(c), hasCard: (id) => id === 'EXT-5', mirrorIndex: () => null };
const rd = (root, indexDir = tmpDir('usagefix-i-'), now = () => new Date(NOW)) => createJournalReader({ root, indexDir, now });

// сеть-подмена, как в v5-app: FLOW77 — находка только в строгой сети (project: 'IPTV')
const strictScan = (text, { project } = {}) => {
  const out = [];
  text.split('\n').forEach((l, i) => { const q = l.indexOf('FLOW77'); if (q >= 0 && project === 'IPTV') out.push({ cls: 2, kind: 'флоу', line: i + 1, start: q, end: q + 6 }); });
  return out;
};

test('маска названий (§6.2): проект угадан по карточкам или его нет — строгая сеть; код из названия — сеть проекта', async () => {
  const w = world();
  const ivan = (sid, text) => ({ type: 'user', uuid: `10000000-0000-4000-8000-${String(++seq + 7000).padStart(12, '0')}`, timestamp: iso(NOW - 3 * H), sessionId: sid, version: '2.1.0', message: { role: 'user', content: text } });
  w.session('s-cards', [{ type: 'custom-title', customTitle: 'заметка FLOW77', sessionId: 's-cards' }, ivan('s-cards', 'смотри EXT-5'), ivan('s-cards', 'ещё EXT-5'), asst('m1', NOW - H, us(1))]);
  w.session('s-title', [{ type: 'custom-title', customTitle: 'EXT · FLOW77', sessionId: 's-title' }, asst('m2', NOW - H, us(1))]);
  w.session('s-none', [{ type: 'custom-title', customTitle: 'разговор FLOW77', sessionId: 's-none' }, asst('m3', NOW - H, us(1))]);
  const reader = rd(w.root);
  await reader.refresh();
  const usage = createUsage({ journals: reader, rateLimit: null, board, now: () => NOW, cacheMs: 0 });
  const raw = usage.payload().byThread.week;
  assert.deepEqual(Object.fromEntries(raw.map((r) => [r.sessionId, [r.project, r.projectBy]])), { 's-cards': ['EXT', 'cards'], 's-title': ['EXT', 'title'], 's-none': [null, null] }, 'исходные данные: как проект определён');
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [] });
  gitInitCommit(dir);
  const bd = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await bd.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const app = await buildApp({ port: 4317, board: bd, registry: createRegistryReader(regFile), scan: strictScan, usage });
  const j = (await app.inject({ method: 'GET', url: '/api/usage', headers: { host: '127.0.0.1:4317' } })).json();
  const t = Object.fromEntries(j.byThread.week.map((r) => [r.sessionId, r.title]));
  assert.equal(t['s-cards'].includes('FLOW77'), false, 'проект по карточкам — догадка, строгая сеть');
  assert.equal(t['s-none'].includes('FLOW77'), false, 'проекта нет — строгая сеть');
  assert.equal(t['s-title'].includes('FLOW77'), true, 'исправный: код из названия — сеть проекта (находки нет)');
});

function foremanWorld() {
  const w = world();
  const t = NOW - H;
  const cwd = 'C:\\work\\copy-1';
  w.session('conductor', [{ type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: iso(t), sessionId: 'conductor', isSidechain: false, version: '2.1.0', cwd: 'C:\\work\\main',
    message: { id: 'c1', role: 'assistant', model: 'm', stop_reason: 'tool_use', usage: us(5), content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `node C:\\tools\\foreman-launch.mjs --card X-1 --cwd ${cwd}` } }] } }]);
  const f = w.session('foreman1', [{ type: 'user', uuid: 'bbbbbbbb-0000-4000-8000-000000000001', timestamp: iso(t + 60000), sessionId: 'foreman1', cwd, version: '2.1.0', message: { role: 'user', content: 'старт' } }, asst('f1', t + 70000, us(77))]);
  return { w, f };
}
const agentOf = (r, sid) => r.usageRecords(0).find((x) => x.sessionId === sid).agent;

test('«прораб»: признак ставит опрос (usage.tick), без единого запроса к ручке', async () => {
  const { w } = foremanWorld();
  const r = rd(w.root);
  await r.refresh();
  const usage = createUsage({ journals: r, rateLimit: null, board, now: () => NOW, cacheMs: 0 });
  assert.equal(agentOf(r, 'foreman1'), 'main', 'до опроса признака нет');
  usage.tick();
  assert.equal(agentOf(r, 'foreman1'), 'foreman', 'ручка /api/usage не вызывалась');
  assert.equal(agentOf(r, 'conductor'), 'main', 'исправный: дирижёр остаётся главной сессией');
});

test('«прораб»: признак переживает пересборку индекса и переписанный (укороченный) файл', async () => {
  const { w, f } = foremanWorld();
  const r = rd(w.root);
  await r.refresh();
  createUsage({ journals: r, rateLimit: null, board, now: () => NOW, cacheMs: 0 }).tick();
  assert.equal(agentOf(r, 'foreman1'), 'foreman');
  await r.rebuild();
  assert.equal(agentOf(r, 'foreman1'), 'foreman', 'после rebuild (takeFiles)');
  fs.writeFileSync(f, jl([asst('f2', NOW - H + 5000, us(3))]));
  await r.refresh({ full: true });
  assert.equal(agentOf(r, 'foreman1'), 'foreman', 'после пересоздания записи файла');
  assert.equal(agentOf(r, 'conductor'), 'main', 'исправный: сессия без признака его не получает');
});

test('вычистка: на полном обходе записи старше окна хранения уходят из состояния и индекса', async () => {
  const w = world();
  w.session('sp', [asst('stale', NOW - 7.5 * 86400000, us(999)), asst('fresh', NOW - 1 * H, us(1))]);
  let clock = NOW;
  const idx = tmpDir('usagefix-i-');
  const r = rd(w.root, idx, () => new Date(clock));
  await r.refresh({ full: true });
  assert.deepEqual(r.usageRecords(0).map((x) => x.in).sort((a, b) => a - b), [1, 999], 'в окне хранения (8 суток) обе записи');
  clock = NOW + 2 * 86400000; // stale — 9,5 суток, fresh — 2 суток 1 час
  await r.refresh({ full: true });
  assert.deepEqual(r.usageRecords(0).map((x) => x.in), [1], 'stale вычищена, fresh осталась');
  r.flush();
  const text = fs.readFileSync(path.join(idx, 'journals.json'), 'utf8');
  assert.equal(text.includes('"stale"'), false);
  assert.equal(text.includes('"fresh"'), true);
});

test('окна 5 ч не выходят за 7 суток: текущее + 32 полных; 33-е назад в медиану не входит', () => {
  const at = (k, n) => ({ t: NOW - (k * 5 + 2.5) * H, in: n, out: 0, cacheRead: 0, cacheWrite: 0, sessionId: 's', agent: 'main' });
  const w = buildUsage({ records: [at(1, 100), at(2, 100), at(32, 100), at(33, 100)], nowMs: NOW }).window5h;
  assert.equal(w.nonEmptyWindows, 3, 'окно 32 — внутри (160–165 ч), окно 33 — за пределами недели');
});

// ---- хвост чтения события лимита ----
const ev = (extra = '') => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1791331200 } }, pad: extra } });
const filler = (n) => `${JSON.stringify({ type: 'assistant', pad: 'x'.repeat(n) })}\n`;
const wf = (lines) => { const f = path.join(tmpDir('usagefix-rl-'), 'stream.jsonl'); fs.writeFileSync(f, lines.join('')); return f; };

test('хвост события лимита: строка на границе окна, малое окно, строка длиннее окна, далёкое событие — находятся; исправный случай рядом', () => {
  const util = (r) => r.info?.unifiedWindows.five_hour.utilization;
  // строка события пересекает границу окна (окно 150 байт режет её пополам)
  assert.equal(util(lastEventIn(wf([filler(500), `${ev()}\n`, filler(40)]), undefined, 150)), 0.5);
  // окно в 1 байт
  assert.equal(util(lastEventIn(wf([filler(300), `${ev()}\n`]), undefined, 1)), 0.5);
  // строка события длиннее окна
  assert.equal(util(lastEventIn(wf([filler(50), `${ev('y'.repeat(5000))}\n`, filler(30)]), undefined, 100)), 0.5);
  // событие в сотнях килобайт от конца (как у прогона 2,4 МБ от конца на живых данных)
  assert.equal(util(lastEventIn(wf([`${ev()}\n`, filler(300000)]), undefined, 1000)), 0.5);
  // исправный: событие в самом хвосте, окно хватает
  assert.equal(util(lastEventIn(wf([filler(500), `${ev()}\n`]), undefined, 4096)), 0.5);
  // последняя строка (оборвана, без перевода строки) — берётся предыдущее событие
  const ev2 = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.9 } } } });
  assert.equal(util(lastEventIn(wf([`${ev()}\n`, filler(20), ev2.slice(0, 60)]), undefined, 100)), 0.5);
  // событий нет и файл пройден целиком — incomplete false
  assert.deepEqual(lastEventIn(wf([filler(2000)]), undefined, 100), { info: null, incomplete: false });
  // предел чтения достигнут, файл не пройден — incomplete true
  assert.deepEqual(lastEventIn(wf([`${ev()}\n`, filler(5000)]), undefined, 100, 1000), { info: null, incomplete: true });
});

test('хвост: прогон с недочитанным файлом — нет молчаливого отката к старому; прогон без событий (пройден целиком) — откат допустим', () => {
  const runs = tmpDir('usagefix-runs-');
  const mk = (name, lines, mtimeS) => { const d = path.join(runs, name); fs.mkdirSync(d); const f = path.join(d, 'stream.jsonl'); fs.writeFileSync(f, lines.join('')); fs.utimesSync(f, mtimeS, mtimeS); };
  const nowS = NOW / 1000;
  mk('old', [`${ev()}\n`], nowS - 9000);
  mk('big-no-event-in-reach', [`${ev()}\n`, filler(20000)], nowS - 100);
  const r = createRateLimitReader({ dir: runs, now: () => NOW, tailBytes: 100, capBytes: 1000 }).get();
  assert.equal(r.remaining, null);
  assert.match(r.note, /не откатываюсь/);
  // исправный: тот же набор, предел хватает — берётся событие свежего прогона
  const ok = createRateLimitReader({ dir: runs, now: () => NOW, tailBytes: 100, capBytes: 1 << 20 }).get();
  assert.equal(ok.remaining.eventAt, iso((nowS - 100) * 1000));
  assert.match(ok.remaining.source, /нижняя граница/);
  assert.equal(ok.remaining.ageKind, 'lowerBound');
});
