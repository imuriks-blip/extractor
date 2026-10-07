// «Отозвать», такт 1 (EXT-71, спека пульта §1.9, строка ПТ7б §7): сервер — действие withdraw. Контроли гейта ПТ7б (3)–(15), каждый отказ —
// 200 и при повторе тем же intentId после рестарта. Гонка, forged, поздний ring и «ни одного await» — в ext71-race.test.mjs.
// Ожидания — из спеки и из того, что положено в тест, не из кода под тестом. Настоящий Plane не запускается (подменный fake-plane.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acceptState } from '../lib/pult/accept.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';
import { Q_MD, SID, SID2, boot, cmds, makeEnv, nextIntent, stepsOf, thread } from './ext71-harness.mjs';

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);

const OLD = { kind: 'oldRules', rulesUpdatedAt: '2026-10-05T10:00:00.000Z', missing: [{ path: 'C:\\Vault\\CLAUDE.md', short: 'CLAUDE.md' }] };
const p2 = (n) => String(n).padStart(2, '0');
const local = (iso) => { const d = new Date(iso); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const WD = (target) => ({ action: 'withdraw', target });
const NOBODY = 'W-261007-000000-0000';
const fresh = async (opts = {}) => boot(makeEnv(), { threads: [thread(SID, { card: 'EXT-20', marks: [OLD] })], ...opts });
const rereadWord = async (s) => (await s.press({ action: 'reread', session: SID })).json();
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('не дождался'); await new Promise((r) => setTimeout(r, 15)); } };
const commentsOf = (s) => s.pl().comments.length;
const pultRecords = (s) => s.pl().comments.filter((c) => c.html.startsWith('<p><b>Слово Ивана · кнопка витрины · '));

// ---------------- основной путь ----------------

test('основной путь: слово с карточкой отозвано — шаги и порядок, запись §1.9 в Plane, память и сигнал сняты, строки «Мои слова»', async () => {
  const s = await fresh();
  const w = await s.word();
  assert.equal(w.outcome, 'ok', w.message);
  assert.equal(s.signals().length, 1);
  const r = await s.press(WD(w.id));
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.match(b.message, /^отозвано · запись на EXT-20 легла \d\d:\d\d$/);
  const ls = s.lines();
  // слово: шаг withdrawn (reason ivan, by — номер отзыва) лёг у отзываемого действия, после его done
  assert.deepEqual(stepsOf(ls, w.id), ['asked', 'fresh', 'plane', 'ring-queued', 'done', 'withdrawn']);
  const wd = ls.find((l) => l.id === w.id && l.step === 'withdrawn');
  assert.equal(wd.reason, 'ivan');
  assert.equal(wd.by, b.id);
  // отзыв: asked с withdraws, карточку и проект нашёл сервер; текста и q нет
  assert.deepEqual(stepsOf(ls, b.id), ['asked', 'plane', 'done']);
  const asked = ls.find((l) => l.id === b.id && l.step === 'asked');
  assert.equal(asked.action, 'withdraw');
  assert.equal(asked.withdraws, w.id);
  assert.equal(asked.card, 'EXT-20');
  assert.equal(asked.project, 'EXT');
  assert.equal(asked.text, undefined);
  assert.equal(asked.q, undefined);
  // запись на карточке — по форме §1.9, без «В ответ на» и без приписки Б
  const at = ls.find((l) => l.id === w.id && l.step === 'asked').at;
  const html = s.pl().comments.at(-1).html;
  assert.equal(html, `<p><b>Слово Ивана · кнопка витрины · ${b.id}</b>: «отозвать ${w.id}»</p>`
    + `<p>Отзывает: ${w.id} · ${local(at)} · «да» — не исполнять; если уже исполнено — сказать Ивану в чате</p>`
    + `<p>Кто решил: слово Ивана · кнопка витрины · ${b.id}</p>`);
  assert.deepEqual(cmds(s.pl().calls), ['show', 'comment', 'comment'], 'у отзыва свежей сверки нет, статус не меняется');
  assert.equal(s.pl().status, 'In Progress');
  // звонок: памяти нет, сигнала нет
  assert.deepEqual((await s.bellGet(SID)).ids, []);
  assert.equal(s.signals().length, 0);
  // «Мои слова»
  const rows = await s.get('/api/actions');
  const wr = rows.find((x) => x.id === w.id);
  assert.equal(wr.ring, 'отозвано');
  assert.equal(wr.withdrawnBy, b.id);
  const br = rows.find((x) => x.id === b.id);
  assert.equal(br.action, 'withdraw');
  assert.equal(br.withdraws, w.id);
  assert.equal(br.word, w.id);
  assert.equal(br.status, 'done');
  assert.equal(br.card, 'EXT-20');
  assert.equal(rows.find((x) => x.id !== w.id && x.id !== b.id), undefined);
  assert.equal('withdrawnBy' in br, false, 'у строки отзыва withdrawnBy нет');
});

