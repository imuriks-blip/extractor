// EXT-48: проверка следа рядом с «Принять» (спека пульта §1.4а). Временные репозитории и временная доска в живой форме;
// ожидаемое — из того, что положено сюда (хеши коммитов, строки контракта), а не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createTraceChecker, hashesIn, hasLine, findContract, deliveryText } from '../lib/trace.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit, gitCommitAll, git } from './helpers.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

// ---------- репозитории ----------
// Хеш случаен: 7-знаковое начало без буквы a–f (~4 % коммитов) или без цифры хешем по правилу §1.4а не считается — тест
// мигал бы. Коммит, чьё начало не годится, повторяется с другим содержимым (потомок прежнего — родство то же).
const goodHash = (h) => /[0-9]/.test(h.slice(0, 7)) && /[a-f]/.test(h.slice(0, 7));
function commitGood(dir, file, msg) {
  let h;
  let i = 0;
  do { fs.writeFileSync(path.join(dir, file), `${msg} ${i++}`); h = gitCommitAll(dir, msg); } while (!goodHash(h));
  return h;
}
// проект EXT: A — в main и origin/main; B — в main после origin/main (не отправлен); C — только на ветке
const repo = tmpDir('tr-repo-');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
gitInitCommit(repo);
const A = commitGood(repo, 'a.txt', 'A');
git(repo, 'update-ref', 'refs/remotes/origin/main', A);
const B = commitGood(repo, 'b.txt', 'B');
git(repo, 'checkout', '-q', '-b', 'ext-5-side');
const C = commitGood(repo, 'c.txt', 'C');
git(repo, 'checkout', '-q', 'main');
// общий репозиторий: D — отправлен (origin/main в packed-refs, как после clone)
const shared = tmpDir('tr-shared-');
fs.writeFileSync(path.join(shared, 's.txt'), 's');
gitInitCommit(shared);
const D = commitGood(shared, 's.txt', 'D');
git(shared, 'update-ref', 'refs/remotes/origin/main', D);
git(shared, 'pack-refs', '--all');
// Vault — из настройки витрины (paths.vault), не из реестра: E — отправлен
const vault = tmpDir('tr-vault-');
fs.writeFileSync(path.join(vault, 'v.md'), 'v');
gitInitCommit(vault);
const E = commitGood(vault, 'v.md', 'E');
git(vault, 'update-ref', 'refs/remotes/origin/main', E);
// репозиторий без origin/main (только локальный git): F
const local = tmpDir('tr-local-');
fs.writeFileSync(path.join(local, 'l.txt'), 'l');
gitInitCommit(local);
const F = commitGood(local, 'l.txt', 'F');

// основной клон, чей локальный main отстаёт: G закоммичен и отправлен из рабочей копии — есть в origin/main, не в main
const behind = tmpDir('tr-behind-');
fs.writeFileSync(path.join(behind, 'h.txt'), 'h');
gitInitCommit(behind);
git(behind, 'checkout', '-q', '-b', 'car-wt');
const G = commitGood(behind, 'g.txt', 'G');
git(behind, 'update-ref', 'refs/remotes/origin/main', G);
git(behind, 'checkout', '-q', 'main');

// К1: коммит, чьё 7-знаковое начало — одни цифры (как живой 2743963), на ветке ext-k1 — не в main. commit-tree с разными
// сообщениями, пока начало не выйдет цифровым (~4 % коммитов)
const tree = git(repo, 'rev-parse', 'main^{tree}').trim();
const tipMain = git(repo, 'rev-parse', 'main').trim();
function commitTree(msgOf, ok) {
  for (let i = 0; i < 2000; i++) {
    const h = git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', tipMain, '-m', msgOf(i)).trim();
    if (ok(h)) return h;
  }
  throw new Error('не вышел нужный хеш');
}
const N = commitTree((i) => `k1 ${i}`, (h) => /^[0-9]{7}/.test(h));
git(repo, 'update-ref', 'refs/heads/ext-k1', N);
// В3: коммит только в refs/remotes/origin/ext-side — не в main и не в origin/main
const O = commitTree((i) => `origin-only ${i}`, goodHash);
git(repo, 'update-ref', 'refs/remotes/origin/ext-side', O);
// М3: репозиторий без main и master (ветка trunk)
const nomain = tmpDir('tr-nomain-');
git(nomain, 'init', '-q', '-b', 'trunk');
const Q = commitGood(nomain, 'q.txt', 'Q');

