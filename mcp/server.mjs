// MCP Экстрактора (спека пульта §5, ПТ10, EXT-82): stdio, построчный JSON-RPC (как probe/p3-mcp.mjs), без SDK.
// Только чтение: данные — GET к витрине (по умолчанию 127.0.0.1:4317; другой адрес — EXTRACTOR_URL или --url, только
// 127.0.0.1/localhost). Каждая сессия поднимает свой процесс. Журнал вызовов — EXTRACTOR_MCP_LOG (по умолчанию
// data/vitrina/mcp.log рядом с витриной): имя, вход, длина ответа; значение CLAUDE_CODE_SESSION_ID в журнал не пишется.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createTools, DEFAULT_URL } from './tools.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argUrl = (() => { const i = process.argv.indexOf('--url'); return i > 0 ? process.argv[i + 1] : undefined; })();
const base = argUrl ?? process.env.EXTRACTOR_URL ?? DEFAULT_URL;
let parsed;
try { parsed = new URL(base); } catch { parsed = null; }
if (!parsed || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
  process.stderr.write('extractor-mcp: адрес витрины — только http://127.0.0.1:<порт> или localhost\n');
  process.exit(2);
}

const LOG = process.env.EXTRACTOR_MCP_LOG ?? path.join(root, 'data', 'vitrina', 'mcp.log');
const log = (o) => {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...o }) + '\n'); } catch { /* журнал не обязателен */ }
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sessionEnv = Boolean(String(process.env.CLAUDE_CODE_SESSION_ID ?? '').trim());
const tools = createTools({ base });

async function handle(m) {
  if (m.method === 'initialize') {
    log({ ev: 'initialize', client: m.params?.clientInfo, sessionEnv });
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'extractor', version: '1.0.0' } } });
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.tools } });
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params || {};
    log({ ev: 'call', name, args: { project: typeof a?.project === 'string' ? a.project.slice(0, 20) : undefined, since: typeof a?.since === 'string' ? a.since.slice(0, 40) : undefined }, sessionEnv });
    const r = await tools.call(name, a);
    log({ ev: r.isError ? 'err' : 'ok', name, chars: r.text.length });
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (!m || typeof m !== 'object') return;
  handle(m).catch(() => { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'internal error' } }); });
});
