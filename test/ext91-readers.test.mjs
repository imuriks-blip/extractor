// EXT-91, такт 2: читатели «последней записи» в режиме live (спека пульта §3.3 пп.8–10, 12; спека витрины §2.4, §2.5).
// Записи — настоящим board.mjs на ВРЕМЕННОЙ доске (копия формата в os.tmpdir, свой git init, инструмент доски скопирован в её tools/);
// C:\projects\unorbis-board не пишется. У каждой проверки рядом исправный случай (новая запись треда без маркера снимает (б) и т. п.).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createLive } from '../lib/pult/live.mjs';
import { createBoardRunner, classify } from '../lib/pult/board-run.mjs';
import { buildWaiting } from '../lib/waiting.mjs';
import { buildProjectBoard } from '../lib/project-board.mjs';
import { findContract } from '../lib/trace.mjs';
import { parseBoardWrite } from '../lib/journal-parse.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, gitCommitAll, git } from './helpers.mjs';

const lib = (f) => import(new URL(`file:///${BOARD_LIB}/${f}`).href);
const { parseCard } = await lib('header.mjs');
const { parseLog, latest } = await lib('log.mjs');

const CONTRACT = ['- **Что изменилось в системе:** x', '- **Откат:** git revert', '- **Остаточный риск:** нет', '- **Доставка:** extractor abcdef1', '- **Знание:** нет'].join('\n');

async function setup() {
  const dir = tmpDir('ext91r-board-');
  makeBoard(dir, { codes: ['EXT'], cards: [
    { id: 'EXT-9', status: 'in-progress', title: 'Девять' }, { id: 'EXT-5', status: 'ready', title: 'Пять' }, { id: 'EXT-6', status: 'in-progress', title: 'Шесть' },
  ] });
  fs.writeFileSync(path.join(dir, 'board.config.json'), JSON.stringify({ mode: 'live', push: false, tz: 'Europe/Riga' }) + '\n');
  fs.cpSync(path.join(BOARD_LIB, '..'), path.join(dir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) });
  gitInitCommit(dir);
  git(dir, 'config', 'user.name', 'Тест');
  git(dir, 'config', 'user.email', 't@test.local');
  const board = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await board.init();
  // настоящий board.mjs: падение — исключение теста (исходы отказа здесь не проверяются)
  const bd = (as, ...a) => execFileSync(process.execPath, [path.join(dir, 'tools', 'board.mjs'), '--as', as, '--root', dir, ...a], { encoding: 'utf8', windowsHide: true });
  const entries = (id) => parseLog(fs.readFileSync(path.join(dir, 'EXT', `${id}.log.md`), 'utf8'));
  return { dir, board, bd, entries };
}

const asked = (s, card) => s.bd('trurl:EXT', 'log', card, 'коммент', '--body', 'Ветка готова. Сливай?');
const yesIds = async (s) => { await s.board.refresh(); return buildWaiting({ board: s.board }).yes.map((r) => r.id); };

test('(б): тред спросил «сливай?», потом status review — вопрос на месте, ключ и «с какого времени» прежние; исправный случай: новая запись треда без маркера снимает', async () => {
  const s = await setup();
  s.bd('trurl:EXT', 'log', 'EXT-9', 'закрытие', '--body', CONTRACT);
  asked(s, 'EXT-9');
  const before = (await s.board.refresh(), buildWaiting({ board: s.board }).yes.find((r) => r.id === 'EXT-9'));
  assert.equal(before?.mark, 'сливай');
  s.bd('trurl:EXT', 'status', 'EXT-9', 'review', '--why', 'готово');
  assert.deepEqual(s.entries('EXT-9').map((e) => e.kind).slice(-3), ['закрытие', 'коммент', 'статус']);
  await s.board.refresh();
  const after = buildWaiting({ board: s.board }).yes.find((r) => r.id === 'EXT-9');
  assert.ok(after, 'после status review вопрос остался в (б)');
  assert.equal(after.mark, 'сливай');
  assert.equal(after.key, before.key, 'ключ строки — заголовок вопроса, не записи статус');
  assert.equal(after.since, before.since);
  // карточка в Review, но (б) важнее (в): в (в) её нет
  assert.deepEqual(buildWaiting({ board: s.board }).review.map((r) => r.id), []);
  // исправный случай: новая запись треда без маркера — снимает
  s.bd('trurl:EXT', 'log', 'EXT-9', 'коммент', '--body', 'Принял слово, сливаю сам.');
  assert.deepEqual(await yesIds(s), [], 'новая запись без маркера снимает (б)');
});