const regFile = path.join(tmpDir('tr-reg-'), 'registry.json');
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { repos: [repo, local, behind, nomain] }, CAR: { repos: [] } }, board_shared_repos: { repos: [shared] } }));
const registry = createRegistryReader(regFile);

// ---------- доска ----------
const h7 = (h) => h.slice(0, 7);
const head = (t) => `### 2026-10-04 ${t} +03:00 · plane · коммент`;
// контракт в форме зеркала (журналы EXT-56, INFRA-81): пункты списка, жирные имена строк
function contract({ delivery, drop = [], who = 'вердикт Голема — два круга', post = null }) {
  const lines = [
    ['Что изменилось в системе', 'проверка следа на витрине.'],
    ['Откат', 'git revert -m 1 <слияние>.'],
    ['Остаточный риск', 'короткие хеши.'],
    ['Доставка', delivery],
    ['Знание', 'такт Демона выдан.'],
    ...(post ? [['Пост', post]] : []),
  ].filter(([n]) => !drop.includes(n));
  return `**Закрытие · контракт** (пп. 9 и 11 перечитаны; ${who})\n\n${lines.map(([n, v]) => `-   **${n}:** ${v}`).join('\n')}\n\nСубагентов выдано: Терминус 1.`;
}
const logOf = (...entries) => entries.map(([t, body]) => `${head(t)}\n\n${body}\n\n`).join('');
const OK_DELIVERY = `extractor ${h7(A)} (Терминус) → отправлено; общий ${h7(D)}; Vault ${h7(E)}.`;

