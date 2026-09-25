// Проба 0.3: мост разрешений. Аргументы: решение (allow|deny), задержка в секундах.
import { appendFileSync } from 'node:fs'
const [decision = 'deny', delay = '0'] = process.argv.slice(2)
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', async () => {
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, Number(delay) * 1000))
  let j = {}; try { j = JSON.parse(raw) } catch {}
  appendFileSync('hook-perm.log', JSON.stringify({ at: new Date().toISOString(), event: j.hook_event_name, tool: j.tool_name, input: j.tool_input, keys: Object.keys(j), decision, waitedMs: Date.now() - t0 }) + '\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision, message: decision === 'deny' ? 'Иван отказал (проба)' : undefined } } }))
})
