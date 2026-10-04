// Проба ПТ4б (EXT-63): какой хук и у какой сессии сработал — строка в probe/pt4b-hooks.log (событие, sid, агент).
// Синхронный, без вывода: только запись; ничего не решает.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let j = {}
  try { j = JSON.parse(raw) } catch {}
  fs.appendFileSync(path.join(HERE, 'pt4b-hooks.log'), JSON.stringify({ at: new Date().toISOString(), event: j.hook_event_name ?? null,
    sid: j.session_id ?? null, agent_id: j.agent_id ?? null, agent_type: j.agent_type ?? null, stop_hook_active: j.stop_hook_active ?? null }) + '\n')
  process.exit(0)
})
