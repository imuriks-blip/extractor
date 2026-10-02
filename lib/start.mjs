// Сборка и запуск витрины: читатели, приложение, опрос, server.log. Слушает только 127.0.0.1 (1.1) —
// адрес константой, не настройкой. Модули доски (scan, parseCard) — импорт по пути из config.paths.boardLib:
// одно место правды (6.2); mirror.mjs не импортируется.
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp, VITRINA_APP } from './app.mjs';
import { createBoardReader } from './board-reader.mjs';
import { createGitRead } from './git-read.mjs';
import { createGitStats } from './git-stats.mjs';
import { createJournalReader } from './journal-reader.mjs';
import { createRegistryReader } from './registry.mjs';
import { createServerLog } from './server-log.mjs';
import { createProcessReader } from './processes.mjs';
import { createDesktopIndex } from './desktop-index.mjs';
import { createAgentDefs } from './agent-defs.mjs';
import { buildWorkers, createCommitsCache } from './waiting.mjs';
import { createRulesMoment } from './rules-moment.mjs';
import { createGitReader } from './git-reader.mjs';
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

export const HOST = '127.0.0.1';
// собранный интерфейс (1.1): <репозиторий>/web/dist — константой, как и data/vitrina; нет сборки — 503 с подсказкой
export const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

// Один экземпляр (спека 5): порт и есть замок, замков-файлов нет. Метка витрины в /api/health — app и pid
// (pid — для скрипта обновления: остановить свою витрину, не чужой node).
export { VITRINA_APP };
export const EXIT_FOREIGN = 3;

// Кто на порту: 'free' — занять можно; 'vitrina' — отвечает витрина (её pid); 'foreign' — занят чем-то иным
// (другой HTTP, не JSON, молчит дольше timeoutMs).
// Слушатель, на который нельзя соединиться (ECONNREFUSED, обрыв без ответа), — чаще всего такая же проба второго
// запуска, занявшая порт на миг (гонка двух стартов, вердикт Голема на В9): тогда проба повторяется, а не «чужой».
export async function checkPort({ port, host = HOST, timeoutMs = 3000, retries = 10, retryMs = 100 }) {
  for (let i = 0; ; i++) {
    const busy = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(true) : reject(e)));
      s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(false)));
    });
    if (!busy) return { state: 'free' };
    const h = await healthOf({ port, host, timeoutMs });
    if (h.answer && h.answer.app === VITRINA_APP && Number.isInteger(h.answer.pid)) return { state: 'vitrina', pid: h.answer.pid };
    if (h.answered || h.timeout || i >= retries) return { state: 'foreign' };
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

// { answered, answer, timeout }: answered — пришёл HTTP-ответ (answer — JSON при 200, иначе null)
function healthOf({ port, host, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/api/health', headers: { host: `${host}:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { let j = null; try { j = res.statusCode === 200 ? JSON.parse(body) : null; } catch { /* не JSON */ } end({ answered: true, answer: j }); });
      res.on('error', () => end({ answered: true, answer: null }));
    });
    req.on('timeout', () => { end({ answered: false, timeout: true }); req.destroy(); });
    req.on('error', () => end({ answered: false }));
  });
}

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

