// Д.3: разбор подозрений на секреты из d3.log — без значений. Для каждой находки печатает
// карточку, где нашлось (описание / коммент), метку рядом и ВИД значения: длина, алфавит,
// похоже ли на номер коммита (40 hex), UUID, id флоу n8n, заглушку. Решение «настоящий или нет» — человеку.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (p) => { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); return r.ok ? r.json() : { error: r.status } }
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')

function shape(v) {
  if (/^[0-9a-f]{40}$/.test(v)) return 'похоже на номер коммита (40 hex)'
  if (/^[0-9a-f]{64}$/.test(v)) return 'хеш 64 hex'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return 'UUID'
  if (/^(\*+|<[^>]+>|x+|\.\.\.|process\.env|\$\{?[A-Z_]+)/i.test(v)) return 'заглушка'
  const kinds = [/[a-z]/.test(v) && 'строчные', /[A-Z]/.test(v) && 'заглавные', /\d/.test(v) && 'цифры', /[-_]/.test(v) && '- или _'].filter(Boolean)
  return `длина ${v.length}, ${kinds.join('+')}`
}
const LABEL = /(api[_-]?key|token|secret|password|пароль|bearer)\s*[:=]\s*(\S{8,})/gi
const PREFIX = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})/g
const CONN = /postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/gi
const LONG = /(?<![A-Za-z0-9])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9])/g

function findings(text, where) {
  const out = []
  for (const m of text.matchAll(LABEL)) out.push(`${where}: метка «${m[1]}» → ${shape(m[2].replace(/[.,;)"'`]+$/, ''))}`)
  for (const m of text.matchAll(PREFIX)) out.push(`${where}: префикс «${m[1].slice(0, 4)}…» → ${shape(m[1])}`)
  for (const _ of text.matchAll(CONN)) out.push(`${where}: строка подключения с паролем`)
  for (const m of text.matchAll(LONG)) out.push(`${where}: длинная строка → ${shape(m[0])}`)
  return out
}

const report = JSON.parse(readFileSync(new URL('./d3.log', import.meta.url), 'utf8'))
const projects = Object.fromEntries((await get('projects/')).results.map((p) => [p.identifier, p.id]))
for (const line of report.suspects) {
  const ref = line.split(':')[0]
  const [ident, seq] = ref.split('-')
  const it = await get(`work-items/${ident}-${seq}/`)
  const pid = projects[ident]
  const card = await get(`projects/${pid}/work-items/${it.id}/`)
  const found = findings(strip(card.description_html), 'описание')
  const cm = await get(`projects/${pid}/work-items/${it.id}/comments/?per_page=100`)
  ;(cm.results || []).forEach((c, i) => found.push(...findings(strip(c.comment_html), `коммент ${i + 1} (${c.created_at.slice(0, 10)})`)))
  console.log(`\n${ref} · ${it.name.slice(0, 70)}`)
  for (const f of [...new Set(found)]) console.log(`   ${f}`)
}
