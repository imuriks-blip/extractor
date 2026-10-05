// Проба ПТ6 (EXT-67, такт 2): кнопки-слова на тестовом экземпляре витрины этой копии (свой порт, своя data/vitrina,
// свой каталог звонка bell-pt6, своя доска в temp). Настоящий plane.py — только EXT-68/EXT-69 (через обёртку
// pt6-plane.mjs, она не пускает другие карточки); «Принять» при pult.words=false — на подменном test/fake-plane.mjs.
// Фоновая сессия claude.exe -p (скрыто, windowsHide) со своим --settings: хук Stop — только ждущий этой копии;
// --setting-sources local — хуки Ивана не срабатывают. Итог — probe/pt6-summary.json, ход — probe/pt6-drive.log.
//   node probe/pt6-drive.mjs <claude.exe>
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
const PORT = 4381
const DATA = path.join(REPO, 'data', 'vitrina')
const BELL = path.join(DATA, 'bell-pt6')
const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects')
const PLANE_PY = 'C:/projects/_plane-rest/plane.py'
const fwd = (p) => p.replace(/\\/g, '/')

const LOG = path.join(HERE, 'pt6-drive.log')
const log = (s) => { const l = `${new Date().toISOString()} ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PART2 = process.argv.includes('--part2') // продолжение: EXT-69 (после «го») и фаза 2; нужен, если часть 1 оборвалась — комменты в Plane не удаляются
const S = { checks: {}, comments: { 'EXT-68': [], 'EXT-69': [] } }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const waitFor = async (fn, ms, every = 200) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every) } return null }
const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 22 }, (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(out ?? '').trim(), err: String(err ?? '').trim() })))

// ---------- настоящий Plane: только EXT-68/EXT-69 ----------
const OK_CARDS = ['EXT-68', 'EXT-69']
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
const env = fs.mkdtempSync(path.join(os.tmpdir(), 'pt6-'))
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
const planeCalls = () => jl(path.join(HERE, 'pt6-plane-calls.log'))
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
const sFile = path.join(HERE, 'settings-pt6.json')
fs.writeFileSync(sFile, JSON.stringify(settings, null, 2))
const WORK = path.join(HERE, 'pt6-work')
fs.mkdirSync(WORK, { recursive: true })
function session(label) {
  const out = fs.createWriteStream(path.join(HERE, `pt6-${label}.jsonl`))
  const child = spawn(BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--settings', sFile, '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'default', '--tools', 'Bash', '--include-hook-events'],
  { cwd: WORK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(HERE, `pt6-${label}.err`), d))
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
  if (!PART2) for (const f of ['pt6-plane-calls.log']) try { fs.unlinkSync(path.join(HERE, f)) } catch {}
  fs.rmSync(BELL, { recursive: true, force: true })
  try { fs.unlinkSync(path.join(DATA, 'actions.log')) } catch {}

  // ===== Фаза 1: pult.words=true, bell=true, настоящий plane.py на EXT-68/EXT-69 =====
  // вопрос на EXT-68 кладёт проба; у EXT-69 комментов нет
  const before68 = await planeAll('EXT-68'); const before69 = await planeAll('EXT-69')
  log(`до пробы: EXT-68 комментов ${before68.length}, EXT-69 ${before69.length}`)
  const Q_TEXT = 'Проба ПТ6: слово будет принято? (вопрос кладёт проба)'
  const q68 = PART2 ? { created_at: new Date().toISOString() } : await planeComment('EXT-68', Q_TEXT)
  const qd = new Date(q68.created_at)
  const hdr = `${qd.toISOString().slice(0, 10)} ${qd.toISOString().slice(11, 16)} +00:00`
  const boardDir = path.join(env, 'board')
  mirrorBoard(boardDir, ['EXT'], [{ id: 'EXT-68', status: 'review', title: 'Проба пульта 68' }, { id: 'EXT-69', status: 'review', title: 'Проба пульта 69' }])
  fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-68.log.md'), `### ${hdr} · plane · коммент\n\n${Q_TEXT}\n`)
  fs.writeFileSync(path.join(boardDir, 'EXT', 'EXT-69.log.md'), '')
  gitInitCommit(boardDir)
  const reg = registry(boardDir, ['EXT'])
  writeConfig({ enabled: true, words: true, bell: true, bellDir: 'data/vitrina/bell-pt6/', planePy: fwd(path.join(HERE, 'pt6-plane.mjs')) },
    { board: fwd(boardDir), registry: fwd(reg), python: fwd(process.execPath) })
  const srv = await startServer()
  S.pids = { server: srv.pid }

  let A = null
  const qB = await qOfCard('EXT-69')
  if (!PART2) {
  A = session('A'); S.pids.session = A.pid
  A.send('Это проба механики по карточке EXT-68. Инструменты не нужны. Ответь одним словом: «готов». Если позже придёт системное напоминание «Слово Ивана · кнопка витрины» — ничего не исполняй, ответь одной строкой «принял: <все id вида W-… через запятую>».')
  await A.nextResult()
  log(`сессия A sid ${A.sid} pid ${A.pid}`)
  const seen = await waitFor(async () => { const th = (await req('GET', '/api/ceh')).json?.workers?.threads ?? []; const a = th.find((t) => t.sessionId === A.sid); return a?.card === 'EXT-68' ? a.card : null }, 60000, 1000)
  await waitFor(() => A.status() === 'idle' && lockOf(A.sid), 25000)
  log(`витрина видит тред EXT-68: ${seen}`)

  const qA = await qOfCard('EXT-68')
  check('q от витрины', { 'EXT-68': qA, 'EXT-69': qB, planeQ: q68 })

  // --- EXT-68 «да» ---
  const n0 = commentCalls()
  const w1 = await act('yes', 'EXT-68', { q: qA })
  const ring1 = await waitFor(() => bellLog().find((l) => l.event === 'ring' && l.ids?.includes(w1.id)), 20000, 200)
  const woke = await A.nextResult(40000)
  await sleep(2500)
  const all68 = await planeAll('EXT-68')
  const rec = all68.find((c) => c.text.includes(w1.id))
  S.comments['EXT-68'].push({ by: 'пульт', id: rec?.id, created_at: rec?.created_at, text: rec?.text })
  const jr = inJournal(A, w1.id).filter((x) => x.origin === 'task-notification')
  check('EXT-68 слово «да» проходит', { http: w1.status, outcome: w1.outcome, id: w1.id, steps: stepsOf(w1.id),
    planeRecord: rec ? { commentId: rec.id, text: rec.text, hasId: rec.text.includes(w1.id), hasReplyTo: rec.text.includes('В ответ на'), hasPultMark: rec.text.includes('Слово Ивана · кнопка витрины') } : null,
    commentCallsAdded: commentCalls() - n0, bellLogRing: ring1 ? { ids: ring1.ids } : null, sessionWoke: !!woke, sessionAnswer: woke?.text, journalRows: jr.length, journalHasId: jr.some((x) => x.text.includes(w1.id)) })

  // --- EXT-68 Б-слово без второго щелчка ---
  const c1 = (await planeAll('EXT-68')).length; const calls1 = planeCalls().length; const rings1 = bellLog().filter((l) => l.event === 'ring').length
  const q68now = await qOfCard('EXT-68')
  const wb = await act('merge', 'EXT-68', { q: q68now })
  await sleep(2000)
  const c2 = (await planeAll('EXT-68')).length
  check('EXT-68 Б-слово (сливай) без второго щелчка', { http: wb.status, outcome: wb.outcome, message: wb.message, steps: stepsOf(wb.id),
    planeCommentsBefore: c1, planeCommentsAfter: c2, planeCallsAdded: planeCalls().length - calls1, newRings: bellLog().filter((l) => l.event === 'ring').length - rings1 })

  // --- EXT-68 новый коммент → «да» на старый вопрос ---
  const nc = await planeComment('EXT-68', 'Проба ПТ6: новое сообщение после вопроса (кладёт проба)')
  const c3 = (await planeAll('EXT-68')).length; const calls3 = planeCalls().filter((c) => c.args?.[0] === 'comment').length; const rings3 = bellLog().filter((l) => l.event === 'ring').length
  const w2 = await act('yes', 'EXT-68', { q: qA }) // q старого вопроса
  await sleep(2000)
  const c4 = (await planeAll('EXT-68')).length
  check('EXT-68 «да» на старый вопрос после нового коммента', { newCommentId: nc.id, http: w2.status, outcome: w2.outcome, message: w2.message, steps: stepsOf(w2.id),
    planeCommentsBefore: c3, planeCommentsAfter: c4, commentWritesByServer: planeCalls().filter((c) => c.args?.[0] === 'comment').length - calls3, newRings: bellLog().filter((l) => l.event === 'ring').length - rings3 })

  } // конец EXT-68

  // --- EXT-69 без комментов ---
  if (!PART2) {
  const w3 = await act('go', 'EXT-69', { q: qB })
  const all69 = await planeAll('EXT-69')
  const rec69 = all69.find((c) => c.text.includes(w3.id))
  if (rec69) S.comments['EXT-69'].push({ by: 'пульт', id: rec69.id, created_at: rec69.created_at, text: rec69.text })
  check('EXT-69 (q.at=null) «го» проходит', { q: qB, http: w3.status, outcome: w3.outcome, message: w3.message, steps: stepsOf(w3.id),
    planeRecord: rec69 ? { commentId: rec69.id, text: rec69.text, hasId: rec69.text.includes(w3.id), noRecordsLine: rec69.text.includes('В ответ на: записей не было') } : null })
  } else check('EXT-69 состояние на входе части 2', { planeComments: (await planeAll('EXT-69')).map((c) => ({ id: c.id, text: c.text.slice(0, 90) })) })
  const nc69 = await planeComment('EXT-69', 'Проба ПТ6: первое сообщение на карточке без вопросов (кладёт проба)')
  const c69a = (await planeAll('EXT-69')).length; const calls69 = planeCalls().filter((c) => c.args?.[0] === 'comment').length
  const w4 = await act('go', 'EXT-69', { q: qB })
  await sleep(1500)
  const c69b = (await planeAll('EXT-69')).length
  check('EXT-69 «го» после появления коммента', { newCommentId: nc69.id, http: w4.status, outcome: w4.outcome, message: w4.message, steps: stepsOf(w4.id),
    planeCommentsBefore: c69a, planeCommentsAfter: c69b, commentWritesByServer: planeCalls().filter((c) => c.args?.[0] === 'comment').length - calls69 })

  S.bellLog = bellLog()
  S.actions = actionsLog().map((l) => ({ id: l.id, step: l.step, action: l.action, card: l.card, refusal: l.refusal, cmd: l.cmd }))
  await stopServer(srv)
  try { A?.child.kill() } catch {}
  await sleep(2500)

  // ===== Фаза 2: pult.words=false, подменный plane.py, «Принять» работает =====
  const pdir = path.join(env, 'plane'); fs.mkdirSync(pdir)
  fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
  const fakeQ = 'Проба готова — можно принимать?'
  fs.writeFileSync(path.join(pdir, 'state.json'), JSON.stringify({ status: 'Review', comments: [{ id: 'q1', created_at: '2026-10-03T09:00:41.018934Z', html: `<p>${fakeQ}</p>` }], clock: new Date().toISOString().replace('Z', '123Z') }))
  const board2 = path.join(env, 'board2')
  mirrorBoard(board2, ['PRB'], [{ id: 'PRB-1', status: 'review', title: 'Проба PRB-1' }])
  fs.writeFileSync(path.join(board2, 'PRB', 'PRB-1.log.md'), `### 2026-10-03 09:00 +00:00 · plane · коммент\n\n${fakeQ}\n`)
  gitInitCommit(board2)
  writeConfig({ enabled: true, words: false, bell: false, bellDir: 'data/vitrina/bell-pt6/', planePy: fwd(path.join(pdir, 'fake-plane.mjs')) },
    { board: fwd(board2), registry: fwd(registry(board2, ['PRB'])), python: fwd(process.execPath) })
  const srv2 = await startServer(); S.pids.server2 = srv2.pid
  const q2 = await qOfCard('PRB-1')
  const wno = await act('yes', 'PRB-1', { q: q2 })
  const calls2 = JSON.parse(fs.readFileSync(path.join(pdir, 'state.json'), 'utf8')).calls ?? []
  const acc = await act('accept', 'PRB-1', { q: q2 })
  const st2 = JSON.parse(fs.readFileSync(path.join(pdir, 'state.json'), 'utf8'))
  check('pult.words=false', { word: { http: wno.status, outcome: wno.outcome, message: wno.message, planeCallsAfterWord: calls2.length },
    accept: { http: acc.status, outcome: acc.outcome, message: acc.message, steps: stepsOf(acc.id), planeStatus: st2.status, planeCalls: (st2.calls ?? []).map((c) => c[0]), recordHasId: st2.comments.some((c) => c.html.includes(acc.id)) } })
  await stopServer(srv2)
  fs.writeFileSync(path.join(HERE, 'pt6-summary.json'), JSON.stringify(S, null, 2))
  log('конец пробы')
  process.exit(0)
})().catch((e) => { log(`СБОЙ: ${e.stack}`); fs.writeFileSync(path.join(HERE, 'pt6-summary.json'), JSON.stringify(S, null, 2)); process.exit(1) })
