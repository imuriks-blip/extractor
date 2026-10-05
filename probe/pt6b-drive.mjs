// Проба ПТ6 (EXT-67, такт 2): кнопки-слова на тестовом экземпляре витрины этой копии (свой порт, своя data/vitrina,
// свой каталог звонка bell-pt6, своя доска в temp). Настоящий plane.py — только EXT-68/EXT-69 (через обёртку
// pt6-plane.mjs, она не пускает другие карточки); «Принять» при pult.words=false — на подменном test/fake-plane.mjs.
// Фоновая сессия claude.exe -p (скрыто, windowsHide) со своим --settings: хук Stop — только ждущий этой копии;
// --setting-sources local — хуки Ивана не срабатывают. Итог — probe/pt6b-summary.json, ход — probe/pt6-drive.log.
//   node probe/pt6-drive.mjs <claude.exe>
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BIN = process.argv[2]
const PORT = 4382
guardLive(REPO, PORT) // отказ из папки живой витрины и на порту 4317 — до любой записи
const DATA = path.join(REPO, 'data', 'vitrina')
const BELL = path.join(DATA, 'bell-pt6b')
const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects')
const PLANE_PY = 'C:/projects/_plane-rest/plane.py'
const fwd = (p) => p.replace(/\\/g, '/')

