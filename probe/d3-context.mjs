// Д.3: контекст подозрений — слова ДО значения и вид значения; само значение не печатается.
// Аргументы: номера карточек. Для строки подключения — вид пароля.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = JSON.parse(readFileSync(join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.plane.env
const BASE = `${env.PLANE_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}/`
const HEAD = { 'X-API-Key': env.PLANE_API_KEY, 'User-Agent': 'node-fetch/unorbis-extractor-probe' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (p) => { await sleep(1100); const r = await fetch(BASE + p, { headers: HEAD }); return r.ok ? r.json() : { error: r.status } }
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
const kinds = (v) => [/[a-z]/.test(v) && 'лат.строчные', /[A-Z]/.test(v) && 'лат.заглавные', /\d/.test(v) && 'цифры', /[а-яё]/i.test(v) && 'кириллица', /[•*]/.test(v) && 'звёздочки/точки'].filter(Boolean).join('+') || 'прочие знаки'
const before = (text, i) => text.slice(Math.max(0, i - 45), i).replace(/[A-Za-z0-9_\-]{20,}/g, '[…]')

// --short: вместо строк от 40 знаков искать 16–39 знаков из букв вперемешку с цифрами (слепое пятно первой сети).
const SHORT = process.argv.includes('--short')
const LONG = SHORT
  ? /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,39}(?![A-Za-z0-9])/g
  : /(?<![A-Za-z0-9])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9])/g
const projects = Object.fromEntries((await get('projects/')).results.map((p) => [p.identifier, p.id]))
for (const ref of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const [ident, seq] = ref.split('-')
  const it = await get(`work-items/${ident}-${seq}/`)
  const pid = projects[ident]
  const texts = [['описание', strip((await get(`projects/${pid}/work-items/${it.id}/`)).description_html)]]
  const cm = await get(`projects/${pid}/work-items/${it.id}/comments/?per_page=100`)
  ;(cm.results || []).forEach((c, i) => texts.push([`коммент ${i + 1}`, strip(c.comment_html)]))
  console.log(`\n${ref}`)
  for (const [where, t] of texts) {
    for (const m of t.matchAll(/postgres(?:ql)?:\/\/([^\s:@]+):([^\s@]+)@/gi))
      console.log(`  ${where}: подключение, пользователь «${m[1]}», пароль: длина ${m[2].length}, ${kinds(m[2])}`)
    for (const m of t.matchAll(/(api[_-]?key|token|secret|password|пароль|bearer)\s*[:=]\s*(\S{8,})/gi))
      console.log(`  ${where}: …${before(t, m.index)}«${m[1]}» → длина ${m[2].length}, ${kinds(m[2])}`)
    for (const m of t.matchAll(LONG))
      console.log(`  ${where}: …${before(t, m.index)}[значение ${m[0].length} зн., ${kinds(m[0])}]`)
  }
}
