// Образцы ответов для вёрстки (web/fixtures, спека 1.6) не расходятся с ключами настоящих ручек.
// Заготовки В1 (null / пустой список) явно перечислены в PENDING с тактом, который их наполняет:
// у них образец показывает целевую форму, а настоящая ручка — пока пустоту. Ключи с «_» в образце — пояснения.
import { createBoardSync } from '../lib/board-sync.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildWorkers } from '../lib/waiting.mjs';
import { createGitReader } from '../lib/git-reader.mjs';
import { createTraceChecker } from '../lib/trace.mjs';
import { createGlossary } from '../lib/glossary.mjs';
import { createRoles } from '../lib/roles.mjs';
import { createAgentDefs } from '../lib/agent-defs.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, git } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const PENDING = {
  ceh: {},
  project: {},
  card: {},
  health: {},
  glossary: {},
  agents: {},
};

// лента карточки — разнородный список: образец каждого вида сверяется с элементом того же вида у ручки
const BY_KIND = ['feed'];
// словари с ключом-путём (не фиксированные ключи) — сверяется только, что это объект
// словари «значение → число» дрейфа разбора (EXT-53) — ключи меняются, сверяется только то, что это словарь
const DRIFT_DICT = ['noteStatus', 'noteNoId', 'noteForeignId', 'resultStatus', 'launchName', 'originKind', 'turnTool', 'turnOrigin'].map((k) => `readers.journals.drift.${k}`); // turnTool — EXT-107 Р1, turnOrigin — EXT-109
const DICT = ['gitCalls', 'readers.journals.unknown', 'readers.processes.unknownStatus', 'readers.processes.unknownWaitingFor', ...DRIFT_DICT];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
const empty = (v) => v === null || (Array.isArray(v) && v.length === 0);
const kind = (v) => (Array.isArray(v) ? 'array' : typeof v);
// Образец массива объектов: первый элемент, а пустые у него поля — из следующих элементов (у первого треда образца
// субагентов нет, у третьего есть — сверяется и их форма).
function template(arr) {
  const t = { ...arr[0] };
  for (const k of Object.keys(t)) if (empty(t[k])) t[k] = arr.map((x) => x?.[k]).find((v) => !empty(v)) ?? t[k];
  return t;
}

// Сверка: ключи объекта равны; заготовка — у ручки пусто; непустой массив образца без пометки — у ручки непустой;
// типы листьев равны (null с любой стороны не сверяется); вглубь — у массивов первый элемент ручки против образца.
function compare(fx, real, pending, at = '') {
  assert.deepEqual(keys(fx), keys(real), `ключи ${at || 'верхнего уровня'}`);
  for (const k of keys(fx)) {
    const p = at ? `${at}.${k}` : k;
    if (DICT.includes(p)) { assert.ok(isObj(fx[k]) && isObj(real[k]), p); continue; }
    if (BY_KIND.includes(p)) {
      for (const kd of new Set(fx[k].map((x) => x.kind))) {
        const r = real[k].find((x) => x.kind === kd);
        assert.ok(r, `${p}: у ручки нет элемента вида ${kd}`);
        compare(template(fx[k].filter((x) => x.kind === kd)), r, pending, `${p}[${kd}]`);
      }
      continue;
    }
    if (pending[p]) { assert.ok(empty(real[k]), `${p}: заготовка (наполняет ${pending[p]}) должна быть пустой`); continue; }
    if (fx[k] !== null && real[k] !== null) assert.equal(kind(real[k]), kind(fx[k]), `${p}: тип`);
    if (Array.isArray(fx[k]) && fx[k].length > 0) assert.ok(Array.isArray(real[k]) && real[k].length > 0, `${p}: в образце непусто, пометки нет — у ручки должно быть непусто`);
    if (isObj(fx[k]) && isObj(real[k])) compare(fx[k], real[k], pending, p);
    else if (Array.isArray(fx[k]) && isObj(fx[k][0]) && isObj(real[k]?.[0])) compare(template(fx[k]), real[k][0], pending, p);
  }
}

