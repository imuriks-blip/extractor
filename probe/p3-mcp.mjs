// Проба П.3 (EXT-33): MCP-сервер Экстрактора (stdio, JSON-RPC построчно, без SDK).
// Инструмент waiting — компактная сводка «Ждёт меня» из витрины (127.0.0.1:4317/api/ceh): ответ короткий,
// потому что ответы MCP висят в контексте (замер 25.09: в ~6 раз тяжелее скрипта). Лог вызовов — rewake/p3.log.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rewake', 'p3.log')
const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n') } catch {} }
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const TOOLS = [{
  name: 'waiting',
  description: 'Что ждёт Ивана сейчас (витрина Экстрактора): число строк по группам и до 5 первых строк. Только чтение.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Код проекта (CAR, EXT…); пусто — все' } } },
}]

async function waiting(project) {
  const r = await fetch('http://127.0.0.1:4317/api/ceh', { headers: { host: '127.0.0.1:4317' } })
  if (!r.ok) throw new Error(`витрина ответила ${r.status}`)
  const j = await r.json()
  const w = j.waiting || {}
  const pick = (a) => (a || []).filter((x) => !project || x.project === project)
  const t = pick(w.threads), y = pick(w.yes), v = pick(w.review)
  const line = (x) => [x.id || x.title || x.sessionId, x.mark || x.kind || '', (x.text || x.title || '').slice(0, 70)].filter(Boolean).join(' · ')
  return [`Ждёт Ивана${project ? ' по ' + project : ''}: тред ждёт ответа ${t.length}, нужно «да» ${y.length}, Review ${v.length}.`,
    ...[...t, ...y].slice(0, 5).map((x) => '- ' + line(x))].join('\n')
}

readline.createInterface({ input: process.stdin }).on('line', async (l) => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') {
    log({ ev: 'initialize', client: m.params?.clientInfo })
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'extractor', version: '0.0.1-probe' } } })
  }
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } })
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params || {}
    log({ ev: 'call', name, args: a })
    try {
      if (name !== 'waiting') throw new Error('нет такого инструмента')
      const text = await waiting(a?.project)
      log({ ev: 'ok', name, chars: text.length })
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } })
    } catch (e) {
      log({ ev: 'err', name, msg: e.message })
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ошибка: ' + e.message }], isError: true } })
    }
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
})
