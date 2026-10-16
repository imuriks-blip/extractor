// EXT-116 Т1 — читатель реестра ролей цеха (спека витрины, «EXT-116 — окно «агенты»», Р1–Р3), гейт Т1 пп.1–6, 3а, 7 (роль).
// Данные — копия реестра Vault 2de0aff (test/fixtures/roles/registry-2de0aff.md) и её порченые варианты в подменённом fs;
// определения — временная папка с шапками по факту 15.10 из спеки (bard 120 · clap 40 · demon 60 · golem 40 · terminus 90 ·
// tikhiy 25; bard, clap, terminus — inherit; demon, tikhiy — sonnet; golem — opus). Живой реестр и ~/.claude не читаются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoles } from '../lib/roles.mjs';
import { createAgentDefs } from '../lib/agent-defs.mjs';
import { buildApp } from '../lib/app.mjs';
import { BOARD_LIB, tmpDir } from './helpers.mjs';

const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// копия на диске — с концами строк, какие дал checkout (core.autocrlf: в свежей копии CRLF); тесты режут текст по \n —
// поэтому SRC приводится к LF, а CRLF проверяется отдельно (тест «CRLF» ниже; EXT-118, находка дирижёра)
const RAW = fs.readFileSync(path.join(HERE, 'fixtures', 'roles', 'registry-2de0aff.md'), 'utf8');
const SRC = RAW.replace(/\r\n/g, '\n');
const P = 'C:/vault/unorbis/_meta/Реестр ролей цеха.md';
const NAMES = ['Иван', 'Лем', 'Трурль', 'Цереброн', 'Тарантога', 'Терминус', 'Электрибальд', 'Клапауций', 'Голем', 'Демон', 'Ийон Тихий'];
const SECTIONS = ['Кто', 'Где живёт', 'Кто ставит задачу и кому отчёт', 'Функции', 'Берёт / не берёт', 'Пишет', 'Читает', 'Инструменты',
  'Запрещено — слово', 'Запрещено — механика', 'Стоп-точки', 'Ориентир и тормоз', 'Форма отчёта', 'Источник правды'];
const FACT = { bard: [120, 'inherit'], clap: [40, 'inherit'], demon: [60, 'sonnet'], golem: [40, 'opus'], terminus: [90, 'inherit'], tikhiy: [25, 'sonnet'] };

// подменённый fs одного файла: текст, время изменения, счётчик чтений, ошибка stat/чтения кодом
function memFs(text, mtimeMs = 1000) {
  const m = { text, mtimeMs, reads: 0, stat: null, read: null };
  const err = (code) => Object.assign(new Error(code), { code });
  m.fs = {
    statSync: (p) => { if (m.stat) throw err(m.stat); if (p !== P || m.text === null) throw err('ENOENT'); return { mtimeMs: m.mtimeMs, size: Buffer.byteLength(m.text) }; },
    readFileSync: (p) => { m.reads++; if (m.read) throw err(m.read); if (p !== P || m.text === null) throw err('ENOENT'); return m.text; },
  };
  return m;
}
function defsDir(over = {}) {
  const dir = tmpDir('defs-');
  for (const [n, [t, mo]] of Object.entries({ ...FACT, ...over })) {
    const lines = [`name: ${n}`, ...(mo ? [`model: ${mo}`] : []), ...(t ? [`maxTurns: ${t}`] : [])];
    fs.writeFileSync(path.join(dir, `${n}.md`), `---\n${lines.join('\n')}\n---\nтело\n`);
  }
  return dir;
}
function reader(text, { over, clock } = {}) {
  const m = memFs(text);
  const defs = createAgentDefs({ dir: defsDir(over) });
  let t = 1_700_000_000_000;
  const roles = createRoles({ file: () => P, defs: defs.read, fs: m.fs, now: clock ?? (() => (t += 1000)) });
  return { m, roles, defs };
}
const role = (r, name) => r.roles.find((x) => x.name === name);
// строка роли в тексте реестра: номер строки (с 1) первой строки, начинающейся с prefix, после заголовка «## name»
function lineOf(text, name, prefix) {
  const ls = text.split('\n');
  const h = ls.indexOf(`## ${name}`);
  return ls.findIndex((l, i) => i > h && l.startsWith(prefix)) + 1;
}
// заменить строку роли, начинающуюся с prefix (после «## name»)
function editRole(text, name, prefix, fn) {
  const ls = text.split('\n');
  const i = lineOf(text, name, prefix) - 1;
  assert.ok(i >= 0, `${name}: нет строки ${prefix}`);
  const out = fn(ls[i], i, ls);
  ls.splice(i, 1, ...(out === null ? [] : [].concat(out)));
  return ls.join('\n');
}

