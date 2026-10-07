// EXT-81, ПТ9: «Новая карточка / мысль» (new-card; спека пульта §1.1 пп.3, 4, 7, 8, §1.3, §1.6) на подменном plane.py (test/fake-plane.mjs,
// команда create) и временной доске. Настоящий plane.py не запускается никогда: python = node, planePy = копия подменного.
// Ожидания — из того, что положено в тест; список похожих — той же similar доски (tools/lib/similar.mjs), посчитанной тестом по файлам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { registerPult } from '../lib/pult/routes.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const { similar } = await import(new URL(`file:///${BOARD_LIB}/similar.mjs`).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const SECRET = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const MAYBE = 'ключ лежит тут: Zq8vK3mP9xLr2TnW';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let intents = 81000;
const nextIntent = () => uuid(++intents);

const BACKUP = 'Настроить резервное копирование базы';
const cards = [
  ...[3, 4, 5, 6, 7, 9, 10].map((n) => ({ id: `EXT-${n}`, status: 'in-progress', title: `${BACKUP} номер ${n}` })),
  { id: 'EXT-40', status: 'done', title: 'Совершенно другое занятие про выгрузку отчётов' },
  { id: 'CAR-3', status: 'backlog', title: `${BACKUP} для машин` },
];
const boardDir = makeBoard(tmpDir('ext81-board-'), { codes: ['EXT', 'CAR', 'RADAR'], cards });
gitInitCommit(boardDir);
const regFile = path.join(tmpDir('ext81-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, CAR: { repos: [] }, RADAR: { repos: [] } } }));
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();
const registry = createRegistryReader(regFile);

// начальное состояние подменного plane.py — plane; data/pdir — переиспользуются для «рестарта»; clock — часы витрины ({t})
async function setup({ plane = {}, words = true, similarFn = similar, data = tmpDir('ext81-data-'), pdir = null, clock = null } = {}) {
  const dir = pdir ?? tmpDir('ext81-plane-');
  const stateFile = path.join(dir, 'state.json');
  if (!pdir) {
    fs.copyFileSync(path.join(HERE, 'fake-plane.mjs'), path.join(dir, 'fake-plane.mjs'));
    fs.writeFileSync(stateFile, JSON.stringify({ status: 'Backlog', ...plane }));
  }
  const web = tmpDir('ext81-web-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body></body></html>');
  const actionsLog = path.join(data, 'actions.log');
  const app = await buildApp({ port: PORT, board, registry, scan, ...(similarFn ? { similar: similarFn } : {}), webDir: web,
    pult: { enabled: true, words, actionsLog, boardRoot: boardDir, python: process.execPath, planePy: path.join(dir, 'fake-plane.mjs') },
    pultSeams: clock ? { now: () => clock.t } : {} });
  const r = await app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } });
  const token = r.body.match(/name="vitrina-token" content="([^"]+)"/)[1];
  const press = (body, intentId = nextIntent()) => app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId, action: 'new-card', ...body }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } });
  const lines = () => (fs.existsSync(actionsLog) ? fs.readFileSync(actionsLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pl = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setPlane = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...pl(), ...patch }));
  const tmp = path.join(data, 'tmp');
  const tmpFiles = () => (fs.existsSync(tmp) ? fs.readdirSync(tmp) : []);
  return { app, press, lines, pl, setPlane, data, pdir: dir, actionsLog, tmpFiles, tmp };
}
const creates = (s) => s.pl().creates ?? [];

// ---------------- похожие: та же функция, что у доски ----------------

