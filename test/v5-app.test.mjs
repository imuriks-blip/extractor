// В5: ручки /api/project/:code (маячок) и /api/card/:id (шапка, тело, связи, лента) — спека 1.6, 2.5, 2.6, 3.2, 6.
// Читатели git и журналов здесь — выжимки (их разбор проверен в своих тестах); ожидаемое — из данных этого файла.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

// сеть-подмена: SECRET42 — находка класса 2 в любой сети; FLOW77 — только в строгой (project: 'IPTV'), как id флоу
// по слову-признаку у доски: так видно, какой сетью маскирован текст
const scan = (text, { project = '' } = {}) => {
  const out = [];
  text.replace(/\r\n?/g, '\n').split('\n').forEach((l, i) => {
    const k = l.indexOf('SECRET42'); if (k >= 0) out.push({ cls: 2, kind: 'метка', line: i + 1, start: k, end: k + 8 });
    const q = l.indexOf('FLOW77'); if (q >= 0 && project === 'IPTV') out.push({ cls: 2, kind: 'флоу', line: i + 1, start: q, end: q + 6 });
  });
  return out;
};
test('подмена сети различает проект: FLOW77 — находка только строгой сети', () => {
  assert.equal(scan('x FLOW77', { project: 'EXT' }).length, 0);
  assert.equal(scan('x FLOW77', { project: 'IPTV' }).length, 1);
});

