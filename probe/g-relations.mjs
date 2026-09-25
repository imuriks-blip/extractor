// EXT-5, факт для Голема: что отдаёт REST Plane на связи карточки. Ищет первые карточки со связями
// среди INFRA и CAR, печатает код ответа и форму (ключи, число связей по типам) — без текстов карточек.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (p) => { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); let b = null; try { b = await r.json() } catch {} return { status: r.status, body: b } }

const projects = (await get('projects/')).body.results
let found = 0
for (const ident of ['INFRA', 'CAR']) {
  const p = projects.find((x) => x.identifier === ident)
  const items = (await get(`projects/${p.id}/work-items/?per_page=100`)).body.results
  for (const it of items) {
    const r = await get(`projects/${p.id}/work-items/${it.id}/relations/`)
    if (r.status !== 200) { console.log(`${ident}-${it.sequence_id}: код ${r.status}`); if (++found >= 2) break; continue }
    const b = r.body || {}
    const counts = Object.fromEntries(Object.entries(b).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, v.length]))
    if (Object.keys(counts).length) {
      console.log(`${ident}-${it.sequence_id}: код 200, ключи ответа: ${Object.keys(b).join(', ')}; непустые: ${JSON.stringify(counts)}; элемент: ${typeof Object.values(b).find((v) => Array.isArray(v) && v.length)[0]}`)
      if (++found >= 3) break
    }
  }
  if (found >= 3) break
}
if (!found) console.log('карточек со связями в первых сотнях INFRA и CAR не нашлось')
