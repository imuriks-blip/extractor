// Сборка и запуск витрины: читатели, приложение, опрос, server.log. Слушает только 127.0.0.1 (1.1) —
// адрес константой, не настройкой. Модули доски (scan, parseCard) — импорт по пути из config.paths.boardLib:
// одно место правды (6.2); mirror.mjs не импортируется.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.mjs';
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

export const HOST = '127.0.0.1';

export async function startServer({ config, dataDir }) {
  const log = createServerLog(path.join(dataDir, 'server.log'));
  const gitStats = createGitStats();
  const git = createGitRead({ onCall: gitStats.onCall });

  const lib = (f) => pathToFileURL(path.join(config.paths.boardLib, f)).href;
  const { scan } = await import(lib('secrets.mjs'));
  const { parseCard } = await import(lib('header.mjs'));
  const { parseLog, latest } = await import(lib('log.mjs'));

  const board = createBoardReader({ root: config.paths.board, git, parseCard, parseLog, latest });
  await board.init();
  const registry = createRegistryReader(config.paths.registry);
  // журналы: полный проход при старте — фоном (сервер отвечает сразу, свежесть журналов — null до первого прохода);
  // индекс смещений — data/vitrina/index (1.3), дальше — только хвосты раз в pollMs.journals
  const journals = createJournalReader({ root: config.paths.journals, indexDir: path.join(dataDir, 'index'), rules: config.boardWriteTools ?? [], indexWriteEveryS: config.indexWriteEveryS ?? 60 });
  const t0 = Date.now();
  journals.refresh().then(() => {
    const s = journals.state();
    log.write('journals', { files: s.files, lines: s.lines, ms: Date.now() - t0, errors: s.errors, unknown: s.unknown });
  }, () => log.write('error', { route: 'journals', code: 'PASS' }));
  // «Кто работает» (В3): реестр процессов (опрос раз в pollMs.processes), десктопный индекс (pollMs.desktopIndex),
  // определения агентов (по mtime); строки собираются на запрос из выжимок читателей
  const procs = createProcessReader({ dir: config.paths.sessions });
  const desktop = createDesktopIndex({ roots: config.paths.desktopIndex ?? [] });
  const maxTurns = createAgentDefs({ dir: config.paths.agents });
  await procs.refresh();
  desktop.refresh();
  // В4: момент «правила обновлены» — хроника Vault (vault_root реестра), коммит по хешу в board_shared_repos;
  // «сделано» блока обрыва — коммиты репозиториев проекта (board_codes → repos) за заход, фоном с кэшем
  const reg0 = registry.get();
  const rules = createRulesMoment({ dir: path.join(reg0.vaultRoot ?? '', 'unorbis', 'Хроника'), git, repos: reg0.sharedRepos, vaultRepo: reg0.vaultRoot });
  await rules.refresh();
  const commits = createCommitsCache({ git, reposOf: (code) => registry.get().codes.find((c) => c.code === code)?.repos ?? [] });
  const threads = {
    list: () => buildWorkers({ procs: procs.entries(), desktop: desktop.get, sessions: journals.sessions(), board, mirrorIndex: board.mirrorIndex(), maxTurns, now: Date.now(),
      thresholds: config.thresholds ?? {}, rulesAt: rules.get()?.at ?? null, commitsOf: commits.get, titleOf: desktop.titleOfCli }),
    state: () => ({ processes: procs.state(), desktop: desktop.state() }),
  };
  const app = await buildApp({ port: config.port, board, registry, journals, threads, scan, log, gitCalls: gitStats.snapshot });

  await app.listen({ host: HOST, port: config.port });
  log.write('start', { port: config.port, pid: process.pid, cards: board.state().cards, boardErrors: board.state().errors });

  // RSS и вызовы git по репозиториям: всего и пик за минуту (Г3, Г4 гейта этапа); ключ — полный путь
  const stats = () => log.write('stats', { rss: process.memoryUsage().rss, git: gitStats.snapshot() });
  const timers = [
    // отказ промиса из интервала не должен дойти до unhandled-rejections=throw (Node 24) — сервер жив
    setInterval(() => { Promise.resolve(board.refresh()).catch(() => log.write('error', { route: 'board', code: 'POLL' })); }, config.pollMs?.board ?? 5000),
    setInterval(() => { journals.refresh().catch(() => log.write('error', { route: 'journals', code: 'POLL' })); }, config.pollMs?.journals ?? 2000),
    setInterval(stats, (config.statsEveryMin ?? 10) * 60000),
    setInterval(() => { procs.refresh().catch(() => log.write('error', { route: 'processes', code: 'POLL' })); }, config.pollMs?.processes ?? 2000),
    setInterval(() => { try { desktop.refresh(); } catch { log.write('error', { route: 'desktop', code: 'POLL' }); } }, config.pollMs?.desktopIndex ?? 10000),
    setInterval(() => { rules.refresh().catch(() => log.write('error', { route: 'rules', code: 'POLL' })); }, config.pollMs?.git ?? 30000),
  ];

  return {
    app,
    board,
    journals,
    async stop() {
      for (const t of timers) clearInterval(t);
      journals.flush();
      await app.close();
      stats();
      log.write('stop', { pid: process.pid });
    },
  };
}