const cards = {
  'EXT-1': logOf(['10:00', '▶ выдан: terminus · ext-1'], ['11:00', contract({ delivery: OK_DELIVERY })]),
  'EXT-2': logOf(['11:00', contract({ delivery: OK_DELIVERY, drop: ['Знание'] })]),
  'EXT-3': logOf(['11:00', contract({ delivery: OK_DELIVERY, who: 'пп. 9 и 11 перечитаны' })]),
  'EXT-4': logOf(['11:00', contract({ delivery: 'extractor abc1234, отправлено.' })]),
  'EXT-5': logOf(['11:00', contract({ delivery: `ветка ${h7(C)}.` })]),
  'EXT-6': logOf(['11:00', contract({ delivery: `extractor ${B}.` })]),
  // слова, похожие на хеш: без буквы a–f («1234567»), без цифры («decade», «deadbeef»), часть составного слова
  'EXT-7': logOf(['11:00', contract({ delivery: 'поток n8n, версия 1234567, строка decade и deadbeef, сессия 2fea3135-c7db, W-261003-125457-20e9; файл на хранилище.' })]),
  'EXT-8': logOf(['11:00', contract({ delivery: OK_DELIVERY })], ['12:00', 'Слияние — решение дирижёра.'], ['12:30', '▶ выдан: demon · знание']),
  'EXT-9': logOf(['11:00', '⏸ получен: terminus · ext-9 · готово, тесты зелёные.']),
  'EXT-10': logOf(['11:00', contract({ delivery: `локально ${h7(F)}.` })]),
  // «Что изменилось:» без «в системе» (слово Ивана 04.10)
  'EXT-11': logOf(['11:00', contract({ delivery: OK_DELIVERY }).replace('Что изменилось в системе', 'Что изменилось')]),
  'EXT-12': logOf(['11:00', contract({ delivery: `из рабочей копии ${h7(G)}, отправлено.` })]),
  // CAR-235: после полного контракта — поздняя запись «Доставка … обновлена» без других строк контракта
  'EXT-13': logOf(['11:00', contract({ delivery: OK_DELIVERY })], ['12:00', 'Доставка по EXT-13 обновлена: прод — deployment `6257df0f`, бандл `index-Bmb2Tzuk.js`.']),
  // «Доставка» и одна «Откат» — уже контракт (неполный), а не «контракта нет»
  'EXT-14': logOf(['11:00', `-   **Откат:** git revert.\n-   **Доставка:** extractor ${h7(A)}. Слово Ивана.`]),
  // В1: «Доставка» пунктом с вложенными пунктами (EXT-43); соседняя строка «Знание» с хешем в Доставку не входит
  'EXT-15': logOf(['11:00', [
    '**Закрытие · контракт** (вердикт Голема)', '',
    '-   **Что изменилось в системе:** x.', '-   **Откат:** y.', '-   **Остаточный риск:** z.',
    '-   **Доставка:**', `    -   extractor — слияние \`${h7(A)}\`.`, '    -   **Живая проба**', `        -   общий \`${h7(D)}\`;`,
    '-   **Знание:** Vault 9a4269f.',
  ].join('\n')]),
  // В1: «**Доставка**» отдельной строкой, пустая строка, список — до следующей строки контракта (ASTRO-22)
  'EXT-16': logOf(['11:00', [
    '**Закрытие · контракт** (вердикт Голема)', '', '**Что изменилось в системе**', '', '-   x.', '',
    '**Доставка**', '', `-   \`main\` = \`${h7(A)}\`, отправлен.`, `-   Vault \`${h7(E)}\`.`, '',
    '**Откат**', '', `-   Откатить \`${h7(B)}\` в \`main\`.`, '', '**Остаточный риск:** нет.', '', '**Знание:** записи нет — 9a4269f.',
  ].join('\n')]),
  // К1: цифровой хеш на ветке; «1234567» и «decade» в репозиториях нет — молча прочь
  'EXT-17': logOf(['11:00', contract({ delivery: `ветка ${N.slice(0, 7)}; версия 1234567, строка decade.` })]),
  'EXT-18': logOf(['11:00', contract({ delivery: `только в origin/ext-side ${h7(O)}.` })]),
  'EXT-19': logOf(['11:00', contract({ delivery: `ветка trunk ${h7(Q)}.` })]),
  // М2: цитата контракта после него — не контракт; «Кто решил» только в цитате — не назван
  'EXT-21': logOf(['11:00', contract({ delivery: OK_DELIVERY })], ['12:00', 'Повторяю:\n\n> **Доставка:** abc1234\n> **Откат:** нет\n> вердикт Голема']),
  'EXT-22': logOf(['11:00', contract({ delivery: OK_DELIVERY, who: 'пп. 9 и 11' }) + '\n\n> слово Ивана в чате: «да»']),
  'CAR-1': logOf(['11:00', contract({ delivery: `общий ${h7(D)}.`, who: 'слово Ивана в чате' })]),
  'CAR-2': logOf(['11:00', contract({ delivery: `общий ${h7(D)}.`, who: 'Коммент Ивана в карточке', post: 'не нужен: внутреннее' })]),
};
const boardDir = makeBoard(tmpDir('tr-board-'), { codes: ['EXT', 'CAR'], cards: [...Object.keys(cards).map((id) => ({ id, status: 'review', title: id })), { id: 'EXT-20', status: 'in-progress', title: 'в работе' }] });
for (const [id, text] of Object.entries(cards)) fs.writeFileSync(path.join(boardDir, id.split('-')[0], `${id}.log.md`), text);
gitInitCommit(boardDir);
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest });
await board.init();

// счётчик вызовов git проверки следа
function countedGit() {
  const calls = [];
  const g = createGitRead({ onCall: (r) => calls.push(r) });
  return { git: g, calls };
}
const make = (opts = {}) => {
  const c = countedGit();
  const t = createTraceChecker({ git: c.git, registry, board, vault, ...opts });
  return { t, calls: c.calls };
};
const main = make();
await main.t.refresh();
const tr = (id) => main.t.peek(id);
const codes = (x) => x.reasons.map((r) => r.code);

// ---------- разбор ----------