async function realResponses() {
  const now = Date.now();
  const hm = (ms) => { const d = new Date(ms + 3 * 3600000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 16)} +03:00`; };
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека', body: 'Тело.' }, { id: 'EXT-7', status: 'in-progress', title: 'Слить', parent: 'EXT-6', blocks: ['EXT-6'] },
    { id: 'EXT-8', status: 'backlog', title: 'Потом' }, { id: 'EXT-9', status: 'ready', title: 'Следом' }, { id: 'EXT-10', status: 'done', title: 'Готово' }] });
  // (б): последняя запись EXT-7 с маркером, свежая; зеркало — .mirror/status.json (В-5)
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-7.log.md'), `### ${hm(now - 3600000)} · plane · коммент\n\nЖдёт «сливай».\n\n`);
  fs.mkdirSync(path.join(dir, '.mirror'));
  fs.writeFileSync(path.join(dir, '.mirror', 'status.json'), JSON.stringify({ lastOk: new Date(now - 86400000).toISOString() }));
  gitInitCommit(dir);
  const reg = path.join(tmpDir('reg-'), 'registry.json');
  // В5: репозиторий проекта (здесь — сама доска: маячок есть, коммиты доски в ленту не идут) и общий с коммитом EXT-6
  const shared = tmpDir('shared-'); fs.writeFileSync(path.join(shared, 'a.txt'), 'x'); gitInitCommit(shared);
  git(shared, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'spec: витрина (EXT-6)');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [dir] } }, board_shared_repos: { repos: [shared] } }));
  // EXT-48: контракт закрытия EXT-6 со следом — коммит общего репозитория (origin/main у него нет — жёлтое «отправку не
  // проверить»: причины и коммиты непусты, форма сверяется целиком)
  // 7-знаковое начало без буквы a–f или без цифры хешем не считается (§1.4а) — тогда коммит переписывается с другим телом
  let specHash = git(shared, 'rev-parse', '--short=7', 'HEAD').trim();
  for (let i = 0; !(/[0-9]/.test(specHash) && /[a-f]/.test(specHash)); i++) {
    git(shared, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--amend', '--allow-empty', '-m', 'spec: витрина (EXT-6)', '-m', `проба ${i}`);
    specHash = git(shared, 'rev-parse', '--short=7', 'HEAD').trim();
  }
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-6.log.md'), `### ${hm(now - 7200000)} · plane · коммент

Закрытие EXT-6 · контракт (вердикт Голема)

-   **Что изменилось в системе:** спека.
-   **Откат:** revert.
-   **Остаточный риск:** нет.
-   **Доставка:** общий ${specHash}.
-   **Знание:** записи нет — спека.

`);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', 'commit', '-q', '-am', 'EXT-6 контракт');
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const journals = createJournalReader({ root: tmpDir('jr-'), indexDir: tmpDir('ji-') });
  await journals.refresh();
  // живые треды EXT (В3): ждущий ответа на AskUserQuestion и работающий с живым субагентом; оба открыты до
  // «правила обновлены»; закрытый тред с висящим ▶ на EXT-6 (В-6 (б)) — данные выжимок читателей
  const sid = '00000000-0000-4000-8000-000000000003';
  const sidW = '00000000-0000-4000-8000-000000000001';
  const sidC = '00000000-0000-4000-8000-000000000009';
  const procs = [
    { pid: 101, sessionId: sid, hostSessionId: 'local_x', name: null, status: 'busy', startedAt: now - 3600000, statusUpdatedAt: now, observedAt: now, live: true },
    { pid: 102, sessionId: sidW, hostSessionId: 'local_w', name: null, status: 'waiting', waitingFor: 'input needed', startedAt: now - 3600000, statusUpdatedAt: now, observedAt: now, live: true },
  ];
  const at = new Date(now - 600000).toISOString();
  const sessions = [
    { sessionId: sid, ivan: { cards: { 'EXT-6': { n: 1, firstAt: at, lastAt: at } } }, boardWrites: [], thread: { askOpen: false, endTurnQ: null, lastAt: at },
      // EXT-49: выжимка памяти читателя — у ручки поле memory в полной форме (сверяется с образцом)
      memory: { tokens: 378000, model: 'claude-opus-5-5', at, compactions: 2 },
      runs: [{ agentId: 'a1', agentType: 'terminus', description: 'EXT-6 В3', target: 60, cards: ['EXT-6', 'EXT-7'], at, turns: 3, zakhods: [3], alive: true, lastEndAt: null, currentZakhod: 3, lastAt: at }] },
    { sessionId: sidW, ivan: { cards: {} }, boardWrites: [], runs: [{ agentId: 'a2', agentType: 'golem', description: 'EXT-7 ревью', target: null, alive: true, lastEndAt: null, currentZakhod: 1, lastAt: at }], thread: { askOpen: true, endTurnQ: null, lastAt: at, ask: { text: 'Какой вариант?', uuid: 'u1', at } }, memory: { tokens: 836000, model: 'claude-opus-5-5', at, compactions: 0 } },
    { sessionId: sidC, ivan: { cards: {} }, runs: [], thread: { customTitle: 'EXT · закрытый' }, boardWrites: [{ at: new Date(now - 4 * 3600000).toISOString(), refs: ['EXT-6'], firstLine: '▶ выдан: terminus · ext-6 · В4' }] },
  ];
  const titles = { local_x: 'EXT · витрина', local_w: 'EXT · вопрос' };
  const threads = {
    list: () => buildWorkers({ procs, desktop: (h) => ({ title: titles[h] }), sessions, board, maxTurns: () => 90, now, thresholds: { taktYellowMin: 60, taktRedMin: 180, waitingOverDayHours: 24, staleMin: 15 }, rulesAt: new Date(now - 1800000).toISOString(), contextWindow: { 'claude-opus-5-5': 1000000 } }),
    state: () => ({ processes: { lastOkAt: at, errors: 0, lastError: null, files: 1, live: 1 }, desktop: { lastOkAt: at, errors: 0, lastError: null, files: 1 } }),
  };
  const registry = createRegistryReader(reg);
  const gitReader = createGitReader({ git: createGitRead(), registry, boardRoot: dir });
  await gitReader.refresh();
  await board.refresh();
  const trace = createTraceChecker({ git: createGitRead(), registry, board });
  await trace.refresh();
  // EXT-61: словарь — файл в формате Vault unorbis/Словарь.md (два раздела по две строки)
  const gl = path.join(tmpDir('gl-'), 'Словарь.md');
  const tbl = (a, b) => `| Термин | По-русски | Что это у нас | Пример |
|---|---|---|---|
| ${a} | р | ч | п |
| ${b} | р | ч | \`к\` |
`;
  fs.writeFileSync(gl, `---
type: reference
---

# Словарь

## Код

${tbl('branch', 'commit')}
## Цех

${tbl('backlog', 'fallback')}`);
  // EXT-99 (§2.12): состояние тихой отправки доски — настоящий модуль на той же временной доске (флаг выключен, sync не зовётся)
  const boardSync = createBoardSync({ root: dir, git: createGitRead(), lock: { pidAlive: () => false, otherBoot: () => false }, scan: () => [], run: () => { throw new Error('sync не зовётся'); } });
  await boardSync.tick();
  // EXT-116: реестр ролей — настоящий читатель на временной копии реестра Vault 2de0aff (test/fixtures/roles) и шести
  // определениях по факту 15.10 (спека, Р2) во временной папке; живой Vault и ~/.claude не читаются
  const vault = tmpDir('vault-');
  fs.mkdirSync(path.join(vault, 'unorbis', '_meta'), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'roles', 'registry-2de0aff.md'), path.join(vault, 'unorbis', '_meta', 'Реестр ролей цеха.md'));
  const defsDir = tmpDir('defs-');
  for (const [n, t, m] of [['bard', 120, 'inherit'], ['clap', 40, 'inherit'], ['demon', 60, 'sonnet'], ['golem', 40, 'opus'], ['terminus', 90, 'inherit'], ['tikhiy', 25, 'sonnet']]) fs.writeFileSync(path.join(defsDir, `${n}.md`), `---\nname: ${n}\nmodel: ${m}\nmaxTurns: ${t}\n---\n`);
  const roles = createRoles({ file: () => path.join(vault, 'unorbis', '_meta', 'Реестр ролей цеха.md'), defs: createAgentDefs({ dir: defsDir }).read });
  const app = await buildApp({ port: 4317, board, boardSync, registry, journals: { state: journals.state, sessions: () => sessions }, threads, scan: () => [], gitReader, projectCards: { get: () => ({ phase: 'Фаза.', next: 'Шаг.' }) }, maxTurns: () => 90, pult: { enabled: true }, trace, glossary: createGlossary({ file: () => gl }), roles });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { ceh: await get('/api/ceh'), project: await get('/api/project/EXT'), card: await get('/api/card/EXT-6'), health: await get('/api/health'), glossary: await get('/api/glossary'), agents: await get('/api/agents') };
}
const real = await realResponses();

