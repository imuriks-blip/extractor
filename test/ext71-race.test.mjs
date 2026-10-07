// «Отозвать», такт 1 (EXT-71, §1.9): гонка отзыва с доставкой (контроль 1 гейта ПТ7б), ложный forged (2), поздний ring после рестарта (16),
// сбой шага 2 (Важно 4), «ни одного await до шага 4» — поведенчески, снятие по actionId в сессии (Мелочь). Ожидания — из спеки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBell, ringText } from '../lib/pult/bell.mjs';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { tmpDir } from './helpers.mjs';
import { Q, SID, boot, makeEnv, nextIntent, stepsOf, thread, uuid } from './ext71-harness.mjs';

const WD = (target) => ({ action: 'withdraw', target });
const fresh = async (opts = {}) => boot(makeEnv(), { threads: [thread(SID, { card: 'EXT-20' })], ...opts });
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('не дождался'); await new Promise((r) => setTimeout(r, 15)); } };

// форма звонка в журнале треда (как в ext65-reread.test.mjs): разбор журнала читателем даёт rings {номер → время}
const ringJournalLine = (text) => ({ parentUuid: null, isSidechain: false, type: 'user', uuid: uuid(77), timestamp: '2026-10-07T10:02:00.000Z',
  message: { role: 'user', content: `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${text}\n</system-reminder>` },
  origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', userType: 'external', entrypoint: 'claude-desktop', sessionId: SID, version: '2.1.286' });
const journalRings = (id) => {
  const st = newSessionState();
  feedSession(st, ringJournalLine(ringText([{ id, at: '2026-10-07T10:00:00.000Z', action: 'yes', card: 'EXT-20', word: 'да', q: Q }])));
  assert.ok(st.rings[id], 'фикстура: звонок с этим номером разобран как «прочитано»');
  return st.rings;
};

// ---------------- (1) гонка ----------------

test('(1) гонка: ждущий забрал слово в GET, отзыв, потом строка ring → «отозвано поздно: доставлено» сразу в памяти, ring-delivered с late: true — следом на такте, один раз', async () => {
  const s = await fresh();
  const w = await s.word();
  assert.deepEqual((await s.bellGet(SID)).ids, [w.id], 'ждущий получил слово в ответе GET');
  const b = (await s.press(WD(w.id))).json();
  assert.equal(b.outcome, 'ok', b.message);
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано', 'строки ring ещё нет');
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] }); // ждущий дозаписал ring
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано поздно: доставлено', 'сразу, не дожидаясь такта');
  assert.equal(s.lines().some((l) => l.id === w.id && l.step === 'ring-delivered'), false, 'шаг — только на такте');
  await s.app.pult.tick();
  await s.app.pult.tick();
  const rd = s.lines().filter((l) => l.id === w.id && l.step === 'ring-delivered');
  assert.equal(rd.length, 1);
  assert.equal(rd[0].late, true);
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано поздно: доставлено');
  assert.equal(s.server.filter(([k]) => k === 'bell').length, 0);
  // исправный рядом: ring по неотозванному слову — обычный ring-delivered без late
  const u = await s.word('go');
  s.bellLog({ sid: SID, event: 'ring', ids: [u.id] });
  await s.app.pult.tick();
  const ud = s.lines().find((l) => l.id === u.id && l.step === 'ring-delivered');
  assert.ok(ud);
  assert.equal(ud.late, undefined);
  assert.equal((await s.rowOf(u.id)).ring, 'доставлено');
});

test('(1) гонка внутри записи: ring ложится, пока пишется карточка (шаг 5) — после повторной дочитки исход ok с красным «отозвано поздно: доставлено»', async () => {
  const s = await fresh();
  const w = await s.word();
  let release;
  s.env.hook.gate = new Promise((r) => { release = r; });
  s.env.hook.hang = 'comment-gate';
  const p = s.press(WD(w.id));
  await until(() => s.lines().some((l) => l.id === w.id && l.step === 'withdrawn'));
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] });
  release();
  const r = await p;
  const b = r.json();
  assert.equal(r.statusCode, 200);
  assert.equal(b.outcome, 'ok');
  assert.match(b.message, /^отозвано поздно: доставлено — тред слово получил, скажи ему в чате/);
  assert.equal(s.pl().comments.filter((c) => c.html.includes('отозвать')).length, 1, 'запись на карточку всё равно легла');
  await s.app.pult.tick();
  assert.equal(s.lines().find((l) => l.id === w.id && l.step === 'ring-delivered').late, true);
});