test('хеш — слово из 7–40 шестнадцатеричных знаков с цифрой и буквой a–f; «decade», «1234567», «deadbeef» и части составных слов — нет', () => {
  assert.deepEqual(hashesIn(`extractor ${h7(A)} (Терминус), ${A}; \`${h7(D)}\``), [h7(A), A, h7(D)]);
  assert.deepEqual(hashesIn('decade 1234567 deadbeef abc123 2fea3135-c7db W-261003-125457-20e9 ext-48-trace'), []);
  assert.deepEqual(hashesIn('слито 2e2f446, отправлено'), ['2e2f446']);
  // адрес — не упоминание коммита: поддомен развёртывания Pages (CAR-272: https://678c0d04.unorbis-car-web.pages.dev)
  assert.deepEqual(hashesIn('коммиты `2b6d302`; развёртывание https://678c0d04.unorbis-car-web.pages.dev; прод'), ['2b6d302']);
  // доменное имя без схемы (CAR-235: deployment `d572ff8e.unorbis-car-web.pages.dev`) — не коммит; точка в конце фразы — хеш
  assert.deepEqual(hashesIn('прод — deployment `d572ff8e.unorbis-car-web.pages.dev`, код e161482. Слито 2e2f446.'), ['e161482', '2e2f446']);
  assert.deepEqual(hashesIn('файл 3a4b5c6.log и 7d8e9f0.json'), []);
});

// ---------- итог по карточке ----------

test('полный контракт, коммиты в main и origin/main (проект, общий, Vault из настройки) → ok «след проверен»', () => {
  const x = tr('EXT-1');
  assert.equal(x.state, 'ok');
  assert.equal(x.label, 'след проверен');
  assert.deepEqual(x.reasons, []);
  assert.deepEqual(x.checked.commits.map((c) => [c.hash, c.repo, c.found, c.inMain, c.pushed]),
    [[h7(A), path.basename(repo), true, true, true], [h7(D), path.basename(shared), true, true, true], [h7(E), path.basename(vault), true, true, true]]);
  assert.equal(x.checked.lines.length, 5);
  assert.equal(x.checked.who, 'вердикт Голема');
  assert.equal(x.contractAt, '2026-10-04T08:00:00.000Z');
  assert.equal(x.laterRecords, 0);
  assert.match(x.hint, /5 строк/);
  assert.match(x.hint, /вердикт Голема/);
  assert.match(x.hint, /коммитов 3/);
});

test('нет строки «Знание» → bad «нет строки: «Знание»»', () => {
  const x = tr('EXT-2');
  assert.equal(x.state, 'bad');
  assert.equal(x.reasons[0].text, 'нет строки: «Знание»');
  assert.equal(x.label, 'нет строки: «Знание»');
});

test('нет «Кто решил» → bad «не назван, кто решил»', () => {
  const x = tr('EXT-3');
  assert.equal(x.state, 'bad');
  assert.deepEqual(codes(x), ['no-who']);
  assert.equal(x.reasons[0].text, 'не назван, кто решил');
  assert.equal(x.checked.who, null);
});

test('коммит не найден ни в одном репозитории → warn «не коммит? проверь глазами» (номер развёртывания без адреса — CAR-270; правка дирижёра)', () => {
  const x = tr('EXT-4');
  assert.equal(x.state, 'warn');
  assert.equal(x.reasons[0].text, 'abc1234 не найден ни в одном репозитории — не коммит? проверь глазами');
  assert.deepEqual(x.checked.commits[0], { hash: 'abc1234', repo: null, found: false, inMain: null, pushed: null });
});

test('коммит только на ветке → bad «<h> не в main (<репозиторий>)»', () => {
  const x = tr('EXT-5');
  assert.equal(x.state, 'bad');
  assert.equal(x.reasons[0].text, `${h7(C)} не в main (${path.basename(repo)})`);
});

test('коммит в main, но не в origin/main → bad «<h> не отправлен (<репозиторий>)»; полный хеш — тоже хеш', () => {
  const x = tr('EXT-6');
  assert.equal(x.state, 'bad');
  assert.equal(x.reasons[0].text, `${B} не отправлен (${path.basename(repo)})`);
  assert.deepEqual(x.checked.commits[0], { hash: B, repo: path.basename(repo), found: true, inMain: true, pushed: false });
});

