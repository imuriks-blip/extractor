// EXT-103 Т3 (спека Vault extractor/SPEC-extractor-roadmap.md, раздел 3 «Вид», гейт Г3): окно «Дорожная карта» — вид по образцам
// web/fixtures/roadmap*.json. Разметку в тестах не рисуем (в репозитории нет сборки JSX для node --test): слова и пометки — чистые
// функции roadmapData.js, которые зовёт Roadmap.jsx; связка в разметке — по исходнику. Ожидаемое — из спеки, не из кода под тестом.
// Глазами (1280 и 400, светлая и тёмная, опрос, вход из шапки) — probe/ext103-shots.mjs, руками.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rd from '../web/src/roadmapData.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', f), 'utf8'));
const ALL = fx('roadmap.json'), ONE = fx('roadmap-EXT.json'), OFF = fx('roadmap-off.json');

test('маршруты: #/roadmap — все проекты, #/roadmap/<КОД> — карта проекта; прочее — не карта', () => {
  assert.deepEqual(rd.roadmapRoute('#/roadmap'), { name: 'roadmap', code: null });
  assert.deepEqual(rd.roadmapRoute('#/roadmap/EXT'), { name: 'roadmap', code: 'EXT' });
  assert.equal(rd.roadmapRoute('#/roadmap/ext'), null);
  assert.equal(rd.roadmapRoute('#/usage'), null);
  assert.equal(rd.roadmapUrl(null), '/api/roadmap');
  assert.equal(rd.roadmapUrl('EXT'), '/api/roadmap/EXT');
  const a = src('App.jsx');
  assert.match(a, /const rm = roadmapRoute\(window\.location\.hash\);/);
  assert.match(a, /body = <Roadmap code=\{route\.code\} \/>;/);
});

test('вход из шапки: «Карта» рядом с «Расход» (кроме самого окна карты); «Карта <КОД>» в окне проекта', () => {
  const a = src('App.jsx');
  assert.match(a, /\{route\.name !== 'roadmap' && <a className="navl" href="#\/roadmap">Карта<\/a>\}\s*<a className="navl" href=\{route\.name === 'usage'/);
  assert.match(src('Project.jsx'), /<a className="bmap" href=\{`#\/roadmap\/\$\{code\}`\}>Карта \{code\}<\/a>/);
});

test('свой опрос ручки раз в 5 с, пока окно открыто (поток событий правку карты не сигналит), не чаще прочих', () => {
  assert.equal(rd.ROADMAP_POLL_MS, 5000);
  const r = src('Roadmap.jsx');
  assert.match(r, /useMemo\(\(\) => pollSource\(roadmapUrl\(code\), ROADMAP_POLL_MS, \{ pauseHidden: true \}\), \[code\]\)/);
  // App не читает для окна карты чужой поток: источник экрана — пустой
  assert.match(src('App.jsx'), /route\.name === 'usage' \|\| route\.name === 'roadmap' \? idleSource/);
});

test('Г3 п.1: проект без карты — серое «карты нет», остальные видны со счётчиками', () => {
  assert.equal(rd.countsParts(null), null);
  assert.equal(rd.NO_MAP, 'карты нет');
  const ext = ALL.projects.find((p) => p.code === 'EXT');
  assert.equal(rd.countsLine(ext.counts), 'ждёт Ивана 1 · идей в обсуждении 1 · впереди 2');
  assert.equal(rd.totalLine(ALL.total), 'впереди по цеху — 2 карточки');
  assert.equal(rd.totalLine({ ahead: 5 }), 'впереди по цеху — 5 карточек');
  assert.match(src('Roadmap.jsx'), /: <span className="faint">\{NO_MAP\}<\/span>\}/);
});

test('карта недоступна (roadmap-off): понятная строка вместо окна, без ошибок', () => {
  const o = rd.offLines(OFF);
  assert.equal(o.error, 'карта недоступна: модуль доски не найден (ERR_MODULE_NOT_FOUND)');
  assert.match(o.hint, /перезапуска витрины/);
  assert.equal(rd.offLines(ALL), null);
  assert.equal(rd.offLines(ONE), null);
});

test('Г3 п.3: порядок разделов — Где стоим · Ждёт Ивана · Идеи · Впереди · Сделано · Снято', () => {
  assert.deepEqual(rd.SECTIONS.map(([, t]) => t), ['Где стоим', 'Ждёт Ивана', 'Идеи', 'Впереди', 'Сделано', 'Снято']);
  const r = src('Roadmap.jsx');
  const at = (s) => r.indexOf(s);
  const seq = ['<Where w={m.where} />', '<Ask code={code}', '<Ideas code={code}', 'sec="ahead"', 'sec="done"', 'sec="cancelled"'].map(at);
  assert.ok(seq.every((v) => v > 0), 'все разделы в разметке');
  assert.deepEqual([...seq].sort((x, y) => x - y), seq, 'в порядке спеки');
});