// ——— п.1 Форма ———
test('п.1 (в): копия реестра 2de0aff — 11 ролей по 14 разделов, проблем нет, error: null', () => {
  const r = reader(SRC).roles.get();
  assert.equal(r.error, null);
  assert.equal(r.failingSince, null);
  assert.deepEqual(r.roles.map((x) => x.name), NAMES);
  for (const x of r.roles) {
    assert.deepEqual(x.sections.map((s) => s.title), SECTIONS, x.name);
    for (const s of x.sections) assert.ok(typeof s.text === 'string' && s.text.length > 0, `${x.name} · ${s.title}`);
    assert.deepEqual(x.problems, [], x.name);
  }
  assert.deepEqual(r.problems, []);
  assert.equal(r.source, 'unorbis/_meta/Реестр ролей цеха.md');
  assert.equal(r.form.sections.length, 14);
  assert.deepEqual(r.form.fields, ['лейбл', 'подпись на доске', 'статус', 'модель', 'тормоз']);
  assert.equal(role(r, 'Иван').line, 24);
  assert.equal(role(r, 'Ийон Тихий').line, 364);
  assert.deepEqual(r.summary.map((s) => s.title), ['Кто пишет на доску', 'git и репозитории', 'Базы и n8n', 'Б-дела — кто что может', 'Модели', 'Ориентир и тормоз']);
  const s0 = r.summary[0];
  assert.deepEqual(s0.head, ['Кто', 'Подпись', 'Что', 'Держит']);
  assert.equal(s0.rows.length, 8);
  assert.deepEqual(s0.rows[0], ['Иван', '`ivan`', 'записи-решения, done', '—']);
  assert.equal(s0.text, undefined, 'подраздел без абзаца — без text');
  assert.ok(r.summary[3].text.startsWith('Метка Б (база'));
  assert.equal(r.summary[3].rows, undefined, 'подраздел без таблицы — без rows');
  assert.equal(r.updatedAt, new Date(1000).toISOString());
});

test('п.1 (а): нет «## Форма раздела роли» — error с номером строки, roles: [], прочего нет', () => {
  const r = reader(SRC.replace('## Форма раздела роли\n', '\n')).roles.get();
  assert.match(r.error, /нет раздела «Форма раздела роли»/);
  assert.match(r.error, /строка 24/, 'первый раздел файла — роль Ивана, строка 24');
  assert.deepEqual(r.roles, []);
  assert.deepEqual(r.summary, []);
  assert.equal(r.updatedAt, null);
  assert.notEqual(r.failingSince, null);
});

test('п.1 (б): в форме 13 разделов (нет «Стоп-точки») — error «форма раздела роли изменилась: нет «Стоп-точки»»', () => {
  const r = reader(SRC.replace(' · **Стоп-точки**', '')).roles.get();
  assert.ok(r.error.includes('форма раздела роли изменилась: нет «Стоп-точки»'), r.error);
  assert.match(r.error, /строка 20/);
  assert.deepEqual(r.roles, []);
  // лишний раздел формы — номером, без имени из реестра
  const e = reader(SRC.replace('**Источник правды**.', '**Источник правды** · **Зебра**.')).roles.get().error;
  assert.ok(e.includes('лишний раздел №15'), e);
  assert.ok(!e.includes('Зебра'), 'текст реестра в ошибку не кладётся');
  // ключ строки полей пропал из формы
  const k = reader(SRC.replace(' · **тормоз**', '')).roles.get().error;
  assert.ok(k.includes('форма раздела роли изменилась: нет ключа «тормоз»'), k);
  // порядок разделов формы другой
  const o = reader(SRC.replace('**Пишет** · **Читает**', '**Читает** · **Пишет**')).roles.get().error;
  assert.ok(o.startsWith('форма раздела роли изменилась'), o);
});

