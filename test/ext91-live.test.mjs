// Пульт, режим live (EXT-91, такт 1; спека пульта §3.3 пп.1, 3, 4, 5, 6, 7, 11, 13, 15, таблица §3.3): запись на доску настоящим board.mjs
// на ВРЕМЕННОЙ доске (копия формата в os.tmpdir, board.config.json mode: live, git init, инструмент доски скопирован в её tools/).
// Plane — подменный plane.py (ни одного вызова в live); настоящий mirror.mjs и C:\projects\unorbis-board не запускаются.
// Ожидания — из того, что положено в тест и из спеки; у каждой проверки рядом исправный случай (отрицательный контроль).
// Подменный запуск board (wrapper) нужен только для исходов, которых настоящий board сам не даст на заказ: таймаут, исключение после
// коммита, занятая доска за 300 мс вместо 10 с; в остальном — настоящий вызов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createLive } from '../lib/pult/live.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { cleanEnv, classify, parseOutput } from '../lib/pult/board-run.mjs';
import { priorOpen, markCandidates } from '../lib/pult/accept.mjs';
import { boardMode } from '../lib/pult/routes.mjs';
import { BOARD_LIB, tmpDir, makeBoard, writeCard, gitInitCommit, git, gitCommitAll } from './helpers.mjs';

const lib = (f) => import(new URL(`file:///${BOARD_LIB}/${f}`).href);
const { parseCard } = await lib('header.mjs');
const { parseLog, latest } = await lib('log.mjs');
const { scan } = await lib('secrets.mjs');
const { similar } = await lib('similar.mjs');
const lockLib = await lib('lock.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(BOARD_LIB, '..'); // чтение кода доски: копируется во временную доску
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 500;
const nextIntent = () => uuid(++intents);

const Q_MD = '**Ветка** готова — `ext-7` можно принимать?';
const Q_AT = '2026-10-03T09:00:00.000Z';
const Q = { at: Q_AT, head: Q_MD };
const logWith = (body, as = 'trurl:EXT', kind = 'коммент', at = '2026-10-03 12:00 +03:00') => `### ${at} · ${as} · ${kind}\n\n${body}\n\n`;
const SECRET5 = 'Xk9mPq2RtVw8zLc4Bn7Y'; // 20 знаков латиницы с цифрами: класс 5, вид «сеть3» (проект не IPTV)
const SECRET2 = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';

const WRAPPER = `import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'cfg.json'), 'utf8'));
const args = process.argv.slice(2);
const cmd = args[4];
const mode = cfg[cmd] ?? 'ok';
const start = Date.now();
const note = () => fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ cmd, mode, pid: process.pid, start, end: Date.now() }) + '\\n');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const real = (a) => spawnSync(process.execPath, [cfg.real, ...a], { encoding: 'utf8', env: process.env });
const pass = (r) => { process.stdout.write(r.stdout); process.exitCode = r.status; };
fs.writeFileSync(path.join(dir, 'pid-' + cmd + '.txt'), String(process.pid));
const hang = () => { note(); setInterval(() => {}, 1000); };
if (mode === 'slow') { sleep(cfg.slowMs ?? 500); const r = real(args); note(); pass(r); }
else if (mode === 'lock-short') { const r = real([...args, '--lock-wait-ms', '300']); note(); pass(r); }
else if (mode === 'crash-after') { real(args); note(); process.stdout.write('ошибка board: boom\\n'); process.exitCode = 2; }
else if (mode === 'crash-before') { note(); process.stdout.write('ошибка board: boom\\n'); process.exitCode = 2; }
else if (mode === 'hang-after') { real(args); hang(); }
else if (mode === 'hang-before') { hang(); }
else if (mode === 'decoy-crash') { const a = [...args]; a[1] = 'trurl:EXT'; real(a); note(); process.stdout.write('ошибка board: boom\\n'); process.exitCode = 2; }
else if (mode === 'silent-1') { note(); process.exitCode = 1; }
else { const r = real(args); note(); pass(r); }
`;

// временная доска: формат живой (шапка §1.2, projects.md §1.6), инструмент доски — копия кода, git init, mode: live
function makeLiveBoard({ mode = 'live', cards = null } = {}) {
  const dir = tmpDir('ext91-board-');
  const list = cards ?? [
    { id: 'EXT-7', status: 'review', title: 'Семь' }, { id: 'EXT-8', status: 'review', title: 'Восемь' }, { id: 'EXT-9', status: 'in-progress', title: 'Девять' },
    { id: 'EXT-10', status: 'review', title: 'Десять' }, { id: 'EXT-11', status: 'review', title: 'Одиннадцать' },
  ];
  makeBoard(dir, { codes: ['EXT', 'CAR'], cards: list });
  fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode, push: false, tz: 'Europe/Riga' }) + '\n');
  fs.cpSync(TOOLS, path.join(dir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) });
  for (const c of list) {
    const lf = path.join(dir, c.id.split('-')[0], `${c.id}.log.md`);
    fs.writeFileSync(lf, logWith(Q_MD));
  }
  // EXT-8: владелец есть — «Вернуть» даёт in-progress
  const f8 = path.join(dir, 'EXT', 'EXT-8.md');
  if (fs.existsSync(f8)) fs.writeFileSync(f8, fs.readFileSync(f8, 'utf8').replace('owner: ""', 'owner: "trurl:EXT"'));
  gitInitCommit(dir);
  git(dir, 'config', 'user.name', 'Иван Тест');
  git(dir, 'config', 'user.email', 'ivan@test.local');
  return dir;
}