test('(б): take после вопроса записей «владелец» и «статус» не считает новыми — вопрос на месте; исправный случай: новая запись треда после take снимает', async () => {
  const s = await setup();
  asked(s, 'EXT-5');
  assert.deepEqual(await yesIds(s), ['EXT-5']);
  s.bd('trurl:EXT', 'take', 'EXT-5');
  assert.deepEqual(s.entries('EXT-5').map((e) => e.kind), ['▶', 'коммент', 'владелец', 'статус']);
  assert.deepEqual(await yesIds(s), ['EXT-5'], 'take вопрос не снял');
  s.bd('trurl:EXT', 'log', 'EXT-5', 'коммент', '--body', 'Взял в работу, вернусь с результатом.');
  assert.deepEqual(await yesIds(s), []);
});

test('читатель: askMark, bodyHead, lastLog и ключ — по последней записи без служебных; давность (anyAt) — по всем записям', async () => {
  const s = await setup();
  s.bd('trurl:EXT', 'log', 'EXT-9', 'закрытие', '--body', CONTRACT);
  asked(s, 'EXT-9');
  await s.board.refresh();
  const q = s.board.card('EXT-9').last;
  s.bd('trurl:EXT', 'status', 'EXT-9', 'review', '--why', 'готово');
  s.bd('trurl:EXT', 'take', 'EXT-9').toString();
  await s.board.refresh();
  const l = s.board.card('EXT-9').last;
  for (const k of ['at', 'key', 'mark', 'askMark', 'line', 'bodyHead', 'author']) assert.equal(l[k], q[k], k);
  assert.equal(l.line, 'Ветка готова. Сливай?');
  assert.equal(l.askMark, 'сливай');
  assert.equal(l.author, 'trurl:EXT');
  const all = s.entries('EXT-9');
  assert.equal(all.at(-1).kind, 'владелец');
  assert.equal(l.anyAt, new Date(all.at(-1).ms).toISOString(), 'давность — время самой последней записи, служебной тоже');
  assert.equal(l.at, new Date(all.find((e) => e.kind === 'коммент').ms).toISOString());
  // доска проекта: строка «последняя запись» — вопрос, не «in-progress → review»
  const pb = buildProjectBoard(s.board.cardsList(), 'EXT');
  assert.deepEqual(pb.review.find((c) => c.id === 'EXT-9').lastLog, { text: 'Ветка готова. Сливай?', author: 'trurl:EXT' });
  // исправный случай: запись не служебного вида становится последней
  s.bd('trurl:EXT', 'log', 'EXT-9', 'коммент', '--body', 'Новая мысль');
  await s.board.refresh();
  assert.equal(s.board.card('EXT-9').last.line, 'Новая мысль');
});

test('карточка, у которой только служебные записи: last без текста, давность из них; (б) её не берёт', async () => {
  const s = await setup();
  // журнал, где есть только записи board status/take (засеянная «▶» зеркала убрана)
  fs.writeFileSync(path.join(s.dir, 'EXT', 'EXT-6.log.md'), '### 2026-10-05 10:00 +03:00 · trurl:EXT · владелец\n\n— → trurl:EXT\n\n### 2026-10-05 10:01 +03:00 · trurl:EXT · статус\n\nready → in-progress\n');
  gitCommitAll(s.dir, 'служебные');
  await s.board.refresh();
  const l = s.board.card('EXT-6').last;
  assert.equal(l.at, null);
  assert.equal(l.line, null);
  assert.ok(Number.isFinite(Date.parse(l.anyAt)));
  assert.deepEqual(buildWaiting({ board: s.board }).yes, []);
  assert.equal(buildProjectBoard(s.board.cardsList(), 'EXT').inProgress.find((c) => c.id === 'EXT-6').lastLog, null);
});