async function setup() {
  const dir = makeBoard(tmpDir('v5app-'), { codes: ['EXT', 'NEW', 'IPTV'], cards: [
    { id: 'IPTV-1', title: 'Флоу FLOW77' },
    { id: 'EXT-41', title: 'Свой FLOW77' },
    { id: 'EXT-40', title: 'Связи с чужими', relates: ['IPTV-1', 'EXT-41'] },
    { id: 'EXT-1', title: 'Экстрактор — кабина' },
    { id: 'EXT-6', title: 'Спека витрины', status: 'review', body: '# Спека\n\nТело с SECRET42.', parent: 'EXT-1', blocks: ['EXT-7'], relates: ['EXT-8'] },
    { id: 'EXT-7', title: 'Слить' },
    { id: 'EXT-8', title: 'Соседка' },
    { id: 'EXT-25', title: 'В1 · каркас', parent: 'EXT-6', blocks: ['EXT-6'] },
    { id: 'EXT-26', title: 'Связана с шестой', relates: ['EXT-6'], updated: '2026-10-01T12:00+03:00' },
    { id: 'EXT-27', title: 'Ждёт шестую', blockedBy: ['EXT-6'] },
    { id: 'NEW-1', title: 'Новый проект' },
    { id: 'EXT-30', title: 'В работе', status: 'in-progress', labels: ['terminus', 'golem'], updated: '2026-10-01T09:00+03:00' },
    { id: 'EXT-31', title: 'В очереди с Б', status: 'ready', labels: [], markB: true, updated: '2026-09-29T09:00+03:00' },
    { id: 'EXT-32', title: 'Сделана давно', status: 'done', updated: '2026-09-20T09:00+03:00' },
    { id: 'EXT-33', title: 'Отменена', status: 'cancelled', updated: '2026-09-27T09:00+03:00' },
    { id: 'EXT-34', title: 'Сделана вчера', status: 'done', updated: '2026-10-01T09:00+03:00' },
  ] });
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-6.log.md'), [
    '### 2026-09-30 13:57 +03:00 · plane · ▶', '', '▶ выдан: clap · EXT-6 · спека', '',
    '### 2026-10-01 10:35 +03:00 · trurl:EXT · решение', '', 'Спека утверждена.', '', 'Кто решил: слово Ивана.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-31.log.md'), '### 2026-09-28 10:00 +03:00 · plane · коммент\n\n' + 'Длинная первая строка '.repeat(10) + '\nвторая строка\n\n');
  fs.rmSync(path.join(dir, 'EXT', 'EXT-30.log.md'));
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const reg = path.join(tmpDir('v5reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: ['unorbis/extractor.md'], repos: ['C:/projects/extractor'] }, IPTV: { projects: [], project_cards: ['iptv.md'], repos: ['C:/projects/iptv-player'] } } }));
  const registry = createRegistryReader(reg);
  const gitCalls = [];
  const gitReader = {
    beacon: (code) => { gitCalls.push(code); return code === 'EXT'
      ? { described: true, message: null, repos: [{ name: 'extractor', path: 'C:/projects/extractor', branch: 'main', dirty: 0, missing: false }, { name: 'wt', path: 'C:/x/wt', branch: 'ext-29', dirty: 3, missing: false }], readAt: '2026-10-02T10:00:00.000Z', failingSince: null }
      : { described: false, message: 'проект не описан в реестре', repos: [], readAt: null, failingSince: null }; },
    commitsFor: (id) => ({ commits: id === 'EXT-6' ? [{ hash: 'abc1234', at: '2026-10-01T10:40:00+03:00', subject: 'spec: витрина SECRET42 (EXT-6)', repo: 'Obsidian Vault', branch: 'main', own: false }]
      : id === 'EXT-40' ? [{ hash: 'own0001', at: '2026-10-01T10:00:00+03:00', subject: 'свой FLOW77 (EXT-40)', repo: 'extractor', branch: 'main', own: true }, { hash: 'iptv001', at: '2026-10-01T09:00:00+03:00', subject: 'чужой FLOW77 (EXT-40)', repo: 'iptv-player', branch: 'main', own: false }] : [], readAt: '2026-10-02T10:00:00.000Z', failingSince: '2026-10-02T10:01:00.000Z' }),
    state: () => ({ lastOkAt: null, errors: 0 }),
  };
  const projectCards = { get: (code) => (code === 'EXT' ? { phase: 'Фаза целиком. '.repeat(10).trim(), next: 'Такт В5.' } : code === 'IPTV' ? { phase: 'Фаза FLOW77.', next: 'Шаг FLOW77.' } : null) };
  const run = (o) => ({ agentType: 'terminus', description: null, target: null, cards: ['EXT-6'], alive: false, lastEndAt: null, turns: 1, zakhods: [1], lastAt: null, starts: [], ...o });
  const sessions = [
    { sessionId: 's1', partials: [{ agentId: 'r3', at: '2026-09-30T23:00:00+03:00', limit: 40 }], runs: [
      run({ agentId: 'r1', description: 'EXT-6 В5 SECRET42 FLOW77', at: '2026-10-01T11:20:00+03:00', alive: true, turns: 34, zakhods: [34], target: 50 }),
      run({ agentId: 'r2', agentType: 'golem', description: 'EXT-6 ревью', at: '2026-10-01T09:10:00+03:00', lastEndAt: '2026-10-01T09:50:00+03:00', lastAt: '2026-10-01T09:49:00+03:00', turns: 31, zakhods: [20, 11], target: 35 }),
      run({ agentId: 'r3', agentType: 'clap', description: 'EXT-6 спека, ред. 2', at: '2026-09-30T22:00:00+03:00', lastEndAt: '2026-09-30T23:00:00+03:00', turns: 40, zakhods: [40] }),
      run({ agentId: 'r4', description: 'EXT-60 чужая', at: '2026-10-01T12:00:00+03:00', cards: ['EXT-60'] }),
    ] },
    // копия сессии продолженного треда: тот же запуск r2, в копии конца не видно — в ленте один раз, «готово»
    { sessionId: 's2', partials: [], runs: [run({ agentId: 'r2', agentType: 'golem', description: 'EXT-6 ревью', at: '2026-10-01T09:10:00+03:00', alive: true, lastAt: '2026-10-01T09:30:00+03:00', turns: 20, zakhods: [20], target: 35 })] },
  ];
  const journals = { sessions: () => sessions, state: () => ({ lastOkAt: '2026-10-02T10:00:00.000Z' }) };
  const maxTurns = (t) => ({ terminus: 90, golem: 40, clap: 40 })[t] ?? null;
  // В3: живой субагент несёт номер карточки в ТЗ (cards запуска) — строка «<агент> работает» на доске проекта
  const threads = { list: () => ({ threads: [{ sessionId: 'x', project: 'EXT', projectBy: 'title', subagents: [{ agent: 'terminus', who: 'Терминус', cards: ['EXT-30'] }] }], subagentsCount: 1, unknownStatus: {} }), state: () => ({ processes: null, desktop: null }) };
  const app = await buildApp({ port: 4317, board, registry, journals, threads, scan, gitReader, projectCards, maxTurns });
  const get = async (url) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } });
  return { get, gitCalls };
}
const S = await setup();

test('окно проекта: маячок — фаза и следующий шаг целиком, репозитории и рабочие копии с веткой и числом незакоммиченных', async () => {
  const b = (await S.get('/api/project/EXT')).json().beacon;
  assert.equal(b.described, true);
  assert.equal(b.phase, 'Фаза целиком. '.repeat(10).trim());
  assert.equal(b.next, 'Такт В5.');
  assert.deepEqual(b.repos.map((r) => [r.name, r.branch, r.dirty]), [['extractor', 'main', 0], ['wt', 'ext-29', 3]]);
  assert.equal(b.readAt, '2026-10-02T10:00:00.000Z');
  assert.equal(b.failingSince, null);
});