test('(5) вход: ровно {action, intentId, target}; любое иное поле — 400; target не по форме — 400; журнал и Plane не тронуты', async () => {
  const s = await fresh();
  const w = await s.word();
  const before = s.lines().length;
  const extra = { card: 'EXT-20', project: 'EXT', session: SID, text: 'x', q: { at: null }, confirm: 'W-261005-120000-a1b2', pick: SID, kind: 'changed', title: 't', rowKey: 'k', until: '1h' };
  for (const [k, v] of Object.entries(extra)) assert.equal((await s.press({ ...WD(w.id), [k]: v })).statusCode, 400, k);
  for (const bad of ['W-261005-120000', 'w-261005-120000-a1b2', 'EXT-20', '', 7, null, `${w.id} `, `${w.id}\n`]) assert.equal((await s.press(WD(bad))).statusCode, 400, JSON.stringify(bad));
  assert.equal((await s.press({ action: 'withdraw' })).statusCode, 400, 'target обязателен');
  assert.equal((await s.press({ action: 'yes', card: 'EXT-20', q: { at: null }, target: w.id })).statusCode, 400, 'target — только у withdraw');
  assert.equal(s.lines().length, before);
  assert.equal(commentsOf(s), 2);
  assert.equal(s.signals().length, 1, 'слово на месте');
  assert.equal((await s.press(WD(w.id))).json().outcome, 'ok', 'исправный рядом: ровно три поля проходят');
});

test('(5) no-target и not-withdrawable — 200, refused, до asked; Plane и звонок не тронуты; номер «Принять»/ping/самого отзыва — not-withdrawable', async () => {
  const s = await fresh();
  const w = await s.word();
  const ping = (await s.press({ action: 'ping' })).json();
  const calls0 = JSON.stringify(s.pl().calls);
  const cases = [['no-target', NOBODY], ['not-withdrawable', ping.id]];
  for (const [name, target] of cases) {
    const r = await s.press(WD(target));
    assert.equal(r.statusCode, 200, name);
    const b = r.json();
    assert.equal(b.outcome, 'refused');
    assert.equal(b.refusal, name);
    assert.deepEqual(stepsOf(s.lines(), b.id), ['refused'], 'отказ до asked: одна строка refused');
    assert.equal(s.lines().find((l) => l.id === b.id).refusal, name);
  }
  assert.equal(JSON.stringify(s.pl().calls), calls0, 'в Plane ничего');
  assert.equal(s.signals().length, 1);
  // сам отзыв — тоже не из круга
  const ok = (await s.press(WD(w.id))).json();
  const r2 = (await s.press(WD(ok.id))).json();
  assert.equal(r2.refusal, 'not-withdrawable');
  // «Принять» (accept) — не из круга: строка в журнале есть
  fs.appendFileSync(s.env.actionsLog, JSON.stringify({ id: 'W-261007-100000-aaaa', at: '2026-10-07T10:00:00+03:00', action: 'accept', card: 'EXT-22', step: 'asked' }) + '\n');
  assert.equal((await s.press(WD('W-261007-100000-aaaa'))).json().refusal, 'not-withdrawable');
});

test('круг действий (проверка 2): yes, go, merge, deploy, no, reply, return, take, reread её проходят; accept, mirror, defer, undefer, new-card, withdraw, cleanup, reindex, ping — not-withdrawable', async () => {
  const s = await fresh();
  const w = await s.word();
  const inCircle = ['yes', 'go', 'merge', 'deploy', 'no', 'reply', 'return', 'take', 'reread'];
  const out = ['accept', 'mirror', 'defer', 'undefer', 'new-card', 'withdraw', 'cleanup', 'reindex', 'ping'];
  const seen = {};
  let n = 0;
  for (const action of [...inCircle, ...out]) {
    const id = `W-261007-11${p2(n)}00-a${p2(n)}0`;
    n += 1;
    seen[action] = id;
    fs.appendFileSync(s.env.actionsLog, JSON.stringify({ id, at: '2026-10-07T11:00:00+03:00', action, step: 'asked' }) + '\n'); // без ring-queued
  }
  for (const action of out) assert.equal((await s.press(WD(seen[action]))).json().refusal, 'not-withdrawable', action);
  for (const action of inCircle) {
    const b = (await s.press(WD(seen[action]))).json();
    assert.equal(b.refusal, 'not-queued', `${action}: из круга — отказ уже не «not-withdrawable», а «не было звонка»`);
  }
  assert.equal((await s.press(WD(w.id))).json().outcome, 'ok');
});