test('давность карточки учитывает ВСЕ записи: служебная запись позже вопроса двигает «давность» в (в) и на доске проекта; (б) — нет', async () => {
  const s = await setup();
  s.bd('trurl:EXT', 'log', 'EXT-6', 'закрытие', '--body', CONTRACT);
  s.bd('trurl:EXT', 'status', 'EXT-6', 'review', '--why', 'готово');
  // время записей руками: вопрос 2026-10-01, статус 2026-10-05 (шапка старше обоих) — разницы между «любой» и «не служебной» в одну минуту не видно
  const f = path.join(s.dir, 'EXT', 'EXT-6.log.md');
  fs.writeFileSync(f, '### 2026-10-01 10:00 +03:00 · trurl:EXT · коммент\n\nГотово, смотри.\n\n### 2026-10-05 10:00 +03:00 · trurl:EXT · статус\n\nin-progress → review\n');
  const h = path.join(s.dir, 'EXT', 'EXT-6.md');
  fs.writeFileSync(h, fs.readFileSync(h, 'utf8').replace(/updated: .*/, 'updated: 2026-09-01T10:00+03:00'));
  gitCommitAll(s.dir, 'время');
  await s.board.refresh();
  const w = buildWaiting({ board: s.board });
  assert.equal(w.review.find((r) => r.id === 'EXT-6').at, '2026-10-05T07:00:00.000Z', 'давность — по статусу 05.10, не по комменту 01.10');
  assert.equal(buildProjectBoard(s.board.cardsList(), 'EXT').review.find((c) => c.id === 'EXT-6').at, '2026-10-05T07:00:00.000Z');
  assert.equal(s.board.card('EXT-6').last.at, '2026-10-01T07:00:00.000Z', 'вопрос — по последней несл. записи');
  // карточка с отметкой Б: «с какого времени» — от max(updated, ВСЕ записи)
  fs.writeFileSync(h, fs.readFileSync(h, 'utf8').replace('mark_b: false', 'mark_b: true'));
  gitCommitAll(s.dir, 'Б');
  await s.board.refresh();
  const b = buildWaiting({ board: s.board, now: Date.parse('2026-10-08T00:00:00Z') }).yes.find((r) => r.id === 'EXT-6');
  assert.ok(b, 'карточка с Б есть в (б)');
  assert.equal(b.since, '2026-10-05T07:00:00.000Z');
});

test('след закрытия: «после контракта — ещё N» не считает status review (и take); исправный случай — настоящая запись считается; newTakt по всем записям', async () => {
  const s = await setup();
  s.bd('trurl:EXT', 'log', 'EXT-9', 'закрытие', '--body', CONTRACT);
  s.bd('trurl:EXT', 'status', 'EXT-9', 'review', '--why', 'готово');
  let k = findContract(s.entries('EXT-9'));
  assert.equal(k.later, 0, 'status review после закрытия — не «ещё 1»');
  assert.equal(k.newTakt, false);
  s.bd('trurl:EXT', 'log', 'EXT-9', 'коммент', '--body', 'Дописал замечание');
  k = findContract(s.entries('EXT-9'));
  assert.equal(k.later, 1, 'настоящая запись считается, служебная — нет');
  s.bd('trurl:EXT', 'log', 'EXT-9', 'коммент', '--body', '▶ выдан: terminus · новый такт');
  k = findContract(s.entries('EXT-9'));
  assert.equal(k.later, 2);
  assert.equal(k.newTakt, true, 'проверка newTakt не тронута');
});

// ---------------- свежая сверка (п.8–9): live.fresher ----------------