test('(1) гонка без карточки: поздний ring по слову без записи — исход тоже красный, записи на доске нет', async () => {
  const env = makeEnv();
  const s = await boot(env, { threads: [thread(SID, { card: 'EXT-20', marks: [{ kind: 'oldRules', rulesUpdatedAt: '2026-10-05T10:00:00.000Z', missing: [{ path: 'C:\\V\\a.md', short: 'a.md' }] }] })] });
  const rr = (await s.press({ action: 'reread', session: SID })).json();
  assert.equal(rr.outcome, 'ok', rr.message);
  const num = rr.id;
  // ждущий дописал ring между GET и отзывом? нет — после шага 4, до исхода: дочитка шага 6 видит его (карточки нет — сразу после шага 4)
  const orig = fs.unlinkSync;
  fs.unlinkSync = (f, ...a) => { const r = orig(f, ...a); if (String(f).endsWith('.ring')) s.bellLog({ sid: SID, event: 'ring', ids: [num] }); return r; };
  let b;
  try { b = (await s.press(WD(num))).json(); } finally { fs.unlinkSync = orig; }
  assert.equal(b.outcome, 'ok');
  assert.match(b.message, /^отозвано поздно: доставлено/);
  assert.equal(s.pl().comments.length, 1, 'в Plane ничего');
});

test('(1) «прочитано»: форма звонка с этим номером в журнале треда → «отозвано поздно: прочитано» (раньше прочих проверок), и то же после рестарта; без формы — «отозвано»', async () => {
  const s = await fresh();
  const w = await s.word();
  const c = await s.word('go');
  const b = (await s.press(WD(w.id))).json();
  assert.equal(b.outcome, 'ok');
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано', 'контроль: журнал пока без формы звонка');
  s.env.sessions = [{ sessionId: SID, rings: journalRings(w.id) }];
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано поздно: прочитано');
  // прочитано проверяется раньше поздней доставки
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] });
  assert.equal((await s.rowOf(w.id)).ring, 'отозвано поздно: прочитано');
  // чужое слово тем же журналом не затронуто
  assert.equal((await s.rowOf(c.id)).ring, 'положено');
  // после рестарта сервера
  const s2 = await boot(s.env);
  assert.equal((await s2.rowOf(w.id)).ring, 'отозвано поздно: прочитано');
  assert.equal((await s2.rowOf(c.id)).ring, 'сброшено перезапуском');
});

// ---------------- (2) ложный forged ----------------

test('(2) ложный forged: ждущий снял список до шага 4, отзыв, GET, ждущий пишет forged по номеру — в server.log stale; исправный рядом — выдуманный номер → forged', async () => {
  const s = await fresh();
  const w = await s.word();
  const keep = await s.word('go');
  const b = (await s.press(WD(w.id))).json(); // сигнал w снят шагом 4
  assert.equal(b.outcome, 'ok');
  assert.deepEqual((await s.bellGet(SID)).ids, [keep.id], 'в ответе номера w нет');
  s.bellLog({ sid: SID, event: 'forged', ids: [w.id] }); // ждущий видел сигнал в своём списке, а слова в ответе нет
  s.bellLog({ sid: SID, event: 'forged', ids: ['W-261007-120000-beef'] }); // исправный рядом: сигнал с выдуманным номером
  await s.bellGet(SID); // дочитка
  const bell = s.server.filter(([k]) => k === 'bell').map(([, o]) => o);
  assert.deepEqual(bell, [{ event: 'stale', sid: SID, id: w.id }, { event: 'forged', sid: SID, id: 'W-261007-120000-beef' }]);
});