const LOG = path.join(HERE, 'pt6b-drive.log')
const log = (s) => { const l = `${new Date().toISOString()} ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PART2 = false // продолжение: EXT-69 (после «го») и фаза 2; нужен, если часть 1 оборвалась — комменты в Plane не удаляются
const S = { checks: {}, comments: { 'EXT-68': [] } }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const waitFor = async (fn, ms, every = 200) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every) } return null }
const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 22 }, (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(out ?? '').trim(), err: String(err ?? '').trim() })))

// ---------- настоящий Plane: только EXT-68/EXT-69 ----------
const OK_CARDS = ['EXT-68']
async function planeComment(card, text) {
  if (!OK_CARDS.includes(card)) throw new Error(`запись в ${card} запрещена`)
  const r = await run('python', [PLANE_PY, 'comment', `<p>${text}</p>`, card])
  const m = r.out.match(/^(EXT-\d+) · коммент (\S+) · (\S+)$/)
  log(`plane.py comment ${card}: код ${r.code}: ${r.out || r.err}`)
  if (r.code !== 0 || !m) throw new Error(`comment ${card} не лёг: ${r.out || r.err}`)
  const c = { id: m[2], created_at: m[3] }
  S.comments[card] = [...(S.comments[card] ?? []), { by: 'проба', ...c, text }]
  return c
}
async function planeAll(card) {
  const r = await run('python', [path.join(HERE, 'pt6-comments.py'), card])
  try { return JSON.parse(r.out) } catch { throw new Error(`чтение комментов ${card}: ${r.out || r.err}`) }
}

// ---------- тестовый экземпляр ----------
const env = fs.mkdtempSync(path.join(os.tmpdir(), 'pt6b-'))
const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
fs.mkdirSync(DATA, { recursive: true })
const writeConfig = (pult, paths) => fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ...defaults, port: PORT, toasts: false, paths: { ...defaults.paths, ...paths }, pult }, null, 2))
function mirrorBoard(dir, codes, cards) {
  fs.mkdirSync(dir)
  makeBoard(dir, { codes, cards })
  gitInitCommit(dir)
  fs.mkdirSync(path.join(dir, '.mirror'))
  fs.writeFileSync(path.join(dir, '.mirror', 'index.json'), '{}')
  fs.writeFileSync(path.join(dir, '.mirror', 'status.json'), JSON.stringify({ lastOk: new Date().toISOString() }))
  fs.mkdirSync(path.join(dir, 'tools'))
  fs.writeFileSync(path.join(dir, 'tools', 'mirror-hidden.js'), '// заглушка пробы: дотяжка карточки не запускается\n')
}
const registry = (dir, codes) => { const f = path.join(env, `registry-${path.basename(dir)}.json`); fs.writeFileSync(f, JSON.stringify({ board_codes: Object.fromEntries(codes.map((c) => [c, { projects: [], project_cards: [], repos: [] }])) })); return f }

function req(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, timeout: 60000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c))
      res.on('end', () => { let j = null; try { j = JSON.parse(b) } catch {} resolve({ status: res.statusCode, body: b, json: j }) })
    })
    r.on('error', () => resolve({ status: 0 })); r.on('timeout', () => r.destroy())
    if (body) r.write(body)
    r.end()
  })
}
let token = null
async function act(action, card, extra = {}) {
  if (!token) token = (await req('GET', '/')).body.match(/name="vitrina-token" content="([^"]+)"/)[1]
  const r = await req('POST', '/api/act', { body: JSON.stringify({ intentId: randomUUID(), action, card, ...extra }),
    headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } })
  log(`нажато «${action}» ${card}: HTTP ${r.status} ${r.json?.outcome ?? ''} id=${r.json?.id ?? ''} — ${r.json?.message ?? r.body.slice(0, 160)}`)
  return { status: r.status, id: r.json?.id ?? null, outcome: r.json?.outcome ?? null, message: r.json?.message ?? null, json: r.json }
}
const qOfCard = async (card) => (await req('GET', `/api/card/${card}`)).json?.pult?.q
const jl = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) } catch { return [] } }
const bellLog = () => jl(path.join(BELL, 'bell.log'))
const actionsLog = () => jl(path.join(DATA, 'actions.log'))
const stepsOf = (id) => actionsLog().filter((l) => l.id === id).map((l) => l.step + (l.cmd ? `:${l.cmd}` : ''))
const planeCalls = () => jl(path.join(HERE, 'pt6b-plane-calls.log'))
const commentCalls = () => planeCalls().filter((c) => c.args?.[0] === 'comment' && c.code === 0).length

const startServer = async () => {
  const srv = spawn(process.execPath, ['server.mjs', '--console-log'], { cwd: REPO, windowsHide: true, stdio: 'ignore' })
  const up = await waitFor(async () => (await req('GET', '/api/health')).status === 200, 30000, 500)
  log(`витрина pid ${srv.pid}: ${up ? 'отвечает' : 'НЕ ПОДНЯЛАСЬ'}`)
  if (!up) { try { process.kill(srv.pid) } catch {} process.exit(1) }
  return srv
}
const stopServer = async (srv) => { try { process.kill(srv.pid) } catch {} await waitFor(async () => (await req('GET', '/api/health')).status === 0, 10000, 300); token = null }

// ---------- фоновая сессия ----------
const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${fwd(path.join(REPO, 'bell', 'waiter.mjs'))}" --port ${PORT} --bell-dir "${fwd(BELL)}"`, async: true, asyncRewake: true }] }] } }
const sFile = path.join(HERE, 'settings-pt6b.json')
fs.writeFileSync(sFile, JSON.stringify(settings, null, 2))
const WORK = path.join(HERE, 'pt6b-work')
fs.mkdirSync(WORK, { recursive: true })
function session(label) {
  const out = fs.createWriteStream(path.join(HERE, `pt6b-${label}.jsonl`))
  const child = spawn(BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--settings', sFile, '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'default', '--tools', 'Bash', '--include-hook-events'],
  { cwd: WORK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(HERE, `pt6b-${label}.err`), d))
  const s = { child, pid: child.pid, sid: null, results: [] }
  let buf = ''
  child.stdout.on('data', (d) => {
    out.write(d); buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.session_id && !s.sid) s.sid = e.session_id
      if (e.type === 'result') s.results.push({ at: Date.now(), text: String(e.result ?? '').slice(0, 300) })
    }
  })
  s.send = (text) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  s.nextResult = async (ms = 120000) => { const n = s.results.length; return waitFor(() => s.results[n], ms) }
  s.status = () => { try { return JSON.parse(fs.readFileSync(path.join(SESS_DIR, `${child.pid}.json`), 'utf8')).status ?? null } catch { return 'нет записи' } }
  s.journal = () => { for (const d of fs.readdirSync(PROJ_DIR)) { const f = path.join(PROJ_DIR, d, `${s.sid}.jsonl`); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8') } return '' }
  return s
}
const lockOf = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(BELL, `${sid}.lock`), 'utf8')) } catch { return null } }
const inJournal = (s, id) => s.journal().split('\n').filter((l) => l.includes(id)).map((l) => { try { const j = JSON.parse(l); return { type: j.type, origin: j.origin?.kind ?? null, text: JSON.stringify(j.message?.content ?? '').slice(0, 700) } } catch { return null } }).filter(Boolean)