test('похожие: список ID — ровно тот, что даёт similar доски по файлам зеркала проекта (порядок readdir, не больше 5, чужой проект не попадает); подмена функции меняет список', async () => {
  const title = BACKUP;
  // ожидание — этой же импортированной функцией по заголовкам файлов проекта EXT в порядке readdir
  const files = fs.readdirSync(path.join(boardDir, 'EXT')).filter((n) => /^EXT-\d+\.md$/.test(n)).sort();
  const want = files.filter((n) => similar(title, parseCard(fs.readFileSync(path.join(boardDir, 'EXT', n), 'utf8')).header.title)).map((n) => n.replace('.md', ''));
  assert.equal(want.length, 7, 'в доске семь похожих — а в ответ идут пять');
  assert.ok(!want.includes('EXT-40') && !want.includes('CAR-3'));
  const s = await setup();
  const r = await s.press({ project: 'EXT', title });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.outcome, 'need-confirm');
  assert.deepEqual(b.confirm.similar.map((x) => x.id), want.slice(0, 5));
  assert.ok(!b.confirm.similar.some((x) => x.id === 'CAR-3'), 'другой проект — не в списке');
  assert.equal(b.confirm.similar[0].title, `${BACKUP} номер 10`);
  assert.equal(b.message, `похожие: ${b.confirm.similar.map((x) => `${x.id} · ${x.title}`).join('\n')}`);
  // отрицательный контроль: витрина, считающая своё (другая функция на входе), даёт другой список — тест краснеет
  const other = await setup({ similarFn: (a, c) => c.includes('номер 3') });
  const o = (await other.press({ project: 'EXT', title })).json();
  assert.deepEqual(o.confirm.similar.map((x) => x.id), ['EXT-3']);
  assert.notDeepEqual(o.confirm.similar.map((x) => x.id), want.slice(0, 5));
  // другой проект — свои карточки: у CAR одна
  const car = (await s.press({ project: 'CAR', title })).json();
  assert.deepEqual(car.confirm.similar.map((x) => x.id), ['CAR-3']);
});

// ---------------- need-confirm и второй щелчок ----------------

test('похожие найдены: need-confirm без вызова plane.py (с формой подтверждения); второй щелчок с confirm создаёт ровно одну карточку Backlog без лейблов; повторное использование confirm — отказ', async () => {
  const s = await setup();
  const title = `${BACKUP} «новая» & <b>`;
  const text = 'первая строка <script>"x"</script> & ещё\nвторая строка';
  const r1 = await s.press({ project: 'EXT', title, text });
  const b1 = r1.json();
  assert.equal(r1.statusCode, 200);
  assert.equal(b1.outcome, 'need-confirm');
  assert.equal(b1.confirm.what, `Новая карточка · EXT: ${title}`);
  assert.equal(b1.confirm.follows, 'создастся карточка в Backlog');
  assert.ok('mirrorAt' in b1.confirm);
  assert.equal(s.pl().calls, undefined, 'до второго щелчка plane.py не вызван');
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'need-confirm']);
  assert.equal(s.lines()[0].title, title);
  assert.equal(s.lines()[0].text, text);
  // без confirm повтором — снова need-confirm, ничего не создано
  assert.equal((await s.press({ project: 'EXT', title, text })).json().outcome, 'need-confirm');
  assert.equal(s.pl().calls, undefined);
  const r2 = await s.press({ project: 'EXT', title, text, confirm: b1.id });
  const b2 = r2.json();
  assert.equal(b2.outcome, 'ok', b2.message);
  assert.match(b2.message, /^создана EXT-101 · Backlog$/);
  assert.equal(b2.created, 'EXT-101');
  const c = creates(s);
  assert.equal(c.length, 1);
  assert.deepEqual(s.pl().calls.filter((x) => x[0] === 'create').map((x) => x[1]), ['EXT']);
  assert.equal(c[0].existed, true, 'файл был на месте в момент вызова');
  assert.equal(path.basename(c[0].file), `card-${b2.id}.json`);
  assert.deepEqual(Object.keys(c[0].body).sort(), ['description_html', 'name', 'state'], 'без лейблов');
  assert.equal(c[0].body.name, title);
  assert.equal(c[0].body.state, 'Backlog');
  assert.equal(c[0].body.description_html,
    `<p>первая строка &lt;script&gt;&quot;x&quot;&lt;/script&gt; &amp; ещё<br>вторая строка</p><p>Кто решил: слово Ивана · кнопка витрины · ${b2.id}</p>`);
  assert.equal(fs.existsSync(c[0].file), false, 'временный файл удалён после вызова');
  assert.deepEqual(s.tmpFiles(), []);
  assert.deepEqual(s.lines().filter((l) => l.id === b2.id).map((l) => l.step), ['asked', 'confirmed', 'plane', 'done']);
  const plane = s.lines().find((l) => l.id === b2.id && l.step === 'plane');
  assert.equal(plane.cmd, 'create');
  assert.equal(plane.result.code, 0);
  assert.match(plane.result.line, /^создана EXT-101 · /);
  assert.equal(s.lines().find((l) => l.id === b2.id && l.step === 'done').result.created, 'EXT-101');
  // подтверждение потрачено: тем же номером второй раз — отказ, второго create нет
  const again = (await s.press({ project: 'EXT', title, text, confirm: b1.id })).json();
  assert.equal(again.outcome, 'refused');
  assert.equal(again.refusal, 'bad-confirm');
  assert.equal(creates(s).length, 1);
});