test('Г3 п.3: счётчик «ждёт Ивана» = открытые qN; закрытые вопросы, отброшенные идеи и «Снято» свёрнуты', () => {
  const q = rd.splitQuestions(ONE.map.questions);
  assert.equal(q.open.length, ONE.counts.askOpen);
  assert.deepEqual(q.closed.map((x) => x.n), ['q2']);
  const i = rd.splitIdeas(ONE.map.ideas);
  assert.deepEqual(i.dropped.map((x) => x.n), ['i3']);
  assert.deepEqual(i.shown.map((x) => x.n), ['i1', 'i2']);
  const r = src('Roadmap.jsx');
  assert.match(r, /useOpen\(`rm-askc-\$\{code\}`, false\)/, 'закрытые вопросы свёрнуты');
  assert.match(r, /useOpen\(`rm-drop-\$\{code\}`, false\)/, 'отброшенные идеи свёрнуты');
  assert.match(r, /sec="cancelled" title="Снято" list=\{cards\.cancelled \|\| \[\]\} defOpen=\{false\}/, '«Снято» свёрнуто');
  assert.match(r, /Ждёт Ивана <span className=\{open\.length \? 'cnt num rm-hot' : 'cnt num'\}>\{open\.length\}<\/span>/);
});

test('Г3 п.2–3: статус идеи с карточкой — со статуса карточки; снятая карточка — серым, не «сделана»', () => {
  const base = { n: 'i9', status: 'стала карточкой', card: 'T-1' };
  assert.deepEqual(rd.ideaView({ ...base, shown: 'стала карточкой', cardStatus: 'ready' }).cls, 'idle');
  const work = rd.ideaView({ ...base, shown: 'в работе', cardStatus: 'in-progress' });
  assert.equal(work.text, 'в работе'); assert.equal(work.cls, 'work'); assert.equal(work.trace, undefined, 'у «в работе» значка следа нет');
  const tr = { state: 'ok', label: 'след сходится', reasons: [] };
  const done = rd.ideaView({ ...base, shown: 'сделана', cardStatus: 'done', cardTrace: tr });
  assert.equal(done.text, 'сделана'); assert.equal(done.cls, 'done'); assert.equal(done.trace, tr, '«сделана» — со значком следа карточки');
  assert.equal(rd.ideaView({ ...base, shown: 'сделана', cardStatus: 'done', cardTrace: null }).trace, null, 'след ещё не проверен — «проверяю след»');
  const gone = rd.ideaView({ ...base, shown: 'стала карточкой · карточка снята', cardStatus: 'cancelled' });
  assert.equal(gone.text, 'стала карточкой · карточка снята'); assert.equal(gone.cls, 'gone');
  // образец: i2 → EXT-6 в review — «в работе»
  assert.equal(rd.ideaView(ONE.map.ideas[1]).text, 'в работе');
  assert.equal(rd.ideaView(ONE.map.ideas[0]).text, 'обсуждаем', 'идея без карточки — статус из файла');
  assert.equal(rd.cardHref('EXT-6'), '#/project/EXT/EXT-6');
  assert.equal(rd.cardHref('INFRA-93'), '#/project/INFRA/INFRA-93', 'карточка любого проекта — в окне своего проекта');
});

test('Г3 п.2: красный и жёлтый след — знак и подсказка причины (коды сервера)', () => {
  const warn = ONE.map.cards.ahead[0].plan.items[0].traces[0];
  assert.equal(rd.traceState(warn), 'warn');
  assert.match(rd.traceTip(warn), /origin\/main.*\(no-origin\)/);
  const bad = ONE.map.cards.done[0].trace;
  assert.equal(rd.traceState(bad), 'bad');
  assert.equal(rd.traceTip(bad), 'контракта закрытия нет (no-contract)');
  const nim = { state: 'bad', label: 'x', reasons: [{ level: 'bad', code: 'not-in-main', text: 'abc1234 не в main' }, { level: 'bad', code: 'not-pushed', text: 'не отправлен' }] };
  assert.equal(rd.traceTip(nim), 'abc1234 не в main (not-in-main)\nне отправлен (not-pushed)');
  assert.equal(rd.traceState(null), 'wait');
  assert.equal(rd.traceState({ state: null }), 'wait');
  assert.equal(rd.traceTip(null), 'проверяю след…');
  assert.deepEqual(rd.TRACE_SIGN, { ok: '✓', warn: '!', bad: '✕', none: '–' }, 'знаки — как у значка «Принять» (Trace.jsx)');
  assert.match(src('Roadmap.jsx'), /<span className=\{`trc rm-trc t-\$\{st\}`\} title=\{tip\}>/);
});