test('свежая сверка: status review и take после q новым вопросом не бывают; новая запись треда — бывает; запись пульта — нет', async () => {
  const s = await setup();
  const live = createLive({ board: s.board, runner: {}, tmpDir: tmpDir('ext91r-tmp-') });
  s.bd('trurl:EXT', 'log', 'EXT-9', 'закрытие', '--body', CONTRACT);
  asked(s, 'EXT-9');
  await s.board.refresh();
  const last = s.board.card('EXT-9').last;
  const q = { at: last.at, head: [...last.bodyHead].slice(0, 60).join('') };
  assert.equal(live.fresher(q, live.fresh('EXT-9')), null, 'новых записей нет');
  s.bd('trurl:EXT', 'status', 'EXT-9', 'review', '--why', 'готово');
  s.bd('trurl:EXT', 'take', 'EXT-9');
  const f = live.fresh('EXT-9');
  assert.equal(f.entries.at(-1).kind, 'владелец');
  assert.equal(live.fresher(q, f), null, 'служебные записи вопросом не считаются');
  s.bd('trurl:EXT', 'log', 'EXT-9', 'коммент', '--body', 'Ещё вопрос: а тесты?');
  const n = live.fresher(q, live.fresh('EXT-9'));
  assert.ok(Number.isFinite(n), 'новая запись треда — новая');
  // запись пульта (ивановская) после q — не вопрос
  const t = await setup();
  const live2 = createLive({ board: t.board, runner: {}, tmpDir: tmpDir('ext91r-tmp-') });
  asked(t, 'EXT-9');
  await t.board.refresh();
  const l2 = t.board.card('EXT-9').last;
  const q2 = { at: l2.at, head: [...l2.bodyHead].slice(0, 60).join('') };
  t.bd('ivan', 'log', 'EXT-9', 'решение', '--body', '**Слово Ивана · кнопка витрины · W-1**: «да»\n\nКто решил: слово Ивана · кнопка витрины · W-1');
  assert.equal(live2.fresher(q2, live2.fresh('EXT-9')), null);
});

// ---------------- слежение за записью субагентов (п.12) ----------------

const RULES = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).boardWriteTools;
const bash = (command, name = 'Bash') => ({ type: 'tool_use', name, input: { command } });
const BJS = 'C:/projects/unorbis-board/tools/board.mjs';

test('boardWriteTools: вызов node … board.mjs [--as v] [--root p] <подкоманда> <карточка> [--body …] разбирается; --as/--root пропускаются; карточка — первый позиционный', () => {
  const p = (c, n) => parseBoardWrite(bash(c, n), RULES);
  let r = p(`node ${BJS} --as trurl:EXT --root C:/x/board log EXT-9 коммент --body "▶ выдан: terminus"`);
  assert.deepEqual([r.refs, r.firstLine, r.tool], [['EXT-9'], '▶ выдан: terminus', 'Bash:board.mjs log']);
  r = p(`node ${BJS} --as trurl:EXT status EXT-9 review --why "готово"`);
  assert.deepEqual([r.refs, r.firstLine], [['EXT-9'], ''], 'без тела — пустая первая строка');
  r = p(`node "${BJS}" take EXT-5`, 'PowerShell');
  assert.deepEqual(r.refs, ['EXT-5']);
  r = p(`& "C:\\Program Files\\nodejs\\node.exe" C:\\projects\\unorbis-board\\tools\\board.mjs --as trurl:EXT --root 'C:\\p q' set EXT-9 --labels a`, 'PowerShell');
  assert.deepEqual(r.refs, ['EXT-9']);
  r = p(`node ${BJS} --as trurl:EXT resolve EXT-9 --why x`);
  assert.deepEqual(r.refs, ['EXT-9']);
  r = p(`node ${BJS} --as lem inbox merge file.md EXT-9`);
  assert.deepEqual([r.refs, r.tool], [['EXT-9'], 'Bash:board.mjs inbox merge']);
  // тело неизвестно: --body-file, --body -, переменная
  assert.equal(p(`node ${BJS} log EXT-9 коммент --body-file C:/t/f.md`).firstLine, null);
  assert.equal(p(`node ${BJS} log EXT-9 коммент --body -`).firstLine, null);
  assert.equal(p(`node ${BJS} log EXT-9 коммент --body "$t"`).firstLine, null);
  assert.equal(p(`node ${BJS} log EXT-9 коммент --body "$(Get-Content f.md -Raw)"`).firstLine, null);
  assert.equal(p(`node ${BJS} log EXT-9 коммент --body "⏸ нужен ответ\nвторая"`).firstLine, '⏸ нужен ответ');
  // флаг со значением перед карточкой не принимается за карточку
  assert.deepEqual(p(`node ${BJS} log --body "x EXT-1" EXT-9 коммент`).refs, ['EXT-9']);
});

