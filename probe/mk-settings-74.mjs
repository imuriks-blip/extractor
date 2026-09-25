// Проба INFRA-74: кандидат-правила «спросить» + хук разрешений, который всё отклоняет и пишет в журнал.
// Сработал хук — правило поймало команду; команда выполнилась — не поймало.
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/')
const ask = JSON.parse(execFileSync(process.execPath, [`${dir}/ask-rules.mjs`], { encoding: 'utf8' }))
writeFileSync(`${dir}/settings-74.json`, JSON.stringify({
  permissions: { ask },
  hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${dir}/hook-perm.mjs" deny 0`, timeout: 60 }] }] },
}, null, 1))
console.log(`правил: ${ask.length}`)