// ---------------- (3) повтор ----------------

test('(3) повторный отзыв — already-withdrawn: id прежнего отзыва и статус, шаг withdrawn один, запись в Plane одна; тот же intentId — прежний исход', async () => {
  const s = await fresh();
  const w = await s.word();
  const first = (await s.press(WD(w.id))).json();
  assert.equal(first.outcome, 'ok');
  const again = await s.press(WD(w.id));
  assert.equal(again.statusCode, 200);
  const a = again.json();
  assert.equal(a.outcome, 'refused');
  assert.equal(a.refusal, 'already-withdrawn');
  assert.equal(a.id, first.id, 'ответ — id того отзыва');
  assert.equal(a.status, 'отозвано');
  assert.equal(s.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').length, 1);
  assert.equal(pultRecords(s).filter((c) => c.html.includes('отозвать')).length, 1);
  // тот же intentId успешного отзыва — прежний исход, второго действия нет
  const k = nextIntent();
  const s2 = await fresh();
  const w2 = await s2.word();
  const x = (await s2.press(WD(w2.id), k)).json();
  const y = (await s2.press(WD(w2.id), k)).json();
  assert.deepEqual(y, x);
  assert.equal(s2.lines().filter((l) => l.action === 'withdraw' && l.step === 'asked').length, 1);
  assert.equal(commentsOf(s2), 3);
});

test('(3) already-withdrawn: любое действие withdraw с done по номеру; отзыв без done (partial) — не отказ, а «только запись»', async () => {
  const s = await fresh();
  const w = await s.word();
  s.setPlane({ fail: { comment: 'refuse' } });
  const p = (await s.press(WD(w.id))).json();
  assert.equal(p.outcome, 'partial');
  const r = (await s.press(WD(w.id))).json();
  assert.notEqual(r.refusal, 'already-withdrawn', 'partial — не done');
  assert.equal(r.outcome, 'partial', 'запись снова не легла (plane всё ещё падает)');
  s.setPlane({ fail: {} });
  assert.equal((await s.press(WD(w.id))).json().outcome, 'ok');
  assert.equal((await s.press(WD(w.id))).json().refusal, 'already-withdrawn');
});

// ---------------- (4) отзыв доставленного ----------------

test('(4) доставлено (ring в bell.log есть, ring-delivered ещё нет) — not-queued с названным статусом; в Plane ничего, withdrawn нет', async () => {
  const s = await fresh();
  const w = await s.word();
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] }); // ждущий записал ring, такт ещё не писал ring-delivered
  assert.equal(s.lines().some((l) => l.id === w.id && l.step === 'ring-delivered'), false);
  const calls0 = JSON.stringify(s.pl().calls);
  const r = await s.press(WD(w.id));
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.outcome, 'refused');
  assert.equal(b.refusal, 'not-queued');
  assert.match(b.message, /доставлено/);
  assert.equal(JSON.stringify(s.pl().calls), calls0);
  assert.equal(s.lines().some((l) => l.step === 'withdrawn'), false);
  assert.equal((await s.rowOf(w.id)).ring, 'доставлено');
  // исправный рядом: второе слово, ring по которому нет, — отзывается
  const w2 = await s.word('go');
  assert.equal((await s.press(WD(w2.id))).json().outcome, 'ok');
});

test('(4) прочитано (форма звонка в журнале треда) — not-queued «прочитано»; сброшено перезапуском у слова без карточки — not-queued «сброшено…»', async () => {
  const s = await fresh();
  const w = await s.word();
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] });
  s.env.sessions = [{ sessionId: SID, rings: { [w.id]: '2026-10-07T10:00:00.000Z' } }];
  const b = (await s.press(WD(w.id))).json();
  assert.equal(b.refusal, 'not-queued');
  assert.match(b.message, /прочитано/);
  assert.equal(s.lines().some((l) => l.step === 'withdrawn'), false);
  // без карточки: reread, рестарт — слово сброшено, снимать нечего
  const s2 = await fresh();
  const rr = await rereadWord(s2);
  assert.equal(rr.outcome, 'ok', rr.message);
  const s3 = await boot(s2.env);
  const c = (await s3.press(WD(rr.id))).json();
  assert.equal(c.refusal, 'not-queued');
  assert.match(c.message, /сброшено перезапуском — снимать нечего/);
  assert.equal(s3.lines().filter((l) => l.id === rr.id && l.step === 'withdrawn').length, 1, 'только withdrawn: restart от старта');
});