// ---------------- Важно 4: шаг 2 бросающий, ни одного await до шага 4 ----------------

test('Важно 4: сбой записи шага withdrawn — исход error, память и сигнал целы, слово дойдёт как обычно, Plane не тронут', async () => {
  const s = await fresh();
  const w = await s.word();
  const orig = fs.appendFileSync;
  fs.appendFileSync = (f, data, ...a) => {
    if (String(f).endsWith('actions.log') && String(data).includes('"step":"withdrawn"')) throw Object.assign(new Error('диск'), { code: 'EIO' });
    return orig(f, data, ...a);
  };
  let r;
  try { r = await s.press(WD(w.id)); } finally { fs.appendFileSync = orig; }
  const b = r.json();
  assert.equal(r.statusCode, 200);
  assert.equal(b.outcome, 'error');
  assert.match(b.message, /не вышло/);
  assert.equal(s.signals().length, 1, 'сигнал цел');
  assert.deepEqual((await s.bellGet(SID)).ids, [w.id], 'память цела — слово дойдёт как обычно');
  assert.equal(s.pl().comments.length, 2, 'в Plane записи нет');
  assert.equal(s.lines().some((l) => l.step === 'withdrawn'), false);
  assert.equal((await s.press(WD(w.id))).json().outcome, 'ok', 'исправный рядом: без сбоя журнала отзыв идёт');
});

test('Важно 4: в обработчике до шага 4 включительно нет await — микрозадача и такт цикла событий, поставленные при asked, срабатывают только после withdrawn и снятия сигнала', async () => {
  const s = await fresh();
  const w = await s.word();
  const order = [];
  const oa = fs.appendFileSync;
  const ou = fs.unlinkSync;
  fs.appendFileSync = (f, data, ...a) => {
    const d = String(data);
    if (String(f).endsWith('actions.log') && d.includes('"action":"withdraw"') && d.includes('"step":"asked"')) {
      queueMicrotask(() => order.push('microtask'));
      process.nextTick(() => order.push('nextTick'));
      setImmediate(() => order.push('immediate'));
      order.push('asked');
    }
    if (String(f).endsWith('actions.log') && d.includes('"step":"withdrawn"')) order.push('withdrawn');
    return oa(f, data, ...a);
  };
  fs.unlinkSync = (f, ...a) => { if (String(f).endsWith('.ring')) order.push('unlink'); return ou(f, ...a); };
  try { assert.equal((await s.press(WD(w.id))).json().outcome, 'ok'); } finally { fs.appendFileSync = oa; fs.unlinkSync = ou; }
  assert.deepEqual(order.slice(0, 3), ['asked', 'withdrawn', 'unlink'], 'шаги 2 и 4 идут подряд');
  assert.deepEqual(order.slice(3).sort(), ['immediate', 'microtask', 'nextTick'], 'отложенные задачи — только после шага 4');
});

test('Важно 4: параллельные GET /api/bell и второй отзыв, пущенные вместе с отзывом, видят слово либо целым, либо снятым — ждущий не получает слово без сигнала', async () => {
  const s = await fresh();
  const w = await s.word();
  const [a, g1, g2, b] = await Promise.all([s.press(WD(w.id)), s.bellGet(SID), s.bellGet(SID), s.press(WD(w.id))]);
  assert.equal([a.json(), b.json()].filter((x) => x.outcome === 'ok').length, 1, 'ровно один отзыв прошёл');
  assert.equal([a.json(), b.json()].filter((x) => x.refusal === 'already-withdrawn' || x.refusal === 'card-busy').length, 1);
  for (const g of [g1, g2]) assert.ok(g.ids.length === 0 || (g.ids.length === 1 && g.ids[0] === w.id));
  assert.deepEqual((await s.bellGet(SID)).ids, []);
  assert.equal(s.signals().length, 0);
});

// ---------------- Мелочь: снимать по actionId в сессии, сигнал — если номера больше нет ----------------

