// INFRA-74: в каком режиме разрешений Иван реально пишет тредам.
// Считает только сообщения человека (type=user, origin.kind=human) в журналах тредов Vault
// за последние N дней (по умолчанию 9). Служебные строки с тем же полем — уведомления фоновых
// задач, сообщения других сессий — выводятся отдельно: первый счёт 25.09 их по ошибке включал.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const days = Number(process.argv[2] || 9)
const dir = join(homedir(), '.claude', 'projects', 'C--Users-imuri-Documents-Obsidian-Vault')
const since = Date.now() - days * 864e5
const human = {}
const other = {}
let files = 0
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue
  const path = join(dir, f)
  if (statSync(path).mtimeMs < since) continue
  files++
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"permissionMode"')) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    const bucket = j.type === 'user' && j.origin?.kind === 'human' ? human : other
    bucket[j.permissionMode] = (bucket[j.permissionMode] || 0) + 1
  }
}
console.log(`журналов тредов Vault за ${days} дн.: ${files}`)
console.log('сообщения Ивана по режимам:', JSON.stringify(human))
console.log('прочие строки с этим полем (не считаются):', JSON.stringify(other))