test('п.1: ни одной роли после формы, не задан Vault — ошибка всего файла, ответ без ролей', () => {
  const cut = SRC.slice(0, SRC.indexOf('## Иван')) + SRC.slice(SRC.indexOf('## Сводные таблицы'));
  assert.match(reader(cut).roles.get().error, /ни одной роли/);
  const r = createRoles({ file: () => null, defs: () => null }).get();
  assert.match(r.error, /не задан путь к Vault/);
  assert.deepEqual(r.roles, []);
});

// ——— п.2 Роль ———
test('п.2 (а): у Демона нет раздела «Пишет» — ровно одна проблема, без «порядок не тот»; у прочих 10 — пусто', () => {
  const r = reader(editRole(SRC, 'Демон', '**Пишет.**', () => null)).roles.get();
  assert.equal(r.error, null);
  const d = role(r, 'Демон');
  assert.deepEqual(d.problems, ['нет раздела «Пишет»']);
  assert.equal(d.sections.find((s) => s.title === 'Пишет').text, null);
  assert.equal(d.sections.length, 14);
  for (const x of r.roles.filter((y) => y.name !== 'Демон')) assert.deepEqual(x.problems, [], x.name);
});

test('п.2 (б): строка полей из 4 частей, «Читает» перед «Пишет», незнакомый раздел и ключ — проблемы ролей, файл разобран', () => {
  let t = editRole(SRC, 'Голем', 'лейбл ', (l) => l.replace(' · подпись нет', ''));
  { // «Читает» и «Пишет» Клапауция меняются местами
    const ls = t.split('\n');
    const a = lineOf(t, 'Клапауций', '**Пишет.**') - 1;
    const b = lineOf(t, 'Клапауций', '**Читает.**') - 1;
    [ls[a], ls[b]] = [ls[b], ls[a]];
    t = ls.join('\n');
  }
  t = editRole(t, 'Лем', '**Инструменты.**', (l) => [l, '', '**Зебра.** выдуманный раздел']);
  t = editRole(t, 'Демон', 'лейбл ', (l) => l.replace(' · тормоз', ' · цвет синий · тормоз'));
  const r = reader(t).roles.get();
  assert.equal(r.error, null);
  assert.deepEqual(r.roles.map((x) => x.name), NAMES);
  const g = role(r, 'Голем');
  assert.equal(g.problems.length, 1, g.problems.join(' | '));
  assert.ok(g.problems[0].includes('частей 4'), g.problems[0]);
  assert.equal(g.fields.sign, null);
  assert.equal(g.turns, 40);
  const c = role(r, 'Клапауций');
  const ls = t.split('\n');
  const kh = ls.indexOf('## Клапауций');
  assert.ok(ls.findIndex((l, i) => i > kh && l.startsWith('**Читает.**')) < ls.findIndex((l, i) => i > kh && l.startsWith('**Пишет.**')), 'проба: Читает раньше Пишет');
  assert.equal(c.problems.length, 1, c.problems.join(' | '));
  assert.ok(c.problems[0].includes('порядок не тот'), c.problems[0]);
  assert.ok(c.sections.every((s) => s.text), 'оба раздела на месте');
  const lem = role(r, 'Лем');
  assert.deepEqual(lem.problems, [`лишний раздел №9 (строка ${lineOf(t, 'Лем', '**Зебра.**')})`]);
  assert.equal(lem.sections.length, 14);
  const d = role(r, 'Демон');
  assert.equal(d.problems.length, 2, d.problems.join(' | '));
  assert.ok(d.problems.some((p) => p.includes('частей 6')));
  assert.ok(d.problems.includes(`незнакомый ключ №5 строки полей (строка ${lineOf(t, 'Демон', 'лейбл ')})`), d.problems.join(' | '));
  assert.ok(!JSON.stringify([lem.problems, d.problems]).includes('Зебра') && !JSON.stringify(d.problems).includes('цвет'), 'имена из реестра в проблему не кладутся');
  for (const x of r.roles.filter((y) => !['Голем', 'Клапауций', 'Лем', 'Демон'].includes(y.name))) assert.deepEqual(x.problems, [], x.name);
});

