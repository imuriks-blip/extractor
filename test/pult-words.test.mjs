// Пульт ПТ6, часть 1 (EXT-67; спека пульта §1.1 пп.4–9, §1.2, таблица 1.3 «да» «го» «сливай» «выкатывай» «нет» «Ответ треду»,
// §2.3, §2.8, §4.3 «pult.words», строка ПТ6 §7): слова-кнопки на подменном plane.py (test/fake-plane.mjs) и временной доске.
// Настоящий plane.py и mirror.mjs не запускаются: python = node, planePy = копия подменного, запуск wscript — подменный spawn.
// Ожидаемые значения — из спеки и из того, что положено в тест, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { restoreIntents } from '../lib/pult/routes.mjs';
import { bDeal } from '../lib/pult/words.mjs';
import { BOARD_LIB, tmpDir, makeBoard, writeCard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 700;
const nextIntent = () => uuid(++intents);
const SID = uuid(801);
const SID2 = uuid(802);
const QU = uuid(901); // сообщение треда с вопросом (журнал)

const Q_MD = '**Ветка** готова — `ext-7` можно принимать?';
const Q_HTML = '<p><strong>Ветка</strong> готова — <code>ext-7</code> можно принимать?</p>';
const Q_AT = '2026-10-03T09:00:00.000Z';
const logWith = (body) => `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${body}\n`;

// EXT-20 обычная (А-дело), EXT-21 без записей, EXT-22 в Review (сливай/выкатывай), EXT-23 mark_b, EXT-24 закрыта, EXT-25 «база» в заголовке,
// EXT-26 последняя запись — вопрос «сливай?», EXT-27 в Review (для «Принять»)
const boardDir = makeBoard(tmpDir('words-board-'), { codes: ['EXT', 'CAR'], cards: [
  { id: 'EXT-20', status: 'in-progress', title: 'Обычная' }, { id: 'EXT-21', status: 'in-progress', title: 'Без записей' },
  { id: 'EXT-22', status: 'review', title: 'Слияние' }, { id: 'EXT-23', status: 'in-progress', title: 'Метка Б', markB: true },
  { id: 'EXT-24', status: 'done', title: 'Закрыта' }, { id: 'EXT-25', status: 'in-progress', title: 'Миграция базы клиентов' },
  { id: 'EXT-26', status: 'in-progress', title: 'Вопрос про слияние' }, { id: 'EXT-27', status: 'review', title: 'Принять' },
] });
for (const id of ['EXT-20', 'EXT-22', 'EXT-23', 'EXT-24', 'EXT-25', 'EXT-27']) fs.writeFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), logWith(Q_MD));
fs.rmSync(path.join(boardDir, 'EXT', 'EXT-21.log.md'));
fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-26.log.md'), logWith('Сливай ветку в main?'));
gitInitCommit(boardDir);
fs.mkdirSync(path.join(boardDir, '.mirror'));
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}');
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: '2026-10-03T09:30:00.000Z', lastOk: '2026-10-03T09:30:00.000Z' }));
fs.mkdirSync(path.join(boardDir, 'tools'));
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка: настоящий не запускается\n');
const regFile = path.join(tmpDir('words-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, CAR: { repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ch = new EventEmitter();
    ch.pid = 9000 + calls.length;
    ch.unref = () => {};
    process.nextTick(() => ch.emit('spawn'));
    return ch;
  };
  fn.calls = calls;
  return fn;
}