test('окно проекта: код без записи в реестре — маячок «проект не описан в реестре»', async () => {
  const b = (await S.get('/api/project/NEW')).json().beacon;
  assert.equal(b.described, false);
  assert.equal(b.message, 'проект не описан в реестре');
  assert.equal(b.phase, null);
  assert.deepEqual(b.repos, []);
});

test('карточка: шапка, тело markdown (маска), связи с вычисленной встречной стороной и заголовками', async () => {
  const r = (await S.get('/api/card/EXT-6')).json();
  assert.equal(r.header.id, 'EXT-6');
  assert.equal(r.body.trim(), '# Спека\n\nТело с [скрыто: метка].');
  const ids = (a) => a.map((x) => `${x.id}:${x.title}`);
  assert.deepEqual(r.links.parent, { id: 'EXT-1', title: 'Экстрактор — кабина' });
  assert.deepEqual(ids(r.links.blocks), ['EXT-7:Слить']);
  assert.deepEqual(ids(r.links.relates), ['EXT-8:Соседка']);
  assert.deepEqual(ids(r.links.blockedBy), []);
  assert.deepEqual(ids(r.links.blockingIt), ['EXT-25:В1 · каркас'], '← блокирует её');
  assert.deepEqual(ids(r.links.relatedFrom), ['EXT-26:Связана с шестой'], '← связана');
  assert.deepEqual(ids(r.links.blockedByIt), ['EXT-27:Ждёт шестую'], 'ждёт её (blocked_by на той стороне)');
  assert.deepEqual(ids(r.links.children), ['EXT-25:В1 · каркас']);
});

test('карточка: лента — комменты журнала, коммиты, запуски агентов; новые сверху; маска на темах и описаниях', async () => {
  const r = (await S.get('/api/card/EXT-6')).json();
  const brief = r.feed.map((f) => `${f.kind}@${f.at}`);
  assert.deepEqual(brief, [
    'run@2026-10-01T08:20:00.000Z', 'commit@2026-10-01T07:40:00.000Z', 'comment@2026-10-01T07:35:00.000Z',
    'run@2026-10-01T06:10:00.000Z', 'run@2026-09-30T19:00:00.000Z', 'comment@2026-09-30T10:57:00.000Z',
  ]);
  const [r1, c, k1, r2, r3, k0] = r.feed;
  assert.deepEqual(c, { kind: 'commit', at: '2026-10-01T07:40:00.000Z', hash: 'abc1234', subject: 'spec: витрина [скрыто: метка] (EXT-6)', repo: 'Obsidian Vault', branch: 'main' });
  assert.equal(k1.author, 'trurl:EXT'); assert.equal(k1.logKind, 'решение'); assert.equal(k1.body, 'Спека утверждена.\n\nКто решил: слово Ивана.');
  assert.equal(k0.author, null, 'автор plane не показывается'); assert.equal(k0.logKind, '▶');
  assert.deepEqual({ ...r1 }, { kind: 'run', at: '2026-10-01T08:20:00.000Z', agent: 'terminus', who: 'Терминус', description: 'EXT-6 В5 [скрыто: метка] [скрыто: флоу]', turnsTotal: 34, entries: 1, maxTurns: 90, target: 50, result: 'работает' });
  assert.equal(r2.result, 'готово'); assert.equal(r2.turnsTotal, 31); assert.equal(r2.entries, 2); assert.equal(r2.maxTurns, 40);
  assert.equal(r3.result, 'обрыв · PARTIAL');
  assert.deepEqual(r.feedCounts, { comment: 2, commit: 1, run: 3 });
  assert.deepEqual(r.feedGit, { readAt: '2026-10-02T10:00:00.000Z', failingSince: '2026-10-02T10:01:00.000Z' });
});

test('карточка без коммитов и запусков (проект не в реестре) — в ленте только запись журнала, не ошибка', async () => {
  const r = await S.get('/api/card/NEW-1');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().feed.map((f) => f.kind), ['comment']);
  assert.deepEqual(r.json().links.children, []);
});

