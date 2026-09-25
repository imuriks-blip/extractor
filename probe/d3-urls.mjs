// Д.3: слепое пятно первой сети — учётные данные внутри ссылок (короткие пароли в параметрах,
// логин:пароль@хост). Проходит все карточки проекта; печатает карточку, место и ВИД, без значений.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (p) => { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); return r.ok ? r.json() : { error: r.status } }
const text = (h) => (h || '').replace(/<a [^>]*href="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ')

const CHECKS = [
  ['параметр ссылки', /[?&](username|user|login|password|pass|pwd|token|key|auth|apikey|api_key)=([^&\s"'<]+)/gi],
  ['логин:пароль в ссылке', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi],
  ['плейлист провайдера', /\bget\.php\b|\bplayer_api\.php\b|\/live\/[^\s/]+\/[^\s/]+\//gi],
]

const [ident] = process.argv.slice(2)
const pid = (await get('projects/')).results.find((p) => p.identifier === ident).id
let cursor = null
const items = []
do { const pg = await get(`projects/${pid}/work-items/?per_page=100${cursor ? `&cursor=${cursor}` : ''}`); items.push(...pg.results); cursor = pg.next_page_results ? pg.next_cursor : null } while (cursor)
for (const it of items) {
  const texts = [['описание', text((await get(`projects/${pid}/work-items/${it.id}/`)).description_html)]]
  const cm = await get(`projects/${pid}/work-items/${it.id}/comments/?per_page=100`)
  ;(cm.results || []).forEach((c, i) => texts.push([`коммент ${i + 1} (${c.created_at.slice(0, 10)})`, text(c.comment_html)]))
  for (const [where, t] of texts) for (const [kind, re] of CHECKS) for (const m of t.matchAll(re)) {
    const v = m[2] ?? m[1] ?? ''
    const masked = /^(\*+|x+|<[^>]*>|\.\.\.|…|XXX|user|pass|password|login|token)$/i.test(v) ? 'заглушка' : `значение ${v.length} зн.`
    console.log(`${ident}-${it.sequence_id} · ${where}: ${kind}${m[1] && kind === 'параметр ссылки' ? ` «${m[1]}»` : ''} → ${kind === 'плейлист провайдера' ? 'адрес плейлиста' : masked}`)
  }
}
console.log(`проверено карточек ${ident}: ${items.length}`)