test('без похожих — создаётся сразу: «создана <ID> · Backlog»; текста нет — в описании только «Кто решил»', async () => {
  const s = await setup();
  const r = await s.press({ project: 'EXT', title: 'Совсем иная затея про маршрутизацию' });
  const b = r.json();
  assert.equal(r.statusCode, 200);
  assert.equal(b.outcome, 'ok', b.message);
  assert.equal(b.message, 'создана EXT-101 · Backlog');
  assert.equal(creates(s)[0].body.description_html, `<p>Кто решил: слово Ивана · кнопка витрины · ${b.id}</p>`);
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'plane', 'done']);
  assert.deepEqual(s.tmpFiles(), []);
});

test('confirm не тот: чужой номер, другой заголовок, другой текст, другой проект, номер другого действия, просрочен (>5 мин) — отказ, create нет; исправный — создаёт', async () => {
  const clock = { t: Date.now() };
  const s = await setup({ clock });
  const title = BACKUP;
  const first = (await s.press({ project: 'EXT', title, text: 'т' })).json();
  assert.equal(first.outcome, 'need-confirm');
  const cases = [
    ['чужой номер', { project: 'EXT', title, text: 'т', confirm: 'W-261004-120000-ffff' }, 'bad-confirm'],
    ['другой заголовок', { project: 'EXT', title: `${BACKUP} иначе`, text: 'т', confirm: first.id }, 'bad-confirm'],
    ['другой текст', { project: 'EXT', title, text: 'другой', confirm: first.id }, 'bad-confirm'],
    ['текста нет', { project: 'EXT', title, confirm: first.id }, 'bad-confirm'],
    ['другой проект', { project: 'CAR', title, text: 'т', confirm: first.id }, 'bad-confirm'],
  ];
  for (const [name, body, refusal] of cases) {
    const r = await s.press(body);
    assert.equal(r.statusCode, 200, name);
    assert.equal(r.json().outcome, 'refused', name);
    assert.equal(r.json().refusal, refusal, name);
  }
  // номер действия, которое ждало подтверждения не для new-card (строка asked другого действия)
  const ping = (await s.app.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), action: 'ping' }),
    headers: { host: `127.0.0.1:${PORT}`, origin: SELF, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-vitrina-token': (await s.app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } })).body.match(/content="([^"]+)"/)[1] } })).json();
  assert.equal((await s.press({ project: 'EXT', title, text: 'т', confirm: ping.id })).json().refusal, 'bad-confirm');
  assert.equal(s.pl().calls, undefined, 'ни один неверный щелчок до plane.py не дошёл');
  // просрочено: 5 минут и секунда
  clock.t += 5 * 60000 + 1000;
  const late = (await s.press({ project: 'EXT', title, text: 'т', confirm: first.id })).json();
  assert.equal(late.outcome, 'refused');
  assert.equal(late.refusal, 'confirm-expired');
  assert.equal(s.pl().calls, undefined);
  // исправный случай: свежий первый щелчок и второй в срок
  const f2 = (await s.press({ project: 'EXT', title, text: 'т' })).json();
  clock.t += 4 * 60000;
  const ok = (await s.press({ project: 'EXT', title, text: 'т', confirm: f2.id })).json();
  assert.equal(ok.outcome, 'ok', ok.message);
  assert.equal(creates(s).length, 1);
});