;(async () => {
  log(`старт: BIN=${BIN}, тестовый экземпляр :${PORT}, temp ${env}`)
  if ((await req('GET', '/api/health')).status !== 0) { log(`порт ${PORT} занят — стоп`); process.exit(1) }
  fs.rmSync(BELL, { recursive: true, force: true })
  try { fs.unlinkSync(path.join(DATA, 'actions.log')) } catch {}
  const n = async () => (await planeAll('EXT-68')).length
  const base = await planeAll('EXT-68'); const last = base.at(-1)
  log(`до пробы: EXT-68 комментов ${base.length}, последний ${last.id}`)
  const qd = new Date(last.created_at)
  const hdr = `${qd.toISOString().slice(0, 10)} ${qd.toISOString().slice(11, 16)} +00:00`
  const boardDir = path.join(env, 'board')
  mirrorBoard(boardDir, ['EXT'], [{ id: 'EXT-68', status: 'review', title: 'Проба пульта 68: база данных' }])
  const logF = path.join(boardDir, 'EXT', 'EXT-68.log.md')
  fs.writeFileSync(logF, `### ${hdr} · plane · коммент\n\n${last.text}\n`)
  gitInitCommit(boardDir)
  const reg = registry(boardDir, ['EXT'])
  writeConfig({ enabled: true, words: true, bell: true, bellDir: 'data/vitrina/bell-pt6b/', planePy: fwd(path.join(HERE, 'pt6b-plane.mjs')) },
    { board: fwd(boardDir), registry: fwd(reg), python: fwd(process.execPath) })
  const srv = await startServer()
  S.pids = { server: srv.pid }
  const A = session('A'); S.pids.session = A.pid
  A.send('Это проба механики по карточке EXT-68. Инструменты не нужны. Ответь одним словом: «готов». Если позже придёт системное напоминание «Слово Ивана · кнопка витрины» — ничего не исполняй, ответь одной строкой «принял: <все id вида W-… через запятую>».')
  await A.nextResult()
  await waitFor(async () => { const th = (await req('GET', '/api/ceh')).json?.workers?.threads ?? []; return th.find((t) => t.sessionId === A.sid)?.card === 'EXT-68' }, 60000, 1000)
  await waitFor(() => A.status() === 'idle' && lockOf(A.sid), 25000)
  const card0 = (await req('GET', '/api/card/EXT-68')).json
  const q1 = card0?.pult?.q
  log(`q: ${JSON.stringify(q1)}; pult: ${JSON.stringify(card0?.pult).slice(0, 300)}`)

  // шаг 1: «да» без второго щелчка
  const c0 = await n(); const calls0 = planeCalls().length
  const s1 = await act('yes', 'EXT-68', { q: q1 }); await sleep(2000)
  const c1 = await n()
  check('шаг 1: «да» без второго щелчка', { http: s1.status, outcome: s1.outcome, message: s1.message, confirm: s1.json?.confirm, id: s1.id, commentsBefore: c0, commentsAfter: c1, planeCallsAdded: planeCalls().length - calls0, steps: stepsOf(s1.id) })

  // шаг 2: со вторым щелчком
  const s2 = await act('yes', 'EXT-68', { q: q1, confirm: s1.id, pick: A.sid }); await sleep(2500)
  const all2 = await planeAll('EXT-68'); const c2 = all2.length
  const rec = all2.find((c) => c.text.includes(s2.id))
  if (rec) S.comments['EXT-68'].push({ by: 'пульт', id: rec.id, created_at: rec.created_at, text: rec.text })
  check('шаг 2: «да» со вторым щелчком', { http: s2.status, outcome: s2.outcome, message: s2.message, id: s2.id, commentsBefore: c1, commentsAfter: c2, newIds: all2.filter((c) => !base.some((b) => b.id === c.id)).map((c) => c.id),
    record: rec ? { id: rec.id, hasB: rec.text.includes('Б — ждёт «да» в чате'), text: rec.text } : null, steps: stepsOf(s2.id), commentWrites: commentCalls() })

  // зеркало приносит запись пульта в журнал карточки (как настоящее), потом шаг 3
  if (rec) {
    const rd = new Date(rec.created_at)
    fs.appendFileSync(logF, `\n### ${rd.toISOString().slice(0, 10)} ${rd.toISOString().slice(11, 16)} +00:00 · plane · коммент\n\n${rec.text}\n`)
    gitInitCommit(boardDir)
  }
  const q3 = await waitFor(async () => { const c = (await req('GET', '/api/card/EXT-68')).json; return c?.pult?.q }, 10000, 500)
  await sleep(3000)
  const q3b = (await req('GET', '/api/card/EXT-68')).json?.pult?.q
  log(`q после записи пульта: ${JSON.stringify(q3b)}`)
  const s3 = await act('yes', 'EXT-68', { q: q3b, pick: A.sid }); await sleep(2000)
  const c3 = await n()
  check('шаг 3: «да» ещё раз после записи пульта', { http: s3.status, outcome: s3.outcome, message: s3.message, id: s3.id, confirm: !!s3.json?.confirm, commentsBefore: c2, commentsAfter: c3, steps: stepsOf(s3.id) })

  S.actions = actionsLog().map((l) => ({ id: l.id, step: l.step, action: l.action, card: l.card, refusal: l.refusal, cmd: l.cmd }))
  S.planeCalls = planeCalls().map((c) => ({ args: c.args?.map((a) => String(a).slice(0, 80)), code: c.code, out: c.stdout?.trim() }))
  await stopServer(srv)
  try { A.child.kill() } catch {}
  await sleep(1500)
  fs.writeFileSync(path.join(HERE, 'pt6b-summary.json'), JSON.stringify(S, null, 2))
  log('конец пробы')
  process.exit(0)
})().catch((e) => { log(`СБОЙ: ${e.stack}`); fs.writeFileSync(path.join(HERE, 'pt6b-summary.json'), JSON.stringify(S, null, 2)); process.exit(1) })
