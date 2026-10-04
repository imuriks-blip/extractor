// Настройки витрины (спека 1.3, 2.8): data/vitrina/config.json, вне git. Нет файла — пишется из
// умолчаний (config.default.json репозитория) атомарно; есть — его значения главнее, недостающие
// вложенные ключи берутся из умолчаний. Адрес не настраивается: только 127.0.0.1 (1.1, 6.1).
import fs from 'node:fs';
import path from 'node:path';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function checked(c) {
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error(`config.json: port — целое 1..65535, сейчас ${JSON.stringify(c.port)}`);
  return c;
}

export function loadConfig({ dataDir, defaults }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let own = {};
  if (fs.existsSync(file)) own = JSON.parse(fs.readFileSync(file, 'utf8'));
  else writeAtomic(file, JSON.stringify(defaults, null, 2) + '\n');
  return checked(merge(defaults, own));
}

// Те же настройки, что читает server.mjs, но ничего не пишется (нет config.json — одни умолчания): для инструментов
// рядом с витриной (tools/restore-actions.mjs берёт порт)
export function readConfig({ dataDir, defaults }) {
  const file = path.join(dataDir, 'config.json');
  return checked(merge(defaults, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}));
}