test('(4) слова нет в памяти и твёрдого статуса нет — «нет в памяти звонка (вероятно, сброшено)», не «положено»', async () => {
  const s = await fresh();
  const id = 'W-261007-120000-aaaa';
  for (const l of [{ id, at: '2026-10-07T12:00:00+03:00', action: 'yes', card: 'EXT-20', project: 'EXT', step: 'asked' },
    { id, step: 'ring-queued', target: { sessionId: SID, title: 'тред', by: 'card' } }, { id, step: 'done', result: { outcome: 'ok', record: id } }]) fs.appendFileSync(s.env.actionsLog, JSON.stringify(l) + '\n');
  const b = (await s.press(WD(id))).json();
  assert.equal(b.refusal, 'not-queued');
  assert.match(b.message, /нет в памяти звонка \(вероятно, сброшено\)/);
  assert.equal(commentsOf(s), 1);
  // слово без звонка (no-thread / off / queue-full): not-queued
  const nid = 'W-261007-120100-bbbb';
  for (const l of [{ id: nid, at: '2026-10-07T12:01:00+03:00', action: 'yes', card: 'EXT-20', step: 'asked' }, { id: nid, step: 'done', result: { outcome: 'ok', ring: { state: 'no-thread' } } }]) fs.appendFileSync(s.env.actionsLog, JSON.stringify(l) + '\n');
  assert.equal((await s.press(WD(nid))).json().refusal, 'not-queued');
});

// ---------------- (6) card-busy ----------------

test('(6) пока слово по той же карточке идёт — 409 card-busy; после — отзыв проходит', async () => {
  const s = await fresh();
  const a = await s.word();
  let release;
  s.env.hook.gate = new Promise((r) => { release = r; });
  s.env.hook.hang = 'comment-gate';
  const slow = s.press({ action: 'yes', card: 'EXT-20', q: { at: '2026-10-03T09:00:00.000Z', head: Q_MD } });
  await until(() => s.lines().filter((l) => l.step === 'asked' && l.action === 'yes').length === 2);
  const calls0 = JSON.stringify(s.pl().calls);
  const r = await Promise.race([s.press(WD(a.id)), new Promise((res) => setTimeout(() => res({ statusCode: 'завис', json: () => ({}) }), 2500))]);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().refusal, 'card-busy');
  assert.equal(s.lines().some((l) => l.step === 'withdrawn'), false, 'ничего не снято');
  assert.equal(s.signals().length, 1);
  s.env.hook.hang = null;
  release();
  assert.equal((await slow).json().outcome, 'ok');
  assert.ok(JSON.stringify(s.pl().calls).length >= calls0.length);
  assert.equal((await s.press(WD(a.id))).json().outcome, 'ok', 'карточка свободна — отзыв идёт');
});

// ---------------- (7) флаги ----------------

test('(7) pult.bell = false → bell-off (200, до asked, кнопки нет); повтор тем же intentId после рестарта — тот же исход и 200', async () => {
  const s = await fresh();
  const w = await s.word();
  const off = await boot(s.env, { bell: false });
  const k = nextIntent();
  const r = await off.press(WD(w.id), k);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().refusal, 'bell-off');
  assert.equal(commentsOf(off), 2);
  const off2 = await boot(s.env, { bell: false });
  const again = await off2.press(WD(w.id), k);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().refusal, 'bell-off');
  assert.equal(again.json().id, r.json().id);
});

test('(7) pult.words = false при bell = true: отзыв проходит (слово «да» — 503); отзыв — «только убирает»', async () => {
  const s = await fresh({ words: false });
  const rr = await rereadWord(s);
  assert.equal(rr.outcome, 'ok', rr.message);
  assert.equal((await s.press({ action: 'yes', card: 'EXT-20', q: { at: null } })).statusCode, 503);
  const b = await s.press(WD(rr.id));
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().outcome, 'ok', b.body);
  assert.equal(s.signals().length, 0);
  // и отзыв слова с карточкой после рестарта (только запись) при words = false
  const w = await boot(s.env, { words: true });
  const yw = await w.word();
  const nw = await boot(s.env, { words: false });
  const r2 = (await nw.press(WD(yw.id))).json();
  assert.equal(r2.outcome, 'ok', r2.message);
});

// ---------------- (8) partial ----------------

