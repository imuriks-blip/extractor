// Экстрактор, витрина этапа 1 — точка входа: node server.mjs
// Свои файлы — только data/vitrina/ (config.json, server.log); источники — только чтение.
// VITRINA_DATA — другой каталог своих файлов (пробы); по умолчанию <репозиторий>/data/vitrina.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { startServer } from './lib/start.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.VITRINA_DATA || path.join(ROOT, 'data', 'vitrina');
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
const config = loadConfig({ dataDir, defaults });

let s;
try {
  s = await startServer({ config, dataDir });
} catch (e) {
  console.error(`витрина не стартовала: ${e.code || e.message}`);
  process.exit(1);
}
console.log(`витрина: http://127.0.0.1:${config.port}/  (данные: ${dataDir})`);

const shutdown = async () => { await s.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