test('одно подтверждение — одна карточка при двух одновременных щелчках', async () => {
  const s = await setup();
  const first = (await s.press({ project: 'EXT', title: BACKUP })).json();
  const [a, b] = await Promise.all([s.press({ project: 'EXT', title: BACKUP, confirm: first.id }), s.press({ project: 'EXT', title: BACKUP, confirm: first.id })]);
  const outs = [a.json().outcome, b.json().outcome].sort();
  assert.deepEqual(outs, ['ok', 'refused']);
  assert.equal(creates(s).length, 1);
});

// ---------------- секрет ----------------

test('секрет класса 2 в заголовке и в тексте → refused secret без вызова plane.py, без строки asked, без секрета в журнале; исправный заголовок рядом проходит', async () => {
  assert.ok(scan(SECRET, { project: 'EXT' }).some((x) => x.cls === 2));
  const s = await setup();
  for (const body of [{ title: `ключ ${SECRET}` }, { title: 'нормальный заголовок про маршруты', text: `вот ${SECRET}` }]) {
    const r = await s.press({ project: 'EXT', ...body });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().outcome, 'refused');
    assert.equal(r.json().refusal, 'secret');
    assert.match(r.json().message, /^похоже на секрет: /);
  }
  assert.equal(s.pl().calls, undefined);
  assert.ok(s.lines().every((l) => l.step === 'refused' && l.refusal === 'secret'), 'строк asked нет');
  assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes(SECRET));
  assert.deepEqual(s.tmpFiles(), []);
  const ok = (await s.press({ project: 'EXT', title: 'нормальный заголовок про маршруты' })).json();
  assert.equal(ok.outcome, 'ok', ok.message);
});

test('секрет класса 5 в заголовке (только заголовок, текста нет) и в тексте: secret-maybe; «не секрет» с номером отказа и тем же заголовком+текстом — создаёт; иное — снова отказ', async () => {
  assert.ok(scan(MAYBE, { project: 'EXT' }).some((x) => x.cls === 5) && !scan(MAYBE, { project: 'EXT' }).some((x) => x.cls === 2));
  const s = await setup();
  let made = 0;
  for (const body of [{ title: `Метка ${MAYBE}` }, { title: 'Заголовок про маршруты без секретов', text: MAYBE }]) {
    const r1 = (await s.press({ project: 'EXT', ...body })).json();
    assert.equal(r1.outcome, 'refused', JSON.stringify(body));
    assert.equal(r1.refusal, 'secret-maybe');
    assert.equal(creates(s).length, made);
    assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes('Zq8vK3mP9xLr2TnW'), 'текст отказанного в журнал не попал');
    const other = (await s.press({ project: 'EXT', ...body, title: `${body.title} ещё`, confirm: r1.id })).json();
    assert.equal(other.refusal, 'secret-maybe', 'другой заголовок — не тот щелчок');
    const otherProject = (await s.press({ project: 'CAR', ...body, confirm: r1.id })).json();
    assert.equal(otherProject.refusal, 'secret-maybe', 'другой проект — не тот щелчок');
    const alien = (await s.press({ project: 'EXT', ...body, confirm: 'W-261004-120000-ffff' })).json();
    assert.equal(alien.refusal, 'secret-maybe');
    assert.equal(creates(s).length, made);
    const ok = (await s.press({ project: 'EXT', ...body, confirm: r1.id })).json();
    assert.equal(ok.outcome, 'ok', ok.message);
    made++;
  }
  assert.equal(creates(s).length, 2);
});

