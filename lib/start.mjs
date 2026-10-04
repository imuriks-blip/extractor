// Сборка и запуск витрины: читатели, приложение, опрос, server.log. Слушает только 127.0.0.1 (1.1) —
// адрес константой, не настройкой. Модули доски (scan, parseCard) — импорт по пути из config.paths.boardLib:
// одно место правды (6.2); mirror.mjs не импортируется.
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from './app.mjs';
import { checkPort, HOST, VITRINA_APP } from './port.mjs';
import { createBoardReader } from './board-reader.mjs';
import { createGitRead } from './git-read.mjs';
import { createGitStats } from './git-stats.mjs';
import { createJournalReader } from './journal-reader.mjs';
import { createBackup, BACKUP_KEEP } from './backup.mjs';
import { createRegistryReader } from './registry.mjs';
import { createServerLog, createStatsLog } from './server-log.mjs';
import { createProcessReader } from './processes.mjs';
import { createDesktopIndex } from './desktop-index.mjs';
import { createAgentDefs } from './agent-defs.mjs';
import { buildWorkers, createCommitsCache, shortRootsOf } from './waiting.mjs';
import { EDIT_RESERVE_MS, EDIT_WINDOW_H } from './journal-parse.mjs';
import { createRulesMoment } from './rules-moment.mjs';
import { resolveReread } from './rules-reread.mjs';
import { createGitReader } from './git-reader.mjs';
import { createTraceChecker } from './trace.mjs';
import { createMergeCheck } from './pult/accept.mjs';
import { createProjectCards } from './project-cards.mjs';
import { createEvents, createServerTick } from './events.mjs';
import { createNotifier, createNotifyLoop, createWake, toastRows, createAskGate } from './notify.mjs';
import { showToast, createToastQueue } from './toast.mjs';

// Подпись данных для потока событий: «Цех» без свежести и без меток времени наблюдения (они меняются каждый опрос и
// дёргали бы интерфейс чаще прежнего опроса) + шапки и последние записи карточек доски (окно проекта, карточка).
const VOLATILE = /^(freshness|lastSeenAt|readAt|lastOkAt|okAt|phaseReadAt)$/;
export function stableJson(v) {
  return JSON.stringify(v, (k, x) => (VOLATILE.test(k) ? undefined : x));
}

export { HOST, checkPort };
// plane.py по умолчанию (спека пульта §3.1); config.json → pult.planePy главнее
export const PLANE_PY = 'C:/projects/_plane-rest/plane.py';
// собранный интерфейс (1.1): <репозиторий>/web/dist — константой, как и data/vitrina; нет сборки — 503 с подсказкой
export const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
// корень репозитория: от него разрешается относительный backup.dir из config.json (по умолчанию data/vitrina/backup/)
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Один экземпляр (спека 5): порт и есть замок, замков-файлов нет. Метка витрины в /api/health — app и pid
// (pid — для скрипта обновления: остановить свою витрину, не чужой node).
export { VITRINA_APP };
export const EXIT_FOREIGN = 3;

// Кто на порту — checkPort (lib/port.mjs; вынесено, чтобы restore не тянул сервер)

// toasts: false в config.json — копия тостов не шлёт (пробные витрины рядом с живой давали Ивану дубли)
export function pickToast(config, toast) {
  return config.toasts === false ? null : toast;
}

function portTaken(state, port, pid) {
  const e = new Error(state === 'vitrina' ? 'ALREADY_RUNNING' : 'PORT_FOREIGN');
  e.code = e.message;
  e.port = port;
  e.pid = pid;
  return e;
}

// Запуск из server.mjs: сервер или код выхода. Витрина уже отвечает — 0 (автозапуск при входе и ручной запуск
// не спорят); порт занят чужим — EXIT_FOREIGN; иной отказ — 1. Строка в server.log пишет startServer.
export async function launch({ config, dataDir, start = startServer, print = console.log, printErr = console.error }) {
  try {
    return { server: await start({ config, dataDir }) };
  } catch (e) {
    if (e.code === 'ALREADY_RUNNING') { print(`витрина уже запущена: http://${HOST}:${config.port}/ (pid ${e.pid}) — второй экземпляр не нужен`); return { exitCode: 0 }; }
    if (e.code === 'PORT_FOREIGN') { printErr(`порт занят чужим: ${HOST}:${config.port} отвечает не витрина`); return { exitCode: EXIT_FOREIGN }; }
    printErr(`витрина не стартовала: ${e.code || e.message}`);
    return { exitCode: 1 };
  }
}