// plane — начальное состояние подменного plane.py; threads — живые треды; sessions — журналы тредов; words/bell — флаги;
// clock — часы витрины (мс), меняются тестом
async function setup(plane = {}, { threads = [], sessions = () => [], words = true, bell = true, clock = null } = {}) {
  const data = tmpDir('words-data-');
  const pdir = tmpDir('words-plane-');
  fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'));
  const stateFile = path.join(pdir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'In Progress', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: '2026-10-03T09:20:00.123456Z', ...plane }));
  const web = tmpDir('words-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const spawn = fakeSpawn();
  const bellDir = path.join(data, 'bell');
  const live = { cur: threads };
  const threadsApi = { list: () => ({ threads: live.cur, subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: '2026-10-04T09:00:00.000Z' }, desktop: null }) };
  const journals = { state: () => ({ lastOkAt: null }), sessions };
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, threads: threadsApi, journals,
    pult: { enabled: true, words, bell, bellDir, actionsLog, mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn, ...(clock ? { now: () => clock.t } : {}) } });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } })).json();
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pl = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setPlane = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...pl(), ...patch }));
  const bellGet = (sid) => app.inject({ method: 'GET', url: `/api/bell/${sid}`, headers: { host: `127.0.0.1:${PORT}` } }).then((x) => x.json());
  return { app, press, get, lines, pl, setPlane, spawn, data, bellDir, bellGet, live, actionsLog };
}

const Q = { at: Q_AT, head: Q_MD };
const thread = (sid, o = {}) => ({ sessionId: sid, title: `тред ${sid.slice(-3)}`, project: 'EXT', projectBy: 'title', card: null, state: 'idle', lastSeenAt: new Date().toISOString(), ...o });
const cmds = (calls) => (calls ?? []).map((c) => c[0] + (c[0] === 'state' ? ` ${c[2]}` : ''));
const sessionQ = (uuidQ) => () => [{ sessionId: SID, lines: 10, thread: { q: uuidQ ? { text: 'Слышишь меня?', uuid: uuidQ, at: '2026-10-04T10:00:00.000Z' } : null } }];
const p2 = (n) => String(n).padStart(2, '0');
const local = (iso) => { const d = new Date(iso); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

// ---------------- каждое слово: запись 1.2 + звонок с тем же <id> ----------------

for (const [action, word, extra, reasonHtml] of [
  ['yes', 'да', {}, null], ['go', 'го', {}, null], ['no', 'нет', { text: 'не надо <b>& так</b>' }, '<p>Причина: не надо &lt;b&gt;&amp; так&lt;/b&gt;</p>'],
  ['reply', 'ответ', { text: 'делай через очередь' }, '<p>делай через очередь</p>'],
]) {
  test(`слово «${word}» (${action}): запись §1.2 в Plane — номер в первом абзаце, «В ответ на», «Кто решил»; статус не меняется; звонок с тем же номером; «положено»`, async () => {
    const s = await setup({}, { threads: [thread(SID2), thread(SID, { card: 'EXT-20' })] });
    const r = await s.press({ action, card: 'EXT-20', q: Q, ...extra });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.outcome, 'ok', b.message);
    assert.match(b.message, /^записано в Plane \d\d:\d\d · тред «тред 801»: положено — тред услышит, когда закончит ход$/);
    const p = s.pl();
    assert.deepEqual(cmds(p.calls), ['show', 'comment'], 'статус не менялся: state не вызывался');
    assert.equal(p.status, 'In Progress');
    assert.equal(p.comments.length, 2);
    const html = p.comments[1].html;
    assert.ok(html.startsWith(`<p><b>Слово Ивана · кнопка витрины · ${b.id}</b>: «${word}»</p>`), html);
    assert.ok(html.includes(`<p>В ответ на: запись ${local(Q_AT)} «${Q_MD}»</p>`), html);
    if (reasonHtml) assert.ok(html.includes(reasonHtml), html);
    assert.ok(!html.includes('Б — ждёт'), 'не Б-дело — приписки нет');
    assert.ok(html.endsWith(`<p>Кто решил: слово Ивана · кнопка витрины · ${b.id}</p>`), html);
    assert.ok(html.replace(/<[^>]*>/g, '').slice(0, 80).includes(b.id), 'номер — в 80 знаках show --last');
    // порядок 1.1 п.9: сверка → запись → звонок → исход; тот же номер — в звонке
    assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'fresh', 'plane', 'ring-queued', 'done']);
    const g = await s.bellGet(SID);
    assert.deepEqual(g.ids, [b.id]);
    assert.ok(g.text.split('\n')[1].includes(` · EXT-20 · «${word}» · в ответ на: ${local(Q_AT)} «${Q_MD}»`), g.text);
    if (extra.text) assert.ok(g.text.endsWith(` · ${extra.text}`), g.text);
    assert.deepEqual((await s.bellGet(SID2)).ids, [], 'чужой тред слова не получает');
    assert.equal((await s.get('/api/actions')).find((x) => x.id === b.id).ring, 'положено');
    assert.equal(s.lines().find((l) => l.step === 'done').result.ring.state, 'queued');
    assert.equal(s.spawn.calls.length, 1, 'дотяжка --card после записи');
  });
}