test('цепочка: класс 5 → «не секрет» → need-confirm (похожие) → «всё равно создать» — одна карточка; номер «не секрет» как подтверждение похожих — не годится', async () => {
  const title = `${BACKUP} ${MAYBE}`;
  assert.ok(scan(title, { project: 'EXT' }).some((x) => x.cls === 5));
  const s = await setup();
  const r1 = (await s.press({ project: 'EXT', title })).json();
  assert.equal(r1.refusal, 'secret-maybe');
  const r2 = (await s.press({ project: 'EXT', title, confirm: r1.id })).json();
  assert.equal(r2.outcome, 'need-confirm', r2.message);
  assert.ok(r2.confirm.similar.length > 0);
  assert.equal(s.pl().calls, undefined);
  const ok = (await s.press({ project: 'EXT', title, confirm: r2.id })).json();
  assert.equal(ok.outcome, 'ok', ok.message);
  assert.equal(creates(s).length, 1);
  // обратное: номер отказа «не секрет» не считается подтверждением похожих (у него нет шага need-confirm)
  const t = await setup();
  const a = (await t.press({ project: 'EXT', title })).json();
  assert.equal(a.refusal, 'secret-maybe');
  const direct = (await t.press({ project: 'EXT', title, confirm: a.id })).json();
  assert.equal(direct.outcome, 'need-confirm');
  assert.equal(t.pl().calls, undefined);
});

// ---------------- повтор тем же intentId, исходы создания ----------------

test('повтор тем же intentId — прежний ответ, одна карточка; после «рестарта» (новое приложение на том же actions.log) — тоже', async () => {
  const s = await setup();
  const intent = nextIntent();
  const body = { project: 'EXT', title: 'Совсем иная затея про маршрутизацию' };
  const a = (await s.press(body, intent)).json();
  const b = (await s.press(body, intent)).json();
  assert.equal(a.outcome, 'ok');
  assert.deepEqual(b, a);
  assert.equal(creates(s).length, 1);
  const s2 = await setup({ data: s.data, pdir: s.pdir });
  const c = (await s2.press(body, intent)).json();
  assert.equal(c.outcome, 'ok');
  assert.equal(c.id, a.id);
  assert.equal(creates(s2).length, 1, 'после рестарта — всё ещё одна карточка');
});

for (const mode of ['unclear', 'garbage', 'traceback']) {
  test(`неясный исход (${mode}): error/UNCLEAR, один вызов create, без автоповтора и без show; тот же intentId — тот же ответ (и после рестарта — с пометкой «по журналу»); файл удалён`, async () => {
    const s = await setup({ plane: { fail: { create: mode } } });
    const intent = nextIntent();
    const body = { project: 'EXT', title: 'Совсем иная затея про маршрутизацию' };
    const r = await s.press(body, intent);
    const b = r.json();
    assert.equal(r.statusCode, 200);
    assert.equal(b.outcome, 'error');
    assert.equal(b.message, 'исход неясен — проверь доску: карточка могла создаться (повторять вслепую нельзя)');
    assert.deepEqual(s.pl().calls.map((x) => x[0]), ['create'], 'один вызов, никакой сверки show');
    const err = s.lines().find((l) => l.id === b.id && l.step === 'error');
    assert.equal(err.result.code, 'UNCLEAR');
    assert.deepEqual(s.tmpFiles(), []);
    assert.equal(fs.existsSync(creates(s)[0].file), false);
    // в журнал — только первая строка вывода (трасса целиком не пишется)
    assert.ok(!fs.readFileSync(s.actionsLog, 'utf8').includes('ReadTimeout'));
    const again = (await s.press(body, intent)).json();
    assert.deepEqual(again, b);
    assert.equal(s.pl().calls.length, 1);
    const s2 = await setup({ data: s.data, pdir: s.pdir });
    const re = (await s2.press(body, intent)).json();
    assert.equal(re.outcome, 'error');
    assert.equal(re.message, 'исход неясен (по журналу) — проверь доску: карточка могла создаться');
    assert.equal(s2.pl().calls.length, 1);
  });
}