test('п.2 (в): копия 2de0aff — Цереброн proposal, cerebron, check: null; Тарантога turns: null; Клапауций 40; Тихий tikhiy; legend', () => {
  const r = reader(SRC).roles.get();
  const ce = role(r, 'Цереброн');
  assert.equal(ce.status, 'proposal');
  assert.equal(ce.label, 'cerebron');
  assert.equal(ce.fields.status, '**предложение — INFRA-97**', 'текст поля — как в файле');
  assert.equal(ce.fact, null);
  assert.equal(ce.check, null);
  const ta = role(r, 'Тарантога');
  assert.equal(ta.turns, null);
  assert.equal(ta.fields.brake, 'время (`--minutes`, по умолчанию 60)');
  assert.equal(ta.status, 'active');
  assert.equal(role(r, 'Клапауций').turns, 40);
  assert.equal(role(r, 'Ийон Тихий').label, 'tikhiy');
  assert.equal(role(r, 'Иван').fields.label, '`ivan`');
  assert.equal(role(r, 'Терминус').fields.model, 'наследует сессию (под прорабом Sonnet)');
  assert.ok(r.legend.startsWith('**Как читать «держит».** *Механика*'), r.legend);
  assert.ok(r.legend.endsWith('страховка — `git status` дирижёра перед коммитом.'));
  assert.ok(!r.legend.includes('Откуда'), 'абзац кончается одиночным «>»');
  for (const x of r.roles) for (const s of x.sections) assert.equal(s.text, s.text.trim(), `${x.name} · ${s.title}: пустых строк и пробелов на концах нет`);
  assert.ok(!JSON.stringify(r.roles).includes('\n---'), 'строки --- между ролями — не текст');
  assert.equal(role(r, 'Иван').sections.at(-1).text, 'Правила цеха, «Команда»; протокол, «Кто есть кто».');
});

test('п.2: статус не распознан — unknown, проблема; лейбл не по правилу имени — null и проблема; legend нет — null', () => {
  let t = editRole(SRC, 'Лем', 'лейбл ', (l) => l.replace('статус действует', 'статус думает'));
  t = editRole(t, 'Трурль', 'лейбл ', (l) => l.replace('`trurl`', '`Trurl X`'));
  t = t.replace('> **Как читать «держит».**', '> Как читать.');
  const r = reader(t).roles.get();
  assert.equal(role(r, 'Лем').status, 'unknown');
  assert.deepEqual(role(r, 'Лем').problems, ['статус не распознан']);
  assert.equal(role(r, 'Трурль').label, null);
  assert.equal(role(r, 'Трурль').problems.length, 1);
  assert.equal(r.legend, null);
});

test('п.4 сводки: нет «## Сводные таблицы» — summary: [] и проблема файла; раздел после сводки — проблема; две таблицы — первая', () => {
  const a = reader(SRC.replace('## Сводные таблицы', '## Свод')).roles.get();
  assert.equal(a.error, null);
  assert.deepEqual(a.summary, []);
  assert.equal(a.problems.length, 1, a.problems.join(' | '));
  const tail = '\n## Приложение\n\nтекст\n';
  const b = reader(SRC + tail + '\n').roles.get();
  assert.equal(b.roles.length, 11);
  assert.deepEqual(b.problems, [`раздел после сводных таблиц не показан (строка ${SRC.split('\n').length + 1})`]);
  assert.ok(!JSON.stringify(b.summary).includes('Приложение'));
  const c = reader(SRC.replace('### Модели\n', '### Модели\n\n| а | б |\n|---|---|\n| 1 | 2 \\| 3 |\n\n| в |\n|---|\n| 9 |\n')).roles.get();
  const mo = c.summary.find((s) => s.title === 'Модели');
  assert.deepEqual(mo.head, ['а', 'б']);
  assert.deepEqual(mo.rows, [['1', '2 | 3']]);
  assert.ok(mo.text.startsWith('Трурль — выбор Ивана'));
  assert.deepEqual(c.problems, ['в подразделе «Модели» таблиц больше одной']);
});