test('(8) comment падает → partial, звонок снят; повтор пишет только запись, запись одна', async () => {
  const s = await fresh();
  const w = await s.word();
  s.setPlane({ fail: { comment: 'refuse' } });
  const r = await s.press(WD(w.id));
  assert.equal(r.statusCode, 200);
  const p = r.json();
  assert.equal(p.outcome, 'partial');
  assert.match(p.message, /^звонок снят, запись об отзыве не легла — повторить/);
  assert.equal((await s.bellGet(SID)).ids.length, 0, 'слово из памяти снято');
  assert.equal(s.signals().length, 0);
  assert.equal(pultRecords(s).filter((c) => c.html.includes('отозвать')).length, 0);
  const row = await s.rowOf(w.id);
  assert.equal(row.ring, 'отозвано');
  assert.equal(row.withdrawnBy, undefined, 'отзыв без done — withdrawnBy нет');
  assert.equal((await s.rowOf(p.id)).status, 'partial');
  s.setPlane({ fail: {} });
  const n0 = cmds(s.pl().calls).length;
  const again = (await s.press(WD(w.id))).json();
  assert.equal(again.outcome, 'ok');
  assert.deepEqual(cmds(s.pl().calls).slice(n0), ['show', 'comment'], 'сверка show --last, затем только запись: ни памяти, ни сигнала');
  assert.equal(s.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').length, 1, 'шаги 1–4 не повторялись');
  const recs = pultRecords(s).filter((c) => c.html.includes('отозвать'));
  assert.equal(recs.length, 1);
  assert.ok(recs[0].html.includes(again.id), 'запись — под номером нового нажатия');
  assert.equal((await s.rowOf(w.id)).withdrawnBy, again.id);
});

test('(8) исход comment неясен: коммент лёг, код 3 — запись найдена по show --last, не partial; не легла и код 3 — partial', async () => {
  const s = await fresh();
  const w = await s.word();
  s.setPlane({ fail: { comment: 'unclear-after' } });
  const a = (await s.press(WD(w.id))).json();
  assert.equal(a.outcome, 'ok', a.message);
  assert.equal(pultRecords(s).filter((c) => c.html.includes('отозвать')).length, 1);
  const s2 = await fresh();
  const w2 = await s2.word();
  s2.setPlane({ fail: { comment: 'unclear-before' } });
  const b = (await s2.press(WD(w2.id))).json();
  assert.equal(b.outcome, 'partial');
  assert.equal(pultRecords(s2).filter((c) => c.html.includes('отозвать')).length, 0);
});

// ---------------- (9) рестарт после отзыва ----------------

test('(9) рестарт после отзыва — «отозвано», не «сброшено перезапуском»; withdrawn: restart слову не пишется; сигналов нет', async () => {
  const s = await fresh();
  const w = await s.word();
  const b = (await s.press(WD(w.id))).json();
  const s2 = await boot(s.env);
  const row = await s2.rowOf(w.id);
  assert.equal(row.ring, 'отозвано');
  assert.equal(row.withdrawnBy, b.id);
  assert.deepEqual(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').map((l) => l.reason), ['ivan']);
  assert.equal(s2.signals().length, 0);
  // исправный рядом: неотозванное слово после рестарта — «сброшено перезапуском»
  const s3 = await fresh();
  const u = await s3.word();
  const s4 = await boot(s3.env);
  assert.equal((await s4.rowOf(u.id)).ring, 'сброшено перезапуском');
});

// ---------------- (10) тред закрыт ----------------

test('(10) тред закрыт: отзыв проходит, пока слово в памяти (до 24 ч); после 24 ч — not-queued «не доставлено: тред закрыт», Plane не тронут', async () => {
  const env = makeEnv();
  const T0 = Date.parse('2026-10-07T09:00:00Z');
  env.clock.t = T0;
  const s = await boot(env, { threads: [thread(SID, { card: 'EXT-20' })] });
  const a = await s.word();
  const b = await s.word('go');
  env.threads = []; // тред умер
  await s.app.pult.tick();
  assert.equal((await s.rowOf(a.id)).ring, 'не доставлено: тред закрыт');
  env.clock.t = T0 + 23 * 3600000;
  const ok = (await s.press(WD(a.id))).json();
  assert.equal(ok.outcome, 'ok', ok.message);
  assert.equal(s.signals().length, 1, 'сигнал второго слова на месте');
  env.clock.t = T0 + 25 * 3600000;
  await s.app.pult.tick();
  assert.equal((await s.rowOf(b.id)).ring, 'не доставлено: тред закрыт');
  const calls0 = JSON.stringify(s.pl().calls);
  const late = (await s.press(WD(b.id))).json();
  assert.equal(late.refusal, 'not-queued');
  assert.match(late.message, /не доставлено: тред закрыт/);
  assert.equal(JSON.stringify(s.pl().calls), calls0);
});

// ---------------- (11) без карточки ----------------

test('(11) слово без карточки (reread): в Plane ничего, след — actions.log (asked с withdraws, withdrawn); сигнал снят; повтор — already-withdrawn', async () => {
  const s = await fresh();
  const rr = await rereadWord(s);
  assert.equal(rr.outcome, 'ok', rr.message);
  const calls0 = JSON.stringify(s.pl().calls);
  const r = await s.press(WD(rr.id));
  const b = r.json();
  assert.equal(r.statusCode, 200);
  assert.equal(b.outcome, 'ok', b.message);
  assert.match(b.message, /записи на доске нет/);
  assert.equal(JSON.stringify(s.pl().calls), calls0, 'в Plane ничего');
  assert.equal(s.signals().length, 0);
  const ls = s.lines();
  const asked = ls.find((l) => l.id === b.id && l.step === 'asked');
  assert.equal(asked.withdraws, rr.id);
  assert.equal(asked.card, undefined);
  assert.equal(asked.project, 'EXT', 'проект — из asked отзываемого');
  assert.deepEqual(stepsOf(ls, b.id), ['asked', 'done']);
  assert.equal(ls.find((l) => l.id === rr.id && l.step === 'withdrawn').by, b.id);
  assert.equal((await s.rowOf(rr.id)).ring, 'отозвано');
  assert.equal((await s.rowOf(rr.id)).withdrawnBy, b.id);
  assert.equal((await s.press(WD(rr.id))).json().refusal, 'already-withdrawn');
  // «Вернуть»-подсказка есть только у return
  assert.doesNotMatch(b.message, /попроси дирижёра/);
});

// ---------------- (12) не снимает чужое ----------------

test('(12) не снимает чужое: три слова в двух тредах — отзыв первого оставляет два других, сигналы на месте, следующий звонок отдаёт ровно их, forged нет', async () => {
  const env = makeEnv();
  const s = await boot(env, { threads: [thread(SID, { card: 'EXT-20' }), thread(SID2, { card: 'EXT-21' })] });
  const a1 = await s.word('yes', 'EXT-20');
  const a2 = await s.word('go', 'EXT-20');
  const b1 = await s.word('yes', 'EXT-21');
  assert.equal(s.signals().length, 3);
  assert.equal((await s.press(WD(a1.id))).json().outcome, 'ok');
  assert.deepEqual(s.signals().sort(), [path.join(SID, `${a2.id}.ring`), path.join(SID2, `${b1.id}.ring`)].sort());
  assert.deepEqual((await s.bellGet(SID)).ids, [a2.id]);
  assert.deepEqual((await s.bellGet(SID2)).ids, [b1.id]);
  s.bellLog({ sid: SID, event: 'ring', ids: [a2.id] }); // ждущий забрал
  s.bellLog({ sid: SID2, event: 'ring', ids: [b1.id] });
  await s.app.pult.tick();
  assert.equal(s.server.filter(([k]) => k === 'bell').length, 0, 'ни forged, ни stale');
  assert.equal(s.lines().filter((l) => l.step === 'ring-delivered').map((l) => l.id).sort().join(), [a2.id, b1.id].sort().join());
  assert.equal((await s.rowOf(a1.id)).ring, 'отозвано');
});

// ---------------- (13) Б-слово ----------------

test('(13) Б-слово (merge): отзыв одним щелчком, без need-confirm, без приписки «Б — ждёт…»; Б-признак карточки после отзыва не снят — «Принять» скрыт', async () => {
  const s = await fresh();
  const first = (await s.press({ action: 'merge', card: 'EXT-22', q: { at: '2026-10-03T09:00:00.000Z', head: Q_MD } })).json();
  assert.equal(first.outcome, 'need-confirm', first.message);
  s.setPlane({ status: 'Review' });
  const m = (await s.press({ action: 'merge', card: 'EXT-22', q: { at: '2026-10-03T09:00:00.000Z', head: Q_MD }, confirm: first.id })).json();
  assert.equal(m.outcome, 'ok', m.message);
  const r = await s.press(WD(m.id));
  const b = r.json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.notEqual(b.outcome, 'need-confirm');
  assert.equal(s.lines().filter((l) => l.id === b.id && l.step === 'need-confirm' || l.id === b.id && l.step === 'confirmed').length, 0);
  const rec = s.pl().comments.at(-1).html;
  assert.ok(rec.includes(`«отозвать ${m.id}»`));
  assert.ok(!rec.includes('Б — ждёт'), 'приписки Б нет');
  assert.ok(rec.includes('«сливай»'));
  // файлы зеркала: вопрос, запись слова «сливай» (с припиской Б) и запись отзыва — карточка по-прежнему с Б-признаком
  const wordHtml = s.pl().comments.filter((c) => c.html.includes('«сливай»'))[0].html;
  const mk = (dir, bodies) => {
    const bd = makeBoard(tmpDir(dir), { codes: ['EXT'], cards: [{ id: 'EXT-22', status: 'review', title: 'Слияние' }] });
    fs.writeFileSync(path.join(bd, 'EXT', 'EXT-22.log.md'), bodies.map((x, i) => `### 2026-10-07 1${i}:00 +03:00 · plane · коммент\n\n${x}\n`).join('\n'));
    gitInitCommit(bd);
    return bd;
  };
  const stateOf = async (bd) => { const br = createBoardReader({ root: bd, git: createGitRead(), parseCard, parseLog, latest }); await br.init(); return acceptState(br.card('EXT-22'), null); };
  const withB = await stateOf(mk('ext71-b1-', [Q_MD, wordHtml, rec]));
  assert.equal(withB.can, false);
  assert.equal(withB.why, 'b-deal', 'запись отзыва не снимает Б-признак слова «сливай»');
  const control = await stateOf(mk('ext71-b2-', [Q_MD, rec]));
  assert.notEqual(control.why, 'b-deal', 'исправный рядом: без записи слова «сливай» признака Б нет');
});

// ---------------- (14) рестарт по промежуткам ----------------

test('(14) рестарт между asked и шагом 2 (фикстура actions.log): тот же intentId — «исход неизвестен»; новое нажатие пишет только запись; без карточки — not-queued', async () => {
  const s = await fresh();
  const w = await s.word();
  const k = nextIntent();
  const crashed = 'W-261007-130000-cccc';
  fs.appendFileSync(s.env.actionsLog, JSON.stringify({ id: crashed, at: new Date().toISOString(), action: 'withdraw', card: 'EXT-20', project: 'EXT', withdraws: w.id, mode: 'mirror', step: 'asked', client: { intentId: k } }) + '\n');
  const s2 = await boot(s.env); // старт: слово было в памяти — withdrawn: restart; сигнал снят
  assert.deepEqual(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').map((l) => l.reason), ['restart']);
  assert.equal(s2.signals().length, 0);
  const same = await s2.press(WD(w.id), k);
  assert.match(same.json().message, /исход неизвестен/);
  assert.equal(commentsOf(s2), 2, 'записи нет');
  const n = (await s2.press(WD(w.id))).json();
  assert.equal(n.outcome, 'ok', n.message);
  assert.equal(pultRecords(s2).filter((c) => c.html.includes('отозвать')).length, 1);
  assert.deepEqual(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').map((l) => l.reason), ['restart'], 'withdrawn: ivan не пишется — звонить некому');
  assert.equal((await s2.rowOf(w.id)).ring, 'сброшено перезапуском');
  assert.equal((await s2.rowOf(w.id)).withdrawnBy, n.id);
  // без карточки
  const t = await fresh();
  const rr = await rereadWord(t);
  fs.appendFileSync(t.env.actionsLog, JSON.stringify({ id: 'W-261007-130100-dddd', at: new Date().toISOString(), action: 'withdraw', project: 'EXT', withdraws: rr.id, mode: 'mirror', step: 'asked', client: { intentId: nextIntent() } }) + '\n');
  const t2 = await boot(t.env);
  const c = (await t2.press(WD(rr.id))).json();
  assert.equal(c.refusal, 'not-queued');
  assert.match(c.message, /снимать нечего/);
});

test('(14) рестарт между шагами 4 и 5 (plane.py висит на comment): тот же intentId — «исход неизвестен», новое нажатие пишет только запись, запись в Plane одна', async () => {
  const s = await fresh();
  const w = await s.word();
  s.env.hook.hang = 'comment-before';
  const k = nextIntent();
  const hung = s.press(WD(w.id), k);
  hung.catch(() => {});
  await until(() => s.lines().some((l) => l.id === w.id && l.step === 'withdrawn'));
  assert.equal(s.signals().length, 0, 'шаги 1–4 прошли');
  s.env.hook.hang = null;
  const s2 = await boot(s.env);
  assert.deepEqual(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').map((l) => l.reason), ['ivan'], 'старт withdrawn: ivan не затирает');
  assert.equal((await s2.rowOf(w.id)).ring, 'отозвано');
  assert.match((await s2.press(WD(w.id), k)).json().message, /исход неизвестен/);
  assert.equal(commentsOf(s2), 2);
  const n = (await s2.press(WD(w.id))).json();
  assert.equal(n.outcome, 'ok', n.message);
  assert.equal(pultRecords(s2).filter((c) => c.html.includes('отозвать')).length, 1);
  assert.equal(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').length, 1);
  assert.equal((await s2.press(WD(w.id))).json().refusal, 'already-withdrawn');
});

test('(14) рестарт во время записи, а запись легла: прежняя запись найдена по show --last — второй раз не пишется', async () => {
  const s = await fresh();
  const w = await s.word();
  s.env.hook.hang = 'comment-after'; // comment вышел в Plane, ответ не пришёл
  const hung = s.press(WD(w.id));
  hung.catch(() => {});
  await until(() => s.pl().comments.length === 3);
  s.env.hook.hang = null;
  const s2 = await boot(s.env);
  const n = (await s2.press(WD(w.id))).json();
  assert.equal(n.outcome, 'ok', n.message);
  assert.equal(commentsOf(s2), 3, 'запись одна — второй не легло');
  assert.equal(pultRecords(s2).filter((c) => c.html.includes('отозвать')).length, 1);
  assert.equal(cmds(s2.pl().calls).at(-1), 'show');
  // исправный рядом: прежняя запись не видна (поверх написал тред) — ляжет вторая, как сказано в риске 18 (е)
  const s3 = await fresh();
  const w3 = await s3.word();
  s3.env.hook.hang = 'comment-after';
  s3.press(WD(w3.id)).catch(() => {});
  await until(() => s3.pl().comments.length === 3);
  s3.env.hook.hang = null;
  s3.setPlane({ comments: [...s3.pl().comments, { id: 'c9', created_at: '2026-10-07T12:00:00.000Z', html: '<p>тред написал</p>' }] });
  const s4 = await boot(s3.env);
  assert.equal((await s4.press(WD(w3.id))).json().outcome, 'ok');
  assert.equal(pultRecords(s4).filter((c) => c.html.includes('отозвать')).length, 2);
});

// ---------------- (15) сброшено перезапуском, слово с карточкой ----------------

test('(15) сброшено перезапуском, слово с карточкой: отзыв только записью — звонка нет, сигналов нет; withdrawn: restart остаётся; повтор — already-withdrawn', async () => {
  const s = await fresh();
  const w = await s.word();
  const s2 = await boot(s.env);
  assert.equal((await s2.rowOf(w.id)).ring, 'сброшено перезапуском');
  const b = (await s2.press(WD(w.id))).json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.match(b.message, /запись об отзыве/);
  assert.equal(s2.signals().length, 0);
  assert.deepEqual(s2.lines().filter((l) => l.id === w.id && l.step === 'withdrawn').map((l) => l.reason), ['restart']);
  assert.equal(pultRecords(s2).filter((c) => c.html.includes(`«отозвать ${w.id}»`)).length, 1);
  const row = await s2.rowOf(w.id);
  assert.equal(row.ring, 'сброшено перезапуском');
  assert.equal(row.withdrawnBy, b.id);
  assert.equal((await s2.press(WD(w.id))).json().refusal, 'already-withdrawn');
});

// ---------------- каждый отказ — 200 и после рестарта ----------------

test('каждый отказ — 200 и при повторе тем же intentId после рестарта (no-target, not-withdrawable, not-queued, already-withdrawn, bell-off); card-busy — 409', async () => {
  const check = async (name, make, bootOpts = {}) => {
    const s = await fresh();
    const { target, s0 = s } = await make(s);
    const k = nextIntent();
    const r = await s0.press(WD(target), k);
    assert.equal(r.statusCode, 200, name);
    assert.equal(r.json().refusal, name);
    const s2 = await boot(s.env, bootOpts);
    const again = await s2.press(WD(target), k);
    assert.equal(again.statusCode, 200, `${name}: после рестарта 200, не 409`);
    assert.equal(again.json().outcome, 'refused');
    assert.equal(again.json().refusal, name);
    assert.equal(again.json().id, r.json().id);
    assert.equal(s2.lines().filter((l) => l.step === 'refused' && l.refusal === name).length, 1, 'второго действия нет');
    return { first: r.json(), again: again.json() };
  };
  await check('no-target', async () => ({ target: NOBODY }));
  await check('not-withdrawable', async (s) => ({ target: (await s.press({ action: 'ping' })).json().id }));
  await check('not-queued', async (s) => { const rr = await rereadWord(s); return { target: rr.id, s0: await boot(s.env) }; });
  const aw = await check('already-withdrawn', async (s) => { const w = await s.word(); const b = (await s.press(WD(w.id))).json(); return { target: w.id, prior: b.id }; });
  assert.ok(aw.first.id.startsWith('W-') && aw.again.id === aw.first.id);
  await check('bell-off', async (s) => { const w = await s.word(); const off = await boot(s.env, { bell: false }); return { target: w.id, s0: off }; }, { bell: false });
});
