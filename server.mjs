// Экстрактор, витрина этапа 1 — точка входа: node server.mjs
// Свои файлы — только data/vitrina/ (config.json, server.log); источники — только чтение.
// Каталог своих файлов не настраивается: только <репозиторий>/data/vitrina (гейт Г7).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { launch } from './lib/start.mjs';
import { redirectConsole } from './lib/console-log.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(ROOT, 'data', 'vitrina');
// скрытый запуск (tools/vitrina-hidden.js): консоли нет — вывод и неперехваченная ошибка в data/vitrina/console.log
if (process.argv.includes('--console-log')) {
  fs.mkdirSync(dataDir, { recursive: true });
  redirectConsole({ file: path.join(dataDir, 'console.log') });
}
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
const config = loadConfig({ dataDir, defaults });

// один экземпляр (спека 5): витрина уже отвечает на порту — выход 0; порт занят чужим — код 3; строка — в server.log
const { server: s, exitCode } = await launch({ config, dataDir });
if (!s) process.exit(exitCode);
console.log(`витрина: http://127.0.0.1:${config.port}/  (данные: ${dataDir})`);

const shutdown = async () => { await s.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