// ——— п.3 Ошибка после удачи ———
test('п.3: после удачи файл испорчен / исчез — прежние роли, error, failingSince; починен — error и failingSince null, lastOkAt новее', () => {
  const { m, roles } = reader(SRC);
  const ok = roles.get();
  assert.equal(ok.error, null);
  const ok1 = roles.state().lastOkAt;
  // (а) испорчен: форма без «Стоп-точки», новое время изменения
  m.text = SRC.replace(' · **Стоп-точки**', ''); m.mtimeMs = 2000;
  const a = roles.get();
  assert.ok(a.error.includes('форма раздела роли изменилась'));
  assert.deepEqual(a.roles.map((x) => x.name), NAMES, 'прежний разбор, не пустота');
  assert.equal(a.updatedAt, new Date(1000).toISOString(), 'время прежнего удачного разбора');
  assert.match(a.failingSince, /^\d{4}-\d\d-\d\dT/);
  // (б) исчез — тот же прежний разбор, failingSince держится с первого сбоя
  m.text = null;
  const b = roles.get();
  assert.match(b.error, /файла нет/);
  assert.equal(b.roles.length, 11);
  assert.equal(b.failingSince, a.failingSince);
  // (в) починен
  m.text = SRC; m.mtimeMs = 3000;
  const c = roles.get();
  assert.equal(c.error, null);
  assert.equal(c.failingSince, null);
  assert.equal(c.updatedAt, new Date(3000).toISOString());
  assert.ok(roles.state().lastOkAt > ok1, 'lastOkAt новее');
  assert.equal(roles.state().failingSince, null);
});

test('п.3: после перезапуска прежнего нет — сломанный файл даёт roles: [] и error', () => {
  const r = reader(SRC.replace(' · **Стоп-точки**', '')).roles.get();
  assert.deepEqual(r.roles, []);
  assert.ok(r.error);
});

// ——— п.4 Свежесть ———
test('п.4: перечитывание по времени изменения и размеру; ничего не сменилось — файл не читается', () => {
  const { m, roles } = reader(SRC);
  roles.get(); roles.get();
  assert.equal(m.reads, 1, '(в) повторный запрос файл не читает');
  m.mtimeMs = 5000;
  roles.get();
  assert.equal(m.reads, 2, '(а) сменилось время при том же размере — перечитан');
  m.text = SRC.replace('## Иван', '## Иван '); // размер +1, время то же
  roles.get();
  assert.equal(m.reads, 3, '(б) сменился размер при том же времени — перечитан');
  roles.get();
  assert.equal(m.reads, 3);
});

// ——— п.3а Health ———
async function app(roles) {
  const board = { state: () => ({}), hasCode: () => false };
  const registry = { state: () => ({}), get: () => ({ codes: [], sharedRepos: [], vaultRoot: null }) };
  const a = await buildApp({ port: 4317, board, registry, scan, roles });
  return { a, get: async (url) => (await a.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })) };
}

test('п.3а (а): форма испорчена, окно не открывали — /api/health → readers.roles: errors ≥ 1, lastError со строкой, failingSince', async () => {
  const { m, roles } = reader(SRC.replace(' · **Стоп-точки**', ''));
  const { get } = await app(roles);
  const h1 = (await get('/api/health')).json().readers.roles;
  assert.ok(h1.errors >= 1);
  assert.match(h1.lastError, /20/);
  assert.ok(!/Стоп|форма/i.test(h1.lastError), 'код причины, без текстов');
  assert.notEqual(h1.failingSince, null);
  assert.equal(h1.lastOkAt, null);
  assert.equal(h1.roles, 0);
  // сломанный неизменный файл не перечитывается и не копит ошибок на каждый health
  await get('/api/health'); await get('/api/health');
  const h3 = (await get('/api/health')).json().readers.roles;
  assert.equal(h3.errors, h1.errors);
  assert.equal(h3.failingSince, h1.failingSince);
  assert.equal(m.reads, 1);
  // сбой по смене файла — новая ошибка
  m.text = SRC.replace(' · **Источник правды**', ''); m.mtimeMs = 9000;
  assert.notEqual(m.text, SRC, 'проба: файл сменился и сломан');
  assert.equal((await get('/api/health')).json().readers.roles.errors, h1.errors + 1);
});

