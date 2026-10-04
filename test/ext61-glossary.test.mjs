// EXT-61: словарь на витрине (спека витрины §2.10) — разбор unorbis/Словарь.md и GET /api/glossary.
// Тексты выдуманные; ожидания — из текста, положенного в тест, не из кода разбора.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { parseGlossary, createGlossary } from '../lib/glossary.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

// живой формат: шапка YAML (с «## » и «|» внутри — не раздел и не таблица), заголовок #, абзацы, разделы ##,
// таблицы с шапкой и разделителем, `\|` в ячейке, обратные кавычки, CRLF в одном разделе, строка-таблица вне раздела
const LIVE = [
  '---',
  'type: reference',
  'title: "## не раздел"',
  'note: | a | b | c | d |',
  '---',
  '',
  '| до | раздела | не | берётся |',
  '|---|---|---|---|',
  '| x | y | z | w |',
  '',
  '# Словарь цеха',
  '',
  'Колонки: **термин** · по-русски.',
  '',
  '## Код и git',
  '',
  '| Термин | По-русски | Что это у нас | Пример |',
  '|---|---|---|---|',
  '| branch | ветка | линия правок | ветка `ext-50-x` |',
  '|  commit  |   коммит   | снимок a \\| b | «коммит 2e2f446» |',
  '',
  'Абзац между таблицами | с палкой.',
  '',
  '## Работа цеха',
  '',
  '| Термин | По-русски | Что это у нас | Пример |',
  '| :--- | :---: | --- | ---: |',
  '| done | готово | карточка закрыта | Review → Done |',
].join('\n') + '\r\n## Модели\r\n\r\n| Термин | По-русски | Что | Пример |\r\n|---|---|---|---|\r\n| token | токен | кусочек | «405 тыс.» |\r\n';

test('разбор живого формата: шапка YAML пропущена, разделы ##, шапка таблицы и разделитель пропущены, ячейки обрезаны', () => {
  const s = parseGlossary(LIVE);
  assert.deepEqual(s.map((x) => x.title), ['Код и git', 'Работа цеха', 'Модели']);
  assert.deepEqual(s[0].rows[0], { term: 'branch', ru: 'ветка', meaning: 'линия правок', example: 'ветка `ext-50-x`' });
  assert.deepEqual(s[1].rows, [{ term: 'done', ru: 'готово', meaning: 'карточка закрыта', example: 'Review → Done' }]);
  assert.deepEqual(s[2].rows, [{ term: 'token', ru: 'токен', meaning: 'кусочек', example: '«405 тыс.»' }]);
});

test('разбор: `\\|` внутри ячейки — не разделитель (в ответе — «|»), обратные кавычки остаются как есть', () => {
  const s = parseGlossary(LIVE);
  assert.deepEqual(s[0].rows[1], { term: 'commit', ru: 'коммит', meaning: 'снимок a | b', example: '«коммит 2e2f446»' });
  assert.equal(s[0].rows.length, 2);
  assert.ok(s[0].rows[0].example.includes('`ext-50-x`'));
});

const write = (file, text, mtimeSec) => { fs.writeFileSync(file, text); fs.utimesSync(file, mtimeSec, mtimeSec); };
const one = (term) => `## Раздел\n\n| Термин | По-русски | Что | Пример |\n|---|---|---|---|\n| ${term} | р | ч | п |\n`;

test('файл поменялся (время изменения) — читатель отдаёт новое; updatedAt — время изменения файла', () => {
  const file = path.join(tmpDir('g61-'), 'Словарь.md');
  write(file, one('alpha'), 1_790_000_000);
  const g = createGlossary({ file: () => file });
  const a = g.get();
  assert.equal(a.error, null);
  assert.equal(a.sections[0].rows[0].term, 'alpha');
  assert.equal(a.updatedAt, new Date(1_790_000_000_000).toISOString());
  write(file, one('beta'), 1_790_000_060);
  const b = g.get();
  assert.equal(b.sections[0].rows[0].term, 'beta');
  assert.equal(b.updatedAt, new Date(1_790_000_060_000).toISOString());
});

test('неизменённый файл на запрос не перечитывается (кэш по времени изменения)', () => {
  const file = path.join(tmpDir('g61-'), 'Словарь.md');
  write(file, one('alpha'), 1_790_000_000);
  let reads = 0;
  const spy = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } };
  const g = createGlossary({ file: () => file, fs: spy });
  g.get(); g.get(); g.get();
  assert.equal(reads, 1);
  write(file, one('beta'), 1_790_000_060);
  g.get();
  assert.equal(reads, 2);
});

test('файла нет — sections пусто, error словами; пути к Vault нет — тоже; файл без разделов с таблицами — error', () => {
  const dir = tmpDir('g61-');
  const missing = createGlossary({ file: () => path.join(dir, 'нет.md') }).get();
  assert.deepEqual(missing.sections, []);
  assert.equal(missing.updatedAt, null);
  assert.match(missing.error, /нет/);
  const noVault = createGlossary({ file: () => null }).get();
  assert.deepEqual(noVault.sections, []);
  assert.match(noVault.error, /Vault/);
  const flat = path.join(dir, 'плоский.md');
  write(flat, '# Заголовок\n\nтолько текст\n', 1_790_000_000);
  const bad = createGlossary({ file: () => flat }).get();
  assert.deepEqual(bad.sections, []);
  assert.match(bad.error, /раздел/);
  // исправный файл — без ошибки (третий случай)
  write(flat, one('ok'), 1_790_000_100);
  assert.equal(createGlossary({ file: () => flat }).get().error, null);
});

async function boardApp(opts) {
  const dir = makeBoard(tmpDir('board-'), { codes: ['EXT'], cards: [{ id: 'EXT-6', status: 'review', title: 'Спека' }] });
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const regFile = path.join(tmpDir('reg-'), 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(regFile), scan: () => [], ...opts });
  return (url) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } });
}

test('GET /api/glossary: файл есть — разделы и строки; файл пропал — 200, sections [], error', async () => {
  const file = path.join(tmpDir('g61-'), 'Словарь.md');
  write(file, LIVE, 1_790_000_000);
  const get = await boardApp({ glossary: createGlossary({ file: () => file }) });
  const r = await get('/api/glossary');
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.deepEqual(Object.keys(j).sort(), ['error', 'sections', 'updatedAt']);
  assert.deepEqual(j.sections.map((x) => x.rows.length), [2, 1, 1]);
  assert.equal(j.error, null);
  fs.unlinkSync(file); // не rmSync: в Node 24.13 на Windows он молча не удаляет файл с кириллицей в имени
  const r2 = await get('/api/glossary');
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json().sections, []);
  assert.equal(typeof r2.json().error, 'string');
});

test('GET /api/glossary без читателя словаря — 200, sections [], error словами', async () => {
  const get = await boardApp({});
  const r = await get('/api/glossary');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().sections, []);
  assert.equal(typeof r.json().error, 'string');
});
