// Проба Д.3 (EXT-3): перенос доски вхолостую — ничего не пишет, только считает.
// Карточки, комменты, вложения, объём текста, подозрения на секреты (только номер карточки и вид находки, без значений).
// Ключ доски берётся из настроек Claude Desktop, как у plane.py; не печатается.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let calls = 0
async function get(path) {
  // 60 запросов в минуту на общий ключ: держим ~55, чтобы треды тоже могли писать.
  await sleep(1100)
  calls++
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, { headers: HEAD })
    if (r.status === 429) { await sleep(30000); continue }
    if (!r.ok) return { error: r.status }
    return r.json()
  }
  return { error: 429 }
}
async function all(path) {
  const out = []
  let cursor = null
  do {
    const sep = path.includes('?') ? '&' : '?'
    const page = await get(`${path}${sep}per_page=100${cursor ? `&cursor=${cursor}` : ''}`)
    if (page.error) return { error: page.error, out }
    out.push(...(page.results || []))
    cursor = page.next_page_results ? page.next_cursor : null
  } while (cursor)
  return { out }
}

// Похожее на секрет: явные метки ключей и длинные непрерывные строки из букв и цифр.
const SECRET = [
  ['метка ключа', /(api[_-]?key|token|secret|password|пароль|bearer)\s*[:=]\s*\S{8,}/i],
  ['ключ по префиксу', /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})/],
  ['строка подключения', /postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/i],
  ['длинная строка', /(?<![A-Za-z0-9])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9])/],
]
const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
function scan(text) { return SECRET.filter(([, re]) => re.test(text)).map(([k]) => k) }

const started = Date.now()
const report = { projects: {}, suspects: [], errors: [] }
const projects = (await get('projects/')).results
for (const p of projects) {
  const items = await all(`projects/${p.id}/work-items/`)
  if (items.error) report.errors.push(`${p.identifier}: карточки ${items.error}`)
  const row = { cards: items.out.length, comments: 0, commentAttachments: 0, cardAttachments: 0, chars: 0 }
  for (const it of items.out) {
    const id = `${p.identifier}-${it.sequence_id}`
    const card = await get(`projects/${p.id}/work-items/${it.id}/`)
    const desc = strip(card.description_html)
    row.chars += desc.length + (it.name || '').length
    const hits = new Set(scan(desc))
    const cm = await all(`projects/${p.id}/work-items/${it.id}/comments/`)
    if (cm.error) report.errors.push(`${id}: комменты ${cm.error}`)
    for (const c of cm.out) {
      row.comments++
      row.commentAttachments += (c.attachments || []).length
      const t = strip(c.comment_html)
      row.chars += t.length
      scan(t).forEach((h) => hits.add(h))
    }
    const at = await get(`projects/${p.id}/work-items/${it.id}/attachments/`)
    if (Array.isArray(at)) row.cardAttachments += at.length
    else if (at.results) row.cardAttachments += at.results.length
    if (hits.size) report.suspects.push(`${id}: ${[...hits].join(', ')}`)
  }
  report.projects[p.identifier] = row
  writeFileSync(new URL('./d3.log', import.meta.url), JSON.stringify(report, null, 1))
}
report.calls = calls
report.minutes = Math.round((Date.now() - started) / 60000)
writeFileSync(new URL('./d3.log', import.meta.url), JSON.stringify(report, null, 1))
console.log(JSON.stringify({ projects: report.projects, suspects: report.suspects.length, errors: report.errors.length, calls, minutes: report.minutes }))
