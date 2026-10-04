// Проба ПТ4б (EXT-63): ждущий звонка на живых фоновых сессиях. Тестовый экземпляр витрины этой копии (свой порт,
// своя data/vitrina, временная доска PRB, подменный plane.py из test/fake-plane.mjs — настоящий Plane и доска не
// трогаются), две фоновые сессии claude.exe -p (скрыто, windowsHide, без shell) со своим --settings: хук Stop —
// только ждущий этой копии (--port, --bell-dir тестового экземпляра) и запись хуков; --setting-sources local —
// хуки Ивана не срабатывают. Слово кладётся «Вернуть» (POST /api/act). Итог — probe/pt4b-summary.json, ход — pt4b-drive.log.
//   node probe/pt4b-drive.mjs <claude.exe>
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeBoard, gitInitCommit } from '../test/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BIN = process.argv[2]
const PORT = 4373
const DATA = path.join(REPO, 'data', 'vitrina')
const BELL = path.join(DATA, 'bell')
const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects')
const LIVE_LOG = 'C:/projects/extractor/data/vitrina/server.log' // живая витрина: только чтение (счёт строк /api/bell)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const fwd = (p) => p.replace(/\\/g, '/')

const LOG = path.join(HERE, 'pt4b-drive.log')
const log = (s) => { const l = `${new Date().toISOString()} ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = { checks: {} }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }

// ---------- тестовый экземпляр: доска PRB, реестр, подменный plane.py, config.json ----------
const Q_MD = 'Проба готова — можно принимать?'
const Q_HTML = `<p>${Q_MD}</p>`
const Q = { at: '2026-10-03T09:00:00.000Z', head: Q_MD }
const env = fs.mkdtempSync(path.join(os.tmpdir(), 'pt4b-'))
const boardDir = path.join(env, 'board')
fs.mkdirSync(boardDir)
const CARDS = ['PRB-1', 'PRB-2']
makeBoard(boardDir, { codes: ['PRB'], cards: CARDS.map((id) => ({ id, status: 'review', title: `Проба ${id}` })) })
for (const id of CARDS) fs.writeFileSync(path.join(boardDir, 'PRB', `${id}.log.md`), `### 2026-10-03 12:00 +03:00 · plane · коммент\n\n${Q_MD}\n`)
gitInitCommit(boardDir)
fs.mkdirSync(path.join(boardDir, '.mirror'))
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: new Date().toISOString() }))
fs.mkdirSync(path.join(boardDir, 'tools'))
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка пробы: дотяжка карточки не запускается\n')
const regFile = path.join(env, 'registry.json')
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { PRB: { projects: [], project_cards: [], repos: [] } } }))
const pdir = path.join(env, 'plane')
fs.mkdirSync(pdir)
fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
const planeState = path.join(pdir, 'state.json')
const resetPlane = () => fs.writeFileSync(planeState, JSON.stringify({ status: 'Review', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: Q_HTML }], clock: new Date().toISOString().replace('Z', '123Z') }))
resetPlane()
fs.mkdirSync(DATA, { recursive: true })
const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ...defaults, port: PORT, toasts: false,
  paths: { ...defaults.paths, board: fwd(boardDir), registry: fwd(regFile), python: fwd(process.execPath) },
  pult: { enabled: true, words: false, bell: true, bellDir: 'data/vitrina/bell/', planePy: fwd(path.join(pdir, 'fake-plane.mjs')) } }, null, 2))

// ---------- HTTP к тестовому экземпляру ----------
function req(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, timeout: 15000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c))
      res.on('end', () => { let j = null; try { j = JSON.parse(b) } catch {} resolve({ status: res.statusCode, body: b, json: j }) })
    })
    r.on('error', () => resolve({ status: 0 })); r.on('timeout', () => r.destroy())
    if (body) r.write(body)
    r.end()
  })
}
let token = null
async function press(card, text) {
  resetPlane()
  if (!token) token = (await req('GET', '/')).body.match(/name="vitrina-token" content="([^"]+)"/)[1]
  const t = Date.now()
  const r = await req('POST', '/api/act', { body: JSON.stringify({ intentId: randomUUID(), action: 'return', card, q: Q, text }),
    headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } })
  const id = r.json?.id ?? null
  log(`нажато «Вернуть» ${card}: ${r.status} ${r.json?.outcome} id=${id} — ${r.json?.message ?? ''}`)
  return { id, at: t, json: r.json }
}
const bellLog = () => { try { return fs.readFileSync(path.join(BELL, 'bell.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const serverLog = () => { try { return fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) } catch { return [] } }
const liveBellLines = () => { try { return fs.readFileSync(LIVE_LOG, 'utf8').split('\n').filter((l) => l.includes('/api/bell')).length } catch (e) { return `не прочитан: ${e.code}` } }
async function waitFor(fn, ms, every = 200) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every) } return null }
const ringOf = (id) => bellLog().find((l) => l.event === 'ring' && l.ids?.includes(id))
const actionStatus = async (ids) => { const r = await req('GET', '/api/actions'); const rows = JSON.stringify(r.json ?? {}); return ids.map((id) => { const m = rows.match(new RegExp(`\\{[^{}]*"id":"${id}"[^{}]*\\}`)); return m ? m[0].slice(0, 400) : null }) }
const ps = (script) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 }, (e, out) => resolve(String(out ?? '').trim())))
const waiterProcs = () => ps("@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*extractor-ext63*bell*waiter.mjs*' } | ForEach-Object { $_.ProcessId }) -join ','")

