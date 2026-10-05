// Ручки пульта (спека пульта §1.1, §1.7, §4.3): вход POST /api/act и ручки чтения. Защита §4.1 — раньше, в
// onRequest (guard.mjs). Здесь — флаг pult.enabled, словарь и параметры, флаг pult.words, intentId, лимиты,
// строки asked → done/error в actions.log. Ни одна GET-ручка не меняет состояние (§4.2).
// pult — то, что приходит из config.json (флаги, пути); seams — подмены только для тестов (обработчики,
// исполнитель Plane, часы, запуск процесса): из конфига их не задать.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, HANDLERS, UUID_RE, cleanText, validate } from './actions.mjs';
import { actionId, actionRows, createActionsLog, lastStepLine, localIso } from './actions-log.mjs';
import { createMirrorRunner, wscriptPath } from './mirror-run.mjs';
import { createPlaneQueue } from './queue.mjs';
import { MARK_ACTIONS, acceptState, createAcceptHandlers, createCardPull, createMergeCheck, createPlaneSpawn, localMarks, markCandidates, needsGit, readRuns } from './accept.mjs';
import { rowMarkKey, rowMarks as rowMarksOf } from './row-marks.mjs';
import { validCardId, validCode } from '../params.mjs';
import { createDeferStore, deferOptions, findRow, untilLabel, untilOf } from './defer.mjs';
import { REREAD_WORD, clipNote, createBell, pickThread, ringBatch, ringText } from './bell.mjs';
import { newestReread } from './reread-last.mjs';
import { WORD_ACTIONS, createWordHandlers, wordQOk } from './words.mjs';
import { createLockCounter } from '../../bell/waiter.mjs';

export const BODY_LIMIT = 8192;
export const INTENT_MS = 10 * 60000;
export const RATE = { perMin: 30 };
export const REREAD_MS = 10 * 60000; // «Перечитать правила»: положено или доставлено моложе 10 минут (время — шаг ring-delivered), пометка не снята — второго звонка нет; «прочитано» окно не снимает (§1.8)
const DAY_MS = 86400000;
// код отказа по слову причины — для исхода, восстановленного из actions.log после рестарта
// отказы сверки и проверок «Принять»/«Вернуть» (ПТ3) — исход действия, 200 с outcome refused
const REFUSAL_CODE = { 'rate-limit': 429, 'card-busy': 409, 'mirror-running': 409,
  'stale-status': 200, 'new-question': 200, secret: 200, 'secret-maybe': 200, 'not-merged': 200, 'b-deal': 200, 'not-review': 200, 'no-card': 200, 'no-row': 200, 'key-temp': 200,
  // слова (ПТ6): карточка закрыта, тред закрыт, подтверждение не то / просрочено, звонок выключен у ответа без карточки
  closed: 200, 'thread-closed': 200, 'bad-confirm': 200, 'confirm-expired': 200, 'bell-off': 200, 'thread-card': 200,
  // «Перечитать правила» (EXT-65, §1.8): исход действия, а не ошибка запроса — 200 с outcome refused, иначе незнакомое имя дало бы 409
  // (thread-closed и bell-off — те же, что у слов ПТ6)
  'no-mark': 200, 'reread-off': 200, 'already-read': 200, queued: 200 };
// исход обработчика → шаг actions.log (§3.4)
const STEP_OF = { ok: 'done', partial: 'partial', error: 'error' };
const errCode = (e) => (typeof e?.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'ERR');

// режим записи (§3.4 `mode`): board.config.json доски; не читается или режима нет — mirror
export function boardMode(root) {
  if (!root) return 'mirror';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'board.config.json'), 'utf8'))?.mode;
    return m === 'live' ? 'live' : 'mirror';
  } catch { return 'mirror'; }
}

// Ключи намерений последних 10 мин из actions.log (§1.1 п.3): после рестарта тот же intentId — прежний исход.
// asked без строки исхода (оборвано рестартом) — исход неизвестен, действие не повторяется.
export function restoreIntents(lines, now) {
  const byId = new Map();
  for (const l of lines) if (typeof l?.id === 'string') byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  const out = new Map();
  for (const [id, ls] of byId) {
    const first = ls.find((l) => l.step === 'asked' || l.step === 'refused');
    const intentId = first?.client?.intentId;
    const at = Date.parse(first?.at);
    if (typeof intentId !== 'string' || !Number.isFinite(at) || now - at >= INTENT_MS) continue;
    const last = lastStepLine(ls);
    let res;
    if (last.step === 'partial') res = { code: 200, body: { id, step: 'partial', outcome: 'partial', message: 'частично (по журналу): запись есть, статус не сменился — повторить' } };
    else if (last.step === 'done') res = { code: 200, body: { id, step: 'done', outcome: last.result?.outcome ?? 'ok', message: 'уже исполнено (по журналу)' } };
    else if (last.step === 'refused') res = { code: REFUSAL_CODE[last.refusal] ?? 409, body: { id, step: 'refused', outcome: 'refused', message: 'уже отказано (по журналу)' } };
    else if (last.step === 'need-confirm') res = { code: 200, body: { id, step: 'need-confirm', outcome: 'need-confirm', message: 'ждёт второго щелчка (по журналу)', ...(last.bdeal ? { bdeal: last.bdeal } : {}), confirm: last.confirm } };
    else if (last.step === 'error' && last.result?.code === 'UNCLEAR') res = { code: 200, body: { id, step: 'error', outcome: 'error', message: 'исход неясен (по журналу): запись могла лечь — повтори, перед записью будет сверка' } };
    else if (last.step === 'error' && last.result?.outcome === 'error') res = { code: 200, body: { id, step: 'error', outcome: 'error', message: 'не исполнено (по журналу) — повторить' } };
    else if (last.step === 'error') res = { code: 500, body: { id, step: 'error', outcome: 'error', message: `ошибка: ${last.result?.code ?? 'ERR'}` } };
    else res = { code: 500, body: { id, step: last.step, outcome: 'error', message: 'исход неизвестен: действие прервано рестартом витрины' } };
    out.set(intentId.toLowerCase(), { at, promise: Promise.resolve(res) });
  }
  return out;
}