test('п.3а (б): файла нет — errors ≥ 1, lastError ENOENT, failingSince; ошибки не копятся на каждый вызов', async () => {
  const { m, roles } = reader(SRC);
  m.text = null;
  const { get } = await app(roles);
  const h1 = (await get('/api/health')).json().readers.roles;
  assert.equal(h1.errors, 1);
  assert.equal(h1.lastError, 'ENOENT');
  assert.notEqual(h1.failingSince, null);
  const h2 = (await get('/api/health')).json().readers.roles;
  assert.equal(h2.errors, 1, 'та же причина — не новая ошибка');
  m.stat = 'EACCES';
  assert.equal((await get('/api/health')).json().readers.roles.errors, 2, 'смена причины');
  assert.match((await get('/api/agents')).json().error, /не читается \(EACCES\)/);
});

test('п.3а (в): файл исправен и не менялся — health дважды: файл прочитан раз, lastOkAt не старше, errors: 0', async () => {
  const { m, roles } = reader(SRC);
  const { get } = await app(roles);
  const h1 = (await get('/api/health')).json().readers.roles;
  const h2 = (await get('/api/health')).json().readers.roles;
  assert.equal(m.reads, 1);
  assert.ok(h2.lastOkAt >= h1.lastOkAt && h1.lastOkAt !== null);
  assert.equal(h2.errors, 0);
  assert.equal(h2.lastError, null);
  assert.equal(h2.failingSince, null);
  assert.equal(h2.roles, 11);
  assert.equal(h2.problems, 0);
  assert.equal(h2.defUnread, 0);
  assert.equal(h2.mtimeMs, 1000);
  assert.deepEqual(Object.keys(h2).sort(), ['defUnread', 'errors', 'failingSince', 'lastError', 'lastOkAt', 'mtimeMs', 'problems', 'roles']);
});

// ——— п.5 Сверка ———
test('п.5 (в): копии шести определений 15.10 и реестр 2de0aff — у шести check ok, drifts: 0; без определения — def: false, check: null', () => {
  const r = reader(SRC).roles.get();
  assert.equal(r.drifts, 0);
  const withDef = r.roles.filter((x) => x.fact?.def === true);
  assert.deepEqual(withDef.map((x) => x.label).sort(), Object.keys(FACT).sort());
  for (const x of withDef) {
    assert.deepEqual(x.check, { brake: 'ok', model: 'ok' }, x.name);
    assert.deepEqual(x.fact, { def: true, maxTurns: FACT[x.label][0], model: FACT[x.label][1] });
    assert.deepEqual(x.drift, []);
  }
  for (const n of ['Иван', 'Лем', 'Трурль', 'Тарантога']) {
    const x = role(r, n);
    assert.deepEqual(x.fact, { def: false }, n);
    assert.equal(x.check, null, n);
    assert.deepEqual(x.drift, [], n);
  }
});

test('п.5 (а): maxTurns: 60 при «тормоз 40 ходов» — check.brake drift, запись в drift[], drifts: 1', () => {
  const r = reader(SRC, { over: { clap: [60, 'inherit'] } }).roles.get();
  const c = role(r, 'Клапауций');
  assert.deepEqual(c.check, { brake: 'drift', model: 'ok' });
  assert.deepEqual(c.drift, [{ field: 'brake', registry: '40', fact: '60' }]);
  assert.equal(r.drifts, 1);
  // число только с одной стороны — drift; в определении maxTurns нет
  const r2 = reader(SRC, { over: { golem: [null, 'opus'] } }).roles.get();
  assert.deepEqual(role(r2, 'Голем').check, { brake: 'drift', model: 'ok' });
  assert.deepEqual(role(r2, 'Голем').drift, [{ field: 'brake', registry: '40', fact: 'maxTurns нет' }]);
  // чисел нет с обеих сторон — unchecked
  const t = editRole(SRC, 'Демон', 'лейбл ', (l) => l.replace('тормоз 60 ходов', 'тормоз нет'));
  const r3 = reader(t, { over: { demon: [null, 'sonnet'] } }).roles.get();
  assert.deepEqual(role(r3, 'Демон').check, { brake: 'unchecked', model: 'ok' });
  assert.equal(r3.drifts, 0);
});

