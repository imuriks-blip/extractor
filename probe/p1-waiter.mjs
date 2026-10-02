// Проба П.1 (EXT-33): «звонок» в живой тред. Хук Stop с async + asyncRewake.
// Ждёт файл кнопки rewake/<session_id>.btn; появился — печатает его текст в stderr и выходит с кодом 2:
// Claude Code должен разбудить сессию этим текстом. Один ждущий на сессию (замок rewake/<sid>.lock с pid).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rewake')
fs.mkdirSync(DIR, { recursive: true })
const log = (o) => fs.appendFileSync(path.join(DIR, 'waiter.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...o }) + '\n')

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let j = {}
  try { j = JSON.parse(raw) } catch {}
  const sid = j.session_id || 'unknown'
  // белый список (шаг 2, общий хук десктопа): файла нет — пускаем всех (шаг 1); есть — только перечисленные сессии
  const allowFile = path.join(DIR, 'allow.txt')
  if (fs.existsSync(allowFile)) {
    const allow = fs.readFileSync(allowFile, 'utf8').split(/\s+/).filter(Boolean)
    if (!allow.includes(sid)) process.exit(0)
  }
  const lock = path.join(DIR, `${sid}.lock`)
  const btn = path.join(DIR, `${sid}.btn`)
  // уже есть живой ждущий этой сессии — второй не нужен
  try {
    const other = Number(fs.readFileSync(lock, 'utf8'))
    if (other && other !== process.pid) { process.kill(other, 0); log({ ev: 'skip', sid, other }); process.exit(0) }
  } catch {}
  fs.writeFileSync(lock, String(process.pid))
  // хозяин — процесс Claude Code этой сессии из реестра ~/.claude/sessions/<pid>.json (sessionId == sid).
  // Claude Code не гасит async-хук при выходе (находка П.1): умер хозяин — уходим сами.
  const SESS = path.join(process.env.USERPROFILE || '', '.claude', 'sessions')
  let owner = null
  try {
    for (const f of fs.readdirSync(SESS).filter((n) => /^\d+\.json$/.test(n))) {
      try { const s = JSON.parse(fs.readFileSync(path.join(SESS, f), 'utf8')); if (s.sessionId === sid) { owner = s.pid; break } } catch {}
    }
  } catch {}
  log({ ev: 'start', sid, owner, event: j.hook_event_name })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const t0 = Date.now()
  const tick = setInterval(() => {
    if (owner && !alive(owner)) {
      clearInterval(tick)
      fs.rmSync(lock, { force: true })
      log({ ev: 'owner-gone', sid, owner, waitedMs: Date.now() - t0 })
      process.exit(0)
    }
    if (!fs.existsSync(btn)) return
    const text = fs.readFileSync(btn, 'utf8').trim()
    fs.rmSync(btn, { force: true })
    fs.rmSync(lock, { force: true })
    clearInterval(tick)
    log({ ev: 'ring', sid, text, waitedMs: Date.now() - t0 })
    process.stderr.write(`Слово Ивана с витрины (проба П.1): ${text}`)
    process.exit(2)
  }, 1000)
})