export async function startServer({ config, dataDir, toast = showToast }) {
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
  const git = createGitRead({ onCall: gitStats.onCall });

  const lib = (f) => pathToFileURL(path.join(config.paths.boardLib, f)).href;
  const { scan } = await import(lib('secrets.mjs'));
  const { parseCard } = await import(lib('header.mjs'));
  const { parseLog, latest } = await import(lib('log.mjs'));

  const board = createBoardReader({ root: config.paths.board, git, parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(config.paths.registry);
  // реестр процессов — до журналов: журналы живых сессий читаются как горячие (liveSessions, EXT-37)
  const procs = createProcessReader({ dir: config.paths.sessions });
  // журналы: полный проход при старте — фоном (сервер отвечает сразу, свежесть журналов — null до первого прохода);
  // индекс смещений — data/vitrina/index (1.3), дальше — только хвосты раз в pollMs.journals
  const journals = createJournalReader({ root: config.paths.journals, indexDir: path.join(dataDir, 'index'), rules: config.boardWriteTools ?? [], indexWriteEveryS: config.indexWriteEveryS ?? 60,
    // EXT-37: полный обход журналов — раз в 30 с; раз в pollMs.journals — горячее, журналы живых сессий всегда горячие
    fullEveryMs: (config.journalsFullEveryS ?? 30) * 1000, liveSessions: () => procs.entries().filter((p) => p.live && p.sessionId).map((p) => p.sessionId) });
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
      thresholds: config.thresholds ?? {}, rulesAt: rules.get()?.at ?? null, commitsOf: commits.get, titleOf: desktop.titleOfCli, slept: wake.slept }),
    state: () => ({ processes: procs.state(), desktop: desktop.state() }),
  };
  // В5: читатель git — репозитории реестра и их рабочие копии, раз в pollMs.git (2.8); первый проход — фоном
  // (маячок и коммиты ленты пусты до него, readAt — null); репозиторий доски — без коммитов (2.6)
  // свой каталог данных — не повод для читателя git (EXT-37: иначе витрина будит себя своим server.log)
  const gitReader = createGitReader({ git, registry, boardRoot: config.paths.board, ignore: [dataDir] });
  gitReader.refresh().catch(() => log.write('error', { route: 'git', code: 'PASS' }));
  const projectCards = createProjectCards({ registry });
  const events = createEvents({ scan, refreshEveryMs: (config.eventsRefreshS ?? 20) * 1000 });
  const app = await buildApp({ port: config.port, board, registry, journals, threads, scan, log, gitCalls: gitStats.snapshot, gitReader, projectCards, maxTurns, webDir: WEB_DIST, events });

  try {
    await app.listen({ host: HOST, port: config.port });
  } catch (e) {
    // гонка: порт заняли между проверкой и listen — тот же разбор
    await app.close().catch(() => {});
    if (e.code === 'EADDRINUSE') throw (await taken()) ?? e;
    throw e;
  }
  log.write('start', { port: config.port, pid: process.pid, cards: board.state().cards, boardErrors: board.state().errors });

  // RSS и вызовы git по репозиториям: всего и пик за минуту (Г3, Г4 гейта этапа); ключ — полный путь
  // gitQuiet (EXT-37): проходы читателя git, репозитории, пропущенные по тишине наблюдателя, status одной копии,
  // полные чтения, репозитории без наблюдателя (опрос по-старому)
  // (git= — последним полем строки: его разбирают по концу строки)
  const stats = () => log.write('stats', { rss: process.memoryUsage().rss, gitQuiet: gitReader.quiet(), git: gitStats.snapshot() });
  // Уведомления (4.1): строки (а) и (б) из ответа «Цеха» (уже под маской); первый цикл — после первого прохода
  // журналов, тихий; пробуждение — полный цикл чтения всех читателей, затем тихий цикл. В server.log — без текстов.
  const url = `http://${HOST}:${config.port}/#/`;
  // тосты — очередью по одному, зависший PowerShell убивается через 15 с (вердикт Голема на В8)
  const showOne = pickToast(config, toast);
  const toasts = createToastQueue({ run: (r) => showOne(r, { url, appId: config.toastAppId ?? '' }), timeoutMs: 15000, onDone: (code) => { if (code !== 0) log.write('error', { route: 'toast', code }); } });
  const notifier = createNotifier({
    file: path.join(dataDir, 'notified.json'),
    show: (r) => { log.write('toast', { group: r.key == null ? 'more' : r.title.endsWith('ждёт ответа') ? 'thread' : 'yes' }); if (showOne) toasts.push(r); },
    onError: (e, kind) => log.write('error', { route: kind === 'show' ? 'toast' : 'notified', code: e.code ?? 'ERR' }),
  });
  const readAll = async () => {
    const t = Date.now();
    await Promise.allSettled([board.refresh(), journals.refresh({ full: true }), procs.refresh(), Promise.resolve().then(() => desktop.refresh()), rules.refresh(), gitReader.refresh()]);
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
  const rowsOfTick = (opts) => { const w = serverTick.current().waiting; return toastRows(w, { confirmed: askGate.see(w), ...opts }); };
  const loop = createNotifyLoop({ notifier, rows: rowsOfTick, readAll, wake });
  loop.start(firstPass).catch(() => log.write('error', { route: 'notify', code: 'START' }));
  const timers = [
    setInterval(() => { serverTick.run(() => loop.tick()).catch(() => log.write('error', { route: 'notify', code: 'TICK' })); }, config.pollMs?.journals ?? 2000),
    // отказ промиса из интервала не должен дойти до unhandled-rejections=throw (Node 24) — сервер жив
    setInterval(() => { Promise.resolve(board.refresh()).catch(() => log.write('error', { route: 'board', code: 'POLL' })); }, config.pollMs?.board ?? 5000),
    setInterval(() => { journals.refresh().catch(() => log.write('error', { route: 'journals', code: 'POLL' })); }, config.pollMs?.journals ?? 2000),
    setInterval(stats, (config.statsEveryMin ?? 10) * 60000),
    setInterval(() => { procs.refresh().catch(() => log.write('error', { route: 'processes', code: 'POLL' })); }, config.pollMs?.processes ?? 2000),
    setInterval(() => { try { desktop.refresh(); } catch { log.write('error', { route: 'desktop', code: 'POLL' }); } }, config.pollMs?.desktopIndex ?? 10000),
    setInterval(() => { rules.refresh().catch(() => log.write('error', { route: 'rules', code: 'POLL' })); }, config.pollMs?.git ?? 30000),
    setInterval(() => { gitReader.refresh().catch(() => log.write('error', { route: 'git', code: 'POLL' })); }, config.pollMs?.git ?? 30000),
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
