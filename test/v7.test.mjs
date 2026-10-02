// В7 (EXT-32): серверные правки под окно проекта и панель карточки — спека 1.6, 2.5, 2.6, 2.7 «Тексты в строках», 3.2.
// Доска — временная копия в живой форме (настоящий читатель доски, parseLog доски); ожидаемое — из данных этого файла.
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

// жирный на границе 120: в сырой строке «**» открывается на 112-м знаке, закрывается за 120-м
const LONG = 'а'.repeat(110) + ' **жирный текст тут** хвост';

async function setup() {
  const dir = makeBoard(tmpDir('v7-'), { codes: ['EXT', 'CAR', 'RADAR'], cards: [
    { id: 'EXT-1', title: 'Длинная с жирным', status: 'in-progress' },
    { id: 'EXT-2', title: 'Короткая с жирным', status: 'review' },
    { id: 'EXT-3', title: 'Простая', status: 'ready' },
    { id: 'CAR-1', title: 'Машина', status: 'ready' },
  ] });
  // заглушки имени, как в живом projects.md доски на 02.10
  fs.writeFileSync(path.join(dir, 'projects.md'), [
    '# Проекты и лейблы доски', '',
    '| код | имя | статус |', '|---|---|---|',
    '| EXT | — (Экстрактор; в реестре пока нет) | active |',
    '| CAR | orbis-car | active |',
    '| RADAR | — (имени в реестре нет, сверит дирижёр) | active |',
    '',
  ].join('\n'));
  const log = (body) => `### 2026-10-01 10:00 +03:00 · trurl:EXT · коммент\n\n${body}\n\nвторая строка\n\n`;
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-1.log.md'), log(LONG));
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-2.log.md'), log('**✅ EXT-17 → Review** — `npm test` зелёный'));
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-3.log.md'), log('Спека утверждена.'));
  gitInitCommit(dir);
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  const reg = path.join(tmpDir('v7reg-'), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }));
  const app = await buildApp({ port: 4317, board, registry: createRegistryReader(reg), scan: () => [] });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  return { get };
}
const S = await setup();

test('доска проекта: последняя запись — разметка снята до обрезки, на границе 120 нет непарных «**», на конце «…»', async () => {
  const b = (await S.get('/api/project/EXT')).board;
  const t = b.inProgress.find((c) => c.id === 'EXT-1').lastLog.text;
  assert.equal(t, 'а'.repeat(110) + ' жирный т…');
  assert.ok(!t.includes('*'));
});

test('доска проекта: короткая запись с жирным и `кодом` — без разметки, без «…»; простая — как есть', async () => {
  const b = (await S.get('/api/project/EXT')).board;
  assert.equal(b.review.find((c) => c.id === 'EXT-2').lastLog.text, '✅ EXT-17 → Review — npm test зелёный');
  assert.equal(b.ready.find((c) => c.id === 'EXT-3').lastLog.text, 'Спека утверждена.');
});

test('имя проекта: заглушка «— (…)» из projects.md — null, настоящее имя — как есть', async () => {
  assert.equal((await S.get('/api/project/EXT')).name, null);
  assert.equal((await S.get('/api/project/RADAR')).name, null);
  assert.equal((await S.get('/api/project/CAR')).name, 'orbis-car');
});

test('имя проекта: одно правило на все ручки — в /api/ceh у заглушки тоже null', async () => {
  const p = (await S.get('/api/ceh')).projects;
  assert.equal(p.find((x) => x.code === 'EXT').name, null);
  assert.equal(p.find((x) => x.code === 'CAR').name, 'orbis-car');
});

test('карточка: поле project — код проекта из папки карточки', async () => {
  assert.equal((await S.get('/api/card/EXT-2')).project, 'EXT');
  assert.equal((await S.get('/api/card/CAR-1')).project, 'CAR');
});
