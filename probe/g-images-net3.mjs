// EXT-5, факты для Голема (Важно 7 и 8): по всем карточкам и комментам всех проектов считает
// (а) картинки, вставленные в текст (<image-component>, <img>), и чьи это адреса — доски или внешние;
// (б) находки сети 3 — строки 16–39 букв+цифр — отдельно формы «id флоу n8n» (ровно 16 букв+цифр) и прочие.
// Значений не печатает. Пишет итог в g-images-net3.log.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (p) => { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); return r.ok ? r.json() : { error: r.status } }
async function all(path) {
  const out = []; let cursor = null
  do { const pg = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100${cursor ? `&cursor=${cursor}` : ''}`); if (pg.error) break; out.push(...pg.results); cursor = pg.next_page_results ? pg.next_cursor : null } while (cursor)
  return out
}
const IMG = /<(image-component|img)\b[^>]*\bsrc="([^"]*)"/gi
const NET3 = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,39}(?![A-Za-z0-9])/g
// Сеть 3 идёт и по тексту, и по значениям атрибутов (href/src) — Важно 9.
const flat = (h) => (h || '').replace(/\b(href|src)="([^"]*)"/g, ' $2 ').replace(/<[^>]+>/g, ' ')

const report = {}
const started = Date.now()
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean)
for (const p of (await get("projects/")).results.filter((p) => !ONLY.length || ONLY.includes(p.identifier))) {
  const row = { images: 0, imagesBoard: 0, imagesOther: 0, cardsWithImages: [], net3n8n: 0, net3other: 0 }
  for (const it of await all(`projects/${p.id}/work-items/`)) {
    const card = await get(`projects/${p.id}/work-items/${it.id}/`)
    const htmls = [card.description_html, ...(await all(`projects/${p.id}/work-items/${it.id}/comments/`)).map((c) => c.comment_html)]
    let imgs = 0
    for (const h of htmls) {
      for (const m of (h || '').matchAll(IMG)) { imgs++; if (/board\.unorbis\.com|^\/|^[0-9a-f-]{36}/i.test(m[2]) || !/^https?:/i.test(m[2])) row.imagesBoard++; else row.imagesOther++ }
      for (const m of flat(h).matchAll(NET3)) { if (m[0].length === 16) row.net3n8n++; else row.net3other++ }
    }
    if (imgs) { row.images += imgs; row.cardsWithImages.push(`${p.identifier}-${it.sequence_id}`) }
  }
  report[p.identifier] = row
  writeFileSync(new URL(`./g-images-net3${ONLY.length ? '-' + ONLY.join('-') : ''}.log`, import.meta.url), JSON.stringify({ report, minutes: Math.round((Date.now() - started) / 60000) }, null, 1))
}
console.log(JSON.stringify(report))