test('Г3 п.2: подпись «шаг N из M» (EXT-108) — только если поле есть в данных', () => {
  for (const it of ONE.map.cards.ahead[0].plan.items) assert.equal(rd.stepLine(it), null);
  assert.equal(rd.stepLine({ step: { thread: 'EXT', n: 3, of: 6 } }), 'тред EXT: шаг 3 из 6');
  assert.equal(rd.stepLine({ step: { n: '3', of: 6 } }), null, 'не число — подписи нет');
  assert.match(src('Roadmap.jsx'), /\{step && <span className="rm-step">\{step\}<\/span>\}/);
});

test('пункты плана: знак и слово отметки; [>] — со статуса карточки', () => {
  const items = ONE.map.cards.ahead[0].plan.items;
  assert.deepEqual(items.map((it) => rd.markView(it).word), ['сделано', 'идёт', 'идёт', 'ждёт', 'снято']);
  assert.equal(rd.markView({ mark: '>', shownMark: null }).word, 'отдан карточкой');
  assert.equal(rd.cardWord('in-progress'), 'в работе');
  assert.equal(rd.cardWord(null), 'нет на доске');
});

test('маленькие под большой — «закрыто X из Y» с сервера; битая карта — строкой, прежний разбор виден', () => {
  assert.match(src('Roadmap.jsx'), /\{c\.childrenSummary && <span className="rm-sum num">\{c\.childrenSummary\.label\}<\/span>\}/);
  assert.equal(ONE.map.cards.ahead[0].childrenSummary.label, 'закрыто 1 из 2 · идёт 1 · ждёт 0');
  assert.equal(rd.brokenLine(null), null);
  assert.equal(rd.brokenLine({ file: 'T/T.map.md', errors: [{ line: 7, msg: 'статус' }, { line: 9, msg: 'дата' }] }),
    'карта T/T.map.md не разбирается — строка 7: статус (и ещё 1); показан прежний разбор');
});

test('только показ (Р-4 (а)): в окне карты нет кнопок и записи', () => {
  const r = src('Roadmap.jsx');
  assert.doesNotMatch(r, /<button/);
  assert.doesNotMatch(r, /method: 'POST'|\/api\/act/);
});

test('«откуда · дата» без повтора даты; дата карты — коротко', () => {
  assert.equal(rd.srcLine({ from: 'чат EXT 17.10', date: '2026-10-17' }), 'чат EXT 17.10');
  assert.equal(rd.srcLine({ from: 'inbox/x.md', date: '2026-10-17' }), 'inbox/x.md · 17.10');
  assert.equal(rd.dateShort('2026-10-17 10:00'), '17.10 10:00');
  assert.equal(rd.roadmapTitle('EXT'), 'Экстрактор · Карта EXT');
});

test('«ждёт:» у пункта плана [!] — ссылка только на номер карточки; «слово Ивана» и прочее — обычным текстом (ревью Голема, Важно 1)', () => {
  assert.deepEqual(rd.waitView('EXT-9'), { card: 'EXT-9', text: 'EXT-9' });
  assert.deepEqual(rd.waitView('INFRA-101'), { card: 'INFRA-101', text: 'INFRA-101' });
  assert.deepEqual(rd.waitView('слово Ивана'), { card: null, text: 'слово Ивана' });
  assert.deepEqual(rd.waitView('EXT-9 и слово Ивана'), { card: null, text: 'EXT-9 и слово Ивана' }, 'номер — только всё значение целиком');
  assert.equal(rd.waitView(null), null);
  const r = src('Roadmap.jsx');
  assert.match(r, /\{w\.card \? <CardLink id=\{w\.card\} \/> : <span className="rm-wt">\{w\.text\}<\/span>\}/);
  assert.doesNotMatch(r, /<CardLink id=\{it\.wait\} \/>/, 'ссылку на «ждёт» без проверки не рисуем');
});

test('опрос карты стоит, пока вкладка скрыта; при возврате — сразу запрос (ревью Голема, Мелочь 1)', () => {
  assert.match(src('Roadmap.jsx'), /pollSource\(roadmapUrl\(code\), ROADMAP_POLL_MS, \{ pauseHidden: true \}\)/);
  const d = src('data.js');
  assert.match(d, /if \(pauseHidden && document\.hidden\) \{ paused = true; return; \}/);
  assert.match(d, /document\.addEventListener\('visibilitychange', onVis\)/);
  assert.match(d, /export const usageSource = pollSource\('\/api\/usage', 30000\);/, '«Расход» — без паузы, как был');
});