// webDir — каталог собранного интерфейса (по умолчанию WEB_DIST; другой — только в тестах, как и toast);
// проход читателя git (старт, интервал, пробуждение): читатель → проверка следа (§1.4а) → слитость веток «Принять».
// Промис кончается после следа: слитость (EXT-57) запускается вслед, но не ждётся — после сна её пересчёт (ttl истёк)
// занял бы readAll и цикл уведомлений (Важно 1 Голема). Свой «один за раз» — в createMergeCheck.refresh.
export function createGitPass({ gitReader, trace, merge, log }) {
  return () => gitReader.refresh().finally(() => trace.refresh().catch(() => log.write('error', { route: 'trace', code: 'PASS' }))
    .then(() => { merge.refresh().catch(() => log.write('error', { route: 'merge', code: 'PASS' })); }));
}

// backupNow — часы суточной копии журнала действий (только в тестах)
export async function startServer({ config, dataDir, toast = showToast, webDir = WEB_DIST, backupNow = () => new Date() }) {
  const log = createServerLog(path.join(dataDir, 'server.log'));
  // порт — до всех читателей: второй экземпляр не читает журналы и не пишет индекс рядом с первым
  const taken = async () => {
    const c = await checkPort({ port: config.port });
    if (c.state === 'free') return null;
    if (c.state === 'vitrina') log.write('already', { port: config.port, pid: c.pid });
    else log.write('port-foreign', { port: config.port });
    return portTaken(c.state, config.port, c.pid);
  };
  const early = await taken();
  if (early) throw early;
  const gitStats = createGitStats();
  // пути git и python — config.json → paths.git, paths.python; по умолчанию — из PATH (мелочь 4 Голема на В10)
  const git = createGitRead({ bin: config.paths?.git || 'git', onCall: gitStats.onCall });

  const lib = (f) => pathToFileURL(path.join(config.paths.boardLib, f)).href;
  const { scan } = await import(lib('secrets.mjs'));
  const { parseCard } = await import(lib('header.mjs'));
  const { parseLog, latest } = await import(lib('log.mjs'));
  // живость run.lock зеркала (ручка /api/mirror пульта) — по правилам доски
  const { pidAlive, otherBoot } = await import(lib('lock.mjs'));

  const board = createBoardReader({ root: config.paths.board, git, parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(config.paths.registry);
  // «правила перечитаны» (EXT-54, спека 2.3): набор файлов — config.json → rulesReread.files, «~/» — от домашней
  // папки, относительные — от vault_root реестра (на старте; смена набора или vault_root — рестарт, отпечаток индекса —
  // пересбор). Неразрешимый элемент выключает функцию целиком — строкой в server.log и полем rereadOff в /api/health
  const rr = resolveReread(config.rulesReread?.files ?? [], { vaultRoot: registry.get().vaultRoot, home: os.homedir() });
  const { files: reread, off: rereadOff } = rr;
  if (rereadOff) log.write('reread-off', { code: rereadOff, item: rr.item });
  // реестр процессов — до журналов: журналы живых сессий читаются как горячие (liveSessions, EXT-37)
  const procs = createProcessReader({ dir: config.paths.sessions });
  // журналы: полный проход при старте — фоном (сервер отвечает сразу, свежесть журналов — null до первого прохода);
  // индекс смещений — data/vitrina/index (1.3), дальше — только хвосты раз в pollMs.journals
  const cwh = config.thresholds?.collisionWindowH;
  const collisionWindowH = Number.isFinite(cwh) && cwh > 0 ? cwh : EDIT_WINDOW_H;
  const journals = createJournalReader({ root: config.paths.journals, indexDir: path.join(dataDir, 'index'), rules: config.boardWriteTools ?? [], reread, rereadOff, indexWriteEveryS: config.indexWriteEveryS ?? 60,
    // EXT-37: полный обход журналов — раз в 30 с; раз в pollMs.journals — горячее, журналы живых сессий всегда горячие
    fullEveryMs: (config.journalsFullEveryS ?? 30) * 1000, liveSessions: () => procs.entries().filter((p) => p.live && p.sessionId).map((p) => p.sessionId),
    // EXT-53: живой запуск без вестей дольше порога — runsSilent (config.json → thresholds.runSilentMin)
    runSilentMin: config.thresholds?.runSilentMin ?? 30,
    // EXT-60: правки файлов хранятся окно «Общего файла» (thresholds.collisionWindowH) + запас; окно сменилось — пересбор индекса
    editKeepMs: collisionWindowH * 3600000 + EDIT_RESERVE_MS });
  const t0 = Date.now();
  const firstPass = journals.refresh().then(() => {
    const s = journals.state();
    log.write('journals', { files: s.files, lines: s.lines, ms: Date.now() - t0, errors: s.errors, unknown: s.unknown });
  }, () => log.write('error', { route: 'journals', code: 'PASS' }));
  // «Кто работает» (В3): реестр процессов (опрос раз в pollMs.processes), десктопный индекс (pollMs.desktopIndex),
  // определения агентов (по mtime); строки собираются на запрос из выжимок читателей
  const desktop = createDesktopIndex({ roots: config.paths.desktopIndex ?? [] });
  const maxTurns = createAgentDefs({ dir: config.paths.agents });
  await procs.refresh();
  desktop.refresh();
  // В4: момент «правила обновлены» — хроника Vault (vault_root реестра), коммит по хешу в board_shared_repos;
  // «сделано» блока обрыва — коммиты репозиториев проекта (board_codes → repos) за заход, фоном с кэшем
  const reg0 = registry.get();
  const rules = createRulesMoment({ dir: path.join(reg0.vaultRoot ?? '', 'unorbis', 'Хроника'), git, repos: reg0.sharedRepos, vaultRepo: reg0.vaultRoot });
  await rules.refresh();
  // пробуждение (5): скачок стенных часов > wakeJumpS между тиками; проспанное — не «нет вестей» («устарело»)
  const wake = createWake({ jumpMs: (config.wakeJumpS ?? 90) * 1000 });
  const commits = createCommitsCache({ git, reposOf: (code) => registry.get().codes.find((c) => c.code === code)?.repos ?? [] });
  const threads = {
    list: () => buildWorkers({ procs: procs.entries(), desktop: desktop.get, sessions: journals.sessions(), board, mirrorIndex: board.mirrorIndex(), maxTurns, now: Date.now(),
      thresholds: config.thresholds ?? {}, rulesAt: rules.get()?.at ?? null, reread, commitsOf: commits.get, titleOf: desktop.titleOfCli, slept: wake.slept,
      // EXT-49: окно памяти по модели; объект живого config.json сливается с умолчанием по ключам (lib/config.mjs)
      contextWindow: config.contextWindow ?? {},
      // EXT-60: «Общий файл» — config.json → collisions (ignore), корни коротких путей — из реестра (читается по mtime)
      collisions: config.collisions ?? null, shortRoots: shortRootsOf(registry.get()) }),
    state: () => ({ processes: procs.state(), desktop: desktop.state() }),
  };
  // В5: читатель git — репозитории реестра и их рабочие копии, раз в pollMs.git (2.8); первый проход — фоном
  // (маячок и коммиты ленты пусты до него, readAt — null); репозиторий доски — без коммитов (2.6)
  // свой каталог данных — не повод для читателя git (EXT-37: иначе витрина будит себя своим server.log)
  const gitReader = createGitReader({ git, registry, boardRoot: config.paths.board, ignore: [dataDir] });
  // проверка следа рядом с «Принять» (спека пульта §1.4а, EXT-48): git — только здесь, вслед за проходом читателя git;
  // Vault — config.json → paths.vault, иначе vault_root реестра
  const trace = createTraceChecker({ git, registry, board, vault: config.paths?.vault || null });
  // слита ли ветка карточки у «Принять» (В7, EXT-57) — тем же проходом, после проверки следа; ручки берут готовое
  const merge = createMergeCheck({ git, registry, board });
  const gitPass = createGitPass({ gitReader, trace, merge, log });
  gitPass().catch(() => log.write('error', { route: 'git', code: 'PASS' }));
  const projectCards = createProjectCards({ registry });
  // суточная копия журнала действий (EXT-50): настройки сливаются по ключам с умолчаниями; нет backup.dir — <данные>/backup
  const bk = { keep: BACKUP_KEEP, ...config.backup };
  const actionsLog = path.join(dataDir, 'actions.log');
  const backup = createBackup({ file: actionsLog, dir: typeof bk.dir === 'string' && bk.dir ? path.resolve(REPO_ROOT, bk.dir) : path.join(dataDir, 'backup'), keep: bk.keep, now: backupNow, log });
  const events = createEvents({ scan, refreshEveryMs: (config.eventsRefreshS ?? 20) * 1000 });
  const app = await buildApp({ port: config.port, board, registry, journals, threads, scan, log, gitCalls: gitStats.snapshot, gitReader, projectCards, maxTurns, webDir, events, trace, backup,
    // пульт (спека пульта): флаги — config.json → pult (по умолчанию выключен); журнал действий — data/vitrina/actions.log
    pult: { enabled: config.pult?.enabled === true, words: config.pult?.words === true, actionsLog,
      mirrorDir: path.join(config.paths.board, '.mirror'), lock: { pidAlive, otherBoot }, boardRoot: config.paths.board,
      // «Принять»/«Вернуть» (ПТ3, спека пульта §3.1): plane.py — общий инструмент тредов; python — paths.python, прежний
      // ключ pult.python, иначе из PATH
      python: config.paths?.python || config.pult?.python || 'python', planePy: config.pult?.planePy ?? PLANE_PY },
    // ветка карточки слита ли (В7) — той же обёрткой чтения (белый список по форме вызова); считает проход (EXT-57)
    merge });

  try {
    await app.listen({ host: HOST, port: config.port });
  } catch (e) {
    // гонка: порт заняли между проверкой и listen — тот же разбор
    await app.close().catch(() => {});
    if (e.code === 'EADDRINUSE') throw (await taken()) ?? e;
    throw e;
  }
  log.write('start', { port: config.port, pid: process.pid, cards: board.state().cards, boardErrors: board.state().errors });
  // копия при старте: последней удачной нет или она старше 24 ч; дальше — первый цикл после местной полуночи (ниже)
  const backupStep = (f) => { try { f(); } catch { log.write('error', { route: 'backup', code: 'STEP' }); } };
  backupStep(() => backup.start());

  // RSS и вызовы git по репозиториям: всего и пик за минуту (Г3, Г4 гейта этапа); ключ — полный путь
  // gitQuiet (EXT-37): проходы читателя git, репозитории, пропущенные по тишине наблюдателя, status одной копии,
  // полные чтения, репозитории без наблюдателя (опрос по-старому)
  // (git= — последним полем строки: его разбирают по концу строки)
  // EXT-53: uuidKeys — ключей во множествах прочитанных uuid (рост памяти, EXT-41), runsLive / runsSilent; та же строка —
  // ещё и в data/vitrina/stats.log со своей ротацией (Г4: server.log в 5 000 строк к 24-му часу мог срезать первый час)
  const statsLog = createStatsLog(path.join(dataDir, 'stats.log'));
  const stats = () => {
    const j = journals.state();
    const mem = process.memoryUsage();
    // heapUsed и external — что из RSS растёт: куча JS или буферы (ревью Голема на EXT-53, Мелочь 6)
    statsLog.writeLine(log.write('stats', { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, uuidKeys: journals.uuidKeys(), runsLive: j.runsLive, runsSilent: j.runsSilent, gitQuiet: gitReader.quiet(), git: gitStats.snapshot() }));
  };
  // Уведомления (4.1): строки (а) и (б) из ответа «Цеха» (уже под маской); первый цикл — после первого прохода
  // журналов, тихий; пробуждение — полный цикл чтения всех читателей, затем тихий цикл. В server.log — без текстов.
  const url = `http://${HOST}:${config.port}/#/`;
  // тосты — очередью по одному, зависший PowerShell убивается через 15 с (вердикт Голема на В8)
  const showOne = pickToast(config, toast);
  const toasts = createToastQueue({ run: (r) => showOne(r, { url, appId: config.toastAppId ?? '' }), timeoutMs: 15000, onDone: (code) => { if (code !== 0) log.write('error', { route: 'toast', code }); } });
  const notifier = createNotifier({
    file: path.join(dataDir, 'notified.json'),
    show: (r) => { log.write('toast', { group: r.key == null ? 'more' : r.title.startsWith('вернулось: ') ? 'back' : r.title.endsWith('ждёт ответа') ? 'thread' : 'yes' }); if (showOne) toasts.push(r); },
    onError: (e, kind) => log.write('error', { route: kind === 'show' ? 'toast' : 'notified', code: e.code ?? 'ERR' }),
  });
  const readAll = async () => {
    const t = Date.now();
    await Promise.allSettled([board.refresh(), journals.refresh({ full: true }), procs.refresh(), Promise.resolve().then(() => desktop.refresh()), rules.refresh(), gitPass()]);
    log.write('wake', { readMs: Date.now() - t });
  };
  // один расчёт «Цеха» на тик — для строк тостов и подписи потока; подпись — только при открытых окнах
  const signature = (ceh) => {
    const cards = board.cardsList().map((c) => [c.id, c.status, c.updated, c.title, c.last?.key ?? null]);
    return createHash('sha1').update(stableJson([ceh, cards])).digest('hex');
  };
  const serverTick = createServerTick({ cehPayload: () => app.vitrina.cehPayload(), events, signature });
  // строка «ждёт ответа» без открытого вопроса — тостом после 3 циклов подряд (EXT-37, ворота createAskGate)
  const askGate = createAskGate();
  // «Отложить до …» (EXT-47): тот же цикл снимает отметки — срок прошёл (тост «вернулось: …»), строки нет (молча); до
  // конца первого прохода цикл не идёт — отметки после рестарта не снимаются по ещё пустым читателям
  const rowsOfTick = (opts) => { const w = serverTick.current().waiting; const back = app.vitrina.deferSweep(w); return toastRows(w, { confirmed: askGate.see(w), back, ...opts }); };
  const loop = createNotifyLoop({ notifier, rows: rowsOfTick, readAll, wake });
  loop.start(firstPass).catch(() => log.write('error', { route: 'notify', code: 'START' }));
  const timers = [
    // тот же цикл будит копию журнала действий: первый тик после местной полуночи (и после сна через полночь) — копия
    setInterval(() => { serverTick.run(() => loop.tick()).catch(() => log.write('error', { route: 'notify', code: 'TICK' })); backupStep(() => backup.tick()); }, config.pollMs?.journals ?? 2000),
    // отказ промиса из интервала не должен дойти до unhandled-rejections=throw (Node 24) — сервер жив
    setInterval(() => { Promise.resolve(board.refresh()).catch(() => log.write('error', { route: 'board', code: 'POLL' })); }, config.pollMs?.board ?? 5000),
    setInterval(() => { journals.refresh().catch(() => log.write('error', { route: 'journals', code: 'POLL' })); }, config.pollMs?.journals ?? 2000),
    setInterval(stats, (config.statsEveryMin ?? 10) * 60000),
    // пульт: отложенная дотяжка --card после конца прохода, строки mirror-seen / mirror-missing (§3.2)
    setInterval(() => { Promise.resolve(app.pult.tick()).catch(() => log.write('error', { route: 'pult', code: 'TICK' })); }, 15000),
    setInterval(() => { procs.refresh().catch(() => log.write('error', { route: 'processes', code: 'POLL' })); }, config.pollMs?.processes ?? 2000),
    setInterval(() => { try { desktop.refresh(); } catch { log.write('error', { route: 'desktop', code: 'POLL' }); } }, config.pollMs?.desktopIndex ?? 10000),
    setInterval(() => { rules.refresh().catch(() => log.write('error', { route: 'rules', code: 'POLL' })); }, config.pollMs?.git ?? 30000),
    setInterval(() => { gitPass().catch(() => log.write('error', { route: 'git', code: 'POLL' })); }, config.pollMs?.git ?? 30000),
  ];

  return {
    app,
    board,
    journals,
    async stop() {
      for (const t of timers) clearInterval(t);
      gitReader.close();
      journals.flush();
      await app.close();
      stats();
      log.write('stop', { pid: process.pid });
    },
  };
}