// последний запуск зеркала по actions.log (строка done с outcome ok): {at, kind, id, recorded — есть ли уже строка error}
export function lastMirrorLaunch(lines) {
  let last = null;
  for (const l of lines) if (l?.action === 'mirror' && l.step === 'done' && l.result?.outcome === 'ok' && typeof l.id === 'string') last = l;
  const at = Date.parse(last?.at);
  if (!last || !Number.isFinite(at)) return null;
  const asked = lines.find((l) => l?.id === last.id && l.step === 'asked');
  return { at, kind: asked?.kind ?? 'changed', id: last.id, recorded: lines.some((l) => l?.id === last.id && l.step === 'error') };
}

// board, registry, merge (createMergeCheck, считает проход читателя git), scan — для «Принять»/«Вернуть» (ПТ3): карточка по зеркалу, ветки проекта, секрет в тексте;
// waitingNow — «Ждёт меня» как в /api/ceh (под маской, после отметок «Отложить», с deferred[]) — для defer (EXT-47)
// слова (ПТ6): sessionsNow — выжимки журналов тредов (последний вопрос треда — сверка ответа строки (а), 1.1 п.6)
// звонок (ПТ4а, EXT-63): threadsNow — живые треды (строки «Кто работает»), liveSids — Set живых sessionId или null (реестр
// процессов не читается), ringsRead — Map sessionId → {id звонка → время} из журналов (форма звонка, «прочитано»)
export function registerPult(app, { hasCode, maskRow, pult = {}, seams = {}, serverLog = { write() {} }, board = null, registry = null, merge: mergeIn = null, scan = null, waitingNow = () => ({}),
  threadsNow = () => [], liveSids = () => null, ringsRead = () => new Map(), sessionsNow = () => [], rulesNoteNow = () => null }) {
  const enabled = pult.enabled === true;
  const words = pult.words === true;
  const bellOn = pult.bell === true; // звонок (§4.3, флаг pult.bell): false — ни слов в памяти, ни сигналов, ни шагов ring-*
  const now = seams.now ?? Date.now;
  const log = createActionsLog(pult.actionsLog ?? null);
  const lines0 = pult.actionsLog ? log.read() : [];
  // «Прогони зеркало» (EXT-42): журнал задачи — data/vitrina/mirror-run.log рядом с actions.log
  const mirror = createMirrorRunner({ boardRoot: pult.boardRoot ?? null, mirrorDir: pult.mirrorDir ?? null, lock: pult.lock ?? null,
    logFile: pult.actionsLog ? path.join(path.dirname(pult.actionsLog), 'mirror-run.log') : null, now, restore: lastMirrorLaunch(lines0),
    ...(seams.spawn ? { spawn: seams.spawn } : {}) });
  // тихий сбой прежнего запуска (проход не стартовал) — строкой error его id при следующем нажатии; GET не пишет
  const mirrorAct = (ctx) => {
    const f = mirror.takeFailure();
    if (f) appendAfter({ id: f.id, step: 'error', at: localIso(new Date(now())), action: 'mirror', mode: boardMode(pult.boardRoot),
      result: { code: 'NOT_STARTED', exit: f.exit, ...(f.line ? { line: maskRow({ text: f.line }, null).text } : {}) } });
    return mirror.act(ctx);
  };
  // plane.py — путь из настроек (pult.planePy, start.mjs); нет пути — очередь отказывает, ничего не запуская
  const planeRun = seams.planeRun ?? (pult.planePy ? createPlaneSpawn({ python: pult.python ?? 'python', planePy: pult.planePy }) : null);
  const plane = createPlaneQueue(planeRun ? { run: planeRun } : {});
  // «Принять»/«Вернуть» (ПТ3): ветка карточки слита ли (В7), дотяжка --card, местная отметка
  // слита ли ветка (EXT-57) — считает проход читателя git (start.mjs), сюда приходит готовый; нет — git нет, условие не мешает
  const merge = mergeIn ?? createMergeCheck({ git: null, registry });
  const cardPull = createCardPull({ boardRoot: pult.boardRoot ?? null, mirrorDir: pult.mirrorDir ?? null, running: () => mirror.state().running,
    logFile: pult.actionsLog ? path.join(path.dirname(pult.actionsLog), 'mirror-card.log') : null, wscript: wscriptPath(), now,
    ...(seams.spawn ? { spawn: seams.spawn } : {}) });
  cardPull.restore(lines0); // очередь дотяжки и время своих --card переживают рестарт (мелочь 7)
  const runsFile = pult.mirrorDir ? path.join(pult.mirrorDir, 'runs.log') : null;
  const readLog = (id) => (board?.readLog ? board.readLog(id) : { entries: [] });
  // lines — уже прочитанный actions.log (такт читает его раз); без них — чтение здесь
  // EXT-70: отметки одной формы на все действия — ring (статус звонка 2.8) считается у последнего действия по карточке / строке
  const ringOfMarks = () => { let read = null; return (ls) => ringStatus(() => (read ??= ringsRead()))(ls); };
  const markArgs = (lines) => ({ lines: lines ?? log.read(), readLog, runs: runsFile ? readRuns(runsFile) : [], now: now(), launches: cardPull.launches() });
  const marks = (lines = null) => (board && pult.actionsLog ? localMarks({ ...markArgs(lines), ring: ringOfMarks() }) : new Map());
  // отметка строки (а) «Ждёт меня»: ключ — session|q.uuid (rowMarkKey); не зависит от доски
  const rowMarks = (lines = null) => (pult.actionsLog ? rowMarksOf({ lines: lines ?? log.read(), ring: ringOfMarks() }) : new Map());
  const acceptHandlers = board ? createAcceptHandlers({ board, merge, mirror: cardPull, readLines: () => log.read(), mask: (t) => maskRow({ text: t }, null).text, now, ring: (ctx) => ringFor(ctx) }) : {};
  // слова (ПТ6): запись на карточку, звонок, Б-дело; без доски обработчиков нет — 501, как у остальных
  const wordHandlers = board ? createWordHandlers({ board, readLines: () => log.read(), mask: (t) => maskRow({ text: t }, null).text, maskP: (t, project) => maskRow({ text: t }, project).text, now, mirror: cardPull,
    ring: (ctx) => ringFor(ctx), bellOn: () => !!bell, threadsNow, sessionsNow }) : {};
  // «Отложить до …» (EXT-47): отметки — data/vitrina/defer.json рядом с actions.log; в Plane ничего
  const defer = createDeferStore({ file: pult.actionsLog ? path.join(path.dirname(pult.actionsLog), 'defer.json') : null, now, ...(seams.deferFs ? { fs: seams.deferFs } : {}),
    onError: (e) => serverLog.write('error', { route: 'defer.json', code: typeof e?.code === 'string' ? e.code : 'ERR' }) });
  const deferHandlers = {
    // строка должна быть в «Ждёт меня» сейчас (видна или уже отложена — тогда срок новый); нет — отказ no-row
    // строка с временным ключом (keyTemp, вопрос ещё не дочитан из журнала) — отказ key-temp: ключ сменится, отметка
    // по старому повисла бы. Запись defer.json не удалась — «не вышло», отметки как были (М5)
    defer: async (ctx) => {
      const found = findRow(waitingNow(), ctx.rowKey);
      if (!found) return { outcome: 'refused', refusal: 'no-row', message: 'строки уже нет в «Ждёт меня» — обнови витрину' };
      if (found.row.keyTemp) return { outcome: 'refused', refusal: 'key-temp', message: 'строку ещё нельзя отложить: вопрос треда пока не дочитан из журнала — попробуй через минуту' };
      const until = untilOf(ctx.until, now());
      try { defer.set(ctx.rowKey, until, ctx.id, found.group); } catch (e) {
        return { outcome: 'error', message: 'не вышло: отметка не записалась — строка не отложена', result: { code: errCode(e) } };
      }
      return { outcome: 'ok', message: `отложено до ${untilLabel(until)}`, result: { until: localIso(new Date(until)) } };
    },
    undefer: async (ctx) => {
      let had;
      try { had = defer.remove(ctx.rowKey); } catch (e) {
        return { outcome: 'error', message: 'не вышло: отметка не снялась — строка ещё отложена', result: { code: errCode(e) } };
      }
      return had ? { outcome: 'ok', message: 'вернулось в «Ждёт меня»' } : { outcome: 'ok', message: 'отметки уже нет — строка в «Ждёт меня», если она ещё есть' };
    },
  };
  const handlers = { ...HANDLERS, mirror: mirrorAct, ...acceptHandlers, ...wordHandlers, ...deferHandlers, reread: (ctx) => rereadAct(ctx), ...(seams.handlers ?? {}) };
  const intents = restoreIntents(lines0, now()); // intentId → {at, promise: {code, body}}
  const softOk = new Map(); // «это не секрет» (класс 5): номер отказа → {action, card, hmac, at}; в памяти, не в журнале
  const hmacKey = crypto.randomBytes(16);
  const hmacOf = (text) => crypto.createHmac('sha256', hmacKey).update(text).digest('hex');
  const started = []; // время начала действий — лимит 30 в минуту
  const busy = new Set(); // карточки, по которым идёт действие

  const refuse = (code, message, extra = {}) => ({ code, body: { id: null, step: null, outcome: 'refused', message, ...extra } });
  // строка исхода после обработчика: сбой журнала не меняет исход Ивану — код в server.log
  const appendAfter = (line) => {
    try { log.append(line); } catch (e) { serverLog.write('error', { route: 'actions.log', code: typeof e?.code === 'string' ? e.code : 'ERR' }); }
  };

  // Звонок (раздел 2): слова в памяти этого запуска, сигналы в pult.bellDir, bell.log ждущего. Только при pult.bell.
  // Старт: сигналы прочь, прежние ring-queued без исхода — withdrawn: restart (2.2 «Цена»)
  const bell = bellOn && pult.bellDir ? createBell({ dir: pult.bellDir, now, live: liveSids,
    onStep: (l) => appendAfter({ id: l.id, step: l.step, at: localIso(new Date(now())), action: l.action, ...(l.card ? { card: l.card } : {}), mode: boardMode(pult.boardRoot), ...(l.reason ? { reason: l.reason } : {}) }),
    // forged по незнакомому id — тревога (Г-П2 (в)); stale — остаток гонки ждущего (2.2)
    onForged: (f) => serverLog.write('bell', { event: f.kind, sid: f.sid, id: f.id }) }) : null;
  // счётчик живых замков — один на запуск: проверенные пары pid|procStart не перепроверяются (PowerShell — за новые)
  const countWaiters = seams.countWaiters ?? createLockCounter().count;
  let waitersNow = null; // до первого счёта — null
  let waitersBusy = false;
  if (bell) { try { bell.start(lines0); } catch (e) { serverLog.write('error', { route: 'bell', code: errCode(e) }); } }
  const titleOf = (t) => maskRow({ text: t.title ?? t.sessionId }, null).text;
  // звонок у «Вернуть» (таблица 1.3, §2.3): после записи и смены статуса; кого будить — 2.3; «несколько» — пока отказ
  // звонка с перечнем (выбор Ивана в подтверждении — с вёрсткой); текст слова — «<ID> возвращена Иваном: <причина>»
  // номер слова — номер записи на карточке (record; при повторе частичного исхода — прежний), шаги — у действия (id).
  // Сбой выбора треда или имени треда — состояние звонка error, действие остаётся done (карточка уже вернулась).
  // ПТ6: слова — то же, но слово и текст звонка приходят от действия (word, text — уже по 2.6), строка (а) — session
  // (правило 2.3 п.1, карточки может не быть: «без карточки»), pick — тред, выбранный Иваном среди нескольких (2.3 п.4)
  function ringFor({ id, record = id, action, card = null, session = null, pick = null, q, word = 'вернуть', text, step, paths, note }) {
    if (!bell) return { message: 'звонок выключен: тред увидит на карточке', result: { state: 'off' } };
    try { return ringPick({ id, record, action, card, session, pick, q, word, text, step, paths, note }); } catch (e) {
      return { message: 'звонок не положен: сбой выбора треда; тред увидит на карточке', result: { state: 'error', code: errCode(e) } };
    }
  }
  function ringPick({ id, record, action, card, session, pick: want, q, word, text, step, paths, note }) {
    const code = card ? card.split('-')[0] : null;
    let pick = pickThread({ threads: threadsNow(), card, session, now: now() });
    if (pick.kind === 'many' && want) { const c = pick.candidates.find((x) => x.sessionId === want); if (c) pick = { kind: 'one', target: c }; }
    if (pick.kind === 'closed') return { message: 'тред закрыт — слово не доставлено', result: { state: 'thread-closed' } };
    if (pick.kind === 'none') return { message: `нет живого треда ${code}; карточка в работе, тред увидит при открытии`, result: { state: 'no-thread' } };
    if (pick.kind === 'many') {
      const list = pick.candidates.map((c) => `«${titleOf(c)}»${c.by === 'cards' ? ' (по карточкам)' : ''}${c.staleMin !== null ? ` (нет вестей ${c.staleMin} мин)` : ''}`).join(', ');
      return { message: `живых тредов ${code} несколько: ${list} — звонка нет: выбор треда в подтверждении ещё не сделан; карточка в работе, тред увидит при открытии`,
        result: { state: 'many', candidates: pick.candidates.map((c) => c.sessionId) } };
    }
    const t = pick.target;
    let r;
    try { r = bell.queue(t.sessionId, { id: record, actionId: id, at: localIso(new Date(now())), action, card, word, text, q, ...(paths ? { paths } : {}), ...(note ? { note } : {}) }); } catch (e) {
      return { message: 'звонок не положен: сигнал не записался; тред увидит на карточке', result: { state: 'error', code: errCode(e) } };
    }
    if (!r.ok) return { message: `очередь треда «${titleOf(t)}» полна — звонка нет; тред увидит на карточке`, result: { state: 'queue-full' } };
    step({ step: 'ring-queued', ...(record !== id ? { word: record } : {}), target: { sessionId: t.sessionId, title: titleOf(t), by: t.by, ...(t.staleMin !== null ? { staleMin: t.staleMin } : {}) } });
    return { message: `тред «${titleOf(t)}»: положено — тред услышит, когда закончит ход${t.staleMin !== null ? ` (нет вестей ${t.staleMin} мин)` : ''}`, result: { state: 'queued' } };
  }
  // статус слова звонка (2.8) по строкам действия; «прочитано» — форма звонка с этим id в журнале треда (внешний след)
  const ringStatus = (read) => (ls) => {
    const qd = ls.find((l) => l.step === 'ring-queued');
    if (!qd) return ls.find((l) => l.step === 'done')?.result?.ring?.state === 'off' ? 'звонок выключен' : null;
    const w = ls.find((l) => l.step === 'withdrawn');
    if (w) return w.reason === 'restart' ? 'сброшено перезапуском' : w.reason === 'thread-closed' ? 'не доставлено: тред закрыт' : 'отозвано';
    const wid = qd.word ?? qd.id; // номер слова в звонке (record), если он не номер действия
    if (read().get(qd.target?.sessionId)?.[wid]) return 'прочитано';
    if (ls.some((l) => l.step === 'ring-delivered')) return 'доставлено';
    // слова нет в памяти этого запуска: звонок выключили после рестарта — слово сброшено
    return bell ? bell.statusOf(wid) ?? 'положено' : 'сброшено перезапуском';
  };

  // «Перечитать правила» (EXT-65, §1.8). Пути и missing берёт сервер сам: пометка oldRules треда session из своего сбора тредов.
  // Тред без пометки — project null. missing — полные пути, поля нет (набор выключен) — null.
  function rereadPlan(session) {
    const th = threadsNow().find((t) => t.sessionId === session) ?? null;
    const mark = (th?.marks ?? []).find((m) => m?.kind === 'oldRules') ?? null;
    return { th, mark, project: mark ? th.project ?? null : null, missing: Array.isArray(mark?.missing) ? mark.missing.map((x) => x.path) : null };
  }
  function rereadAct(ctx) {
    const { th, mark, missing } = ctx.pre;
    const refused = (refusal, message, extra = {}) => ({ outcome: 'refused', refusal, message, ...extra });
    if (!bell) return refused('bell-off', 'звонок выключен (pult.bell): просить тред перечитать правила нечем — попроси словами');
    if (!th) return refused('thread-closed', 'тред закрыт — просьба не доставлена');
    if (!mark) return th.rulesReread ? refused('already-read', 'тред уже перечитал правила — просить нечего') : refused('no-mark', 'у треда нет пометки «Старые правила» — просить нечего');
    if (!missing) return refused('reread-off', 'набор файлов правил выключен в настройках витрины — просьбу составить нечем');
    if (!missing.length) return refused('already-read', 'тред уже перечитал правила — просить нечего');
    // прежняя просьба этому треду: положена (в памяти сервера) или доставлена моложе 10 минут, а Read в журнале ещё не виден
    const lines = log.read();
    const byId = new Map();
    for (const l of lines) if (typeof l?.id === 'string') byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
    const priors = [...byId.values()].filter((ls) => ls[0]?.action === 'reread' && ls.find((l) => l.step === 'asked')?.session === ctx.session && ls[0].id !== ctx.id && ls.some((l) => l.step === 'ring-queued'));
    // последняя — по общему правилу с страницей (reread-last.mjs): новее по времени просьбы, не по порядку строк журнала
    const prior = newestReread(priors.map((ls) => ({ id: ls[0].id, at: (ls.find((l) => l.step === 'asked') ?? ls[0]).at, ls })))?.ls;
    if (prior) {
      let read = null;
      const status = ringStatus(() => (read ??= ringsRead()))(prior);
      // время — от шага ring-delivered; «прочитано» окно не снимает (первая секунда пробуждения, тред ещё читает файлы, §1.8);
      // шага нет (доставка ещё не записана тактом) — от просьбы
      const deliveredAt = Date.parse(prior.find((l) => l.step === 'ring-delivered')?.at) || Date.parse(prior[0].at) || now();
      if (status === 'положено' || ((status === 'доставлено' || status === 'прочитано') && now() - deliveredAt < REREAD_MS)) {
        return refused('queued', `просьба этому треду уже в пути (${prior[0].id}: ${status}) — второй звонок не нужен`, { extra: { prev: { id: prior[0].id, status } } });
      }
    }
    // строка хроники — по маске проекта треда, до 300 знаков
    const raw = rulesNoteNow();
    let note = typeof raw === 'string' && raw.trim() ? String(maskRow({ text: raw.trim() }, th.project ?? null).text) : '';
    note = clipNote(note);
    const rg = ringFor({ id: ctx.id, action: 'reread', card: null, session: ctx.session, word: REREAD_WORD, step: ctx.step, paths: missing, note });
    if (rg.result?.state !== 'queued') return { outcome: 'error', message: `просьба не доставлена: ${rg.message}`, result: { code: 'NOT_RUNG', ...(rg.result ? { ring: rg.result } : {}) } };
    return { outcome: 'ok', message: `просьба перечитать правила (файлов: ${missing.length}) · ${rg.message}`, result: { missing: missing.length, ring: rg.result } };
  }

  async function run(v, req) {
    const t = now();
    while (started.length && t - started[0] >= 60000) started.shift();
    const spec = ACTIONS[v.action];
    const handler = Object.hasOwn(handlers, v.action) ? handlers[v.action] : null;
    if (!handler) return { code: 501, body: { id: null, step: null, outcome: 'error', message: `«${spec.label}» ещё не подключено` } };
    // «Перечитать правила» (§1.8): пометка треда из своего сбора тредов — проект и missing идут в asked, исход решает обработчик
    const pre = v.action === 'reread' ? rereadPlan(v.session) : null;
    if (pre?.project) v.project = pre.project;
    const d = new Date(t);
    const id = actionId(d);
    const base = { id, at: localIso(d), action: v.action, ...(v.card ? { card: v.card } : {}), ...(v.project ? { project: v.project } : {}), mode: boardMode(pult.boardRoot) };
    const client = { intentId: v.intentId, origin: req.headers.origin ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null };
    const refused = (code, refusal, message) => {
      log.append({ ...base, step: 'refused', refusal, client });
      return { code, body: { id, step: 'refused', outcome: 'refused', message } };
    };
    if (started.length >= RATE.perMin) return refused(429, 'rate-limit', `не больше ${RATE.perMin} действий в минуту — подожди`);
    if (v.card && busy.has(v.card)) return refused(409, 'card-busy', `${v.card}: предыдущее ещё идёт`);
    // секрет в тексте Ивана (§1.1 п.4) — до asked: текст в журнал пишется только после проверки (§3.4)
    let softPass = null;
    if (v.text !== undefined && scan) {
      // сеть проекта карточки; без проекта — строгая (IPTV), как маска строк без проекта
      const found = scan(v.text, { project: v.project ?? 'IPTV' });
      const hard = found.find((x) => x.cls === 2);
      if (hard) return refused(200, 'secret', `похоже на секрет: ${hard.kind} — на доску не пишется`);
      const soft = found.find((x) => x.cls === 5);
      if (soft) {
        // второй щелчок «это не секрет» (1.1 п.4, как --not-secret у board): confirm = номер отказа; тот же текст (HMAC в памяти —
        // в журнал не идёт ничего от текста), то же действие и карточка, не дольше 5 мин. Пропуск едет дальше по цепочке
        // подтверждений (Б-дело после «не секрет»): записью carried на номер нового нажатия
        const pass = v.confirm ? softOk.get(v.confirm) : null;
        if (pass && t - pass.at <= INTENT_MS / 2 && pass.action === v.action && pass.card === (v.card ?? null) && pass.hmac === hmacOf(v.text)) {
          softPass = pass;
          softOk.set(id, { ...pass, carried: true });
        } else {
          for (const [k, e] of softOk) if (t - e.at > INTENT_MS) softOk.delete(k);
          softOk.set(id, { action: v.action, card: v.card ?? null, hmac: hmacOf(v.text), at: t });
          return refused(200, 'secret-maybe', `может быть секретом: ${soft.kind} — на доску не пишется; второй щелчок «это не секрет» — с номером этого отказа в confirm`);
        }
      }
    }
    // asked — до первого внешнего действия (§1.1 п.8); текст Ивана и голова вопроса — только здесь и по маске
    const q = v.q && typeof v.q.head === 'string' ? { ...v.q, head: maskRow({ head: v.q.head }, v.project).head } : v.q;
    log.append({ ...base, step: 'asked', ...(v.kind ? { kind: v.kind } : {}), ...(v.session ? { session: v.session } : {}), ...(pre?.missing ? { missing: pre.missing } : {}), ...(q ? { q } : {}),
      ...(v.rowKey !== undefined ? { rowKey: maskRow({ rowKey: v.rowKey }, v.project).rowKey } : {}), ...(v.until ? { until: v.until } : {}),
      ...(v.text !== undefined ? { text: maskRow({ text: v.text }, v.project).text } : {}), client });
    started.push(t);
    if (v.card) busy.add(v.card);
    const t0 = Date.now();
    const tail = { mode: base.mode };
    // промежуточные шаги обработчика (fresh, plane — §3.4) — той же формы, что строки исхода
    const step = (line) => appendAfter({ id, at: localIso(new Date(now())), action: v.action, ...(v.card ? { card: v.card } : {}), ...tail, ...line });
    try {
      const res = await handler({ id, action: v.action, card: v.card ?? null, project: v.project ?? null, session: v.session ?? null, kind: v.kind ?? null,
        pre, q: v.q ?? null, text: v.text ?? null, rowKey: v.rowKey ?? null, until: v.until ?? null, pick: v.pick ?? null,
        // confirm — второй щелчок Б-дела; номер отказа «не секрет» им не является (carried — цепочка: тот же номер уже Б-подтверждение)
        confirm: softPass && !softPass.carried ? null : v.confirm ?? null, plane, step });
      const outcome = res?.outcome ?? 'ok';
      const extra = { ...(res?.pull ? { pull: true } : {}), ...(res?.extra ?? {}) };
      // Б-дело без второго щелчка (ПТ6): asked лёг, во внешнем мире ничего; шаг need-confirm хранит то, что видит окно подтверждения
      if (outcome === 'need-confirm') {
        appendAfter({ id, step: 'need-confirm', at: localIso(new Date(now())), action: v.action, ...(v.card ? { card: v.card } : {}), ...tail,
          ...(res.bdeal ? { bdeal: res.bdeal } : {}), confirm: { ...res.confirm, q }, result: { ms: Date.now() - t0 } }); // q — с головой по маске, как в asked
        return { code: 200, body: { id, step: 'need-confirm', outcome, message: res.message ?? '', ...(res.bdeal ? { bdeal: res.bdeal } : {}), confirm: { ...res.confirm, q } } };
      }
      // отказ обработчика после asked (зеркало уже идёт и т.п.) — строка refused со словом причины, не ошибка
      if (outcome === 'refused') {
        const refusal = typeof res.refusal === 'string' ? res.refusal : null;
        appendAfter({ id, step: 'refused', at: localIso(new Date(now())), action: v.action, ...(v.card ? { card: v.card } : {}), ...tail, refusal, result: { ms: Date.now() - t0 } });
        return { code: REFUSAL_CODE[refusal] ?? 409, body: { id, step: 'refused', outcome, message: res?.message ?? '', ...extra } };
      }
      // ok → done, partial → partial, error (исход действия, не сбой витрины) → error; ответ 200
      const st = STEP_OF[outcome] ?? 'done';
      appendAfter({ id, step: st, at: localIso(new Date(now())), action: v.action, ...(v.card ? { card: v.card } : {}), ...tail, result: { outcome, ...(res?.result ?? {}), ms: Date.now() - t0 } });
      return { code: 200, body: { id, step: st, outcome, message: res?.message ?? '', ...extra } };
    } catch (e) {
      const code = errCode(e);
      appendAfter({ id, step: 'error', at: localIso(new Date(now())), action: v.action, ...tail, result: { code, ms: Date.now() - t0 } });
      return { code: 500, body: { id, step: 'error', outcome: 'error', message: `ошибка: ${code}` } };
    } finally {
      if (v.card) busy.delete(v.card);
    }
  }

  // тело больше 8 КБ, битый JSON — 400; тип без парсера — 415 (обработчик ошибок app.mjs)
  app.post('/api/act', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!enabled) return reply.code(503).send(refuse(503, 'пульт выключен (pult.enabled)').body);
    const chk = validate(req.body, { hasCode });
    if (!chk.ok) return reply.code(400).send(refuse(400, `неверный параметр: ${chk.why}`).body);
    const v = chk.value;
    if (ACTIONS[v.action].word && !words) return reply.code(503).send(refuse(503, 'слова с витрины включатся после правки правил').body);
    // слову q обязателен (1.1 п.5): у ответа строки (а) — {uuid, at}, у прочих — запись карточки или {at: null}; проверяется
    // там, где обработчик есть (без него — 501, как было)
    if (WORD_ACTIONS.includes(v.action) && Object.hasOwn(handlers, v.action) && !wordQOk(v)) return reply.code(400).send(refuse(400, 'неверный параметр: q').body);
    // полный проход — со вторым щелчком в ПТ8; до того форма принимается, исполнения нет
    if (v.action === 'mirror' && v.kind === 'full') return reply.code(501).send({ id: null, step: null, outcome: 'error', message: '«Прогони зеркало» (полный проход) ещё не подключено' });
    const t = now();
    for (const [k, e] of intents) if (t - e.at >= INTENT_MS) intents.delete(k);
    let entry = intents.get(v.intentId);
    if (!entry) {
      entry = { at: t, promise: run(v, req) };
      intents.set(v.intentId, entry);
    }
    const res = await entry.promise;
    return reply.code(res.code).send(res.body);
  });

  // «Мои слова» и статусы слова: строка на действие, новые сверху; по умолчанию — за 24 ч
  app.get('/api/actions', async (req, reply) => {
    const q = req.query ?? {};
    if (q.card !== undefined && !validCardId(q.card, hasCode)) return reply.code(400).send();
    if (q.project !== undefined && !validCode(q.project, hasCode)) return reply.code(400).send();
    if (q.session !== undefined && !UUID_RE.test(String(q.session))) return reply.code(400).send();
    const since = q.since === undefined ? now() - DAY_MS : Date.parse(String(q.since));
    if (!Number.isFinite(since)) return reply.code(400).send();
    let read = null; // журналы — один раз на запрос и только если есть звонки
    return actionRows(log.read(), ringStatus(() => (read ??= ringsRead())))
      .filter((r) => Date.parse(r.at) >= since)
      .filter((r) => (q.card === undefined || r.card === q.card) && (q.project === undefined || r.project === q.project) && (q.session === undefined || r.session === q.session))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      // session наружу — только у reread (EXT-65: один общий опрос страницы раскладывает строки по тредам); у прочих — как было
      .map(({ session, ...r }) => maskRow(r.action === 'reread' && session ? { ...r, session } : r, r.project));
  });

  // lastError — текст прохода mirror.mjs (источник витрине неизвестен, спека 6.2) — строгой сетью: maskRow без проекта
  // (мелочь 2 Голема на В10; мягкая сеть preSerialization не закрывала id флоу по признаку)
  app.get('/api/mirror', async () => maskRow(mirror.state(), null));

  // уборка рабочих копий — ПТ8б; пока форма с пустым списком
  app.get('/api/worktrees', async (req, reply) => {
    const p = req.query?.project;
    if (p !== undefined && !validCode(p, hasCode)) return reply.code(400).send();
    return [];
  });

  // ручка ждущего (2.2): браузеру закрыта (bell-browser в guard.mjs). Чистая: дочитывает bell.log (слова с ring сняты из
  // памяти) и отдаёт недоставленные слова треда с текстом звонка 2.6; ничего не пишет. pult.bell = false — 503.
  // «Перечитай» не в одном звонке со словами (2.6): есть слова — отдаются только они, id «перечитай» — в held (ждущий его
  // сигнал не трогает и forged не пишет), уйдёт отдельным звонком на следующем запросе ждущего
  app.get('/api/bell/:sid', async (req, reply) => {
    if (!UUID_RE.test(req.params.sid)) return reply.code(404).send();
    if (!bell) return reply.code(503).send();
    const { ring, held } = ringBatch(bell.pending(req.params.sid.toLowerCase()));
    // held — только когда есть что держать: прежняя форма ответа {ids, text} не меняется
    return { ids: ring.map((w) => w.id), text: ring.length ? ringText(ring) : null, ...(held.length ? { held } : {}) };
  });

  // фоновый такт (таймер в start.mjs — app.pult.tick): отложенная дотяжка --card после конца прохода; строки mirror-seen /
  // mirror-missing — по файлам доски, один раз на действие (GET ничего не пишет, §4.2)
  async function tick() {
    if (!enabled) return; // пульт выключен — ни дотяжки, ни чтения actions.log
    // звонок: дочитать bell.log (ring-delivered), тред умер — через 24 ч withdrawn
    if (bell) { try { bell.tick(); } catch (e) { serverLog.write('error', { route: 'bell', code: errCode(e) }); } }
    // живые ждущие (§1.7): замки с совпавшим procStart; счёт в фоне, /api/health отдаёт кэш
    if (bell && !waitersBusy) {
      waitersBusy = true;
      Promise.resolve().then(() => countWaiters({ dir: pult.bellDir })).then((n) => { waitersNow = n; }, () => {}).finally(() => { waitersBusy = false; });
    }
    for (const [card, res] of await cardPull.tick()) serverLog.write('pull', { card, res });
    if (!board || !pult.actionsLog) return;
    const lines = log.read(); // один раз за такт
    const has = (id, step) => lines.some((l) => l.id === id && l.step === step);
    // кандидаты в отметки (все действия с записью на карточке, EXT-70): красная считается у каждого, не только у победившего
    const open = new Map(markCandidates(markArgs(lines)).map((c) => [c.aid, c]));
    for (const l of lines) {
      if (!['done', 'partial'].includes(l?.step) || !MARK_ACTIONS.includes(l.action) || !l.card || !['ok', 'partial'].includes(l.result?.outcome) || !l.result?.record || has(l.id, 'mirror-seen')) continue;
      if (now() - Date.parse(l.result.planeAt ?? l.at) > 7 * DAY_MS) continue;
      const cand = open.get(l.id);
      if (!cand && (readLog(l.card)?.entries ?? []).some((e) => String(e.body ?? '').includes(l.result.record))) {
        appendAfter({ id: l.id, step: 'mirror-seen', at: localIso(new Date(now())), action: l.action, card: l.card, mode: boardMode(pult.boardRoot) });
      } else if (cand?.missing && !has(l.id, 'mirror-missing')) {
        appendAfter({ id: l.id, step: 'mirror-missing', at: localIso(new Date(now())), action: l.action, card: l.card, mode: boardMode(pult.boardRoot) });
      }
    }
  }

  // «Принять» можно ли (В7) — по карточке зеркала и ветке; acceptNow — итог прохода (строки «Ждёт меня», карточка)
  const cardOf = (id) => board?.card(id) ?? null;
  // готовый q для интерфейса (§1.1 п.5) — ровно в той форме, что принимает POST: {at, head} последней записи журнала
  // карточки в файлах зеркала (at — время заголовка, head — первые 60 знаков тела без управляющих) или {at: null};
  // карточки нет в читателе (битая шапка) — null: кнопок у неё нет
  const qOf = (id) => {
    const c = cardOf(id);
    if (!c) return null;
    if (!c.last?.at) return { at: null };
    return { at: c.last.at, head: [...cleanText(c.last.bodyHead ?? '')].slice(0, 60).join('') };
  };
  return {
    qOf,
    // /api/health → bell (§1.7): живых ждущих — null (замки с procStart не сверяются, ПТ4б), слов в очереди
    bellHealth: () => ({ on: !!bell, waiters: bell ? waitersNow : null, queued: bell ? bell.queued() : 0 }),
    plane,
    defer,
    // пункты меню «Отложить до …» с готовым временем — тем же untilOf и теми же часами, что defer
    deferOptions: () => deferOptions(now()),
    marks,
    rowMarks,
    rowMarkKey,
    // actions.log одним чтением на запрос страницы (отметки карточек и строк (а) — из одних строк)
    lines: () => (pult.actionsLog ? log.read() : []),
    tick,
    // итог прохода (EXT-57: на запрос страницы git не зовётся); ветка решает только у Review без Б-признака (мелочь 6)
    acceptNow: (id) => { const c = cardOf(id); return acceptState(c, needsGit(c) ? merge.peek(id) : null); },
  };
}
