// Проба Д.4 (EXT-3): цена чтения доски агентом — ответ Plane (как его видит подключение) против файлов git-доски.
// Три действия: «мои карточки», «покажи карточку», «последние 3 записи». Сравнение в знаках ответа.
// Файлы будущего формата собираются в черновой папке (аргумент), не в репозитории доски.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
const CARDS = ['CAR-256', 'INFRA-74', 'EXT-3', 'LEDGER-156']
const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function raw(p) { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); return r.text() }
const text = (h) => (h || '').replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|li|h\d)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&[a-z]+;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

const projects = JSON.parse(await raw('projects/')).results
const byId = Object.fromEntries(projects.map((p) => [p.id, p.identifier]))
const rows = []

// 1. «Мои карточки»: фильтры доски не работают — подключение листает все карточки всех проектов.
let planeMine = 0
const mine = []
for (const p of projects) {
  const states = JSON.parse(await raw(`projects/${p.id}/states/`)).results
  const labels = JSON.parse(await raw(`projects/${p.id}/labels/`)).results
  const sName = Object.fromEntries(states.map((s) => [s.id, s.name]))
  const trurl = labels.find((l) => l.name === 'trurl')?.id
  planeMine += JSON.stringify(states).length + JSON.stringify(labels).length
  let cursor = null
  do {
    const body = await raw(`projects/${p.id}/work-items/?per_page=100${cursor ? `&cursor=${cursor}` : ''}`)
    planeMine += body.length
    const pg = JSON.parse(body)
    for (const it of pg.results) if (['Ready', 'In Progress'].includes(sName[it.state]) && it.labels?.includes(trurl)) mine.push(`${p.identifier}-${it.sequence_id} · ${sName[it.state].toLowerCase()} · ${it.priority} · ${it.name}`)
    cursor = pg.next_page_results ? pg.next_cursor : null
  } while (cursor)
}
// В git: поиск по шапкам — одна строка на карточку.
rows.push(['мои карточки (все проекты)', planeMine, mine.join('\n').length, `${mine.length} карточек`])

// 2–3. Карточка целиком и последние 3 записи журнала.
mkdirSync(OUT, { recursive: true })
for (const ref of CARDS) {
  const itBody = await raw(`work-items/${ref}/`)
  const it = JSON.parse(itBody)
  const full = await raw(`projects/${it.project}/work-items/${it.id}/?expand=state,labels`)
  const cmBody = await raw(`projects/${it.project}/work-items/${it.id}/comments/?per_page=100`)
  const card = JSON.parse(full)
  const comments = JSON.parse(cmBody).results.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const head = ['---', `id: ${ref}`, `title: ${card.name}`, `status: ${(card.state?.name || '').toLowerCase()}`, `priority: ${card.priority}`,
    `labels: [${(card.labels || []).map((l) => l.name).join(', ')}]`, `created: ${card.created_at?.slice(0, 10)}`, `updated: ${card.updated_at?.slice(0, 10)}`, '---', '', text(card.description_html)].join('\n')
  const entries = comments.map((c) => `### ${c.created_at.slice(0, 16).replace('T', ' ')} · запись\n\n${text(c.comment_html)}\n`)
  writeFileSync(join(OUT, `${ref}.md`), head)
  writeFileSync(join(OUT, `${ref}.log.md`), entries.join('\n'))
  rows.push([`карточка ${ref}`, full.length, head.length, ''])
  // Подключение отдаёт все комменты карточки разом; в git — хвост журнала.
  rows.push([`последние 3 записи ${ref}`, cmBody.length, entries.slice(-3).join('\n').length, `всего записей ${entries.length}`])
}

console.log('действие | Plane, знаков | git, знаков | во сколько раз | примечание')
for (const [a, p, g, note] of rows) console.log(`${a} | ${p} | ${g} | ${(p / Math.max(g, 1)).toFixed(1)} | ${note}`)