test('хешей в «Доставке» нет (поток, строка, файл; «decade», «1234567») → none «след без коммитов — проверь глазами»', async () => {
  const x = tr('EXT-7');
  assert.equal(x.state, 'none');
  assert.equal(x.label, 'след без коммитов — проверь глазами');
  assert.deepEqual(x.checked.commits, []);
});

test('после контракта ещё записи → проверка по контракту (ok), laterRecords 2 и серая строка', () => {
  const x = tr('EXT-8');
  assert.equal(x.state, 'ok');
  assert.equal(x.laterRecords, 2);
  assert.equal(x.contractAt, '2026-10-04T08:00:00.000Z');
  assert.ok(x.reasons.some((r) => r.level === 'info' && r.text === 'после контракта — ещё 2 записи'));
});

test('записи с «Доставкой» нет → bad «контракта закрытия нет»', () => {
  const x = tr('EXT-9');
  assert.equal(x.state, 'bad');
  assert.equal(x.label, 'контракта закрытия нет');
  assert.equal(x.contractAt, null);
});

test('CAR без строки «Пост» → warn «нет строки «Пост» — нужна, если карточка выкачена»; с «Пост» — ok; «Коммент Ивана» без учёта регистра', () => {
  const x = tr('CAR-1');
  assert.equal(x.state, 'warn');
  assert.equal(x.reasons[0].text, 'нет строки «Пост» — нужна, если карточка выкачена');
  const y = tr('CAR-2');
  assert.equal(y.state, 'ok');
  assert.equal(y.checked.who, 'коммент Ивана');
  // у EXT строки «Пост» не требуется
  assert.ok(!codes(tr('EXT-1')).includes('no-post'));
});

test('репозиторий без origin/main → warn «отправку не проверить», не красное «не отправлен»', () => {
  const x = tr('EXT-10');
  assert.equal(x.state, 'warn');
  assert.deepEqual(codes(x), ['no-origin']);
  assert.equal(x.checked.commits[0].pushed, null);
});

test('«Что изменилось:» без «в системе» — строка есть (слово Ивана 04.10); обрубок «Что изменило» — нет', () => {
  assert.equal(hasLine('-   **Что изменилось:** проверка следа.', 'Что изменилось в системе'), true);
  assert.equal(hasLine('Что изменилось — проверка следа', 'Что изменилось в системе'), true);
  assert.equal(hasLine('**Что изменилось в системе:** да', 'Что изменилось в системе'), true);
  assert.equal(hasLine('-   **Что изменило:** обрубок', 'Что изменилось в системе'), false);
  const x = tr('EXT-11');
  assert.equal(x.state, 'ok');
  assert.equal(x.checked.lines.length, 5);
});

test('коммит в origin/main, локальный main основного клона позади → доставлен (ok), inMain и pushed — true', () => {
  const x = tr('EXT-12');
  assert.equal(x.state, 'ok');
  assert.deepEqual(x.checked.commits[0], { hash: h7(G), repo: path.basename(behind), found: true, inMain: true, pushed: true });
});

test('контракт — запись с «Доставкой» и ещё хоть одной строкой: поздняя «Доставка … обновлена» (CAR-235) — не контракт, а запись после него', () => {
  const x = tr('EXT-13');
  assert.equal(x.state, 'ok');
  assert.equal(x.contractAt, '2026-10-04T08:00:00.000Z');
  assert.equal(x.laterRecords, 1);
  assert.ok(!x.checked.commits.some((c) => c.hash === '6257df0f'));
});

test('«Доставка» и «Откат» без прочих строк — неполный контракт: bad «нет строки: …», а не «контракта закрытия нет»', () => {
  const x = tr('EXT-14');
  assert.equal(x.state, 'bad');
  assert.deepEqual(x.reasons.filter((r) => r.level === 'bad').map((r) => r.text), ['нет строки: «Что изменилось в системе», «Остаточный риск», «Знание»']);
  assert.equal(x.contractAt, '2026-10-04T08:00:00.000Z');
});

