// Сборка и запуск витрины: читатели, приложение, опрос, server.log. Слушает только 127.0.0.1 (1.1) —
// адрес константой, не настройкой. Модули доски (scan, parseCard) — импорт по пути из config.paths.boardLib:
// одно место правды (6.2); mirror.mjs не импортируется.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.mjs';
import { createBoardReader } from './board-reader.mjs';
import { createGitRead } from './git-read.mjs';
import { createGitStats } from './git-stats.mjs';
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
  const app = await buildApp({ port: config.port, board, registry, scan, log, gitCalls: gitStats.snapshot });

  await app.listen({ host: HOST, port: config.port });
  log.write('start', { port: config.port, pid: process.pid, cards: board.state().cards, boardErrors: board.state().errors });

  // RSS и вызовы git по репозиториям: всего и пик за минуту (Г3, Г4 гейта этапа); ключ — полный путь
  const stats = () => log.write('stats', { rss: process.memoryUsage().rss, git: gitStats.snapshot() });
  const timers = [
    setInterval(() => { board.refresh(); }, config.pollMs?.board ?? 5000),
    setInterval(stats, (config.statsEveryMin ?? 10) * 60000),
  ];

  return {
    app,
    board,
    async stop() {
      for (const t of timers) clearInterval(t);
      await app.close();
      stats();
      log.write('stop', { pid: process.pid });
    },
  };
}
