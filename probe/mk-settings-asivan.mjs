// EXT-5, проба для Голема: шаблон «спросить» на запись от имени Ивана — кандидат *board*--as*ivan* —
// против обычных написаний (путь в кавычках, двойной пробел) и против законной записи другого автора.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/')
const ask = ['Bash', 'PowerShell'].map((s) => `${s}(*board*--as*ivan*)`)
writeFileSync(`${dir}/settings-asivan.json`, JSON.stringify({
  permissions: { ask },
  hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${dir}/hook-perm.mjs" deny 0`, timeout: 60 }] }] },
}, null, 1))
console.log(ask.join(' · '))