async function setup({ mode = 'live', cards = null, seams = {}, slog = null, wrap = null, log = null, boardDir: given = null, bell = false, threads = null } = {}) {
  const boardDir = given ?? makeLiveBoard({ mode, cards });
  const data = tmpDir('ext91-data-');
  const actionsLog = path.join(data, 'actions.log');
  if (log) fs.writeFileSync(actionsLog, log.map((l) => JSON.stringify(l) + '\n').join(''));
  const pdir = tmpDir('ext91-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'Review', comments: [], clock: '2026-10-03T09:20:00.123456Z' }));
  const web = tmpDir('ext91-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const wdir = tmpDir('ext91-wrap-');
  fs.writeFileSync(path.join(wdir, 'board-wrap.mjs'), WRAPPER);
  const setWrap = (cfg) => fs.writeFileSync(path.join(wdir, 'cfg.json'), JSON.stringify({ real: path.join(boardDir, 'tools', 'board.mjs'), ...cfg }));
  setWrap(wrap ?? {});
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(path.join(tmpDir('ext91-reg-'), 'registry.json'));
  const spawned = [];
  const threadsApi = { list: () => ({ threads: threads ?? [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: '2026-10-04T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions: () => [] };
  const app = await buildApp({ port: PORT, board, registry, scan, similar, webDir: web, ...(slog ? { log: slog } : {}), ...(threads ? { threads: threadsApi, journals } : {}),
    pult: { enabled: true, words: true, bell, bellDir: path.join(data, 'bell'), actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { boardScript: path.join(wdir, 'board-wrap.mjs'), boardTimeoutMs: 20000, boardSpawn: (...a) => { spawned.push(a); return realSpawn(...a); }, ...seams } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const raw = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '');
  const lines = () => raw().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const planeCalls = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).calls ?? [];
  const entries = (id) => parseLog(fs.readFileSync(path.join(boardDir, id.split('-')[0], `${id}.log.md`), 'utf8'));
  const header = (id) => parseCard(fs.readFileSync(path.join(boardDir, id.split('-')[0], `${id}.md`), 'utf8')).header;
  const calls = () => (fs.existsSync(path.join(wdir, 'calls.log')) ? fs.readFileSync(path.join(wdir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const commits = () => Number(git(boardDir, 'rev-list', '--count', 'HEAD').trim());
  const tmpFiles = () => (fs.existsSync(path.join(data, 'tmp')) ? fs.readdirSync(path.join(data, 'tmp')) : []);
  return { app, press, lines, raw, planeCalls, entries, header, calls, commits, tmpFiles, boardDir, data, wdir, setWrap, board, spawned, actionsLog };
}
import { spawn as realSpawn } from 'node:child_process';

const accept = (card = 'EXT-7', extra = {}) => ({ action: 'accept', card, q: Q, ...extra });
const trailer = (dir, key) => git(dir, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`).trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- режим из файла доски (п.1) ----------------

test('boardMode: live и mirror читаются; нечитаемый файл, битый JSON, иной mode — null (молчаливого mirror нет)', () => {
  const d = tmpDir('ext91-mode-');
  const w = (t) => fs.writeFileSync(path.join(d, 'board.config.json'), t);
  w('{"mode":"live"}'); assert.equal(boardMode(d), 'live');
  w('{"mode":"mirror"}'); assert.equal(boardMode(d), 'mirror');
  w('{"mode":"Live"}'); assert.equal(boardMode(d), null);
  w('{"push":false}'); assert.equal(boardMode(d), null);
  w('{не json'); assert.equal(boardMode(d), null);
  fs.unlinkSync(path.join(d, 'board.config.json')); assert.equal(boardMode(d), null);
  assert.equal(boardMode(null), 'mirror', 'витрина без доски — как было');
});

test('нечитаемый или иной режим доски → отказ 200 board-mode «зови дирижёра»: ни asked, ни board, ни Plane; исправный режим рядом проходит', async () => {
  for (const bad of ['{не json', '{"mode":"hybrid"}', '{}']) {
    const s = await setup();
    fs.writeFileSync(path.join(s.boardDir, 'board.config.json'), bad);
    const before = s.commits();
    const r = await s.press(accept());
    assert.equal(r.statusCode, 200, bad);
    assert.equal(r.json().outcome, 'refused');
    assert.equal(r.json().refusal, 'board-mode');
    assert.match(r.json().message, /доска в неясном режиме — зови дирижёра/);
    assert.deepEqual(s.lines().map((l) => l.step), ['refused']);
    assert.equal(s.lines()[0].mode, null);
    assert.equal(s.commits(), before);
    assert.equal(s.calls().length, 0);
    assert.deepEqual(s.planeCalls(), []);
  }
  const ok = await setup();
  assert.equal((await ok.press(accept())).json().outcome, 'ok');
});

test('режим пишется в asked и в каждую строку действия; mirror-доска пишет mirror (прежнее поведение: Plane, не board)', async () => {
  const s = await setup();
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'ok');
  assert.ok(s.lines().length >= 4);
  assert.ok(s.lines().every((l) => l.mode === 'live'), JSON.stringify(s.lines().map((l) => [l.step, l.mode])));
  const m = await setup({ mode: 'mirror' });
  const mr = await m.press(accept());
  assert.equal(m.lines()[0].mode, 'mirror');
  assert.ok(m.lines().every((l) => l.mode === 'mirror'));
  assert.equal(m.calls().length, 0, 'в mirror board не зовётся');
  assert.ok(m.planeCalls().length > 0, `в mirror пишет Plane: ${JSON.stringify(mr.json())}`);
});

// ---------------- «Принять» / «Вернуть» (пп.3, 4, таблица) ----------------

test('«Принять» live: log решение → status done настоящим board; запись в файлах с номером в первой строке, «Кто решил», трейлеры Board-As: ivan; Plane — ни одного вызова; тело-файл удалён', async () => {
  const s = await setup();
  const before = s.commits();
  const r = await s.press(accept());
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'ok', JSON.stringify(b));
  assert.match(b.message, /^принято · Done в доске \d\d:\d\d$/);
  assert.equal(s.header('EXT-7').status, 'done');
  const es = s.entries('EXT-7');
  assert.deepEqual(es.map((e) => e.kind), ['коммент', 'решение', 'статус']);
  const dec = es[1];
  assert.equal(dec.as, 'ivan');
  assert.ok(dec.body.startsWith(`**Слово Ивана · кнопка витрины · ${b.id}**: «принято»`), dec.body);
  assert.ok(dec.body.includes(`В ответ на: запись `) && dec.body.includes(`«${Q_MD}»`), dec.body);
  assert.ok(dec.body.trimEnd().endsWith(`Кто решил: слово Ивана · кнопка витрины · ${b.id}`), dec.body);
  assert.match(es[2].body, new RegExp(`^review → done\\nПочему: принято: слово Ивана · кнопка витрины · ${b.id}$`));
  assert.equal(s.commits(), before + 2, 'два коммита: решение и статус');
  assert.equal(trailer(s.boardDir, 'Board-As'), 'ivan');
  assert.equal(trailer(s.boardDir, 'Board-Session'), '', 'сессии Claude нет');
  assert.deepEqual(s.lines().map((l) => `${l.step}${l.cmd ? ':' + l.cmd : ''}`), ['asked', 'board:log', 'board:status', 'done']);
  const bl = s.lines().filter((l) => l.step === 'board');
  assert.ok(bl.every((l) => l.result.code === 0 && typeof l.result.line === 'string' && l.result.line.length > 0));
  assert.match(bl[0].result.line, new RegExp(`^EXT-7 · решение · \\d\\d:\\d\\d · [0-9a-f]+$`));
  assert.match(bl[1].result.line, /^EXT-7 review → done · [0-9a-f]+$/);
  assert.deepEqual(s.planeCalls(), [], 'Plane не тронут');
  assert.deepEqual(s.tmpFiles(), [], 'файл тела удалён');
  assert.equal(s.lines().find((l) => l.step === 'done').result.state, 'done');
});

test('вызов board: node [board.mjs, --as ivan, --root <доска>, команда …] массивом, windowsHide, окружение без ключа Plane и CLAUDECODE / CLAUDE_CODE_*; контроль: с чужим окружением board ставит Board-Session', async () => {
  const dirty = { ...process.env, PLANE_API_KEY: 'plk-not-a-key', PLANE_BASE_URL: 'http://x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-чужая', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_ME: 'да' };
  const s = await setup({ seams: { boardEnv: dirty } });
  assert.equal((await s.press(accept())).json().outcome, 'ok');
  assert.equal(s.spawned.length, 2);
  for (const [cmd, args, opts] of s.spawned) {
    assert.equal(cmd, 'node');
    assert.equal(args[0], path.join(s.wdir, 'board-wrap.mjs'));
    assert.deepEqual(args.slice(1, 5), ['--as', 'ivan', '--root', s.boardDir]);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.env.KEEP_ME, 'да');
    for (const k of ['PLANE_API_KEY', 'PLANE_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) assert.ok(!(k in opts.env), k);
  }
  assert.deepEqual(s.spawned.map((c) => c[1][5]), ['log', 'status']);
  assert.equal(trailer(s.boardDir, 'Board-Session'), '');
  // контроль: окружение с CLAUDE_CODE_SESSION_ID доходит до board — трейлер появился бы (проверка могла красниться)
  const c = await setup({ seams: { boardEnv: undefined } });
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-чужая' };
  execFileSync(process.execPath, [path.join(c.boardDir, 'tools', 'board.mjs'), '--as', 'ivan', '--root', c.boardDir, 'log', 'EXT-7', 'коммент', '--body', 'x'], { env, windowsHide: true });
  assert.equal(trailer(c.boardDir, 'Board-Session'), 'sess-чужая');
  assert.deepEqual(Object.keys(cleanEnv({ plane_api_key: 'x', Claudecode: '1', CLAUDE_CODE_X: '1', PATH: 'p' })), ['PATH']);
});

test('«Вернуть» live: владельца в шапке нет → ready, есть → in-progress; запись с причиной; --why «вернуть: …»', async () => {
  const s = await setup();
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нет теста <b>"x" & y</b>' });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.match(r.json().message, /^возвращено · ready в доске \d\d:\d\d · звонок выключен: тред увидит на карточке$/);
  assert.equal(s.header('EXT-7').status, 'ready');
  const es = s.entries('EXT-7');
  assert.ok(es[1].body.startsWith(`**Слово Ивана · кнопка витрины · ${r.json().id}**: «вернуть»`));
  assert.ok(es[1].body.includes('Причина: нет теста <b>"x" & y</b>'), es[1].body);
  assert.match(es[2].body, new RegExp(`Почему: вернуть: слово Ивана · кнопка витрины · ${r.json().id}$`));
  // владелец есть (EXT-8) — in-progress
  const o = await s.press({ action: 'return', card: 'EXT-8', q: Q, text: 'доделай' });
  assert.equal(o.json().outcome, 'ok', JSON.stringify(o.json()));
  assert.match(o.json().message, /^возвращено · in-progress в доске/);
  assert.equal(s.header('EXT-8').status, 'in-progress');
  assert.equal(s.header('EXT-8').owner, 'trurl:EXT', 'владелец не тронут');
});

test('исходы по кодам: код 3 → board-busy (200), код 4 → board-conflict (200, после ⚠-строк), нигде не коммит; исправная доска рядом проходит', async () => {
  const s = await setup({ wrap: { log: 'lock-short' } });
  fs.writeFileSync(path.join(s.boardDir, '.board.lock'), JSON.stringify({ pid: process.pid, as: 'trurl:EXT', cmd: 'log', at: new Date().toISOString(), boot: lockLib.bootTime() }));
  const before = s.commits();
  const r = await s.press(accept());
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().refusal, 'board-busy');
  assert.equal(r.json().message, 'доска занята — повтори');
  assert.equal(s.lines().at(-1).step, 'refused');
  assert.equal(s.lines().find((l) => l.step === 'board').result.code, 3);
  assert.equal(s.commits(), before);
  fs.unlinkSync(path.join(s.boardDir, '.board.lock'));
  assert.equal((await s.press(accept())).json().outcome, 'ok', 'замок снят — проходит');
  // конфликт шапки: board печатает ⚠ и отказывает кодом 4
  const c = await setup();
  fs.writeFileSync(path.join(c.boardDir, '.board-sync.json'), JSON.stringify({ conflict: ['EXT/EXT-7.md'] }));
  const cr = await c.press(accept());
  assert.equal(cr.json().refusal, 'board-conflict');
  assert.equal(cr.json().message, 'на карточке конфликт шапки — решает владелец, зови дирижёра');
  assert.equal(c.lines().find((l) => l.step === 'board').result.code, 4);
  assert.equal(c.header('EXT-7').status, 'review');
  const other = await c.press(accept('EXT-8'));
  assert.equal(other.json().outcome, 'ok', 'другая карточка без конфликта — проходит');
});

test('«похоже на испорченную кодировку» (код 1) → отказ «зови дирижёра», флаг --ok-qmarks витрина не ставит никогда; иной код 1 — строка исхода board Ивану', async () => {
  const s = await setup();
  const bad = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: '??? ??? ??? ???' });
  assert.equal(bad.json().refusal, 'board-encoding');
  assert.equal(bad.json().message, 'запись не прошла: испорченная кодировка — зови дирижёра');
  assert.ok(s.spawned.every((c) => !c[1].includes('--ok-qmarks')));
  assert.equal(s.entries('EXT-7').length, 1);
  const good = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'нормальный текст' });
  assert.equal(good.json().outcome, 'ok');
  // иной код 1: нет такой карточки в файлах (reader видит её устаревшей: файл удалён и закоммичен без опроса)
  const t = await setup();
  git(t.boardDir, 'rm', '-q', 'EXT/EXT-11.md', 'EXT/EXT-11.log.md');
  git(t.boardDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'rm');
  const r = await t.press(accept('EXT-11'));
  assert.equal(r.json().outcome, 'error', JSON.stringify(r.json()));
});

test('⚠-строки board — не исход: исход — строки после всех ⚠; ⚠ в server.log и отдельным полем warnings; чистая доска — без warnings', async () => {
  const sl = [];
  const s = await setup({ slog: { write: (event, f = {}) => sl.push([event, f]) } });
  // грязное дерево: правка отслеживаемого файла мимо board → «⚠ грязное дерево доски: …»
  fs.appendFileSync(path.join(s.boardDir, 'projects.md'), '\n<!-- мимо board -->\n');
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'ok');
  assert.ok(Array.isArray(r.json().warnings) && r.json().warnings.length >= 1, JSON.stringify(r.json()));
  assert.ok(r.json().warnings.every((w) => w.startsWith('⚠')));
  assert.match(r.json().warnings[0], /грязное дерево доски: projects\.md/);
  assert.ok(!r.json().message.includes('⚠'));
  const bl = s.lines().filter((l) => l.step === 'board');
  assert.ok(bl.every((l) => !l.result.line.startsWith('⚠')), 'в строке исхода ⚠ нет');
  assert.match(bl[0].result.line, /^EXT-7 · решение/);
  assert.ok(sl.some(([e, f]) => e === 'board-warn' && /грязное дерево/.test(f.line)));
  const clean = await setup();
  const cr = await clean.press(accept());
  assert.equal(cr.json().outcome, 'ok');
  assert.ok(!('warnings' in cr.json()), 'чистая доска — подсказки нет');
  // разбор чистой функцией: ⚠ в середине вывода, исход — после последней; при коде 0 — последняя строка
  const p = parseOutput('⚠ раз\n⚠ два\nпервая\nпоследняя\n');
  assert.deepEqual(p.warnings, ['⚠ раз', '⚠ два']);
  assert.equal(classify({ code: 0, stdout: '⚠ раз\nEXT-7 review → done · abc\n' }).line, 'EXT-7 review → done · abc');
  assert.equal(classify({ code: 1, stdout: '⚠ раз\nнет карточки EXT-99\nвторая\n' }).line, 'нет карточки EXT-99');
});

// ---------------- partial и неясный исход (пп.4, 5) ----------------

test('partial: запись легла, status отказал (код 3) → «частично», повтор зовёт ТОЛЬКО status (записи в журнале не прибавилось); исправный повтор рядом', async () => {
  const s = await setup({ wrap: { status: 'lock-short' } });
  const first = await s.press(accept());
  // замок берёт только status: log прошёл (его замок — свой), перед status кладём чужой
  assert.equal(first.json().outcome, 'ok', 'без чужого замка — исправный случай проходит');
  const t = await setup({ wrap: { status: 'lock-short' } });
  // чужой замок появляется после шага log: подменный запуск ставит его перед status
  fs.writeFileSync(path.join(t.wdir, 'board-wrap.mjs'), WRAPPER.replace("const hang =", "if (cmd === 'status' && cfg.holdLock) fs.writeFileSync(path.join(cfg.root, '.board.lock'), JSON.stringify({ pid: process.pid, as: 'x', cmd: 'x', at: new Date().toISOString(), boot: cfg.boot }));\nconst hang ="));
  t.setWrap({ status: 'lock-short', holdLock: true, root: t.boardDir, boot: lockLib.bootTime() });
  const r = await t.press(accept());
  assert.equal(r.json().outcome, 'partial', JSON.stringify(r.json()));
  assert.match(r.json().message, /^частично: запись есть, статус не сменился — повторить \(/);
  assert.equal(t.header('EXT-7').status, 'review');
  assert.equal(t.entries('EXT-7').filter((e) => e.kind === 'решение').length, 1);
  const rec = t.lines().find((l) => l.step === 'partial').result.record;
  assert.equal(rec, r.json().id);
  fs.unlinkSync(path.join(t.boardDir, '.board.lock'));
  t.setWrap({});
  const again = await t.press(accept());
  assert.equal(again.json().outcome, 'ok', JSON.stringify(again.json()));
  assert.equal(t.entries('EXT-7').filter((e) => e.kind === 'решение').length, 1, 'второй записи нет');
  assert.equal(t.header('EXT-7').status, 'done');
  const second = t.lines().filter((l) => l.id === again.json().id);
  assert.deepEqual(second.map((l) => `${l.step}${l.cmd ? ':' + l.cmd : ''}`), ['asked', 'board:status', 'done']);
  assert.equal(second.at(-1).result.record, rec, 'номер записи прежний');
});

test('неясный исход log (код 2 «ошибка board:» после коммита): читается <ID>.log.md, запись с номером есть → идём к status, второй записи нет; записи нет → «не легла», status не зовётся', async () => {
  const s = await setup({ wrap: { log: 'crash-after' } });
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.equal(s.entries('EXT-7').filter((e) => e.kind === 'решение').length, 1);
  assert.equal(s.header('EXT-7').status, 'done');
  const steps = s.lines().filter((l) => l.step === 'board').map((l) => `${l.cmd}:${l.result.code}`);
  assert.deepEqual(steps, ['log:2', 'read:0', 'status:0']);
  assert.equal(s.lines().find((l) => l.cmd === 'read').result.line, 'запись найдена');
  // записи нет (исключение до коммита) — error NOT_WRITTEN, статус не менялся
  const n = await setup({ wrap: { log: 'crash-before' } });
  const nr = await n.press(accept());
  assert.equal(nr.json().outcome, 'error');
  assert.match(nr.json().message, /запись не легла/);
  assert.equal(n.lines().find((l) => l.cmd === 'read').result.line, 'записи нет');
  assert.ok(!n.lines().some((l) => l.cmd === 'status'));
  assert.equal(n.lines().at(-1).result.code, 'NOT_WRITTEN');
  assert.equal(n.entries('EXT-7').length, 1);
  // и повтор после этого — обычное нажатие, пишет запись
  n.setWrap({});
  assert.equal((await n.press(accept())).json().outcome, 'ok');
  assert.equal(n.entries('EXT-7').filter((e) => e.kind === 'решение').length, 1);
});

test('таймаут 60 с (здесь 6 с, 1,5 с у зависания до записи): процесс снят деревом по своему pid; запись легла до зависания — к status; не легла — error; прочие процессы живы', async () => {
  // посторонний долгоживущий процесс, запущенный этим же тестом: снятие по pid его не задевает (в конце снимается по своему pid)
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
  const s = await setup({ wrap: { log: 'hang-after' }, seams: { boardTimeoutMs: 6000 } });
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  const pid = Number(fs.readFileSync(path.join(s.wdir, 'pid-log.txt'), 'utf8'));
  await wait(300);
  assert.equal(alive(pid), false, 'зависший board снят');
  assert.deepEqual(s.lines().filter((l) => l.step === 'board').map((l) => `${l.cmd}:${l.result.code}`), ['log:null', 'read:0', 'status:0']);
  assert.equal(s.lines().find((l) => l.cmd === 'log').result.line, 'таймаут');
  // зависание до записи: записи нет
  const n = await setup({ wrap: { log: 'hang-before' }, seams: { boardTimeoutMs: 1500 } });
  const nr = await n.press(accept());
  assert.equal(nr.json().outcome, 'error');
  assert.equal(n.entries('EXT-7').length, 1);
  await wait(300);
  assert.equal(alive(Number(fs.readFileSync(path.join(n.wdir, 'pid-log.txt'), 'utf8'))), false);
  // исправный рядом: без зависания тот же таймаут не мешает
  const ok = await setup({ seams: { boardTimeoutMs: 15000 } });
  assert.equal((await ok.press(accept())).json().outcome, 'ok');
  assert.equal(alive(bystander.pid), true, 'посторонний процесс жив');
  } finally { bystander.kill(); }
});

test('код 1 без строки исхода — неясный; код 2 без «ошибка board:» — вызов не выполнен (error, не неясный)', () => {
  assert.equal(classify({ code: 1, stdout: '' }).kind, 'unclear');
  assert.equal(classify({ code: 2, stdout: 'не id карточки: x\n' }).kind, 'bad-call');
  assert.equal(classify({ code: 2, stdout: 'ошибка board: boom\n' }).kind, 'unclear');
  assert.equal(classify({ code: null, stdout: '', timedOut: true }).kind, 'unclear');
  assert.equal(classify({ code: 1, stdout: 'нет карточки EXT-9\n' }).kind, 'rule');
  assert.equal(classify({ code: 1, stdout: 'похоже на секрет: метка, тело\n' }).kind, 'secret');
  assert.equal(classify({ code: 1, stdout: 'похоже на испорченную кодировку — передай тело файлом\n' }).kind, 'encoding');
});

test('сеть секретов по всему телу (live.guard): класс 2 — отказ всегда; класс 5 — только подтверждённый вид, иной вид и неподтверждённый — отказ; флаги ровно по найденным подтверждённым', () => {
  const live = createLive({ board: {}, runner: {}, scan, tmpDir: tmpDir('g-') });
  const body = (t) => `**Слово Ивана · кнопка витрины · W-1**: «нет»

Причина: ${t}

Кто решил: слово Ивана · кнопка витрины · W-1`;
  assert.equal(live.guard({ notSecret: ['сеть3'] }, [body(SECRET2)], 'EXT').refused.refusal, 'secret');
  assert.match(live.guard({ notSecret: [] }, [body(SECRET5)], 'EXT').refused.message, /сеть3/);
  assert.match(live.guard({ notSecret: ['метка-рядом'] }, [body(SECRET5)], 'EXT').refused.message, /сеть3/);
  assert.deepEqual(live.guard({ notSecret: ['сеть3'] }, [body(SECRET5)], 'EXT'), { flags: ['--not-secret', 'сеть3'] });
  assert.deepEqual(live.guard({ notSecret: ['сеть3', 'метка-рядом'] }, [body('обычный текст')], 'EXT'), { flags: [] }, 'подтверждённого вида в теле нет — флага нет');
  // вторая находка другого вида при подтверждённом первом — отказ (подтверждение не шире текста Ивана)
  const two = `${SECRET5} и ${'q'.repeat(45)}`;
  assert.equal(live.guard({ notSecret: ['сеть3'] }, [body(two)], 'EXT').refused?.refusal, 'secret');
});

// ---------------- свежая сверка по файлам (п.8, п.9) ----------------

test('свежая сверка: тред ответил в файле после q → new-question, board не зовётся; служебная запись «статус» после q вопросом не считается; исправный случай рядом', async () => {
  const s = await setup();
  fs.appendFileSync(path.join(s.boardDir, 'EXT', 'EXT-7.log.md'), logWith('Ещё вопрос: а тесты?', 'trurl:EXT', 'коммент', '2026-10-03 12:05 +03:00'));
  gitCommitAll(s.boardDir, 'тред написал');
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'refused');
  assert.equal(r.json().refusal, 'new-question');
  assert.match(r.json().message, /^на карточке новое сообщение от \d\d:\d\d — посмотри и ответь заново$/);
  assert.ok(!('pull' in r.json()), 'в live кнопки дотяжки нет');
  assert.equal(s.calls().length, 0);
  // служебная запись вместо вопроса: статус review тем же тредом — не новый вопрос
  const t = await setup();
  fs.appendFileSync(path.join(t.boardDir, 'EXT', 'EXT-7.log.md'), logWith('in-progress → review', 'trurl:EXT', 'статус', '2026-10-03 12:05 +03:00'));
  gitCommitAll(t.boardDir, 'статус');
  assert.equal((await t.press(accept())).json().outcome, 'ok');
  // тот же q, но хвост журнала и есть q (читатель берёт любую последнюю): «статус» в ту же минуту — тоже не новое
  const u = await setup();
  fs.appendFileSync(path.join(u.boardDir, 'EXT', 'EXT-7.log.md'), logWith('in-progress → review', 'trurl:EXT', 'статус', '2026-10-03 12:00 +03:00'));
  gitCommitAll(u.boardDir, 'статус в ту же минуту');
  assert.equal((await u.press(accept())).json().outcome, 'ok');
});

test('свежая сверка: статус в шапке уже не review (тред сменил, кэш витрины старый) → stale-status «на доске сейчас …», ничего не записано', async () => {
  const s = await setup();
  const f = path.join(s.boardDir, 'EXT', 'EXT-7.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: review', 'status: in-progress'));
  gitCommitAll(s.boardDir, 'тред вернул в работу');
  const before = s.commits();
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'refused');
  assert.equal(r.json().refusal, 'stale-status');
  assert.match(r.json().message, /^на доске сейчас in-progress/);
  assert.equal(s.commits(), before);
  assert.equal(s.calls().length, 0);
  assert.equal((await s.press(accept('EXT-8'))).json().outcome, 'ok', 'другая карточка — проходит');
});

// ---------------- секреты (п.7) ----------------

test('секрет класса 2 в тексте Ивана → отказ secret до asked, board не зовётся; в голове вопроса q — тоже (без второго щелчка); обычный текст рядом проходит', async () => {
  const s = await setup();
  const r = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: `вот ключ ${SECRET2}` });
  assert.equal(r.json().refusal, 'secret');
  assert.match(r.json().message, /похоже на секрет: префикс/);
  assert.equal(s.lines().every((l) => l.step !== 'asked'), true);
  assert.equal(s.calls().length, 0);
  const q2 = await s.press({ action: 'accept', card: 'EXT-7', q: { at: Q_AT, head: `токен ${SECRET2}` } });
  assert.equal(q2.json().refusal, 'secret');
  assert.match(q2.json().message, /в цитате вопроса/);
  const q5 = await s.press({ action: 'accept', card: 'EXT-7', q: { at: Q_AT, head: `ссылка ${SECRET5} тут` } });
  assert.equal(q5.json().refusal, 'secret', 'класс 5 вне текста Ивана — отказ без второго щелчка');
  assert.equal(s.calls().length, 0);
  assert.equal((await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'просто причина' })).json().outcome, 'ok');
});

test('класс 5 в тексте Ивана → второй щелчок, потом board --not-secret ровно по подтверждённому виду (трейлер Board-Override); без секрета флага нет', async () => {
  const s = await setup();
  const text = `вот значение ${SECRET5} — это не секрет`;
  const first = await s.press({ action: 'return', card: 'EXT-7', q: Q, text });
  assert.equal(first.json().refusal, 'secret-maybe');
  assert.match(first.json().message, /сеть3/);
  assert.equal(s.calls().length, 0);
  const second = await s.press({ action: 'return', card: 'EXT-7', q: Q, text, confirm: first.json().id });
  assert.equal(second.json().outcome, 'ok', JSON.stringify(second.json()));
  const logCall = s.spawned.find((c) => c[1][5] === 'log')[1];
  const ns = logCall.flatMap((a, i) => (a === '--not-secret' ? [logCall[i + 1]] : []));
  assert.deepEqual(ns, ['сеть3']);
  assert.ok(!s.spawned.find((c) => c[1][5] === 'status')[1].includes('--not-secret'));
  const asked = s.lines().find((l) => l.id === second.json().id && l.step === 'asked');
  assert.deepEqual(asked.notSecret, ['сеть3']);
  assert.ok(s.entries('EXT-7').some((e) => e.body.includes(SECRET5)));
  // без секрета — флага нет
  const t = await setup();
  assert.equal((await t.press({ action: 'return', card: 'EXT-7', q: Q, text: 'обычный текст' })).json().outcome, 'ok');
  assert.ok(t.spawned.every((c) => !c[1].includes('--not-secret')));
  assert.equal(trailer(t.boardDir, 'Board-Override'), '');
});

test('подтверждение «не секрет» не переносится на другой текст: второй щелчок с другим текстом — снова secret-maybe, board не зовётся', async () => {
  const s = await setup();
  const first = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: `значение ${SECRET5}` });
  const other = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'Zq8LmN3pXw5Rt7VbKd2C другой', confirm: first.json().id });
  assert.equal(other.json().refusal, 'secret-maybe');
  assert.equal(s.calls().length, 0);
});

// ---------------- слова live ----------------

test('слово «да» live: запись решением без смены статуса, «записано в доску», без дотяжки зеркала и без Plane', async () => {
  const s = await setup();
  const r = await s.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.match(r.json().message, /^записано в доску \d\d:\d\d · /);
  assert.equal(s.header('EXT-9').status, 'in-progress');
  const e = s.entries('EXT-9').at(-1);
  assert.equal(e.kind, 'решение');
  assert.ok(e.body.startsWith(`**Слово Ивана · кнопка витрины · ${r.json().id}**: «да»`), e.body);
  assert.deepEqual(s.planeCalls(), []);
  assert.deepEqual(s.lines().filter((l) => l.step === 'board').map((l) => l.cmd), ['log']);
  const no = await s.press({ action: 'no', card: 'EXT-9', q: Q, text: 'не надо' });
  assert.equal(no.json().outcome, 'ok');
  assert.ok(s.entries('EXT-9').at(-1).body.includes('Причина: не надо'));
  // закрытая карточка (в файлах Done) — отказ closed
  const f = path.join(s.boardDir, 'EXT', 'EXT-10.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: review', 'status: done'));
  gitCommitAll(s.boardDir, 'закрыта');
  const c = await s.press({ action: 'yes', card: 'EXT-10', q: Q });
  assert.equal(c.json().refusal, 'closed');
});

test('«сливай» live: второй щелчок без возраста зеркала (confirm.mirrorAt = null); запись после подтверждения', async () => {
  const s = await setup();
  const first = await s.press({ action: 'merge', card: 'EXT-7', q: Q });
  assert.equal(first.json().outcome, 'need-confirm');
  assert.equal(first.json().confirm.mirrorAt, null);
  assert.equal(s.calls().length, 0);
  const second = await s.press({ action: 'merge', card: 'EXT-7', q: Q, confirm: first.json().id });
  assert.equal(second.json().outcome, 'ok', JSON.stringify(second.json()));
  assert.ok(s.entries('EXT-7').at(-1).body.includes('«сливай»'));
});

// ---------------- новая карточка (п.5, таблица) ----------------

test('новая карточка live: new … --force-new после СВОЕГО поиска дублей — похожие → второй щелчок → создаётся даже дубль заголовка; тело — файлом, Кто решил', async () => {
  const s = await setup();
  const title = 'Семь';
  const first = await s.press({ action: 'new-card', project: 'EXT', title, text: 'описание задачи' });
  assert.equal(first.json().outcome, 'need-confirm');
  assert.deepEqual(first.json().confirm.similar.map((x) => x.id), ['EXT-7']);
  assert.equal(first.json().confirm.mirrorAt, null);
  assert.equal(s.calls().length, 0, 'поиск дублей — своя функция, board не зовётся');
  const second = await s.press({ action: 'new-card', project: 'EXT', title, text: 'описание задачи', confirm: first.json().id });
  assert.equal(second.json().outcome, 'ok', JSON.stringify(second.json()));
  assert.match(second.json().message, /^создана EXT-12 · Backlog$/);
  assert.equal(second.json().created, 'EXT-12');
  assert.equal(s.header('EXT-12').title, title);
  const ncall = s.spawned.find((c) => c[1][5] === 'new')[1];
  assert.deepEqual(ncall.slice(5, 8), ['new', 'EXT', title]);
  assert.ok(ncall.includes('--force-new') && ncall.includes('--body-file'));
  assert.equal(trailer(s.boardDir, 'Board-As'), 'ivan');
  const body = fs.readFileSync(path.join(s.boardDir, 'EXT', 'EXT-12.md'), 'utf8');
  assert.ok(body.includes('описание задачи') && body.includes(`Кто решил: слово Ивана · кнопка витрины · ${second.json().id}`), body);
  assert.deepEqual(s.planeCalls(), []);
  assert.deepEqual(s.tmpFiles(), []);
  // без похожих — сразу создаётся, исправный случай
  const ok = await s.press({ action: 'new-card', project: 'EXT', title: 'Совсем другое дело про уборку', text: '' });
  assert.equal(ok.json().outcome, 'ok');
  assert.equal(ok.json().created, 'EXT-13');
});

test('неясный new: карточка с этим заголовком, созданная после asked, с коммитом Board-As: ivan — её номер в исход, дубля нет; нет — «не знаю, создана ли»; чужая подпись или старая карточка не годятся', async () => {
  const title = 'Новая уникальная затея';
  const s = await setup({ wrap: { new: 'crash-after' } });
  const r = await s.press({ action: 'new-card', project: 'EXT', title, text: 'тело' });
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.equal(r.json().created, 'EXT-12');
  assert.deepEqual(s.lines().filter((l) => l.step === 'board').map((l) => `${l.cmd}:${l.result.code}`), ['new:2', 'read:0']);
  assert.equal(fs.readdirSync(path.join(s.boardDir, 'EXT')).filter((n) => /^EXT-\d+\.md$/.test(n)).length, 6);
  // исключение до записи — карточки нет
  const n = await setup({ wrap: { new: 'crash-before' } });
  const nr = await n.press({ action: 'new-card', project: 'EXT', title, text: 'тело' });
  assert.equal(nr.json().outcome, 'error');
  assert.match(nr.json().message, /^не знаю, создана ли — проверь доску/);
  assert.equal(n.lines().at(-1).result.code, 'UNCLEAR');
  // карточка с тем же заголовком создана ЧУЖОЙ подписью после asked — не наша
  const d = await setup({ wrap: { new: 'decoy-crash' } });
  const dr = await d.press({ action: 'new-card', project: 'EXT', title, text: 'тело' });
  assert.equal(dr.json().outcome, 'error', JSON.stringify(dr.json()));
  assert.match(dr.json().message, /^не знаю, создана ли/);
  assert.equal(d.header('EXT-12').title, title, 'чужая карточка в файлах есть');
  // та же карточка, но создана до asked (шапка старая) — не годится
  const o = await setup({ cards: [{ id: 'EXT-7', status: 'review', title }], wrap: { new: 'crash-before' } });
  const or = await o.press({ action: 'new-card', project: 'EXT', title, text: 'тело', confirm: undefined });
  assert.equal(or.json().outcome, 'need-confirm', 'сначала похожие — свой поиск');
});

// ---------------- зеркало в live (п.15) ----------------

test('зеркало в live → отказ 200 mode-live «доска в git — зеркало не нужно», процесс зеркала не запускается; в mirror та же кнопка запускает', async () => {
  const s = await setup();
  const r = await s.press({ action: 'mirror' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, 'refused');
  assert.equal(r.json().refusal, 'mode-live');
  assert.equal(r.json().message, 'доска в git — зеркало не нужно');
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'refused']);
  assert.equal(s.lines().at(-1).mode, 'live');
  const full = await s.press({ action: 'mirror', kind: 'full' });
  assert.equal(full.json().refusal, 'mode-live');
  // повтор тем же intentId после рестарта восстанавливается тем же кодом 200
  const { restoreIntents } = await import('../lib/pult/routes.mjs');
  const again = restoreIntents(s.lines().map((l, i) => (i === 0 ? { ...l, client: { intentId: 'aaaaaaaa-0000-4000-8000-000000000001' } } : l)), Date.now());
  assert.equal((await [...again.values()][0].promise).code, 200);
});

// ---------------- читатели actions.log: оба шага ----------------

test('priorOpen: шаг board log — тот же след, что plane comment; прежнее mirror-действие без записи отдаёт mode mirror; отказ mirror-prior прежнее снимает', () => {
  const L = (id, extra) => ({ id, card: 'EXT-7', action: 'accept', at: '2026-10-10T10:00:00+03:00', ...extra });
  const live = [L('W-1', { step: 'asked', mode: 'live' }), L('W-1', { step: 'board', cmd: 'log', mode: 'live', result: { code: 0 } }), L('W-1', { step: 'board', cmd: 'status', mode: 'live', result: { code: 3 } }),
    L('W-1', { step: 'partial', mode: 'live', result: { outcome: 'partial', record: 'W-1' } })];
  assert.deepEqual(priorOpen(live, 'EXT-7', 'accept', 'W-2'), { id: 'W-1', record: 'W-1', known: true, mode: 'live' });
  const mirror = [L('W-0', { step: 'asked', mode: 'mirror' }), L('W-0', { step: 'plane', cmd: 'comment', mode: 'mirror', result: { code: 0 } }), L('W-0', { step: 'partial', mode: 'mirror', result: { outcome: 'partial', record: 'W-0' } })];
  assert.deepEqual(priorOpen(mirror, 'EXT-7', 'accept', 'W-2'), { id: 'W-0', record: 'W-0', known: true, mode: 'mirror' });
  const dropped = [...mirror, L('W-3', { step: 'asked', mode: 'live' }), L('W-3', { step: 'refused', mode: 'live', refusal: 'mirror-prior', prior: 'W-0' })];
  assert.equal(priorOpen(dropped, 'EXT-7', 'accept', 'W-4'), null);
  // контроль: шаг без записи (только status) — прежнего открытого нет
  assert.equal(priorOpen([L('W-5', { step: 'asked' }), L('W-5', { step: 'board', cmd: 'status', result: { code: 0 } })], 'EXT-7', 'accept', 'W-6'), null);
});

test('markCandidates: у действий live отметок нет; у действий mirror после перехода без записи в файлах — красное «запись … не перенесена в доску», с записью — снято', () => {
  const mk = (id, mode) => [{ id, step: 'asked', action: 'accept', card: 'EXT-7', mode, at: '2026-10-10T10:00:00+03:00' },
    { id, step: 'done', action: 'accept', card: 'EXT-7', mode, at: '2026-10-10T10:00:05+03:00', result: { outcome: 'ok', record: id, state: 'Done', planeAt: '2026-10-10T07:00:05.000Z' } }];
  const now = Date.parse('2026-10-10T07:30:00Z');
  const none = () => ({ entries: [] });
  assert.equal(markCandidates({ lines: mk('W-L', 'live'), readLog: none, now, live: true }).length, 0, 'live — отметок нет');
  const red = markCandidates({ lines: mk('W-M', 'mirror'), readLog: none, now, live: true });
  assert.equal(red.length, 1);
  assert.equal(red[0].missing, true);
  assert.equal(red[0].mark.text, 'запись W-M не перенесена в доску (Plane после заморозки)');
  const seen = markCandidates({ lines: mk('W-M', 'mirror'), readLog: () => ({ entries: [{ body: 'Слово Ивана · W-M' }] }), now, live: true });
  assert.equal(seen.length, 0, 'запись перенесена — отметки нет');
  // контроль: до перехода (live = false) красной без прохода зеркала нет, текст прежний
  const before = markCandidates({ lines: mk('W-M', 'mirror'), readLog: none, now, live: false });
  assert.equal(before[0].missing, false);
  assert.match(before[0].mark.text, /зеркало ещё не видело/);
});

// ---------------- действия, начатые в mirror, после перехода (п.13) ----------------

const mirrorPartial = (id, card = 'EXT-7') => [
  { id, step: 'asked', at: '2026-10-10T10:00:00+03:00', action: 'accept', card, project: 'EXT', mode: 'mirror', q: Q, client: { intentId: 'bbbbbbbb-0000-4000-8000-00000000000a' } },
  { id, step: 'plane', at: '2026-10-10T10:00:03+03:00', action: 'accept', card, mode: 'mirror', cmd: 'comment', result: { code: 0, line: 'ok', ms: 5 } },
  { id, step: 'partial', at: '2026-10-10T10:00:05+03:00', action: 'accept', card, mode: 'mirror', result: { outcome: 'partial', record: id, ms: 9 } },
];

test('действие начато в mirror (partial), запись перенесена в файлы доски → «Принять» после перехода зовёт только status; без Plane', async () => {
  const s = await setup({ log: mirrorPartial('W-251010-100000-aaaa') });
  fs.appendFileSync(path.join(s.boardDir, 'EXT', 'EXT-7.log.md'), logWith('**Слово Ивана · кнопка витрины · W-251010-100000-aaaa**: «принято»\n\nКто решил: слово Ивана', 'plane', 'коммент', '2026-10-03 12:00 +03:00'));
  gitCommitAll(s.boardDir, 'перенос зеркалом');
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'ok', JSON.stringify(r.json()));
  assert.deepEqual(s.calls().map((c) => c.cmd), ['status']);
  assert.equal(s.header('EXT-7').status, 'done');
  assert.deepEqual(s.planeCalls(), []);
});

test('действие начато в mirror, записи в файлах нет → отказ «начато до перехода … нажми заново»; второе нажатие — новое действие, пишет свою запись; прежнее больше не продолжается', async () => {
  const s = await setup({ log: mirrorPartial('W-251010-100000-bbbb') });
  const r = await s.press(accept());
  assert.equal(r.json().outcome, 'refused');
  assert.equal(r.json().refusal, 'mirror-prior');
  assert.equal(r.json().message, 'действие начато до перехода, запись в Plane в доску не перенесена — нажми заново');
  assert.equal(s.calls().length, 0);
  assert.equal(s.lines().at(-1).prior, 'W-251010-100000-bbbb');
  const again = await s.press(accept());
  assert.equal(again.json().outcome, 'ok', JSON.stringify(again.json()));
  assert.deepEqual(s.calls().map((c) => c.cmd), ['log', 'status']);
  assert.equal(s.entries('EXT-7').filter((e) => e.kind === 'решение').length, 1);
});

// ---------------- одна очередь записей на сервер (п.3) ----------------

test('одна очередь: два одновременных нажатия по разным карточкам — вызовы board идут по одному, не перекрываясь; чтения (без board) параллельны', async () => {
  const s = await setup({ wrap: { log: 'slow', status: 'slow', slowMs: 400 } });
  const [a, b] = await Promise.all([s.press(accept('EXT-7')), s.press(accept('EXT-8'))]);
  assert.equal(a.json().outcome, 'ok', JSON.stringify(a.json()));
  assert.equal(b.json().outcome, 'ok', JSON.stringify(b.json()));
  const cs = s.calls().sort((x, y) => x.start - y.start);
  assert.equal(cs.length, 4);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].start >= cs[i - 1].end, `вызов ${i} начался до конца предыдущего: ${JSON.stringify(cs)}`);
  assert.ok(new Set(cs.map((c) => c.pid)).size === 4);
});

// ---------------- «Отозвать» без звонка в live (запись об отзыве — board) ----------------

const SID = '11111111-2222-4333-8444-555555555555';
const thread = (sid, o = {}) => ({ sessionId: sid, title: `тред ${sid.slice(-3)}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), ...o });

test('отзыв слова с карточкой в live: звонок снят, запись «отозвать …» пишет board log решением, Plane не зовётся; без звонка (pult.bell выключен) — отказ bell-off без записи', async () => {
  const s = await setup({ bell: true, threads: [thread(SID, { card: 'EXT-7' })] });
  const w = await s.press({ action: 'return', card: 'EXT-7', q: Q, text: 'доделай' });
  assert.equal(w.json().outcome, 'ok', JSON.stringify(w.json()));
  assert.ok(s.lines().some((l) => l.step === 'ring-queued'), 'слово положено в звонок');
  const wd = await s.press({ action: 'withdraw', target: w.json().id });
  assert.equal(wd.json().outcome, 'ok', JSON.stringify(wd.json()));
  assert.match(wd.json().message, /^отозвано · запись на EXT-7 легла \d\d:\d\d/);
  const last = s.entries('EXT-7').filter((e) => e.kind === 'решение').at(-1);
  assert.ok(last.body.startsWith(`**Слово Ивана · кнопка витрины · ${wd.json().id}**: «отозвать ${w.json().id}»`), last.body);
  assert.ok(last.body.includes('Отзывает: ') && last.body.trimEnd().endsWith(`Кто решил: слово Ивана · кнопка витрины · ${wd.json().id}`));
  assert.deepEqual(s.planeCalls(), []);
  assert.ok(s.lines().filter((l) => l.id === wd.json().id).some((l) => l.step === 'board' && l.cmd === 'log' && l.result.code === 0));
  assert.ok(s.lines().filter((l) => l.id === wd.json().id).every((l) => l.mode === 'live'));
  assert.ok(s.lines().some((l) => l.step === 'withdrawn' && l.reason === 'ivan'));
  // без звонка отзывать нечего
  const n = await setup();
  const yes = await n.press({ action: 'yes', card: 'EXT-9', q: Q });
  assert.equal(yes.json().outcome, 'ok');
  const no = await n.press({ action: 'withdraw', target: yes.json().id });
  assert.equal(no.json().refusal, 'bell-off');
  assert.equal(n.entries('EXT-9').filter((e) => e.kind === 'решение').length, 1);
});