test('известный отказ Plane (код 1, «Доска ответила …») → «не создана: …», NOT_CREATED, файл удалён, повтор тем же intentId — тот же ответ без второго вызова', async () => {
  const s = await setup({ plane: { fail: { create: 'refuse' } } });
  const intent = nextIntent();
  const body = { project: 'EXT', title: 'Совсем иная затея про маршрутизацию' };
  const b = (await s.press(body, intent)).json();
  assert.equal(b.outcome, 'error');
  assert.equal(b.message, 'не создана: Доска ответила 400: {"error":"bad state"}');
  assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'error').result.code, 'NOT_CREATED');
  assert.deepEqual(s.tmpFiles(), []);
  assert.deepEqual((await s.press(body, intent)).json(), b);
  assert.equal(s.pl().calls.length, 1);
});

// классификация исхода create (вердикт Голема, Важно 2): 4xx и «не дошло до запроса» — точно не создана; 5xx — запись могла лечь
for (const [mode, known, line] of [['refuse', true, 'Доска ответила 400'], ['nostatus', true, 'Нет статуса «Backlog»'], ['noenv', true, 'нет PLANE_API_KEY'], ['refuse502', false, 'Доска ответила 502']]) {
  test(`create: «${line}» (код 1) — ${known ? 'не создана (NOT_CREATED)' : 'исход неясен (UNCLEAR), без повтора'}`, async () => {
    const s = await setup({ plane: { fail: { create: mode } } });
    const b = (await s.press({ project: 'EXT', title: 'Совсем иная затея про маршрутизацию' })).json();
    assert.equal(b.outcome, 'error');
    assert.equal(s.lines().find((l) => l.id === b.id && l.step === 'error').result.code, known ? 'NOT_CREATED' : 'UNCLEAR');
    assert.equal(known ? b.message.startsWith('не создана: ') : b.message.startsWith('исход неясен'), true);
    assert.equal(s.pl().calls.length, 1);
    assert.deepEqual(s.tmpFiles(), []);
  });
}