test('п.5 (б): model: opus при «модель Sonnet» — check.model drift; model нет в определении — unchecked, не расхождение', () => {
  const r = reader(SRC, { over: { demon: [60, 'opus'] } }).roles.get();
  const d = role(r, 'Демон');
  assert.deepEqual(d.check, { brake: 'ok', model: 'drift' });
  assert.deepEqual(d.drift, [{ field: 'model', registry: 'Sonnet', fact: 'opus' }]);
  assert.equal(r.drifts, 1);
  const r2 = reader(SRC, { over: { tikhiy: [25, null] } }).roles.get();
  assert.deepEqual(role(r2, 'Ийон Тихий').check, { brake: 'ok', model: 'unchecked' });
  assert.deepEqual(role(r2, 'Ийон Тихий').drift, []);
  assert.equal(r2.drifts, 0);
  // первое слово реестра не из списка — unchecked
  const t = editRole(SRC, 'Голем', 'лейбл ', (l) => l.replace('модель Opus', 'модель Опус'));
  assert.equal(role(reader(t).roles.get(), 'Голем').check.model, 'unchecked');
});

// ——— п.7 (роль): определение не читается ———
test('п.7 (б): ошибка stat определения без прежнего — fact def: null, check: null, readers.roles.defUnread: 1', async () => {
  const dir = defsDir();
  const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const defs = createAgentDefs({ dir, fs: { statSync: (p) => { if (p.endsWith('golem.md')) throw err; return fs.statSync(p); }, readFileSync: fs.readFileSync } });
  const m = memFs(SRC);
  const roles = createRoles({ file: () => P, defs: defs.read, fs: m.fs });
  const r = roles.get();
  assert.deepEqual(role(r, 'Голем').fact, { def: null });
  assert.equal(role(r, 'Голем').check, null);
  assert.deepEqual(role(r, 'Голем').drift, []);
  assert.deepEqual(role(r, 'Демон').check, { brake: 'ok', model: 'ok' });
  const { get } = await app(roles);
  assert.equal((await get('/api/health')).json().readers.roles.defUnread, 1);
});

// ——— п.6 Маска ———
const TOKEN = '123456789:' + 'Ab1_-'.repeat(7);
test('п.6 (а, б): секрет вида токена бота в разделе роли и в ячейке сводки — замаскирован в /api/agents', async () => {
  let t = editRole(SRC, 'Голем', '**Читает.**', (l) => `${l} Ключ ${TOKEN} для пробы.`);
  t = t.replace('| Голем | ~25 | 40 | ~40 |', `| Голем | ~25 | 40 | ${TOKEN} |`);
  const { roles } = reader(t);
  assert.ok(JSON.stringify(roles.get()).includes(TOKEN), 'проба: в разборе секрет есть');
  const { get } = await app(roles);
  const res = await get('/api/agents');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(!res.body.includes(TOKEN));
  assert.match(role(body, 'Голем').sections.find((s) => s.title === 'Читает').text, /\[скрыто: [^\]]+\] для пробы\.$/);
  const cell = body.summary.find((s) => s.title === 'Ориентир и тормоз').rows.find((x) => x[0] === 'Голем')[3];
  assert.match(cell, /^\[скрыто: [^\]]+\]$/);
});

test('п.6 (в): копия 2de0aff — ответ /api/agents совпадает с разбором без маски, замен 0', async () => {
  const { roles } = reader(SRC, { clock: () => 1_700_000_000_000 });
  const plain = JSON.parse(JSON.stringify(roles.get()));
  const { get } = await app(roles);
  const res = await get('/api/agents');
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('[скрыто'), 'замен 0');
  assert.deepEqual(res.json(), plain);
});

