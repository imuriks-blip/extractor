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

export const HOST = '127.0.0.1';

export async function startServer({ config, dataDir }) {
  const log = createServerLog(path.join(dataDir, 'server.log'));
  const gitStats = createGitStats();
  const git = createGitRead({ onCall: gitStats.onCall });

  const lib = (f) => pathToFileURL(path.join(config.paths.boardLib, f)).href;
  const { scan } = await import(lib('secrets.mjs'));
  const { parseCard } = await import(lib('header.mjs'));

  const board = createBoardReader({ root: config.paths.board, git, parseCard });
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
  const app = await buildApp({ port: config.port, board, registry, journals, scan, log, gitCalls: gitStats.snapshot });

  await app.listen({ host: HOST, port: config.port });
  log.write('start', { port: config.port, pid: process.pid, cards: board.state().cards, boardErrors: board.state().errors });

  // RSS и вызовы git по репозиториям: всего и пик за минуту (Г3, Г4 гейта этапа); ключ — полный путь
  const stats = () => log.write('stats', { rss: process.memoryUsage().rss, git: gitStats.snapshot() });
  const timers = [
    // отказ промиса из интервала не должен дойти до unhandled-rejections=throw (Node 24) — сервер жив
    setInterval(() => { Promise.resolve(board.refresh()).catch(() => log.write('error', { route: 'board', code: 'POLL' })); }, config.pollMs?.board ?? 5000),
    setInterval(() => { journals.refresh().catch(() => log.write('error', { route: 'journals', code: 'POLL' })); }, config.pollMs?.journals ?? 2000),
    setInterval(stats, (config.statsEveryMin ?? 10) * 60000),
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