// ---------- фоновая сессия ----------
const settings = { hooks: {
  Stop: [{ hooks: [
    { type: 'command', command: `node "${fwd(path.join(REPO, 'bell', 'waiter.mjs'))}" --port ${PORT} --bell-dir "${fwd(BELL)}"`, async: true, asyncRewake: true },
    { type: 'command', command: `node "${fwd(path.join(HERE, 'pt4b-hooklog.mjs'))}"` },
  ] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: `node "${fwd(path.join(HERE, 'pt4b-hooklog.mjs'))}"` }] }],
} }
const sFile = path.join(HERE, 'settings-pt4b.json')
fs.writeFileSync(sFile, JSON.stringify(settings, null, 2))
const WORK = path.join(HERE, 'pt4b-work')
fs.mkdirSync(WORK, { recursive: true })

function session(label) {
  const out = fs.createWriteStream(path.join(HERE, `pt4b-${label}.jsonl`))
  const child = spawn(BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--settings', sFile, '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'default', '--tools', 'Task,Agent,Bash', '--include-hook-events'],
  { cwd: WORK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(HERE, `pt4b-${label}.err`), d))
  const s = { label, child, pid: child.pid, sid: null, results: [], assistant: [], exited: null }
  let buf = ''
  child.stdout.on('data', (d) => {
    out.write(d); buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.session_id && !s.sid) s.sid = e.session_id
      if (e.type === 'result') s.results.push({ at: Date.now(), text: String(e.result ?? '').slice(0, 300) })
      if (e.type === 'assistant' && !e.parent_tool_use_id) { const t = (e.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '); if (t) s.assistant.push({ at: Date.now(), text: t.slice(0, 300) }) }
    }
  })
  child.on('exit', (code) => { s.exited = { code, at: Date.now() } })
  s.send = (text) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  s.nextResult = async (ms = 120000) => { const n = s.results.length; return waitFor(() => s.results[n], ms) }
  s.status = () => { try { return JSON.parse(fs.readFileSync(path.join(SESS_DIR, `${child.pid}.json`), 'utf8')).status ?? null } catch { return 'нет записи' } }
  s.journal = () => { for (const d of fs.readdirSync(PROJ_DIR)) { const f = path.join(PROJ_DIR, d, `${s.sid}.jsonl`); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8') } return '' }
  return s
}
const lockOf = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(BELL, `${sid}.lock`), 'utf8')) } catch { return null } }
const waiterStarted = (sid, after) => waitFor(() => bellLog().find((l) => l.sid === sid && l.event === 'start' && Date.parse(l.at) >= after), 15000)
// строки «звонка» в журнале сессии: user с origin task-notification и id
const ringsInJournal = (s, id) => s.journal().split('\n').filter((l) => l.includes(id)).map((l) => { try { const j = JSON.parse(l); return { type: j.type, origin: j.origin?.kind ?? null, text: JSON.stringify(j.message?.content ?? '').slice(0, 900) } } catch { return null } }).filter(Boolean)