test('Р3: NO_ROLES без читателя — /api/agents 200 с error и пустым списком, readers.roles есть', async () => {
  const board = { state: () => ({}), hasCode: () => false };
  const registry = { state: () => ({}), get: () => ({ codes: [], sharedRepos: [], vaultRoot: null }) };
  const a = await buildApp({ port: 4317, board, registry, scan });
  const res = await a.inject({ method: 'GET', url: '/api/agents', headers: { host: '127.0.0.1:4317' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().roles, []);
  assert.ok(res.json().error);
  const h = (await a.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4317' } })).json();
  assert.equal(h.readers.roles.roles, 0);
});

// ——— дозапрос 1 (ревью Голема, Важно 1): исключение разборщика не ParseError не роняет /api/health в 500 ———
test('Важно 1: разборщик падает не ParseError (readFileSync отдал не строку) — health 200, errors ≥ 1, lastError PARSE_BUG; agents 200 с error', async () => {
  const { m, roles } = reader(SRC);
  assert.equal(roles.get().error, null, 'проба: сначала удачный разбор');
  // не строка, которую String() не превращает в текст: TypeError внутри разбора, не ParseError
  const bad = Object.create(null);
  const goodRead = m.fs.readFileSync;
  m.fs.readFileSync = () => { m.reads++; return bad; };
  m.mtimeMs = 7000;
  const { get } = await app(roles);
  const res = await get('/api/health');
  assert.equal(res.statusCode, 200);
  const h = res.json().readers.roles;
  assert.ok(h.errors >= 1);
  assert.equal(h.lastError, 'PARSE_BUG');
  assert.notEqual(h.failingSince, null);
  assert.equal(h.roles, 11, 'прежний разбор держится');
  const a = await get('/api/agents');
  assert.equal(a.statusCode, 200);
  assert.match(a.json().error, /PARSE_BUG/);
  assert.equal(a.json().roles.length, 11);
  // сбой кэшируется по файлу, как ошибка разбора: неизменный файл не перечитывается, ошибки не копятся
  const before = m.reads;
  await get('/api/health');
  assert.equal(m.reads, before);
  assert.equal((await get('/api/health')).json().readers.roles.errors, h.errors);
  // файл исправили (новое время изменения) — ошибка снимается (повторное ревью Голема, Мелочь 3)
  m.fs.readFileSync = goodRead;
  m.mtimeMs = 8000;
  const fixed = (await get('/api/health')).json().readers.roles;
  assert.equal(fixed.failingSince, null);
  assert.equal(roles.get().error, null);
  // без прежнего разбора — то же, roles: []
  const r2 = reader(SRC);
  r2.m.fs.readFileSync = () => bad;
  const g2 = await app(r2.roles);
  const h2 = await g2.get('/api/health');
  assert.equal(h2.statusCode, 200);
  assert.equal(h2.json().readers.roles.lastError, 'PARSE_BUG');
  assert.deepEqual((await g2.get('/api/agents')).json().roles, []);
});

test('Мелочь 1 (повторное ревью): путь к Vault бросает (paths.vault не строкой) — health 200, lastError NO_VAULT; agents 200 с error', async () => {
  const roles = createRoles({ file: () => { throw new TypeError('The "path" argument must be of type string'); }, defs: () => null });
  const { get } = await app(roles);
  const res = await get('/api/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().readers.roles.lastError, 'NO_VAULT');
  const a = await get('/api/agents');
  assert.equal(a.statusCode, 200);
  assert.match(a.json().error, /не строкой/, 'текст — путь задан, но не строкой (ревью Голема, Мелочь A)');
});

test('CRLF (EXT-118): реестр с концами строк CRLF разбирается так же, как с LF — роли, разделы, проблемы, сводка', () => {
  const crlf = SRC.replace(/\n/g, '\r\n');
  const a = reader(SRC).roles.get();
  const b = reader(crlf).roles.get();
  assert.equal(b.error, null);
  assert.equal(b.roles.length, 11);
  assert.deepEqual(b.roles.map((r) => [r.name, r.sections.length, r.problems.length]), a.roles.map((r) => [r.name, r.sections.length, r.problems.length]));
  // целиком — заголовки и тексты разделов, поля, сводка: «\r» внутри текста не остаётся (ревью Голема, Мелочь)
  assert.deepEqual(b.roles, a.roles);
  assert.deepEqual(b.summary, a.summary);
  assert.ok(!JSON.stringify(b).includes('\\r'), 'нигде в разборе нет \\r');
});