test('свежесть журналов (В2) — время последнего удачного прохода читателя, в «Цехе» и окне проекта', () => {
  assert.match(real.ceh.freshness.journals.lastOkAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(real.project.freshness.journals.lastOkAt, real.ceh.freshness.journals.lastOkAt);
});

test('образцы: все файлы — JSON', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) assert.doesNotThrow(() => load(f), f);
});

for (const [name, file] of [['ceh', 'ceh.json'], ['project', 'project-EXT.json'], ['card', 'card-EXT-6.json'], ['health', 'health.json'], ['glossary', 'glossary.json'], ['agents', 'agents.json']]) {
  test(`образец ${file}: ключи как у настоящей ручки, заготовки помечены тактом`, () => {
    compare(load(file), real[name], PENDING[name]);
  });
}

test('EXT-116: сверка agents.json и readers.roles — против настоящего читателя реестра, не против заглушки NO_ROLES', () => {
  assert.equal(real.agents.error, null);
  assert.ok(real.agents.roles.length > 0);
  assert.ok(real.health.readers.roles.roles > 0);
  assert.ok(real.agents.roles.some((r) => r.check), 'сверка с определениями посчитана');
});

test('EXT-116: образцы agents-error.json и agents-drift.json — форма agents.json и нужные окну Т2 случаи', () => {
  const ok = load('agents.json');
  const roleKeys = keys(ok.roles[0]);
  for (const f of ['agents-error.json', 'agents-drift.json']) {
    const fx = load(f);
    assert.deepEqual(keys(fx), keys(ok), f);
    for (const r of fx.roles) assert.deepEqual(keys(r), roleKeys, `${f}: ${r.name}`);
  }
  assert.equal(ok.roles.length, 11);
  assert.equal(ok.error, null);
  assert.equal(ok.drifts, 0);
  const er = load('agents-error.json');
  assert.ok(er.error && er.failingSince && er.roles.length > 0, 'ошибка с прежними ролями');
  const dr = load('agents-drift.json');
  const has = (p) => dr.roles.some(p);
  assert.ok(has((r) => r.check?.brake === 'drift' && r.drift.some((d) => d.field === 'brake')), 'brake drift');
  assert.ok(has((r) => r.check?.model === 'drift' && r.drift.some((d) => d.field === 'model')), 'model drift');
  assert.ok(has((r) => r.check?.model === 'unchecked'), 'model unchecked');
  assert.ok(has((r) => r.check === null && r.fact?.def === false), 'без определения');
  assert.ok(has((r) => r.check === null && r.fact?.def === null), 'определение не читается');
  assert.ok(has((r) => r.status === 'proposal'), 'предложение');
  assert.ok(has((r) => r.problems.length > 0 && r.sections.some((s) => s.text === null)), 'разобрано не всё');
  assert.equal(dr.drifts, dr.roles.reduce((n, r) => n + r.drift.length, 0));
});