test('код 0, но создана карточка чужого проекта в выводе — исход неясен (код проекта должен совпасть)', async () => {
  const s = await setup();
  s.setPlane({ fail: {} });
  // подмена: сервер просит EXT, а подменный plane.py отвечает кодом другого проекта — через вход create в CAR нельзя, поэтому правим копию
  const f = path.join(s.pdir, 'fake-plane.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('out(`создана ${code}-${num}', 'out(`создана ZZZ-${num}'));
  const b = (await s.press({ project: 'EXT', title: 'Совсем иная затея про маршрутизацию' })).json();
  assert.equal(b.outcome, 'error');
  assert.match(b.message, /^исход неясен/);
});

// ---------------- параметры и ограничения ----------------

test('параметры: заголовок 121 и текст 2001 → 400 (после снятия управляющих), 120/2000 проходят; нет заголовка, пустой, неизвестный проект → 400; без записи в журнал', async () => {
  const s = await setup();
  const code = async (b) => (await s.press(b)).statusCode;
  assert.equal(await code({ project: 'EXT', title: 'я'.repeat(121) }), 400);
  assert.equal(await code({ project: 'EXT', title: 'т', text: 'я'.repeat(2001) }), 400);
  assert.equal(await code({ project: 'EXT' }), 400);
  assert.equal(await code({ project: 'EXT', title: '  \u0001 ' }), 400);
  assert.equal(await code({ project: 'NOPE', title: 'т' }), 400);
  assert.equal(await code({ title: 'т' }), 400);
  assert.equal(s.lines().length, 0);
  assert.equal(s.pl().calls, undefined);
  assert.equal(await code({ project: 'EXT', title: `${'ж'.repeat(120)}\u0007\u0000` }), 200, '120 знаков + управляющие — проходит');
  assert.equal(await code({ project: 'CAR', title: 'я'.repeat(120), text: 'я'.repeat(2000) }), 200);
  assert.equal(creates(s).length, 2);
  assert.equal(creates(s)[1].body.name, 'я'.repeat(120));
});

test('RADAR: 200 refused no-new-card без вызова plane.py (строка asked ложится — отказ обработчика, как у прочих действий); повтор после рестарта — тот же отказ', async () => {
  const s = await setup();
  const intent = nextIntent();
  const r = await s.press({ project: 'RADAR', title: 'Идея для радара' }, intent);
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'refused');
  assert.equal(b.refusal, 'no-new-card');
  assert.equal(b.message, 'в RADAR карточка рождается с вердиктом — заводит дирижёр');
  assert.equal(s.pl().calls, undefined);
  assert.deepEqual(s.lines().map((l) => l.step), ['asked', 'refused']);
  assert.deepEqual(s.tmpFiles(), []);
  const s2 = await setup({ data: s.data, pdir: s.pdir });
  const re = await s2.press({ project: 'RADAR', title: 'Идея для радара' }, intent);
  assert.equal(re.statusCode, 200);
  assert.equal(re.json().refusal, 'no-new-card');
});

test('pult.words выключен → 503 без записи; нет функции похожих → 501; без доски (registerPult без board) → 501', async () => {
  const off = await setup({ words: false });
  const r = await off.press({ project: 'EXT', title: 'т' });
  assert.equal(r.statusCode, 503);
  assert.equal(off.lines().length, 0);
  assert.equal(off.pl().calls, undefined);
  const noSim = await setup({ similarFn: null });
  const r2 = await noSim.press({ project: 'EXT', title: 'Совсем иная затея про маршрутизацию' });
  assert.equal(r2.statusCode, 501);
  assert.equal(noSim.pl().calls, undefined);
  // без доски: голый Fastify с одним registerPult (защита §4.1 — в onRequest приложения, здесь не нужна)
  const bare = Fastify();
  registerPult(bare, { hasCode: () => true, maskRow: (x) => x, pult: { enabled: true, words: true, actionsLog: path.join(tmpDir('ext81-bare-'), 'actions.log') }, similar });
  const r3 = await bare.inject({ method: 'POST', url: '/api/act', payload: JSON.stringify({ intentId: nextIntent(), action: 'new-card', project: 'EXT', title: 'т' }),
    headers: { 'content-type': 'application/json' } });
  assert.equal(r3.statusCode, 501);
  await bare.close();
});

test('журнал: asked с заголовком и текстом, шаги plane/create и done; токен страницы и вывод plane.py целиком не пишутся', async () => {
  const s = await setup({ plane: { fail: { create: 'traceback' } } });
  const b = (await s.press({ project: 'EXT', title: 'Совсем иная затея про маршрутизацию', text: 'подробности' })).json();
  const mine = s.lines().filter((l) => l.id === b.id);
  assert.deepEqual(mine.map((l) => l.step), ['asked', 'plane', 'error']);
  assert.equal(mine[0].action, 'new-card');
  assert.equal(mine[0].project, 'EXT');
  assert.equal(mine[0].title, 'Совсем иная затея про маршрутизацию');
  assert.equal(mine[0].text, 'подробности');
  assert.deepEqual(mine[1].result.line, 'Traceback (most recent call last):');
  const raw = fs.readFileSync(s.actionsLog, 'utf8');
  assert.ok(!raw.includes('x-vitrina-token') && !raw.includes('board.example') && !raw.includes('description_html'));
});

test('граница по файлу: в репозитории нет копии нормализации заголовков (titleWords) — поиск похожих только функцией доски', () => {
  const root = path.join(HERE, '..');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(mjs|js)$/.test(e.name) && /titleWords/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  for (const d of ['lib', 'web', 'server.mjs']) { const p = path.join(root, d); if (fs.existsSync(p)) { if (fs.statSync(p).isDirectory()) walk(p); else if (/titleWords/.test(fs.readFileSync(p, 'utf8'))) hits.push(p); } }
  assert.deepEqual(hits, []);
});
