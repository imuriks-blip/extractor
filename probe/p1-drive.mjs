// Проба П.1 (EXT-33): водитель. Поднимает фоновую сессию бинарником десктопа с хуком Stop (async + asyncRewake)
// только в своём --settings, шлёт одно сообщение, ждёт итога хода, стоит без дела IDLE_S секунд, «жмёт кнопку»
// (файл rewake/<sid>.btn) и смотрит, проснётся ли сессия сама — без нового сообщения в stdin. Затем вторая кнопка.
// Итог — p1-result.json и p1.jsonl (поток событий).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = process.argv[2]
const CWD = process.argv[3] // папка без CLAUDE.md проекта — дешевле
const IDLE_S = Number(process.argv[4] || 20)
const DIR = path.join(HERE, 'rewake')
fs.mkdirSync(DIR, { recursive: true })

const settings = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `node "${path.join(HERE, 'p1-waiter.mjs').replace(/\\/g, '/')}"`, async: true, asyncRewake: true }] }],
  },
}
const sFile = path.join(HERE, 'settings-p1.json')
fs.writeFileSync(sFile, JSON.stringify(settings, null, 2))

const out = fs.createWriteStream(path.join(HERE, 'p1.jsonl'))
const child = spawn(BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--settings', sFile, '--include-hook-events'], { cwd: CWD, windowsHide: true })
child.stderr.on('data', (d) => fs.appendFileSync(path.join(HERE, 'p1.err'), d))

const res = { turns: [], rings: [], sid: null, events: 0 }
let buf = ''
const waiters = []
const onEvent = (e) => {
  res.events++
  if (e.session_id && !res.sid) res.sid = e.session_id
  if (e.type === 'assistant') {
    const t = (e.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ')
    if (t) res.turns.push({ at: new Date().toISOString(), text: t.slice(0, 300) })
  }
  for (const w of [...waiters]) if (w.test(e)) { waiters.splice(waiters.indexOf(w), 1); w.done(e) }
}
child.stdout.on('data', (d) => {
  out.write(d)
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    try { onEvent(JSON.parse(line)) } catch {}
  }
})
const waitFor = (test, ms) => new Promise((resolve) => {
  const w = { test, done: resolve }
  waiters.push(w)
  setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null) } }, ms)
})
const send = (text) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))

;(async () => {
  send('Это проба механики, инструменты не нужны. Ответь одним словом: «готов». Если позже придёт системное напоминание со словом Ивана — ответь одной строкой «принял: <текст>».')
  const r1 = await waitFor((e) => e.type === 'result', 120000)
  res.firstResult = !!r1
  for (const n of [1, 2]) {
    await sleep(IDLE_S)
    const turnsBefore = res.turns.length
    const text = n === 1 ? 'сливай EXT-99 (первая кнопка)' : 'да на EXT-98 (вторая кнопка)'
    fs.writeFileSync(path.join(DIR, `${res.sid}.btn`), text)
    const t0 = Date.now()
    const r = await waitFor((e) => e.type === 'result', 90000)
    res.rings.push({ n, text, woke: !!r, msToResult: r ? Date.now() - t0 : null, newTurns: res.turns.slice(turnsBefore) })
  }
  child.stdin.end()
  await sleep(5)
  try { child.kill() } catch {}
  const lockLeft = fs.readdirSync(DIR).filter((f) => f.endsWith('.lock'))
  res.locksLeftAfterExit = lockLeft
  fs.writeFileSync(path.join(HERE, 'p1-result.json'), JSON.stringify(res, null, 2))
  console.log(JSON.stringify(res, null, 2))
  process.exit(0)
})()