test('образец ceh.json: порядок проектов — решение Ивана 5; состояния тредов — один словарь §2.1, каждое есть', () => {
  const fx = load('ceh.json');
  assert.deepEqual(fx.projects.map((p) => p.code), ['CAR', 'LEDGER', 'MAKAR', 'ASTRO', 'BW', 'INFRA', 'EXT', 'RADAR', 'IPTV']);
  const STATES = ['waiting', 'busy', 'idle', 'stale'];
  const seen = fx.workers.threads.map((t) => t.state);
  for (const s of seen) assert.ok(STATES.includes(s), s);
  for (const s of STATES) assert.ok(seen.includes(s), `нет образца состояния ${s}`);
  for (const t of fx.workers.threads.filter((x) => x.state === 'stale')) assert.ok(STATES.includes(t.lastState), 'устарело: lastState — вычисленное состояние');
  assert.equal(fx.projects.find((p) => p.code === 'EXT').name, null); // имя-заглушка «—» → null (В7, EXT-32)
  assert.equal(load('project-EXT.json').name, null);
  assert.ok(!JSON.stringify(fx).includes('"lastOk"'));
});

test('доска проекта: «<агент> работает» — живой субагент из строк «Кто работает» (В3) с номером карточки в ТЗ', () => {
  const ip = real.project.board.inProgress;
  assert.deepEqual(ip.map((c) => [c.id, c.agentWorking]), [['EXT-7', 'Терминус']]);
  assert.equal(real.project.board.ready[0].agentWorking, null);
});