test('К1: хеш из одних цифр (7170320, 2743963) — кандидат: найден на ветке → bad «не в main»; «1234567» и «decade», которых нет нигде, — ни причины, ни строки', () => {
  const x = tr('EXT-17');
  assert.equal(x.state, 'bad');
  assert.deepEqual(x.reasons.filter((r) => r.level !== 'info').map((r) => r.text), [`${N.slice(0, 7)} не в main (${path.basename(repo)})`]);
  assert.deepEqual(x.checked.commits.map((c) => c.hash), [N.slice(0, 7)]);
  // без коммитов вовсе: слова-кандидаты не найдены — «след без коммитов», как и было
  assert.equal(tr('EXT-7').state, 'none');
  assert.deepEqual(tr('EXT-7').checked.commits, []);
});

test('В1: «Доставка» с вложенными пунктами — их хеши в проверке, соседняя «Знание: … 9a4269f» — нет', () => {
  const x = tr('EXT-15');
  assert.deepEqual(x.checked.commits.map((c) => c.hash), [h7(A), h7(D)]);
  assert.equal(x.state, 'ok');
});

test('В1: «**Доставка**», пустая строка, список — до следующей строки контракта («Откат» с хешем не входит)', () => {
  const x = tr('EXT-16');
  assert.deepEqual(x.checked.commits.map((c) => c.hash), [h7(A), h7(E)]);
  assert.equal(x.state, 'ok');
});

test('В3: коммит только в refs/remotes/origin/<ветка> — не в main и не в origin/main → bad «не в main»', () => {
  const x = tr('EXT-18');
  assert.equal(x.state, 'bad');
  assert.equal(x.reasons[0].text, `${h7(O)} не в main (${path.basename(repo)})`);
});

test('М3: в репозитории нет ни main, ни master → warn «<h>: в <репо> нет ветки main или master», не «git не ответил»', () => {
  const x = tr('EXT-19');
  assert.equal(x.state, 'warn');
  assert.deepEqual(x.reasons.filter((r) => r.level !== 'info').map((r) => [r.code, r.text]), [['no-main', `${h7(Q)}: в ${path.basename(nomain)} нет ветки main или master`]]);
});

test('М2: цитата (>) не делает запись контрактом и не называет, кто решил', () => {
  const x = tr('EXT-21');
  assert.equal(x.state, 'ok');
  assert.equal(x.contractAt, '2026-10-04T08:00:00.000Z');
  assert.equal(x.laterRecords, 1);
  const y = tr('EXT-22');
  assert.equal(y.state, 'bad');
  assert.deepEqual(y.reasons.map((r) => r.code), ['no-who']);
});

test('М4: один репозиторий упал — найденный в другом коммит судится по нему («не в main»), не найденный нигде — warn с именем упавшего', async () => {
  const real = createGitRead();
  const sick = path.resolve(local).toLowerCase();
  const g = async (r, args) => { if (path.resolve(r).toLowerCase() === sick) { const e = new Error('упал'); e.code = 128; throw e; } return real(r, args); };
  const t = createTraceChecker({ git: g, registry, board, vault });
  await t.refresh();
  assert.equal(t.peek('EXT-5').reasons[0].text, `${h7(C)} не в main (${path.basename(repo)})`);
  const x = t.peek('EXT-4');
  assert.equal(x.state, 'warn');
  assert.equal(x.reasons[0].text, `коммит abc1234: не удалось проверить — git не ответил (${path.basename(local)})`);
});

test('карточка не в Review — не проверяется (null)', () => {
  assert.equal(tr('EXT-20'), null);
});

// ---------- когда считать ----------

