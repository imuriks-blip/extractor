// Проба 0.3: настройки на одну сессию — хук разрешений и хук уведомлений.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/')
for (const [name, decision, delay] of [['3a', 'deny', 0], ['3b', 'allow', 0], ['3c', 'allow', 45]]) {
  writeFileSync(`${dir}/settings-${name}.json`, JSON.stringify({
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${dir}/hook-perm.mjs" ${decision} ${delay}`, timeout: 600 }] }],
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${dir}/hook-notify.mjs"`, timeout: 10 }] }],
    },
  }, null, 1))
}
