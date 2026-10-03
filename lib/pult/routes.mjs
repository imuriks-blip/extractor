// Ручки пульта (спека пульта §1.1, §1.7, §4.3): вход POST /api/act и ручки чтения. Защита §4.1 — раньше, в
// onRequest (guard.mjs). Здесь — флаг pult.enabled, словарь и параметры, флаг pult.words, intentId, лимиты,
// строки asked → done/error в actions.log. Ни одна GET-ручка не меняет состояние (§4.2).
// pult — то, что приходит из config.json (флаги, пути); seams — подмены только для тестов (обработчики,
// исполнитель Plane, часы, запуск процесса): из конфига их не задать.
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, HANDLERS, UUID_RE, cleanText, validate } from './actions.mjs';
import { actionId, actionRows, createActionsLog, localIso } from './actions-log.mjs';
import { createMirrorRunner, wscriptPath } from './mirror-run.mjs';
import { createPlaneQueue } from './queue.mjs';
import { acceptState, createAcceptHandlers, createCardPull, createMergeCheck, createPlaneSpawn, localMarks, needsGit, readRuns } from './accept.mjs';
import { validCardId, validCode } from '../params.mjs';

export const BODY_LIMIT = 8192;
export const INTENT_MS = 10 * 60000;
export const RATE = { perMin: 30 };
const DAY_MS = 86400000;
// код отказа по слову причины — для исхода, восстановленного из actions.log после рестарта
// отказы сверки и проверок «Принять»/«Вернуть» (ПТ3) — исход действия, 200 с outcome refused
const REFUSAL_CODE = { 'rate-limit': 429, 'card-busy': 409, 'mirror-running': 409,
  'stale-status': 200, 'new-question': 200, secret: 200, 'secret-maybe': 200, 'not-merged': 200, 'b-deal': 200, 'not-review': 200, 'no-card': 200 };
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
    const last = ls.at(-1);
    let res;
    if (last.step === 'partial') res = { code: 200, body: { id, step: 'partial', outcome: 'partial', message: 'частично (по журналу): запись есть, статус не сменился — повторить' } };
    else if (last.step === 'done') res = { code: 200, body: { id, step: 'done', outcome: last.result?.outcome ?? 'ok', message: 'уже исполнено (по журналу)' } };
    else if (last.step === 'refused') res = { code: REFUSAL_CODE[last.refusal] ?? 409, body: { id, step: 'refused', outcome: 'refused', message: 'уже отказано (по журналу)' } };
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

