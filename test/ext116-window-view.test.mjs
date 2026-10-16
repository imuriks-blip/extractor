// EXT-116 Т2 (спека витрины, раздел «EXT-116 — окно «агенты»», Р4 и гейт Т2): окно «Агенты цеха» — вид по образцам web/fixtures.
// Разметку в тестах не рисуем (в репозитории нет сборки JSX для node --test): слова и пометки — чистые функции agentsData.js,
// которые зовёт Agents.jsx; связка в разметке — по исходнику. Ожидаемое — из спеки, не из кода под тестом. Глазами (1280 и 400,
// светлая и тёмная, Escape / крестик / мимо, поиск) — probe/ext116-shots.mjs, руками.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ad from '../web/src/agentsData.js';
import { HELP } from '../web/src/help.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(ROOT, '..', 'web', 'src', f), 'utf8');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'web', 'fixtures', f), 'utf8'));
const OK = fx('agents.json'), ERR = fx('agents-error.json'), DRIFT = fx('agents-drift.json'), EMPTY = fx('agents-empty.json');
const role = (d, name) => d.roles.find((r) => r.name === name);
const NOW = Date.parse('2026-10-16T09:00:00.000Z'); // failingSince образцов — 08:40

test('гейт 1 (а): error и roles: [] → «реестр не разобран: …» вместо списка, без «данные на», без legend', () => {
  const e = ad.errorLines(EMPTY, NOW);
  assert.equal(e.error, `реестр не разобран: ${EMPTY.error}`);
  assert.equal(e.stale, null, 'прежнего разбора нет — «данные на» не пишется');
  assert.equal(e.list, false);
  assert.equal(ad.headLine(EMPTY), null, 'updatedAt: null — строки «реестр от» нет');
  assert.equal(ad.legendHead(EMPTY.legend), null, 'legend: null — строки нет');
  const a = src('Agents.jsx');
  assert.match(a, /else if \(!roles\.length\) body = null;/, 'ролей нет — тело пусто, ошибка строкой над ним');
  assert.match(a, /\{err && <p className="ags-m ags-err">\{err\.error\}<\/p>\}/);
  assert.match(a, /\{legend && \(/);
});

test('гейт 1 (б): error и прежние роли с failingSince → строка над списком «данные на ЧЧ:ММ, чтение не удаётся N мин», список виден', () => {
  const e = ad.errorLines(ERR, NOW);
  assert.equal(e.error, `реестр не разобран: ${ERR.error}`);
  assert.match(e.stale, /^данные на \d\d\.\d\d \d\d:\d\d, чтение не удаётся 20 мин$/);
  assert.equal(e.list, true);
  assert.equal(ERR.roles.length, 11);
  assert.match(src('Agents.jsx'), /\{err\?\.stale && <p className="ags-m ags-gray">\{err\.stale\}<\/p>\}/);
});

test('гейт 1 (в): исправный образец → 11 ролей, ошибки нет; шапка «Агенты цеха · 11 ролей», «реестр от ДД.ММ ЧЧ:ММ · выжимка, прав источник»', () => {
  assert.equal(ad.errorLines(OK, NOW), null);
  assert.equal(OK.roles.length, 11);
  assert.equal(ad.TITLE, 'Агенты цеха');
  assert.equal(ad.rolesTitle(11), '11 ролей');
  assert.equal(ad.rolesTitle(1), '1 роль');
  assert.match(ad.headLine(OK), /^реестр от \d\d\.\d\d \d\d:\d\d · выжимка, прав источник$/);
});

test('гейт 2 (а): роль proposal → метка значением статуса и серая строка в раскрытии', () => {
  const c = role(OK, 'Цереброн');
  assert.deepEqual(ad.roleTags(c), [{ kind: 'proposal', text: 'предложение — INFRA-97' }]);
  assert.equal(ad.PROPOSAL_NOTE, 'Роль не действует: ниже — предложение, а не права');
  const a = src('Agents.jsx');
  assert.match(a, /\{role\.status === 'proposal' && <p className="ags-note">\{PROPOSAL_NOTE\}<\/p>\}/);
  assert.match(a, /role\.status === 'proposal' \? ' prop' : ''/, 'строка приглушена');
});

test('гейт 2 (б): problems и text: null → «разобрано не всё: N», «раздела нет в реестре»; fact.def: null → «определение не читается»', () => {
  const b = role(DRIFT, 'Электрибальд');
  assert.deepEqual(ad.roleTags(b).map((t) => t.text), ['разобрано не всё: 2']);
  const miss = b.sections.find((s) => s.text === null);
  assert.equal(ad.sectionKind(miss.text), 'missing');
  assert.equal(ad.MISSING, 'раздела нет в реестре');
  assert.equal(ad.sectionKind('Нет.'), 'none', '«Нет.» — серым');
  assert.equal(ad.sectionKind('Код в ветке'), 'text');
  const d = role(DRIFT, 'Демон');
  assert.deepEqual(ad.roleTags(d).map((t) => t.text), ['определение не читается']);
  assert.equal(d.check, null);
  assert.equal(ad.fieldMark(d, 'brake'), null, 'сверки нет — у полей пометок нет');
  assert.match(src('Agents.jsx'), /\{kind === 'missing' \? MISSING : <Rich text=\{s\.text\} \/>\}/);
});

test('гейт 2 (в): действующая роль без проблем → меток нет', () => {
  for (const n of ['Иван', 'Терминус', 'Голем']) assert.deepEqual(ad.roleTags(role(OK, n)), [], n);
});

test('гейт 3 (а, б): drift — жёлтое у тормоза и у модели с обоими значениями и подсказкой «прав источник»', () => {
  const brake = ad.fieldMark(role(DRIFT, 'Клапауций'), 'brake');
  assert.deepEqual(brake, { kind: 'drift', text: 'реестр: 40 · определение: 60', title: 'прав источник — определение; реестр правит тред INFRA' });
  assert.equal(ad.fieldMark(role(DRIFT, 'Клапауций'), 'model'), null, 'ok — без пометки');
  const model = ad.fieldMark(role(DRIFT, 'Голем'), 'model');
  assert.equal(model.kind, 'drift');
  assert.equal(model.text, 'реестр: Opus всегда (под прорабом — явным параметром вызова) · определение: sonnet');
  assert.deepEqual(ad.driftLine(DRIFT), { text: 'расхождений с определениями: 2', warn: true });
  const a = src('Agents.jsx');
  assert.match(a, /if \(m\?\.kind === 'drift'\) return <span className="ags-dr" title=\{m\.title\}>\{m\.text\}<\/span>;/);
  assert.match(a, /<span className=\{drift\.warn \? 'ags-warn' : 'ags-gray'\}>/);
  assert.match(src('styles.css'), /\.ags-dr\{[^}]*background:var\(--amber-bg\);color:var\(--amber\)\}/, 'жёлтое — токены amber');
});

test('гейт 3 (в, г): drifts: 0 → серое «с определениями сходится»; unchecked → серое «не сверяется», не жёлтое; check: null → без пометок', () => {
  assert.deepEqual(ad.driftLine(OK), { text: 'с определениями сходится', warn: false });
  for (const r of OK.roles) for (const f of ['brake', 'model']) assert.equal(ad.fieldMark(r, f), null, `${r.name}: ${f}`);
  const t = ad.fieldMark(role(DRIFT, 'Ийон Тихий'), 'model');
  assert.equal(t.kind, 'unchecked');
  assert.equal(t.text, 'не сверяется');
  const i = role(DRIFT, 'Иван');
  assert.equal(i.check, null);
  assert.equal(ad.fieldMark(i, 'brake'), null);
  assert.equal(ad.fieldMark(i, 'model'), null);
  assert.match(src('Agents.jsx'), /\{m && <span className="ags-un" title=\{m\.title\}> · \{m\.text\}<\/span>\}/);
  assert.match(src('styles.css'), /\.ags-un\{[^}]*color:var\(--muted\)/, 'серое (muted: контраст AA; faint — 2,6:1 на белом)');
});

test('гейт 4: поиск — «база» находит роли с разделом о базах (разделы раскрыты), «zzz» — «ничего не найдено»; ё = е, регистр', () => {
  const found = ad.searchRoles(OK.roles, 'база');
  assert.ok(found.length > 0);
  for (const { role: r, hits } of found) {
    assert.ok(hits.length > 0, r.name);
    for (const i of hits) assert.match(`${r.sections[i].title} ${r.sections[i].text}`, /баз/i, `${r.name}: ${r.sections[i].title}`);
  }
  assert.ok(ad.searchSummary(OK.summary, 'база').some((s) => s.title === 'Базы'));
  assert.deepEqual(ad.searchRoles(OK.roles, 'zzz'), []);
  assert.deepEqual(ad.searchSummary(OK.summary, 'zzz'), []);
  assert.equal(ad.NOTHING, 'ничего не найдено');
  assert.equal(ad.searchRoles(OK.roles, 'ТЕРМИНУС').length, ad.searchRoles(OK.roles, 'терминус').length);
  assert.deepEqual(ad.queryWords('Ёлка   база'), ['елк', 'баз']);
  assert.ok(ad.searchRoles(OK.roles, '').every((x) => x.hits === null), 'без поиска — раскрытие по щелчку');
  assert.match(src('Agents.jsx'), /else if \(!shown\.length && !summary\.length\) body = <p className="gls-m">\{NOTHING\}<\/p>;/);
});

test('гейт 4: legend — серой строкой, свёрнут до первой фразы, раскрывается щелчком; null — строки нет', () => {
  assert.deepEqual(ad.legendHead(OK.legend), { head: '**Как читать «держит».**', rest: OK.legend.slice('**Как читать «держит».**'.length).trim() });
  assert.equal(ad.legendHead(null), null);
  assert.deepEqual(ad.legendHead('Одна фраза без конца'), { head: 'Одна фраза без конца', rest: '' });
  const a = src('Agents.jsx');
  assert.match(a, /<button type="button" className="ags-lg" aria-expanded=\{legendOpen\} onClick=\{\(\) => setLegendOpen\(\(x\) => !x\)\}>/);
  assert.match(src('styles.css'), /\.ags-lg\{[^}]*color:var\(--muted\)/);
});

test('гейт 4: окно — диалог словаря (useDialog: Escape, крестик, щелчок мимо, фокус на кнопку); кнопка «Агенты» в tbtns рядом со «Словарём»', () => {
  const a = src('Agents.jsx');
  assert.match(a, /const \{ btn, dlg, close, dialogProps \} = useDialog\(\);/);
  assert.match(a, /<button ref=\{btn\} type="button" className="hbtn" title=\{TITLE\} aria-haspopup="dialog" onClick=\{show\}>Агенты<\/button>/);
  assert.match(a, /<dialog \{\.\.\.dialogProps\} className="hlp gls ags" aria-labelledby="ags-title">/, 'размеры и шапка — окна словаря');
  assert.match(a, /<button type="button" className="close" aria-label="Закрыть" onClick=\{close\}>×<\/button>/);
  assert.match(a, /fetch\('\/api\/agents', \{ cache: 'no-store' \}\)/, 'запрос при каждом открытии, только GET');
  assert.doesNotMatch(a, /method:/, 'окно ничего не пишет (А-2 (а))');
  const app = src('App.jsx');
  assert.match(app, /<span className="tbtns">[\s\S]*?<Glossary \/>\s*<Agents \/>\s*<Help \/>\s*<\/span>/);
  assert.match(src('styles.css'), /@media \(max-width:560px\)\{\s*\.ags-t thead\{display:none\}/, 'до 560 — строка карточкой');
});

test('гейт 5: памятка — пункт «Агенты» в разделе «Кнопки» сразу за «Словарём», текстом из ТЗ Т2 дословно', () => {
  const items = HELP.find((s) => s.title === 'Кнопки').items;
  const i = items.findIndex((x) => x.startsWith('**Агенты**'));
  assert.ok(i > 0);
  assert.ok(items[i - 1].startsWith('**Словарь**'));
  assert.equal(items[i], '**Агенты** — кнопка в шапке рядом со «Словарём»: кто есть кто в цехе — роль, где живёт, что пишет, что ему запрещено и чем это держится (словом или механикой). Данные — реестр ролей цеха в Vault; витрина только показывает, правит реестр тред INFRA. Жёлтое — реестр расходится с определением агента (тормоз или модель); серое «не сверяется» — сверять не с чем.');
});

test('образцы: пути в текстах разделов — с обратными косыми (ревью Голема по Т1)', () => {
  const B = String.fromCharCode(92);
  const want = `C:${B}projects${B}_wt${B}<проект>-<карточка>`;
  for (const [f, d] of [['agents.json', OK], ['agents-error.json', ERR], ['agents-drift.json', DRIFT]]) {
    const texts = d.roles.flatMap((r) => r.sections.map((s) => s.text ?? ''));
    assert.ok(texts.some((t) => t.includes(want)), f);
    assert.ok(!texts.some((t) => t.includes('C:projects')), `${f}: косые не пропали`);
  }
});

// Мелочь ревью Голема по Т2: поиск совпадал внутри слова («бот» находил «работ») и учитывал слова в 1–2 буквы.
// Основа слова запроса — только с начала слова текста; слова запроса в 1 букву не учитываются (из одних таких — как пустой).
test('гейт 4: поиск — основа с начала слова, не внутри; слова в 1 букву не учитываются, «ТЗ» — да', () => {
  const R = [
    { name: 'Первый', fields: {}, sections: [{ title: 'Работа', text: 'работает молча, заработок' }] },
    { name: 'Второй', fields: {}, sections: [{ title: 'Связь', text: 'пишет в чат **бота**' }] },
    { name: 'Третий', fields: {}, sections: [{ title: 'Связь', text: 'Боты цеха' }] },
    { name: 'Четвёртый', fields: {}, sections: [{ title: 'Связь', text: 'отвечает «боту» (на ходу)' }] },
  ];
  const names = (q) => ad.searchRoles(R, q).map((x) => x.role.name);
  // внутри слова — нет: «бот» не находит «работ», «заработок»
  assert.deepEqual(names('бот'), ['Второй', 'Третий', 'Четвёртый']);
  assert.deepEqual(names('бот'.toUpperCase()), ['Второй', 'Третий', 'Четвёртый']);
  assert.deepEqual(names('рабо'), ['Первый'], '«рабо» — с начала «работает», не внутри «заработок»; роль одна');
  // исправный случай: основа с начала слова находит формы — «бота» и «боты» → основа «бот»
  assert.deepEqual(ad.queryWords('бота боты'), ['бот', 'бот']);
  assert.deepEqual(names('бота'), ['Второй', 'Третий', 'Четвёртый']);
  assert.deepEqual(names('боты'), ['Второй', 'Третий', 'Четвёртый']);
  assert.deepEqual(names('работа'), ['Первый']);
  assert.deepEqual(ad.searchRoles(R, 'бот').find((x) => x.role.name === 'Четвёртый').hits, [0], 'после « — начало слова');
  // слова в 1 букву не учитываются; от 2 букв — да (термины цеха: «ТЗ», «PR»; повторное ревью Голема, Мелочь B)
  assert.deepEqual(ad.queryWords('в и бот'), ['бот']);
  assert.deepEqual(ad.queryWords('в и'), []);
  assert.deepEqual(ad.queryWords('ТЗ PR'), ['тз', 'pr']);
  assert.deepEqual(names('бот в'), names('бот'), '«в» не сужает и не расширяет');
  assert.ok(ad.searchRoles(R, 'в и').every((x) => x.hits === null), 'из одних коротких — как пустой: все роли, раскрытие по щелчку');
  assert.equal(ad.searchRoles(R, 'в и').length, R.length);
  assert.deepEqual(ad.searchSummary(OK.summary, 'в и'), OK.summary, 'сводка — как без поиска');
  // «ТЗ» — с начала слова, не внутри («ТЗ» не находит «отзыв»); дефис — граница («бот» находит «чат-бот»); ё = е внутри текста
  const T = [
    { name: 'Пятый', fields: {}, sections: [{ title: 'Задачи', text: 'берёт ТЗ дирижёра' }] },
    { name: 'Шестой', fields: {}, sections: [{ title: 'Связь', text: 'отзыв, чат-бот, Ёмкость' }] },
  ];
  const tn = (q) => ad.searchRoles(T, q).map((x) => x.role.name);
  assert.deepEqual(tn('тз'), ['Пятый']);
  assert.deepEqual(tn('бот'), ['Шестой']);
  assert.deepEqual(tn('емк'), ['Шестой']);
  assert.deepEqual(tn('берет'), ['Пятый']);
  // сводка: то же правило начала слова
  const S = [{ title: 'Связь', text: '', rows: [['Работа', 'заработок'], ['Боты', 'чат']] }];
  assert.deepEqual(ad.searchSummary(S, 'бот'), [{ title: 'Связь', text: '', rows: [['Боты', 'чат']] }]);
  // окно: «ищем» — когда в запросе есть учитываемые слова (сводка раскрыта только тогда)
  const a = src('Agents.jsx');
  assert.ok(a.includes('const searching = queryWords(q).length > 0;'), 'из одних коротких — сводка не раскрывается');
});
