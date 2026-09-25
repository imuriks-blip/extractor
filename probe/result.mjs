// Печатает итог сессии из файла stream-json: результат, ходы, вызовы инструментов.
import { readFileSync } from 'node:fs'

const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return {} } })
const tools = []
for (const e of lines) {
  if (e.type === 'assistant' && !e.parent_tool_use_id) for (const c of e.message.content) if (c.type === 'tool_use') tools.push(`${c.name}(${JSON.stringify(c.input).slice(0, 60)})`)
}
const r = lines.find((e) => e.type === 'result')
console.log(`вызовы: ${tools.join(' · ') || 'нет'}`)
console.log(`итог: ${r ? (r.result || r.subtype).split('\n')[0].slice(0, 200) : 'нет результата'}`)