// board, registry, gitRead, scan — для «Принять»/«Вернуть» (ПТ3): карточка по зеркалу, ветки проекта, секрет в тексте
export function registerPult(app, { hasCode, maskRow, pult = {}, seams = {}, serverLog = { write() {} }, board = null, registry = null, gitRead = null, scan = null }) {
  const enabled = pult.enabled === true;
  const words = pult.words === true;
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
  const merge = createMergeCheck({ git: gitRead, registry, ...(seams.mergeTtlMs !== undefined ? { ttlMs: seams.mergeTtlMs } : {}) });
  const cardPull = createCardPull({ boardRoot: pult.boardRoot ?? null, mirrorDir: pult.mirrorDir ?? null, running: () => mirror.state().running,
    logFile: pult.actionsLog ? path.join(path.dirname(pult.actionsLog), 'mirror-card.log') : null, wscript: wscriptPath(), now,
    ...(seams.spawn ? { spawn: seams.spawn } : {}) });
  cardPull.restore(lines0); // очередь дотяжки и время своих --card переживают рестарт (мелочь 7)
  const runsFile = pult.mirrorDir ? path.join(pult.mirrorDir, 'runs.log') : null;
  const readLog = (id) => (board?.readLog ? board.readLog(id) : { entries: [] });
  // lines — уже прочитанный actions.log (такт читает его раз); без них — чтение здесь
  const marks = (lines = null) => (board && pult.actionsLog
    ? localMarks({ lines: lines ?? log.read(), readLog, runs: runsFile ? readRuns(runsFile) : [], now: now(), launches: cardPull.launches() }) : new Map());
  const acceptHandlers = board ? createAcceptHandlers({ board, merge, mirror: cardPull, readLines: () => log.read(), mask: (t) => maskRow({ text: t }, null).text, now }) : {};
  const handlers = { ...HANDLERS, mirror: mirrorAct, ...acceptHandlers, ...(seams.handlers ?? {}) };
  const intents = restoreIntents(lines0, now()); // intentId → {at, promise: {code, body}}
  const started = []; // время начала действий — лимит 30 в минуту
  const busy = new Set(); // карточки, по которым идёт действие

  const refuse = (code, message, extra = {}) => ({ code, body: { id: null, step: null, outcome: 'refused', message, ...extra } });
  // строка исхода после обработчика: сбой журнала не меняет исход Ивану — код в server.log
  const appendAfter = (line) => {
    try { log.append(line); } catch (e) { serverLog.write('error', { route: 'actions.log', code: typeof e?.code === 'string' ? e.code : 'ERR' }); }
  };

  async function run(v, req) {
    const t = now();
    while (started.length && t - started[0] >= 60000) started.shift();
    const spec = ACTIONS[v.action];
    const handler = Object.hasOwn(handlers, v.action) ? handlers[v.action] : null;
    if (!handler) return { code: 501, body: { id: null, step: null, outcome: 'error', message: `«${spec.label}» ещё не подключено` } };
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
    if (v.text !== undefined && scan) {
      // сеть проекта карточки; без проекта — строгая (IPTV), как маска строк без проекта
      const found = scan(v.text, { project: v.project ?? 'IPTV' });
      const hard = found.find((x) => x.cls === 2);
      if (hard) return refused(200, 'secret', `похоже на секрет: ${hard.kind} — на доску не пишется`);
      const soft = found.find((x) => x.cls === 5);
      if (soft) return refused(200, 'secret-maybe', `может быть секретом: ${soft.kind} — на доску не пишется; второй щелчок «это не секрет» — после ПТ6`);
    }
    // asked — до первого внешнего действия (§1.1 п.8); текст Ивана и голова вопроса — только здесь и по маске
    const q = v.q && typeof v.q.head === 'string' ? { ...v.q, head: maskRow({ head: v.q.head }, v.project).head } : v.q;
    log.append({ ...base, step: 'asked', ...(v.kind ? { kind: v.kind } : {}), ...(v.session ? { session: v.session } : {}), ...(q ? { q } : {}),
      ...(v.text !== undefined ? { text: maskRow({ text: v.text }, v.project).text } : {}), client });
    started.push(t);
    if (v.card) busy.add(v.card);
    const t0 = Date.now();
    const tail = { mode: base.mode };
    // промежуточные шаги обработчика (fresh, plane — §3.4) — той же формы, что строки исхода
    const step = (line) => appendAfter({ id, at: localIso(new Date(now())), action: v.action, ...(v.card ? { card: v.card } : {}), ...tail, ...line });
    try {
      const res = await handler({ id, action: v.action, card: v.card ?? null, project: v.project ?? null, session: v.session ?? null, kind: v.kind ?? null,
        q: v.q ?? null, text: v.text ?? null, plane, step });
      const outcome = res?.outcome ?? 'ok';
      const extra = res?.pull ? { pull: true } : {};
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
    return actionRows(log.read())
      .filter((r) => Date.parse(r.at) >= since)
      .filter((r) => (q.card === undefined || r.card === q.card) && (q.project === undefined || r.project === q.project) && (q.session === undefined || r.session === q.session))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map(({ session, ...r }) => maskRow(r, r.project));
  });

  app.get('/api/mirror', async () => mirror.state());

  // уборка рабочих копий — ПТ8б; пока форма с пустым списком
  app.get('/api/worktrees', async (req, reply) => {
    const p = req.query?.project;
    if (p !== undefined && !validCode(p, hasCode)) return reply.code(400).send();
    return [];
  });

  // звонок — ПТ4; браузеру ручка закрыта уже сейчас (проверка bell-browser в guard.mjs)
  app.get('/api/bell/:sid', async (req, reply) => {
    if (!UUID_RE.test(req.params.sid)) return reply.code(404).send();
    return [];
  });

  // фоновый такт (таймер в start.mjs — app.pult.tick): отложенная дотяжка --card после конца прохода; строки mirror-seen /
  // mirror-missing — по файлам доски, один раз на действие (GET ничего не пишет, §4.2)
  async function tick() {
    if (!enabled) return; // пульт выключен — ни дотяжки, ни чтения actions.log
    for (const [card, res] of await cardPull.tick()) serverLog.write('pull', { card, res });
    if (!board || !pult.actionsLog) return;
    const lines = log.read(); // один раз за такт
    const has = (id, step) => lines.some((l) => l.id === id && l.step === step);
    const open = marks(lines);
    for (const l of lines) {
      if (l?.step !== 'done' || !['accept', 'return'].includes(l.action) || l.result?.outcome !== 'ok' || !l.result?.record || has(l.id, 'mirror-seen')) continue;
      if (now() - Date.parse(l.result.planeAt ?? l.at) > 7 * DAY_MS) continue;
      const m = open.get(l.card);
      const mine = m && m.id === l.result.record;
      if (!mine && (readLog(l.card)?.entries ?? []).some((e) => String(e.body ?? '').includes(l.result.record))) {
        appendAfter({ id: l.id, step: 'mirror-seen', at: localIso(new Date(now())), action: l.action, card: l.card, mode: boardMode(pult.boardRoot) });
      } else if (mine && m.missing && !has(l.id, 'mirror-missing')) {
        appendAfter({ id: l.id, step: 'mirror-missing', at: localIso(new Date(now())), action: l.action, card: l.card, mode: boardMode(pult.boardRoot) });
      }
    }
  }

  // «Принять» можно ли (В7) — по карточке зеркала и ветке; acceptNow — из кэша (строки «Ждёт меня»), acceptCheck — проверка
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
    plane,
    marks,
    tick,
    // git — только у карточек, где ветка решает (Review без Б-признака); строки (б) и прочие — без peek (мелочь 6)
    acceptNow: (id) => { const c = cardOf(id); return acceptState(c, needsGit(c) ? merge.peek(id) : null); },
    acceptCheck: async (id) => { const c = cardOf(id); return acceptState(c, needsGit(c) ? await merge.check(id) : null); },
    // по одной, не залпом: кэш 5 мин, обычно всё уже в нём
    warm: async (ids) => { for (const id of ids) if (needsGit(cardOf(id))) await merge.check(id).catch(() => null); },
  };
}