test('1.1 п.9: не легла запись — звонка нет (comment отказан) — и слова на карточку не пишутся мимо сверки', async () => {
  const s = await setup({ fail: { comment: 'refuse' } }, { threads: [thread(SID, { card: 'EXT-20' })] });
  const r = await s.press({ action: 'yes', card: 'EXT-20', q: Q });
  assert.equal(r.json().outcome, 'error');
  assert.ok(!s.lines().some((l) => l.step === 'ring-queued'));
  assert.deepEqual((await s.bellGet(SID)).ids, []);
  assert.ok(!fs.existsSync(path.join(s.bellDir, SID)));
});

// ---------------- Б-дело: второй щелчок ----------------

test('Б-слово («сливай») без второго щелчка: need-confirm, в Plane — ничего (ни show, ни comment), звонка нет; со вторым щелчком — запись с припиской «Б — ждёт «да» в чате.» и звонок', async () => {
  const s = await setup({ status: 'Review' }, { threads: [thread(SID, { card: 'EXT-22' })] });
  const r1 = await s.press({ action: 'merge', card: 'EXT-22', q: Q });
  assert.equal(r1.statusCode, 200);
  const b1 = r1.json();
  assert.equal(b1.outcome, 'need-confirm');
  assert.equal(b1.step, 'need-confirm');
  assert.equal(b1.confirm.what, '«сливай» по EXT-22, проект EXT');
  assert.match(b1.confirm.follows, /слить = выкатить/);
  assert.deepEqual(b1.confirm.q, Q);
  assert.equal(b1.confirm.mirrorAt, '2026-10-03T09:30:00.000Z');
  assert.equal(s.pl().calls, undefined, 'в Plane не было ни одного вызова');
  assert.equal(s.pl().comments.length, 1);
  assert.ok(!fs.existsSync(path.join(s.bellDir, SID)), 'звонка нет');
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'need-confirm']);
  // второй щелчок: тот же POST с confirm = номер шага asked и новым intentId
  const r2 = await s.press({ action: 'merge', card: 'EXT-22', q: Q, confirm: b1.id });
  const b2 = r2.json();
  assert.equal(b2.outcome, 'ok', b2.message);
  const html = s.pl().comments[1].html;
  assert.ok(html.startsWith(`<p><b>Слово Ивана · кнопка витрины · ${b2.id}</b>: «сливай»</p>`), html);
  assert.ok(html.includes('<p>Б — ждёт «да» в чате.</p>'), html);
  assert.ok(html.indexOf('Б — ждёт') < html.indexOf('Кто решил'), 'приписка перед «Кто решил»');
  assert.equal(s.pl().status, 'Review', 'слияние — рука дирижёра: статус не меняется');
  assert.deepEqual((await s.bellGet(SID)).ids, [b2.id]);
  assert.deepEqual(s.lines().filter((l) => l.id === b2.id).map((l) => l.step), ['asked', 'confirmed', 'fresh', 'plane', 'ring-queued', 'done']);
  assert.equal(s.lines().find((l) => l.step === 'done' && l.id === b2.id).result.bdeal, 'слово «сливай»');
});

test('«выкатывай»: окно подтверждения называет «выкатка в прод проекта EXT»; без щелчка — Plane пуст', async () => {
  const s = await setup({ status: 'Review' });
  const b = (await s.press({ action: 'deploy', card: 'EXT-22', q: Q })).json();
  assert.equal(b.outcome, 'need-confirm');
  assert.equal(b.confirm.follows, 'выкатка в прод проекта EXT');
  assert.equal(s.pl().calls, undefined);
});