test('кэш: второй проход без перемен git не зовёт; новый коммит в origin/main — пересчёт только этой проверки, EXT-6 становится ok', async () => {
  const s = make();
  await s.t.refresh();
  const n = s.calls.length;
  assert.ok(n > 0);
  await s.t.refresh();
  assert.equal(s.calls.length, n, 'вершины и записи те же — git не звался');
  const r2 = tmpDir('tr-repo2-');
  fs.cpSync(repo, r2, { recursive: true });
  const reg2 = path.join(tmpDir('tr-reg2-'), 'registry.json');
  fs.writeFileSync(reg2, JSON.stringify({ board_codes: { EXT: { repos: [r2] }, CAR: { repos: [] } }, board_shared_repos: { repos: [shared] } }));
  const c = countedGit();
  const t2 = createTraceChecker({ git: c.git, registry: createRegistryReader(reg2), board, vault });
  await t2.refresh();
  assert.equal(t2.peek('EXT-6').state, 'bad');
  const before = c.calls.length;
  git(r2, 'update-ref', 'refs/remotes/origin/main', B); // «отправка с этой машины»
  await t2.refresh();
  assert.equal(t2.peek('EXT-6').state, 'ok');
  assert.ok(c.calls.length > before);
  // origin/main сдвинулся — по одному merge-base на найденный в r2 коммит (A, B, C, N, O: origin проверяется первым),
  // без новых поисков rev-parse и без проверок других репозиториев
  assert.ok(c.calls.length - before <= [A, B, C, N, O].length, `пересчёт только задетого: ${c.calls.length - before} вызовов`);
});

test('смена последней записи карточки → до прохода — null («проверяю след…»), после — по новому контракту', async () => {
  const dir = makeBoard(tmpDir('tr-b2-'), { codes: ['EXT'], cards: [{ id: 'EXT-1', status: 'review' }] });
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-1.log.md'), logOf(['11:00', contract({ delivery: OK_DELIVERY, drop: ['Откат'] })]));
  gitInitCommit(dir);
  const b2 = createBoardReader({ root: dir, git: createGitRead(), parseCard, parseLog, latest });
  await b2.init();
  const t = createTraceChecker({ git: createGitRead(), registry, board: b2, vault });
  assert.equal(t.peek('EXT-1'), null, 'ещё не посчитано');
  await t.refresh();
  assert.equal(t.peek('EXT-1').state, 'bad');
  fs.writeFileSync(path.join(dir, 'EXT', 'EXT-1.log.md'), logOf(['11:00', contract({ delivery: OK_DELIVERY, drop: ['Откат'] })], ['13:00', contract({ delivery: OK_DELIVERY })]));
  gitCommitAll(dir, 'log');
  await b2.refresh();
  assert.equal(t.peek('EXT-1'), null, 'последняя запись сменилась — прежний итог не показывается');
  await t.refresh();
  assert.equal(t.peek('EXT-1').state, 'ok');
});

test('ошибка git → не bad «не найден», а warn «не удалось проверить»; следующий проход после починки — ok', async () => {
  let broken = true;
  const real = createGitRead();
  const flaky = async (r, args) => { if (broken) { const e = new Error('git упал'); e.code = 128; throw e; } return real(r, args); };
  const t = createTraceChecker({ git: flaky, registry, board, vault });
  await t.refresh();
  const x = t.peek('EXT-1');
  assert.equal(x.state, 'warn');
  assert.ok(x.reasons.every((r) => r.code !== 'not-found'));
  assert.match(x.reasons[0].text, /не удалось проверить/);
  assert.equal(x.checked.commits[0].found, null);
  assert.equal(t.peek('EXT-4').reasons[0].code, 'git-error', 'и несуществующий коммит при сломанном git — не «не найден»');
  broken = false;
  await t.refresh();
  assert.equal(t.peek('EXT-1').state, 'ok');
  assert.equal(t.peek('EXT-4').reasons[0].code, 'not-found');
});

// ---------- ручки ----------