test('доска проекта: колонки по статусу, карточка — номер, первый лейбл, Б, давность, заголовок, агент В3, последняя запись', async () => {
  const b = (await S.get('/api/project/EXT')).json().board;
  assert.deepEqual(b.inProgress, [{ id: 'EXT-30', title: 'В работе', label: 'terminus', markB: false, at: '2026-10-01T06:00:00.000Z', agentWorking: 'Терминус', lastLog: null }]);
  const r = b.ready[0];
  assert.equal(r.id, 'EXT-31'); assert.equal(r.label, null); assert.equal(r.markB, true); assert.equal(r.agentWorking, null);
  assert.equal(r.lastLog.author, null, 'автор plane не показывается');
  assert.equal(r.lastLog.text.length, 120); assert.ok(r.lastLog.text.endsWith('…')); assert.ok(r.lastLog.text.startsWith('Длинная первая строка'));
  assert.equal(r.at, '2026-09-29T06:00:00.000Z', 'давность — max(updated, последняя запись)');
  assert.deepEqual(b.review.map((c) => [c.id, c.at, c.lastLog.text, c.lastLog.author]), [['EXT-6', '2026-10-01T07:35:00.000Z', 'Спека утверждена.', 'trurl:EXT']]);
  assert.equal(b.backlog.length, 8);
  assert.deepEqual(Object.keys(b.backlog[0]).sort(), ['at', 'id', 'label', 'title']);
  assert.deepEqual(b.done.map((c) => [c.id, c.cancelled]), [['EXT-34', false], ['EXT-33', true], ['EXT-32', false]], 'последние сверху, отменённая — с пометкой');
  assert.deepEqual(b.counts, { live: 3, backlog: 8, done: 3 });
});

test('доска проекта: в колонке свежие сверху', async () => {
  const b = (await S.get('/api/project/EXT')).json().board;
  assert.equal(b.backlog.length, 8);
  assert.equal(b.backlog[0].id, 'EXT-26');
  const ats = b.backlog.map((c) => Date.parse(c.at));
  assert.deepEqual(ats, [...ats].sort((x, y) => y - x));
});

test('«Цех»: фаза и следующий шаг — первое предложение до 90 знаков с «…», целиком — full; нет карточки — null', async () => {
  const long = 'Очень длинное первое предложение фазы, которое никак не помещается в девяносто знаков строки проекта. Второе.';
  const ceh = (await S.get('/api/ceh')).json();
  const ext = ceh.projects.find((p) => p.code === 'EXT');
  assert.deepEqual(ext.next, { short: 'Такт В5.', full: 'Такт В5.' });
  assert.equal(ext.phase.full, 'Фаза целиком. '.repeat(10).trim());
  assert.equal(ext.phase.short, 'Фаза целиком.');
  assert.equal(ceh.projects.find((p) => p.code === 'NEW').phase, null);
  const { brief } = await import('../lib/project-cards.mjs');
  const b = brief(long);
  assert.equal(b.short.length, 90); assert.ok(b.short.endsWith('…')); assert.equal(b.full, long);
  assert.deepEqual(brief('Такт В5. Потом В6.'), { short: 'Такт В5.', full: 'Такт В5. Потом В6.' });
  assert.equal(brief('01.10 слито, шаг 2.5 — дальше').short, '01.10 слито, шаг 2.5 — дальше', 'точка без пробела — не конец предложения');
  assert.equal(brief(null), null);
});

test('«Цех»: фаза и шаг каждого проекта — сетью его проекта (IPTV — строгой), не мягкой сетью ручки', async () => {
  const ceh = (await S.get('/api/ceh')).json();
  const iptv = ceh.projects.find((p) => p.code === 'IPTV');
  assert.deepEqual(iptv.phase, { short: 'Фаза [скрыто: флоу].', full: 'Фаза [скрыто: флоу].' });
  assert.deepEqual(iptv.next, { short: 'Шаг [скрыто: флоу].', full: 'Шаг [скрыто: флоу].' });
});

test('карточка EXT: коммит из репозитория IPTV и заголовок связанной IPTV-карточки — строгой сетью; свои — сетью EXT', async () => {
  const r = (await S.get('/api/card/EXT-40')).json();
  const rel = Object.fromEntries(r.links.relates.map((x) => [x.id, x.title]));
  assert.equal(rel['IPTV-1'], 'Флоу [скрыто: флоу]');
  assert.equal(rel['EXT-41'], 'Свой FLOW77');
  const subj = Object.fromEntries(r.feed.filter((f) => f.kind === 'commit').map((f) => [f.hash, f.subject]));
  assert.deepEqual(subj, { own0001: 'свой FLOW77 (EXT-40)', iptv001: 'чужой [скрыто: флоу] (EXT-40)' });
  assert.ok(r.feed.every((f) => !('own' in f)), 'служебный признак сети наружу не идёт');
});
