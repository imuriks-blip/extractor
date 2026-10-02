// Сервер витрины (спека 1.1, 1.6, 6): GET — чтение, POST — только /api/act (спека пульта §0, §4), проверка Host,
// без CORS, параметры — до чтения диска, каждый ответ — через маску секретов. Слушать (127.0.0.1) — забота server.mjs; здесь только приложение.
import Fastify from 'fastify';
import { maskDeep } from './mask.mjs';
import { validCode, validCardId } from './params.mjs';
import { buildCeh } from './ceh.mjs';
import { buildWaiting } from './waiting.mjs';
import { buildLinks, buildFeed, cardRuns } from './card-feed.mjs';
import { NOT_DESCRIBED } from './git-reader.mjs';
import { buildProjectBoard, workingByCard } from './project-board.mjs';
import { createWebStatic } from './web-static.mjs';
import { createEvents } from './events.mjs';
import { createGuard, newToken, CHECKS } from './pult/guard.mjs';
import { registerPult } from './pult/routes.mjs';

// journals — читатель журналов (В2); без него (тесты В1) — пустой, свежесть журналов null
const NO_JOURNALS = { state: () => ({ lastOkAt: null }) };
// threads — строки «Кто работает» (В3: реестр процессов, десктопный индекс, журналы); без него — пусто
const NO_THREADS = { list: () => ({ threads: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: null, desktop: null }) };

// gitReader — читатель git (В5: маячок, коммиты ленты; данные опроса, на запрос git не зовётся); без него — по реестру,
// без репозиториев. projectCards — фаза и следующий шаг карточки проекта; maxTurns — тормоз агента (определения агентов).
// Строгая сеть маски (6.2): сеть IPTV — «id флоу по признаку» не прощается. Ею — чужие тексты: другой проект,
// общие репозитории (межпроектные), неизвестный источник (решение дирижёра по вердикту Голема на В5).
const STRICT = 'IPTV';
// метка витрины в /api/health (один экземпляр, спека 5)
export const VITRINA_APP = 'extractor-vitrina';
const NO_GIT = { beacon: () => ({ repos: [], readAt: null, failingSince: null }), commitsFor: () => ({ commits: [], readAt: null, failingSince: null }), state: () => null };