test('ручки: trace у строк (в) /api/ceh и waiting[] окна проекта, pult.trace в /api/card/:id; на запрос страницы git проверки следа не зовётся', async () => {
  const s = make();
  const app = await buildApp({ port: 4317, board, registry, scan: () => [], trace: s.t, pult: { enabled: true } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } })).json();
  // до прохода — null у всех
  const ceh0 = await get('/api/ceh');
  assert.ok(ceh0.waiting.review.length > 0);
  assert.ok(ceh0.waiting.review.every((r) => r.trace === null));
  assert.equal(s.calls.length, 0);
  await s.t.refresh();
  const n = s.calls.length;
  assert.ok(n > 0, 'счётчик видит вызовы прохода');
  const ceh = await get('/api/ceh');
  const row = ceh.waiting.review.find((r) => r.id === 'EXT-4');
  assert.equal(row.trace.state, 'warn');
  assert.equal(row.trace.label, 'abc1234 не найден ни в одном репозитории — не коммит? проверь глазами');
  const proj = await get('/api/project/EXT');
  assert.equal(proj.waiting.find((r) => r.id === 'EXT-1').trace.state, 'ok');
  const card = await get('/api/card/EXT-6');
  assert.equal(card.pult.trace.state, 'bad');
  assert.equal((await get('/api/card/EXT-20')).pult.trace, null);
  assert.equal(s.calls.length, n, 'запросы страниц git не звали');
  await app.close();
});

// ---------- второй круг Голема (правка дирижёра) ----------

test('Важно 1 круга 2: после контракта «▶ выдан» — newTakt (контракт мог устареть); «⏸» и цитата «▶» — нет', () => {
  const contract = { ms: 1, index: 0, body: '<p><b>Закрытие</b></p>\n- **Доставка:** 2e2f446\n- **Откат:** revert' };
  const takt = { ms: 2, index: 1, body: '<p>▶ выдан: terminus · car-235 · второй круг</p>' };
  const pause = { ms: 3, index: 2, body: '<p>⏸ получен: terminus · car-235</p>' };
  const quoted = { ms: 4, index: 3, body: '> ▶ выдан: старая цитата\nответ' };
  assert.equal(findContract([contract, takt, pause]).newTakt, true);
  assert.equal(findContract([contract, pause, quoted]).newTakt, false);
  // такт Демона (знание) и Тихого (пост) после контракта — законный порядок, контракт не устаревает
  const demon = { ms: 5, index: 4, body: '<p>▶ выдан: demon · main · знание по CAR-235</p>' };
  const tikhiy = { ms: 6, index: 5, body: '▶ выдан: tikhiy · пост' };
  assert.equal(findContract([contract, demon, tikhiy]).newTakt, false);
  assert.equal(findContract([contract, demon, takt]).newTakt, true);
  // третий круг Голема: живые виды записи — жирное, закрытое после двоеточия (CAR-263), имя внутри жирного (ASTRO-22),
  // Бальд с картинками к посту; «▶ выдан» посреди строки (CAR-264) — новый такт
  const live = (body) => findContract([contract, { ms: 9, index: 9, body }]).newTakt;
  assert.equal(live('**▶ выдан:** demon · Vault main · знание по вехе В2.'), false);
  assert.equal(live('**▶ выдан: Демон** · знание'), false);
  assert.equal(live('▶ выдан: bard · картинки к посту CAR-264'), false);
  assert.equal(live('**Картинки нужны** (решение дирижёра): шаги поста. **▶ выдан: bard** — вёрстка формы заново'), true);
  assert.equal(live('**▶ выдан:** terminus · car-235 · второй круг'), true);
  assert.equal(live('▶ выдан: terminus · постоянная ссылка на файл'), true, '«постоянная» — не «пост»');
  // четвёртый круг: «пост / картинки» снимает признак только с Бальда; упоминание в кавычках — не выдача
  assert.equal(live('**▶ выдан:** terminus · та же ветка · Т2 — List и выпуск пропуска картинки (sign.js)'), true);
  assert.equal(live('▶ выдан: golem · ревью «Посты для клиентов»'), true);
  assert.equal(live('Промах дирижёра: запись «▶ выдан: golem» перед ревью не сделана.'), false);
  assert.equal(findContract([contract]).later, 0);
});

test('мелочь 4 круга 2: вложенная строка контракта («- Откат проверен: …») внутри «Доставки» не обрывает сбор', () => {
  const body = ['- **Доставка:**', '    - extractor 2e2f446', '    - Откат проверен: revert на копии', '    - Vault 8a7f299', '- **Знание:** f86edec'].join('\n');
  const d = deliveryText(body);
  assert.match(d, /8a7f299/);
  assert.doesNotMatch(d, /f86edec/);
});
