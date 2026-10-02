// Ручки пульта (спека пульта §1.1, §1.7, §4.3): вход POST /api/act и ручки чтения. Защита §4.1 — раньше, в
// onRequest (guard.mjs). Здесь — флаг pult.enabled, словарь и параметры, флаг pult.words, intentId, лимиты,
// строки asked → done/error в actions.log. Ни одна GET-ручка не меняет состояние (§4.2).
import { ACTIONS, HANDLERS, UUID_RE, validate } from './actions.mjs';
import { actionId, actionRows, createActionsLog, localIso } from './actions-log.mjs';
import { readMirror } from './mirror-status.mjs';
import { createPlaneQueue } from './queue.mjs';
import { validCardId, validCode } from '../params.mjs';

export const BODY_LIMIT = 8192;
export const INTENT_MS = 10 * 60000;
export const RATE = { perMin: 30 };
const DAY_MS = 86400000;

export function registerPult(app, { hasCode, maskRow, pult = {} }) {
  const enabled = pult.enabled === true;
  const words = pult.words === true;
  const now = pult.now ?? Date.now;
  const log = createActionsLog(pult.actionsLog ?? null);
  const handlers = { ...HANDLERS, ...(pult.handlers ?? {}) };
  const plane = createPlaneQueue(pult.planeRun ? { run: pult.planeRun } : {});
  const intents = new Map(); // intentId → {at, promise: {code, body}}
  const started = []; // время начала действий — лимит 30 в минуту
  const busy = new Set(); // карточки, по которым идёт действие

  const refuse = (code, message, extra = {}) => ({ code, body: { id: null, step: null, outcome: 'refused', message, ...extra } });

  async function run(v, req) {
    const t = now();
    while (started.length && t - started[0] >= 60000) started.shift();
    const spec = ACTIONS[v.action];
    const handler = Object.hasOwn(handlers, v.action) ? handlers[v.action] : null;
    if (!handler) return { code: 501, body: { id: null, step: null, outcome: 'error', message: `«${spec.label}» ещё не подключено` } };
    const d = new Date(t);
    const id = actionId(d);
    const base = { id, at: localIso(d), action: v.action, ...(v.card ? { card: v.card } : {}), ...(v.project ? { project: v.project } : {}) };
    const client = { intentId: v.intentId, origin: req.headers.origin ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null };
    const refused = (code, refusal, message) => {
      log.append({ ...base, step: 'refused', refusal, client });
      return { code, body: { id, step: 'refused', outcome: 'refused', message } };
    };
    if (started.length >= RATE.perMin) return refused(429, 'rate-limit', `не больше ${RATE.perMin} действий в минуту — подожди`);
    if (v.card && busy.has(v.card)) return refused(409, 'card-busy', `${v.card}: предыдущее ещё идёт`);
    // asked — до первого внешнего действия (§1.1 п.8); текст Ивана — только здесь и по маске
    log.append({ ...base, step: 'asked', ...(v.session ? { session: v.session } : {}), ...(v.q ? { q: v.q } : {}),
      ...(v.text !== undefined ? { text: maskRow({ text: v.text }, v.project).text } : {}), client });
    started.push(t);
    if (v.card) busy.add(v.card);
    const t0 = Date.now();
    try {
      const res = await handler({ id, action: v.action, card: v.card ?? null, project: v.project ?? null, session: v.session ?? null, plane });
      log.append({ id, step: 'done', at: localIso(new Date(now())), action: v.action, result: { ms: Date.now() - t0 } });
      return { code: 200, body: { id, step: 'done', outcome: res?.outcome ?? 'ok', message: res?.message ?? '' } };
    } catch (e) {
      const code = typeof e?.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'ERR';
      log.append({ id, step: 'error', at: localIso(new Date(now())), action: v.action, result: { code, ms: Date.now() - t0 } });
      return { code: 500, body: { id, step: 'error', outcome: 'error', message: `ошибка: ${code}` } };
    } finally {
      if (v.card) busy.delete(v.card);
    }
  }

  // тело больше 8 КБ, битый JSON — 400 (обработчик ошибок app.mjs: 4xx разбора тела на /api/act)
  app.post('/api/act', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!enabled) return reply.code(503).send(refuse(503, 'пульт выключен (pult.enabled)').body);
    const chk = validate(req.body, { hasCode });
    if (!chk.ok) return reply.code(400).send(refuse(400, `неверный параметр: ${chk.why}`).body);
    const v = chk.value;
    if (ACTIONS[v.action].word && !words) return reply.code(503).send(refuse(503, 'слова с витрины включатся после правки правил').body);
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

  app.get('/api/mirror', async () => readMirror({ dir: pult.mirrorDir ?? null, now: Date.now(), lock: pult.lock ?? null }));

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

  return { plane };
}