test('снятие по actionId в сессии: один и тот же номер слова дважды в памяти — отзыв одного оставляет второе и сигнал; сигнал уходит с последним', () => {
  const dir = tmpDir('ext71-bell-');
  const steps = [];
  const bell = createBell({ dir, onStep: (l) => steps.push(l) });
  const N = 'W-261007-120000-aaaa';
  const A1 = 'W-261007-120000-1111';
  const A2 = 'W-261007-120100-2222';
  const mk = (actionId) => ({ id: N, actionId, at: '2026-10-07T12:00:00.000Z', action: 'yes', card: 'EXT-20', word: 'да', q: Q });
  assert.deepEqual(bell.queue(SID, mk(A1)), { ok: true });
  assert.deepEqual(bell.queue(SID, mk(A2)), { ok: true });
  const sig = path.join(dir, SID, `${N}.ring`);
  assert.ok(fs.existsSync(sig));
  assert.equal(bell.queued(), 2);
  assert.deepEqual(bell.withdraw(SID, { actionId: A1, word: N, action: 'yes', card: 'EXT-20' }), { removed: 1 });
  assert.equal(bell.queued(), 1, 'второе слово с тем же номером осталось');
  assert.ok(fs.existsSync(sig), 'сигнал остался: иначе ждущий найдёт слово без сигнала');
  assert.equal(bell.holds(SID, A2), true);
  assert.equal(bell.holds(SID, A1), false);
  assert.deepEqual(bell.withdraw(SID, { actionId: A2, word: N, action: 'yes', card: 'EXT-20' }), { removed: 1 });
  assert.equal(fs.existsSync(sig), false, 'номера в памяти больше нет — сигнал снят');
  assert.equal(bell.queued(), 0);
  // чужая сессия не тронута
  const OTHER = uuid(900);
  bell.queue(OTHER, mk('W-261007-120200-3333'));
  bell.withdraw(SID, { actionId: 'W-261007-120200-3333', word: N });
  assert.equal(bell.queued(), 1, 'отзыв в сессии SID не снимает слова сессии OTHER');
});

// ---------------- (16) поздний ring после рестарта ----------------

test('(16) поздний ring после рестарта: старт пишет ring-delivered с late: true по слову с withdrawn: ivan; статус — «отозвано поздно: доставлено»; один раз', async () => {
  const s = await fresh();
  const w = await s.word();
  const quiet = await s.word('go');
  const b = (await s.press(WD(w.id))).json();
  assert.equal(b.outcome, 'ok');
  s.bellLog({ sid: SID, event: 'ring', ids: [w.id] }); // ждущий записал ring, сервер уже остановили (такт не прошёл)
  assert.equal(s.lines().some((l) => l.id === w.id && l.step === 'ring-delivered'), false);
  const s2 = await boot(s.env);
  const rd = s2.lines().filter((l) => l.id === w.id && l.step === 'ring-delivered');
  assert.equal(rd.length, 1);
  assert.equal(rd[0].late, true);
  assert.equal((await s2.rowOf(w.id)).ring, 'отозвано поздно: доставлено');
  assert.deepEqual(stepsOf(s2.lines(), w.id).filter((x) => x === 'withdrawn'), ['withdrawn'], 'withdrawn: ivan не затёрт restart-ом');
  // ещё рестарт — второго ring-delivered нет
  const s3 = await boot(s.env);
  assert.equal(s3.lines().filter((l) => l.id === w.id && l.step === 'ring-delivered').length, 1);
  assert.equal((await s3.rowOf(w.id)).ring, 'отозвано поздно: доставлено');
  // исправный рядом: отозванное слово без ring — поздней доставки нет; неотозванное — обычный restart
  const s4 = await fresh();
  const w4 = await s4.word();
  await s4.press(WD(w4.id));
  const s5 = await boot(s4.env);
  assert.equal(s5.lines().some((l) => l.id === w4.id && l.step === 'ring-delivered'), false);
  assert.equal((await s5.rowOf(w4.id)).ring, 'отозвано');
  assert.equal(quiet.outcome, 'ok');
  void nextIntent;
});