test('boardWriteTools, отрицательный контроль: упоминание «board.mjs log» в тексте — не запись; чтение, чужой интерпретатор, нет карточки — не запись', () => {
  const p = (c, n) => parseBoardWrite(bash(c, n), RULES);
  // упоминание без интерпретатора и внутри строки
  assert.equal(p(`git commit -m "см. board.mjs log EXT-5 — запись"`), null);
  assert.equal(p(`git commit -m "fix: node ${BJS} log EXT-5 x"`), null, 'в кавычках сообщения коммита');
  assert.equal(p(`echo 'node board.mjs log EXT-5 коммент'`), null);
  assert.equal(p(`python ${BJS} log EXT-5 коммент`), null, 'иной интерпретатор');
  assert.equal(p(`cat board.mjs log EXT-5`), null);
  assert.equal(p(`node ${BJS} show EXT-5`), null, 'чтение — не запись');
  assert.equal(p(`node ${BJS} log`), null, 'нет карточки');
  assert.equal(p(`node ${BJS} new EXT "Заголовок"`), null, 'new: номера ещё нет');
  assert.equal(p(`node ${BJS} logs EXT-5`), null, 'подкоманда — целое слово');
  assert.equal(parseBoardWrite({ type: 'tool_use', name: 'Write', input: { command: `node ${BJS} log EXT-5 коммент` } }, RULES), null, 'не тот инструмент');
  // упоминание внутри тела настоящего вызова: запись одна, карточка — первая позиционная
  const r = p(`node ${BJS} --as trurl:EXT log EXT-9 коммент --body "пример: node ${BJS} log EXT-5 коммент --body x"`);
  assert.deepEqual(r.refs, ['EXT-9']);
  // исправный случай рядом: тот же вызов без кавычек вокруг — запись
  assert.deepEqual(p(`node ${BJS} log EXT-5 коммент --body x`).refs, ['EXT-5']);
  // прежние правила (python plane.py) не задеты
  assert.deepEqual(parseBoardWrite(bash('python C:/x/plane.py comment "▶ выдан" EXT-3'), RULES).refs, ['EXT-3']);
});

// ---------------- путь к node (п.5) ----------------

test('createBoardRunner: node по умолчанию — process.execPath; paths.node (аргумент node) — замена', async () => {
  const seen = [];
  const spawn = (cmd) => { seen.push(cmd); const c = new EventEmitter(); c.pid = 1; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; };
  await createBoardRunner({ root: 'C:/b', spawn }).run(['read']);
  await createBoardRunner({ root: 'C:/b', spawn, node: 'D:/custom/node.exe' }).run(['read']);
  assert.deepEqual(seen, [process.execPath, 'D:/custom/node.exe']);
});

// ---------------- таймаут board: close от taskkill не перебивает исход (EXT-112) ----------------

test('createBoardRunner: на таймауте close от taskkill (код 1) приходит раньше конца снятия → исход {code: null, timedOut: true}, «таймаут»; без таймаута код 1 — код 1', async () => {
  const fake = () => { const c = new EventEmitter(); c.pid = 777; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; return c; };
  let child = null;
  // снятие деревом: процесс умирает с кодом 1 (так кончает taskkill /F) до того, как taskkill вернулся
  const kill = async () => { child.emit('exit', 1); child.emit('close', 1); await new Promise((r) => setTimeout(r, 50)); };
  const r = await createBoardRunner({ root: 'C:/b', spawn: () => (child = fake()), kill, timeoutMs: 100 }).run(['log']);
  assert.deepEqual([r.code, r.timedOut], [null, true]);
  assert.deepEqual([classify(r).kind, classify(r).line], ['unclear', 'таймаут']);
  // исправный случай: свой выход кодом 1 до таймаута — код 1 как есть, не таймаут
  const own = () => { const c = fake(); setTimeout(() => { c.emit('exit', 1); c.emit('close', 1); }, 20); return c; };
  const r2 = await createBoardRunner({ root: 'C:/b', spawn: own, kill, timeoutMs: 5000 }).run(['log']);
  assert.deepEqual([r2.code, r2.timedOut], [1, undefined]);
  assert.equal(classify(r2).line, 'код 1 без строки исхода');
});