test('Б-дело по карточке: mark_b · вопрос «сливай?» · «база» в заголовке → «да» просит второй щелчок; обычная карточка и ответ из строки (а) — нет', async () => {
  for (const card of ['EXT-23', 'EXT-25', 'EXT-26']) {
    const s = await setup();
    const q = card === 'EXT-26' ? { at: '2026-10-03T09:00:00.000Z', head: 'Сливай ветку в main?' } : Q;
    const b = (await s.press({ action: 'yes', card, q })).json();
    assert.equal(b.outcome, 'need-confirm', card);
    assert.equal(s.pl().calls, undefined, card);
  }
  const plain = await setup();
  assert.equal((await plain.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'ok');
  // свободный ответ строки (а) согласием на Б-дело не считается никогда (К2) — у него Б не бывает, второго щелчка нет
  const row = await setup({}, { threads: [thread(SID)], sessions: sessionQ(QU) });
  const r = (await row.press({ action: 'reply', card: 'EXT-23', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'да, делай' })).json();
  assert.equal(r.outcome, 'ok', r.message);
  // ответ на развилку (строка (б), без session) на Б-карточке — Б
  const fork = await setup();
  assert.equal((await fork.press({ action: 'reply', card: 'EXT-23', q: Q, text: 'вариант 2' })).json().outcome, 'need-confirm');
});

test('Б-дело, признак по тексту: граница слова слева явная, кириллица («вход» — да, «выход» и «подбаза» — нет)', () => {
  const c = (title, bodyHead = '') => ({ title, last: { bodyHead } });
  assert.match(bDeal(c('Вход в кабинет'), 'yes'), /вход/);
  assert.match(bDeal(c('x', 'правим auth'), 'yes'), /auth/);
  assert.match(bDeal(c('x', 'Удаление/Удалено: снос старых'), 'yes'), /снос|удален/);
  assert.match(bDeal(c('Перенос базы'), 'yes'), /баз/);
  assert.match(bDeal(c('Миграции'), 'no'), /миграц/);
  assert.equal(bDeal(c('Выход из режима'), 'yes'), null);
  assert.equal(bDeal(c('Подбаза и OAuth, базар'), 'yes'), null);
  assert.equal(bDeal(c('Обычная'), 'go'), null);
  assert.equal(bDeal({ title: 'x', markB: true }, 'go'), 'mark_b');
  assert.equal(bDeal({ title: 'x', last: { mark: 'развилка' } }, 'go'), 'последняя запись — «развилка»');
});

test('второй щелчок: чужой/неизвестный номер, другая карточка, другой текст, использованный и просроченный — отказ, в Plane ничего', async () => {
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const s = await setup({ status: 'Review' }, { threads: [], clock });
  const first = (await s.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  assert.equal(first.outcome, 'need-confirm');
  const ref = async (body, why) => {
    const before = s.pl().comments.length;
    const r = (await s.press(body)).json();
    assert.equal(r.outcome, 'refused', why);
    assert.equal(s.lines().at(-1).refusal, why);
    assert.equal(s.pl().comments.length, before, why);
  };
  await ref({ action: 'merge', card: 'EXT-22', q: Q, confirm: 'W-261004-120000-ffff' }, 'bad-confirm');
  await ref({ action: 'deploy', card: 'EXT-22', q: Q, confirm: first.id }, 'bad-confirm'); // другое слово
  await ref({ action: 'merge', card: 'EXT-22', q: { at: null }, confirm: first.id }, 'bad-confirm'); // другой вопрос
  await ref({ action: 'merge', card: 'EXT-22', q: Q, text: 'x', confirm: first.id }, 'bad-confirm'); // у слова нет текста — другой текст
  // исправный: тот же щелчок — проходит; повторно с тем же номером — «использовано»
  assert.equal((await s.press({ action: 'merge', card: 'EXT-22', q: Q, confirm: first.id })).json().outcome, 'ok');
  s.setPlane({ status: 'Review' });
  await ref({ action: 'merge', card: 'EXT-22', q: Q, confirm: first.id }, 'bad-confirm');
  // просрочено: больше 5 минут после asked
  const second = (await s.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  assert.equal(second.outcome, 'need-confirm');
  clock.t += 5 * 60000 + 1000;
  await ref({ action: 'merge', card: 'EXT-22', q: Q, confirm: second.id }, 'confirm-expired');
});

// ---------------- привязка к вопросу (К1, п.6) ----------------

test('после прохода зеркала в Plane дописан новый коммент → «да» на старый вопрос отказано (new-question), comment не вызван; вопрос не менялся — прошло', async () => {
  const s = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41Z', html: Q_HTML }, { id: 'q2', created_at: '2026-10-03T09:05:02Z', html: '<p>Ещё вопрос: а тесты?</p>' }] },
    { threads: [thread(SID, { card: 'EXT-20' })] });
  const r = await s.press({ action: 'yes', card: 'EXT-20', q: Q });
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /^на карточке новое сообщение от \d\d:\d\d — посмотри и ответь заново$/);
  assert.equal(r.json().pull, true);
  assert.deepEqual(cmds(s.pl().calls), ['show'], 'comment не вызывался');
  assert.equal(s.pl().comments.length, 2);
  assert.equal(s.lines().at(-1).refusal, 'new-question');
  assert.ok(!fs.existsSync(path.join(s.bellDir, SID)), 'звонка нет');
  // исправный случай рядом — вопрос не менялся (ряд тестов выше) — прошло
  const ok = await setup();
  assert.equal((await ok.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'ok');
});

test('q.at = null (карточка без записей): «го» прошло; в Plane появился чужой коммент → «го» отказано; только запись пульта — прошло', async () => {
  const none = await setup({ comments: [] });
  const r = await none.press({ action: 'go', card: 'EXT-21', q: { at: null } });
  assert.equal(r.json().outcome, 'ok', r.json().message);
  assert.ok(none.pl().comments[0].html.includes('<p>В ответ на: записей не было</p>'));
  const seen = await setup({ comments: [{ id: 'z', created_at: '2026-10-03T09:00:00Z', html: '<p>Вопрос треда?</p>' }] });
  const refd = await seen.press({ action: 'go', card: 'EXT-21', q: { at: null } });
  assert.equal(refd.json().outcome, 'refused');
  assert.equal(seen.lines().at(-1).refusal, 'new-question');
  assert.deepEqual(cmds(seen.pl().calls), ['show']);
  const mine = await setup({ comments: [{ id: 'z', created_at: '2026-10-03T09:00:00Z', html: '<p><b>Слово Ивана · кнопка витрины · W-261003-120000-ab12</b>: «да»</p>' }] });
  assert.equal((await mine.press({ action: 'go', card: 'EXT-21', q: { at: null } })).json().outcome, 'ok');
});

test('нормализация: та же минута и тот же текст в HTML (Plane) и markdown (зеркало) — не «новый вопрос»; та же минута, другие слова — новый', async () => {
  const same = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:59Z', html: Q_HTML }] });
  assert.equal((await same.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'ok');
  const other = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:59Z', html: '<p>Другой вопрос в ту же минуту?</p>' }] });
  const r = await other.press({ action: 'yes', card: 'EXT-20', q: Q });
  assert.equal(r.json().outcome, 'refused');
  assert.equal(other.lines().at(-1).refusal, 'new-question');
  // экранирование markdown и U+FE0F с обеих сторон
  const esc = await setup({ comments: [{ id: 'q1', created_at: '2026-10-03T09:00:10Z', html: '<p>Готово&nbsp;✅\uFE0F <b>да</b>, a_b *c*?</p>' }] });
  assert.equal((await esc.press({ action: 'yes', card: 'EXT-20', q: { at: Q_AT, head: 'Готово ✅ **да**, a\\_b \\*c\\*?' } })).json().outcome, 'ok');
});

test('карточка закрыта: по зеркалу — отказ closed без обращения к Plane; в Plane Done при старом зеркале — отказ closed, comment не вызван; «сливай» при статусе не Review — stale-status', async () => {
  const m = await setup();
  const r = await m.press({ action: 'yes', card: 'EXT-24', q: Q });
  assert.equal(r.json().outcome, 'refused');
  assert.equal(m.lines().at(-1).refusal, 'closed');
  assert.equal(m.pl().calls, undefined);
  const p = await setup({ status: 'Done' });
  assert.equal((await p.press({ action: 'yes', card: 'EXT-20', q: Q })).json().outcome, 'refused');
  assert.equal(p.lines().at(-1).refusal, 'closed');
  assert.deepEqual(cmds(p.pl().calls), ['show']);
  const st = await setup({ status: 'In Progress' });
  const c = (await st.press({ action: 'merge', card: 'EXT-22', q: Q })).json();
  const c2 = (await st.press({ action: 'merge', card: 'EXT-22', q: Q, confirm: c.id })).json();
  assert.equal(c2.outcome, 'refused');
  assert.match(c2.message, /^в Plane сейчас In Progress; зеркало от /);
  assert.deepEqual(cmds(st.pl().calls), ['show']);
});

// ---------------- ответ треду из строки (а) ----------------

test('ответ треду без карточки: в Plane — ничего, след — actions.log и звонок «без карточки» строго этому треду (2.3 п.1)', async () => {
  const s = await setup({}, { threads: [thread(SID), thread(SID2)], sessions: sessionQ(QU) });
  const r = await s.press({ action: 'reply', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' });
  const b = r.json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.match(b.message, /записи на доске нет \(тред без карточки\) · тред «тред 801»: положено/);
  assert.equal(s.pl().calls, undefined, 'plane.py не звался');
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'ring-queued', 'done']);
  assert.equal(s.lines()[0].session, SID);
  const g = await s.bellGet(SID);
  assert.deepEqual(g.ids, [b.id]);
  assert.ok(g.text.split('\n')[1].includes(' · без карточки · «ответ» · в ответ на: '), g.text);
  assert.ok(g.text.endsWith(' · слышу'));
  assert.deepEqual((await s.bellGet(SID2)).ids, []);
});

test('ответ треду из строки (а) с карточкой: запись на карточке («В ответ на: сообщение треда»), звонок — треду строки, а не треду карточки', async () => {
  const s = await setup({}, { threads: [thread(SID), thread(SID2, { card: 'EXT-20' })], sessions: sessionQ(QU) });
  const b = (await s.press({ action: 'reply', card: 'EXT-20', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' })).json();
  assert.equal(b.outcome, 'ok', b.message);
  const html = s.pl().comments[1].html;
  assert.ok(html.includes(`<p>В ответ на: сообщение треда ${local('2026-10-04T10:00:00.000Z')}</p>`), html);
  assert.ok(html.includes('<p>слышу</p>'));
  assert.deepEqual((await s.bellGet(SID)).ids, [b.id]);
  assert.deepEqual((await s.bellGet(SID2)).ids, []);
});

test('ответ треду: тред задал новый вопрос → отказ, звонка нет; тред закрыт → «тред закрыт — слово не доставлено»; журнал без вопроса → отказ', async () => {
  const s = await setup({}, { threads: [thread(SID)], sessions: sessionQ(uuid(902)) });
  const r = await s.press({ action: 'reply', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' });
  assert.equal(r.json().outcome, 'refused');
  assert.match(r.json().message, /^тред задал новый вопрос/);
  assert.equal(s.lines().at(-1).refusal, 'new-question');
  assert.ok(!fs.existsSync(path.join(s.bellDir, SID)));
  const gone = await setup({}, { threads: [], sessions: sessionQ(QU) });
  const g = (await gone.press({ action: 'reply', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' })).json();
  assert.equal(g.outcome, 'refused');
  assert.equal(g.message, 'тред закрыт — слово не доставлено');
  const none = await setup({}, { threads: [thread(SID)], sessions: sessionQ(null) });
  assert.equal((await none.press({ action: 'reply', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' })).json().outcome, 'refused');
});

test('ответ без карточки при выключенном звонке (pult.bell = false) — отказ bell-off: записать некуда; слово по карточке — запись есть, «звонок выключен»', async () => {
  const s = await setup({}, { bell: false, threads: [thread(SID)], sessions: sessionQ(QU) });
  const r = (await s.press({ action: 'reply', session: SID, q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' }, text: 'слышу' })).json();
  assert.equal(r.outcome, 'refused');
  assert.equal(s.lines().at(-1).refusal, 'bell-off');
  const c = (await s.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(c.outcome, 'ok');
  assert.match(c.message, /звонок выключен: тред увидит на карточке$/);
  assert.ok(!s.lines().some((l) => String(l.step).startsWith('ring-')));
});

// ---------------- форма запроса, флаг, секрет ----------------

test('форма: слову q обязателен (нет — 400); у ответа строки (а) q = {uuid, at}, у прочих — запись карточки; ответ без карточки и треда — 400', async () => {
  const s = await setup({}, { threads: [thread(SID)], sessions: sessionQ(QU) });
  const code = async (body) => (await s.press(body)).statusCode;
  assert.equal(await code({ action: 'yes', card: 'EXT-20' }), 400);
  assert.equal(await code({ action: 'yes', card: 'EXT-20', q: { uuid: QU, at: '2026-10-04T10:00:00.000Z' } }), 400);
  assert.equal(await code({ action: 'reply', session: SID, q: Q, text: 'x' }), 400);
  assert.equal(await code({ action: 'reply', text: 'x', q: Q }), 400);
  assert.equal(await code({ action: 'reply', card: 'EXT-20', q: Q }), 400, 'текст ответа обязателен');
  assert.equal(s.lines().length, 0, 'до asked — ничего');
  assert.equal(s.pl().calls, undefined);
});

test('pult.words = false: каждое слово → 503 без записи и без Plane, а «Принять» работает', async () => {
  const s = await setup({ status: 'Review' }, { words: false });
  for (const body of [{ action: 'yes', card: 'EXT-20', q: Q }, { action: 'go', card: 'EXT-20', q: Q }, { action: 'merge', card: 'EXT-22', q: Q },
    { action: 'deploy', card: 'EXT-22', q: Q }, { action: 'no', card: 'EXT-20', q: Q }, { action: 'reply', card: 'EXT-20', q: Q, text: 'x' }]) {
    const r = await s.press(body);
    assert.equal(r.statusCode, 503, body.action);
    assert.match(r.json().message, /после правки правил/);
  }
  assert.equal(s.lines().length, 0);
  assert.equal(s.pl().calls, undefined);
  const acc = await s.press({ action: 'accept', card: 'EXT-27', q: Q });
  assert.equal(acc.statusCode, 200);
  assert.equal(acc.json().outcome, 'ok', acc.json().message);
  assert.equal(s.pl().status, 'Done');
});

test('секрет класса 2 в тексте слова («нет», ответ) → отказ secret, текста в журнале нет, в Plane и в звонке ничего', async () => {
  const s = await setup({}, { threads: [thread(SID, { card: 'EXT-20' })] });
  for (const action of ['no', 'reply']) {
    const r = await s.press({ action, card: 'EXT-20', q: Q, text: `ключ ${SECRET}` });
    assert.equal(r.json().outcome, 'refused', action);
    assert.match(r.json().message, /^похоже на секрет: /);
    assert.equal(s.lines().at(-1).refusal, 'secret');
  }
  assert.equal(s.pl().calls, undefined);
  assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes(SECRET));
  assert.ok(!fs.existsSync(path.join(s.bellDir, SID)));
  // исправный случай рядом — обычный текст проходит
  assert.equal((await s.press({ action: 'no', card: 'EXT-20', q: Q, text: 'не надо' })).json().outcome, 'ok');
});

test('секрет класса 5 — второй щелчок «это не секрет»: без него отказ, с номером отказа и тем же текстом — проходит, с другим текстом или чужим номером — снова отказ', async () => {
  const MAYBE = 'ключ лежит тут: Zq8vK3mP9xLr2TnW';
  assert.ok(scan(MAYBE, { project: 'EXT' }).some((x) => x.cls === 5) && !scan(MAYBE, { project: 'EXT' }).some((x) => x.cls === 2), 'пример — класс 5');
  const s = await setup({}, { threads: [thread(SID, { card: 'EXT-20' })] });
  const r1 = (await s.press({ action: 'no', card: 'EXT-20', q: Q, text: MAYBE })).json();
  assert.equal(r1.outcome, 'refused');
  assert.match(r1.message, /^может быть секретом: /);
  assert.equal(s.pl().calls, undefined);
  assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes('Zq8vK3mP9xLr2TnW'), 'текст отказанного в журнал не попал');
  const other = (await s.press({ action: 'no', card: 'EXT-20', q: Q, text: `${MAYBE}x`, confirm: r1.id })).json();
  assert.equal(other.outcome, 'refused', 'другой текст — не тот щелчок');
  const alien = (await s.press({ action: 'no', card: 'EXT-20', q: Q, text: MAYBE, confirm: 'W-261004-120000-ffff' })).json();
  assert.equal(alien.outcome, 'refused');
  assert.equal(s.pl().calls, undefined);
  const ok = (await s.press({ action: 'no', card: 'EXT-20', q: Q, text: MAYBE, confirm: r1.id })).json();
  assert.equal(ok.outcome, 'ok', ok.message);
  assert.equal(s.pl().comments.length, 2);
});

// ---------------- неясный исход, повтор, звонок при нескольких тредах ----------------

test('неясный исход comment: коммент лёг (код 3) — найден по номеру, запись одна, звонок есть; коммента нет — error, звонка нет, повтор кладёт одну запись', async () => {
  const lay = await setup({ fail: { comment: 'unclear-after' } }, { threads: [thread(SID, { card: 'EXT-20' })] });
  const r = (await lay.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(r.outcome, 'ok', r.message);
  assert.equal(lay.pl().comments.length, 2, 'запись одна');
  assert.deepEqual((await lay.bellGet(SID)).ids, [r.id]);
  const miss = await setup({ fail: { comment: 'unclear-before' } }, { threads: [thread(SID, { card: 'EXT-20' })] });
  const e = (await miss.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(e.outcome, 'error');
  assert.ok(!miss.lines().some((l) => l.step === 'ring-queued'));
  miss.setPlane({ fail: {} });
  const again = (await miss.press({ action: 'yes', card: 'EXT-20', q: Q })).json();
  assert.equal(again.outcome, 'ok', again.message);
  assert.equal(miss.pl().comments.length, 2, 'после повтора запись одна');
  assert.deepEqual((await miss.bellGet(SID)).ids, [again.id]);
});

test('несколько живых тредов проекта — запись есть, звонка нет, перечень; с pick (выбор Ивана, 2.3 п.4) — слово тому треду', async () => {
  const s = await setup({}, { threads: [thread(SID), thread(SID2)] });
  const many = (await s.press({ action: 'go', card: 'EXT-20', q: Q })).json();
  assert.equal(many.outcome, 'ok');
  assert.match(many.message, /живых тредов EXT несколько: «тред 801», «тред 802» — звонка нет/);
  assert.deepEqual((await s.bellGet(SID)).ids, []);
  s.setPlane({ comments: s.pl().comments.filter((c) => c.id === 'q1') }); // вопрос тот же: новая запись пульта не мешает и так
  const picked = (await s.press({ action: 'go', card: 'EXT-20', q: Q, pick: SID2 })).json();
  assert.equal(picked.outcome, 'ok', picked.message);
  assert.deepEqual((await s.bellGet(SID2)).ids, [picked.id]);
  assert.deepEqual((await s.bellGet(SID)).ids, []);
});

test('тот же intentId — прежний исход, второй записи нет; need-confirm переживает рестарт (restoreIntents)', async () => {
  const s = await setup({ status: 'Review' });
  const id = nextIntent();
  const a = (await s.press({ action: 'merge', card: 'EXT-22', q: Q }, id)).json();
  const b = (await s.press({ action: 'merge', card: 'EXT-22', q: Q }, id)).json();
  assert.deepEqual(b, a);
  assert.equal(s.lines().filter((l) => l.step === 'asked').length, 1);
  const restored = await restoreIntents(s.lines().map((l) => (l.step === 'asked' ? { ...l, client: { ...l.client, intentId: id } } : l)), Date.now()).get(id).promise;
  assert.equal(restored.code, 200);
  assert.equal(restored.body.outcome, 'need-confirm');
  assert.equal(restored.body.confirm.what, a.confirm.what);
});