;(async () => {
  log(`старт: BIN=${BIN}, тестовый экземпляр :${PORT}, доска ${boardDir}`)
  S.liveBellBefore = liveBellLines()
  for (const f of ['bell.log', 'STOP']) try { fs.unlinkSync(path.join(BELL, f)) } catch {}
  const srv = spawn(process.execPath, ['server.mjs', '--console-log'], { cwd: REPO, windowsHide: true, stdio: 'ignore' })
  const up = await waitFor(async () => (await req('GET', '/api/health')).status === 200, 30000, 500)
  log(`витрина pid ${srv.pid}: ${up ? 'отвечает' : 'НЕ ПОДНЯЛАСЬ'}; bell: ${JSON.stringify((await req('GET', '/api/health')).json?.bell)}`)
  if (!up) process.exit(1)
  const A = session('A'); const B = session('B')
  const first = (card) => `Это проба механики по карточке ${card}. Инструменты не нужны. Ответь одним словом: «готов». Если позже придёт системное напоминание «Слово Ивана · кнопка витрины» — ничего не исполняй, ответь одной строкой «принял: <все id вида W-… через запятую>».`
  A.send(first('PRB-1')); B.send(first('PRB-2'))
  await Promise.all([A.nextResult(), B.nextResult()])
  log(`A sid ${A.sid} pid ${A.pid}; B sid ${B.sid} pid ${B.pid}`)
  const seen = await waitFor(async () => { const j = (await req('GET', '/api/ceh')).json; const th = j?.workers?.threads ?? []; const a = th.find((t) => t.sessionId === A.sid); const b = th.find((t) => t.sessionId === B.sid); return a?.card === 'PRB-1' && b?.card === 'PRB-2' ? { a: a.card, b: b.card, status: [a.procStatus, b.procStatus] } : null }, 60000, 1000)
  log(`витрина видит треды: ${JSON.stringify(seen)}`)
  await waitFor(() => A.status() === 'idle' && B.status() === 'idle' && lockOf(A.sid) && lockOf(B.sid), 20000)

  // T1: свободный тред, одно слово → звонок ≤ 10 с; слово A не в журнале B
  const w1 = await press('PRB-1', 'проба T1')
  const r1 = await waitFor(() => ringOf(w1.id), 15000, 100)
  const res1 = await A.nextResult(30000)
  await sleep(3000)
  check('T1 ≤10 с от кнопки', { id: w1.id, msToRingLine: r1 ? Date.parse(r1.at) - w1.at : null, msToWokenResult: res1 ? res1.at - w1.at : null, answer: res1?.text, inJournalA: ringsInJournal(A, w1.id).filter((x) => x.origin === 'task-notification').length, inJournalB: ringsInJournal(B, w1.id).length, Bresults: B.results.length })
  const w1b = await press('PRB-2', 'проба T1 для B')
  const res1b = await B.nextResult(30000)
  await sleep(3000)
  check('T1 две сессии', { idB: w1b.id, bWoke: !!res1b, msB: res1b ? res1b.at - w1b.at : null, inJournalA: ringsInJournal(A, w1b.id).length, inJournalB: ringsInJournal(B, w1b.id).filter((x) => x.origin === 'task-notification').length })

  // T2: сигнал мимо сервера → forged, звонка нет; исправный рядом
  await waitFor(() => A.status() === 'idle' && lockOf(A.sid), 20000)
  const fake = 'W-261004-000000-dead'
  const nA = A.results.length
  fs.writeFileSync(path.join(BELL, A.sid, `${fake}.ring`), '')
  const fg = await waitFor(() => bellLog().find((l) => l.event === 'forged' && l.ids?.includes(fake)), 10000, 100)
  await sleep(8000)
  check('T2 поддельный сигнал', { forgedLine: !!fg, newTurnsA: A.results.length - nA, inJournalA: ringsInJournal(A, fake).length, signalLeft: fs.existsSync(path.join(BELL, A.sid, `${fake}.ring`)), serverForged: serverLog().filter((l) => l.event === 'forged' || l.event === 'stale').map((l) => l.event) })
  const w2 = await press('PRB-1', 'проба T2 исправный')
  const res2 = await A.nextResult(30000)
  check('T2 исправный рядом', { id: w2.id, woke: !!res2, ms: res2 ? res2.at - w2.at : null })

  // T3: занятой тред (busy), два слова, GET дважды, злая страница Edge → один звонок с двумя id после конца хода
  await waitFor(() => A.status() === 'idle' && lockOf(A.sid), 20000)
  const ringsBefore = bellLog().filter((l) => l.event === 'ring').length
  A.send('Напиши подряд числа от 1 до 250 словами по-русски, через запятую, без пояснений.')
  const busy = await waitFor(() => A.status() === 'busy', 15000, 100)
  const w3a = await press('PRB-1', 'проба T3 первое')
  const w3b = await press('PRB-1', 'проба T3 второе')
  const g1 = await req('GET', `/api/bell/${A.sid}`); const g2 = await req('GET', `/api/bell/${A.sid}`)
  const evil = path.join(env, 'evil.html')
  fs.writeFileSync(evil, `<!doctype html><img src="http://127.0.0.1:${PORT}/api/bell/${A.sid}"><script>fetch('http://127.0.0.1:${PORT}/api/bell/${A.sid}', {mode: 'no-cors'}).finally(() => { document.title = 'done' })</script>`)
  const srvBefore = serverLog().length
  await new Promise((resolve) => { const e = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(env, 'edge')}`, '--virtual-time-budget=4000', '--dump-dom', `file:///${fwd(evil)}`], { windowsHide: true, stdio: 'ignore' }); e.on('exit', resolve); setTimeout(() => { try { e.kill() } catch {} resolve() }, 30000) })
  await sleep(1000)
  const evilLines = serverLog().slice(srvBefore).filter((l) => l.route === '/api/bell/:sid' || String(l.route ?? '').startsWith('/api/bell'))
  const statusDuringBusy = A.status()
  const ringsWhileBusy = bellLog().filter((l) => l.event === 'ring').length - ringsBefore
  const res3 = await A.nextResult(120000) // конец хода «числа»
  const r3 = await waitFor(() => ringOf(w3a.id), 20000, 100)
  const res3b = await A.nextResult(30000) // ход по звонку
  await sleep(4000)
  const j3 = ringsInJournal(A, w3a.id).filter((x) => x.origin === 'task-notification')
  check('T3 busy, два слова, GET×2, Edge', { busySeen: !!busy, statusDuringBusy, ringsWhileBusy, ids: [w3a.id, w3b.id], get1: g1.json?.ids, get2: g2.json?.ids, getStatus: [g1.status, g2.status],
    evil: evilLines.map((l) => ({ status: l.status, deny: l.deny ?? null })), turnEndAt: res3?.at, ringLine: r3 ? { ids: r3.ids, msAfterTurnEnd: Date.parse(r3.at) - (res3?.at ?? 0) } : null, wokenAnswer: res3b?.text,
    journalRingRows: j3.length, journalHasBoth: j3.some((x) => x.text.includes(w3a.id) && x.text.includes(w3b.id)), journalText: j3[0]?.text ?? null, statuses: await actionStatus([w3a.id, w3b.id]) })

  // T4: два хода подряд после одного звонка → forged 0, второго звонка с теми же id нет
  const lenT4 = bellLog().length
  A.send('Ответь одним словом: «раз».'); await A.nextResult(60000); await sleep(3000)
  A.send('Ответь одним словом: «два».'); await A.nextResult(60000); await sleep(5000)
  const after4 = bellLog().slice(lenT4)
  check('T4 два хода после звонка', { forged: after4.filter((l) => l.event === 'forged').length, ringsSameIds: bellLog().filter((l) => l.event === 'ring' && (l.ids.includes(w3a.id) || l.ids.includes(w3b.id))).length, events: after4.map((l) => l.event) })

  // T5: поддельная строка ring → «доставлено» без «прочитано», нового слова нет
  await waitFor(() => A.status() === 'idle' && lockOf(A.sid), 20000)
  A.send('Напиши подряд числа от 1 до 200 словами по-русски, через запятую, без пояснений.')
  await waitFor(() => A.status() === 'busy', 15000, 100)
  const w5 = await press('PRB-1', 'проба T5')
  fs.appendFileSync(path.join(BELL, 'bell.log'), JSON.stringify({ at: new Date().toISOString(), sid: A.sid, event: 'ring', ids: [w5.id] }) + '\n')
  const g5 = await req('GET', `/api/bell/${A.sid}`)
  await A.nextResult(120000); await sleep(8000)
  check('T5 поддельная строка ring', { id: w5.id, getAfterFake: g5.json?.ids, inJournalA: ringsInJournal(A, w5.id).filter((x) => x.origin === 'task-notification').length, after: bellLog().filter((l) => l.ids?.includes(w5.id)).map((l) => l.event), serverForged: serverLog().filter((l) => l.event === 'forged' || l.event === 'stale').map((l) => l.event), status: await actionStatus([w5.id]) })

  // T6: замки — мёртвый pid, чужой procStart; STOP на тике и при старте
  const killWaiter = async () => { const l = lockOf(A.sid); if (l) { try { process.kill(l.pid) } catch {} } await sleep(1500); return l?.pid }
  await waitFor(() => lockOf(A.sid), 15000)
  const k1 = await killWaiter()
  fs.writeFileSync(path.join(BELL, `${A.sid}.lock`), JSON.stringify({ pid: k1, procStart: '1', bootAt: 'x', at: 'x' })) // pid мёртв
  let t = Date.now(); A.send('Ответь одним словом: «три».'); await A.nextResult(60000)
  await waiterStarted(A.sid, t); const L1 = lockOf(A.sid)
  check('T6 замок с мёртвым pid', { deadPid: k1, nowLock: L1 && { pid: L1.pid, procStart: L1.procStart }, taken: !!L1 && L1.pid !== k1 })
  await killWaiter()
  fs.writeFileSync(path.join(BELL, `${A.sid}.lock`), JSON.stringify({ pid: process.pid, procStart: '1', bootAt: 'x', at: 'x' })) // pid жив (водитель), время старта чужое
  t = Date.now(); A.send('Ответь одним словом: «четыре».'); await A.nextResult(60000)
  await waiterStarted(A.sid, t); const L2 = lockOf(A.sid)
  check('T6 замок с чужим procStart', { alivePid: process.pid, nowLock: L2 && { pid: L2.pid, procStart: L2.procStart }, taken: !!L2 && L2.pid !== process.pid })
  const lenStop = bellLog().length
  fs.writeFileSync(path.join(BELL, 'STOP'), '')
  await waitFor(() => bellLog().slice(lenStop).find((l) => l.event === 'stop' && l.sid === A.sid), 5000)
  t = Date.now(); A.send('Ответь одним словом: «пять».'); await A.nextResult(60000); await sleep(3000)
  check('T6 STOP на тике и до старта', { events: bellLog().slice(lenStop).filter((l) => l.sid === A.sid).map((l) => l.event), lockAfter: lockOf(A.sid) })
  fs.unlinkSync(path.join(BELL, 'STOP'))

  // T7: waiting — даёт ли -p статус «ждёт разрешения» (Bash без разрешения)
  const st7 = new Set(); let on7 = true
  ;(async () => { while (on7) { st7.add(A.status()); await sleep(100) } })()
  const lenH7 = bellLog().length
  A.send('Выполни инструментом Bash команду: echo pt4b. Затем ответь одним словом: «сделал».')
  const res7 = await A.nextResult(90000); await sleep(2000); on7 = false
  check('T7 waiting', { statusesSeen: [...st7], answer: res7?.text, events: bellLog().slice(lenH7).filter((l) => l.sid === A.sid).map((l) => l.event) })

  // T8: субагент — срабатывает ли Stop у субагента
  const hooksFile = path.join(HERE, 'pt4b-hooks.log')
  const hLen = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8').split('\n').filter(Boolean).length : 0
  const bLen = bellLog().length
  A.send('Вызови один раз инструмент Task (или Agent) с subagent_type general-purpose и заданием «ответь одним словом: ok, инструменты не используй». Потом ответь одним словом: «готово».')
  const res8 = await A.nextResult(180000); await sleep(4000)
  const hooks8 = fs.readFileSync(hooksFile, 'utf8').split('\n').filter(Boolean).slice(hLen).map((l) => JSON.parse(l))
  const usedTask = fs.readFileSync(path.join(HERE, 'pt4b-A.jsonl'), 'utf8').includes('"parent_tool_use_id":"')
  check('T8 субагент', { answer: res8?.text, subagentRan: usedTask, hooks: hooks8.map((h) => ({ event: h.event, sid: h.sid === A.sid ? 'A' : h.sid, agent: h.agent_type })), waiterStarts: bellLog().slice(bLen).filter((l) => l.event === 'start').length })

  // T9: хозяин убит → ждущий ушёл ≤ 5 с, сирот нет
  await waitFor(() => lockOf(A.sid) && lockOf(B.sid), 15000)
  const before9 = await waiterProcs()
  const kills = []
  for (const s of [A, B]) { const len = bellLog().length; const t0 = Date.now(); s.child.kill(); const g = await waitFor(() => bellLog().slice(len).find((l) => l.sid === s.sid && l.event === 'owner-gone'), 15000, 100); kills.push({ s: s.label, msToOwnerGone: g ? Date.parse(g.at) - t0 : null, lockLeft: !!lockOf(s.sid) }) }
  await sleep(1500)
  const after9 = await waiterProcs()
  check('T9 хозяин убит', { waitersBefore: before9, kills, waitersAfter: after9 || '(нет)' })

  S.liveBellAfter = liveBellLines()
  check('живая витрина: строк /api/bell в её server.log', { before: S.liveBellBefore, after: S.liveBellAfter })
  S.bellLog = bellLog(); S.health = (await req('GET', '/api/health')).json?.bell
  S.sessions = { A: { sid: A.sid, results: A.results.length }, B: { sid: B.sid, results: B.results.length } }
  try { process.kill(srv.pid) } catch {}
  fs.writeFileSync(path.join(HERE, 'pt4b-summary.json'), JSON.stringify(S, null, 2))
  log('конец пробы')
  process.exit(0)
})().catch((e) => { log(`СБОЙ: ${e.stack}`); process.exit(1) })