export async function buildApp({ port, board, registry, journals = NO_JOURNALS, threads = NO_THREADS, scan, log = { write() {} }, gitCalls = () => ({}), gitReader = NO_GIT, projectCards = null, maxTurns = () => null, webDir = null, webFs, events = null, pult = {}, pultSeams = {} }) {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  // пульт (спека пульта): токен страницы — 32 байта на запуск, в <meta> оболочки при отдаче; защита §4.1 — набором
  // проверок guard.mjs (Host и метод — для всех запросов, остальное — для /api/act и /api/bell/:sid)
  const token = newToken();
  // набор проверок подменяется только тестовым параметром pultSeams (отрицательный контроль): config.json защиту не выключит
  const guard = createGuard({ port, token, checks: pultSeams.checks ?? CHECKS });

  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    // чужой Host — 421 (перепривязка DNS, 1.1); метод — 405; защита записи — 415/403 (§4.1); отказ — код без тела
    const deny = guard(req);
    if (deny) { req.denied = deny.name; return reply.code(deny.code).send(); }
  });
  // Маска на выходе (6.2). Текст карточки или проекта — с кодом его проекта (req.maskProject):
  // сеть доски у IPTV строже (путь «id флоу по признаку» закрыт). ВНИМАНИЕ: preSerialization видит только
  // объекты, которые Fastify сериализует сам; SSE (`/api/events`, lib/events.mjs) маскирует сам.
  app.addHook('preSerialization', async (req, reply, payload) => maskDeep(payload, scan, { project: req.maskProject ?? '' }));
  // запрет фреймов (мелочь Голема на В6): у всех ответов, включая 421/404/503 — страницу витрины нельзя вложить в чужую
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const ms = Number((process.hrtime.bigint() - req.startedAt) / 1000000n);
    // в server.log — маршрут (шаблон), код и время; ни параметров, ни текстов (6.3); отказ защиты — имя проверки
    log.write('req', { route: req.routeOptions?.url ?? '-', status: reply.statusCode, ms, ...(req.denied ? { deny: req.denied } : {}) });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send());
  app.setErrorHandler((err, req, reply) => {
    log.write('error', { route: req.routeOptions?.url ?? '-', code: err.code ?? 'ERR' });
    // тело пульта: тип без парсера (форма, multipart — их парсеров нет, §4.2) — 415; не разобралось (больше 8 КБ,
    // битый JSON, пустое) — 400 (§1.1 п.2, §4.3)
    if (req.routeOptions?.url === '/api/act' && err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send();
    if (req.routeOptions?.url === '/api/act' && err.statusCode >= 400 && err.statusCode < 500) return reply.code(400).send({ id: null, step: null, outcome: 'refused', message: 'тело запроса не принято' });
    reply.code(500).send();
  });

  // mirror — возраст зеркала доски (В-5): «доска: зеркало Plane от ДД.ММ ЧЧ:ММ» из .mirror/status.json
  // failingSince (2.7) — с первого сбоя подряд, null после удачи: серая строка «данные на ЧЧ:ММ, чтение не удаётся N мин»
  const fresh = (st) => ({ lastOkAt: st.lastOkAt ?? null, failingSince: st.failingSince ?? null });
  const freshness = () => ({ board: fresh(board.state()), journals: fresh(journals.state()), mirror: board.mirrorStatus ? board.mirrorStatus() : null });
  // незнакомые значения status реестра процессов (2.1) — счётчик по значению, не падение
  const readersOfThreads = () => {
    const s = threads.state();
    const l = s.processes ? threads.list() : null; // один сбор строк на запрос
    return { processes: s.processes ? { ...s.processes, unknownStatus: l.unknownStatus, unknownWaitingFor: l.unknownWaitingFor ?? {} } : null, desktop: s.desktop };
  };
  const isCode = (code) => validCode(code, (c) => board.hasCode(c));

  // app и pid — метка витрины для второго запуска (один экземпляр, спека 5) и скрипта обновления
  app.get('/api/health', async () => ({
    ok: true,
    app: VITRINA_APP,
    pid: process.pid,
    readers: { board: board.state(), registry: registry.state(), journals: journals.state(), ...readersOfThreads(), git: gitReader.state() },
    gitCalls: gitCalls(),
    rss: process.memoryUsage().rss,
    uptimeS: Math.round(process.uptime()),
  }));

  // Строка треда — тексты из журналов (название, описание субагента): маска сетью его проекта; тред без кода проекта —
  // строгой сетью (ветка IPTV: id флоу по слову-признаку не прощается). Общий хук ниже маскирует ответ ещё раз.
  // проект, угаданный по карточкам, сеть не ослабляет: мягче строгой — только код из названия (вердикт Голема)
  const maskCode = (t) => (t.projectBy === 'title' && t.project ? t.project : 'IPTV');
  // Один сбор на запрос (В4): треды с пометками (маска сетью треда), строки (а) — той же сетью, что их тред;
  // (б) и (в) — тексты карточек, сеть проекта карточки; строки «тред закрыт» — строгой сетью (проект взят из карточки).
  const collect = () => {
    const w = threads.list();
    const rows = (w.waiting ?? []).map((r) => maskDeep(r, scan, { project: maskCode(r) }));
    const waiting = buildWaiting({ threads: rows, board, now: Date.now() });
    waiting.yes = waiting.yes.map((r) => maskDeep(r, scan, { project: r.project }));
    waiting.review = waiting.review.map((r) => maskDeep(r, scan, { project: r.project }));
    return {
      w,
      threads: w.threads.map((t) => maskDeep(t, scan, { project: maskCode(t) })),
      closed: (w.closed ?? []).map((c) => maskDeep(c, scan, { project: 'IPTV' })),
      waiting,
    };
  };
  // ответ «Цеха» — и для ручки, и для сервера (start.mjs: подпись потока событий, строки тостов 4.1 — уже под маской)
  const cehPayload = () => {
    const c = collect();
    const ceh = buildCeh({ board, registry: registry.get(), projectCards, workers: { ...c.w, threads: c.threads }, waiting: c.waiting, freshness: freshness() });
    // фаза и шаг каждого проекта — сетью его проекта: у ручки «Цеха» своего проекта нет, общий хук — мягкая сеть
    ceh.projects = ceh.projects.map((p) => ({ ...p, phase: maskDeep(p.phase, scan, { project: p.code }), next: maskDeep(p.next, scan, { project: p.code }) }));
    return ceh;
  };
  app.get('/api/ceh', async () => cehPayload());
  app.decorate('vitrina', { cehPayload });

  // Поток событий (1.1, 1.6, В8): `changed {scope}` — сигнал «перечитай»; Host и только GET — общий хук выше.
  // В server.log — маршрут, код и длительность потока при обрыве (onResponse у уведённого ответа не срабатывает).
  const ev = events ?? createEvents({ scan });
  app.get('/api/events', (req, reply) => ev.attach(req, reply, () => {
    log.write('req', { route: '/api/events', status: 200, ms: Number((process.hrtime.bigint() - req.startedAt) / 1000000n) });
  }));
  app.addHook('preClose', async () => ev.closeAll());

  // Маячок (2.5, 3.2): фаза и следующий шаг — целиком; репозитории проекта и рабочие копии — ветка, число незакоммиченных;
  // кода нет в реестре — «проект не описан в реестре». readAt/failingSince — серая строка 2.7 у блока.
  const beaconOf = (code) => {
    const described = registry.get().codes.some((c) => c.code === code);
    const g = gitReader.beacon(code);
    const p = described ? (projectCards?.get(code) ?? null) : null;
    return { described, message: described ? null : NOT_DESCRIBED, phase: p?.phase ?? null, next: p?.next ?? null,
      phaseReadAt: p?.readAt ?? null, phaseFailingSince: p?.failingSince ?? null, // серая строка 2.7 у фазы и шага
      repos: described ? g.repos : [], readAt: g.readAt ?? null, failingSince: g.failingSince ?? null };
  };

  // Окно проекта: «Ждёт меня по <КОД>» (2.4 — плоский список: (а) треды проекта, (б), (в)), «Кто работает по <КОД>»
  // с «правила свежие» и строками «тред закрыт» (В-6 (б)); маячок и доска — В5.
  app.get('/api/project/:code', async (req, reply) => {
    const { code } = req.params;
    if (!isCode(code)) return reply.code(404).send();
    req.maskProject = code;
    const c = collect();
    const mine = (r) => r.project === code;
    const waiting = [
      ...c.waiting.threads.filter(mine).map((r) => ({ group: 'thread', ...r })),
      ...c.waiting.yes.filter(mine).map((r) => ({ group: 'yes', ...r })),
      ...c.waiting.review.filter(mine).map((r) => ({ group: 'review', ...r })),
    ];
    const n = (g) => waiting.filter((r) => r.group === g).length;
    return {
      code,
      // имя-заглушка «— (…)» из projects.md — null (читатель доски, В7): крошки — только код
      name: board.codes().find((p) => p.code === code)?.name ?? null,
      beacon: beaconOf(code),
      waiting,
      waitingCount: { count: n('thread') + n('yes'), more: n('review') },
      workers: { threads: c.threads.filter(mine).map((t) => ({ ...t, rulesFresh: c.w.rulesFresh?.[t.sessionId] ?? null })), closed: c.closed.filter(mine) },
      board: buildProjectBoard(board.cardsList(), code, workingByCard(c.w.threads)),
      freshness: freshness(),
    };
  });

  // Карточка (2.6): шапка и тело (markdown; в HTML с очисткой — вёрстка, 2.6) из файла; связи со встречной стороной;
  // лента — записи журнала, коммиты читателя git (опрос, 2.8), запуски Agent из индекса журналов (В2); новые сверху.
  // feedGit — свежесть коммитов (серая строка 2.7); feedCounts — числа фильтра ленты.
  app.get('/api/card/:id', async (req, reply) => {
    const { id } = req.params;
    if (!validCardId(id, (c) => board.hasCode(c))) return reply.code(404).send();
    const card = board.readCard(id);
    if (!card) return reply.code(404).send();
    req.maskProject = id.split('-')[0];
    // битая шапка — 200 с error: 'шапка' (экран показывает «карточка не читается»), не 500
    const jl = board.readLog ? board.readLog(id) : { entries: [], error: null };
    const g = gitReader.commitsFor(id);
    // сеть: свой текст карточки (тело, журнал, свой репозиторий, свои связи) — сетью проекта (общий хук ниже);
    // коммит общего или чужого репозитория, заголовок карточки другого проекта, description запуска — строгой
    const code = req.maskProject;
    const strict = (v) => maskDeep(v, scan, { project: STRICT });
    const commits = g.commits.map(({ own, ...c }) => (own ? c : strict(c)));
    const runs = cardRuns(journals.sessions ? journals.sessions() : [], id, maxTurns).map((r) => ({ ...r, description: strict(r.description) }));
    const { feed, counts } = buildFeed({ logEntries: jl.entries, commits, runs });
    let links = card.header ? buildLinks(board, id, card.header) : null;
    if (links) {
      const fix = (x) => (x && x.id.split('-')[0] !== code ? { ...x, title: strict(x.title) } : x);
      links = Object.fromEntries(Object.entries(links).map(([k, v]) => [k, Array.isArray(v) ? v.map(fix) : fix(v)]));
    }
    // project — код проекта из папки карточки (2.6 «проект», В7): <КОД>/<КОД>-<N>.md, код уже сверен с projects.md
    return { project: code, header: card.header, body: card.body, error: card.error, links,
      feed, feedCounts: counts, feedGit: { readAt: g.readAt ?? null, failingSince: g.failingSince ?? null }, logError: jl.error };
  });

  // Пульт (спека пульта §1.7): POST /api/act и ручки чтения; маска строк — сетью проекта, без проекта — строгой
  const maskRow = (r, project) => maskDeep(r, scan, { project: project || STRICT });
  registerPult(app, { hasCode: (c) => board.hasCode(c), maskRow, pult, seams: pultSeams, serverLog: log });

  // Интерфейс (1.1, В6): собранная статика web/dist — всё, что не /api/*; /api/* без ручки — 404 без тела, как было.
  // Ответ — Buffer или строка: preSerialization (маска) его не трогает — это сборка, не тексты источников.
  if (webDir) {
    const serve = createWebStatic({ root: webDir, fs: webFs, token });
    app.get('/*', (req, reply) => (req.raw.url.startsWith('/api/') ? reply.code(404).send() : serve(req, reply)));
  }

  await app.ready();
  return app;
}
