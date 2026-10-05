// Проба ПТ6в (EXT-65): «Перечитать правила» на тестовом экземпляре витрины этой копии (свой порт, своя data/vitrina,
// свой каталог звонка bell-pt6v, временная доска и временный Vault с хроникой — в temp). Запись в Plane — нет вовсе
// (действие reread в Plane не пишет, plane.py не запускается). Фоновые сессии claude.exe -p (скрыто, windowsHide) со своим
// --settings: хук Stop — только ждущий этой копии; --setting-sources local — хуки Ивана не срабатывают; Read разрешён.
// Сессии A, D, E запущены ДО коммита строки хроники (их startedAt раньше момента), их первое сообщение — после него.
// Итог — probe/pt6v-summary.json, ход — probe/pt6v-drive.log, журналы сессий — probe/pt6v-*.jsonl (в .gitignore).
//   node probe/pt6v-drive.mjs <claude.exe>
import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'
import { parseRing } from './pt6v-ring.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BIN = process.argv[2]
const PORT = 4383
guardLive(REPO, PORT) // отказ из папки живой витрины и на порту 4317 — до любой записи
const DATA = path.join(REPO, 'data', 'vitrina')
const BELL = path.join(DATA, 'bell-pt6v')
const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects')
const fwd = (p) => p.replace(/\\/g, '/')

const LOG = path.join(HERE, 'pt6v-drive.log')
const log = (s) => { const l = `${new Date().toISOString()} ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = { checks: {} }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const waitFor = async (fn, ms, every = 200) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every) } return null }
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { windowsHide: true, encoding: 'utf8' }).trim()

// ---------- временные: Vault с хроникой, набор из трёх файлов, доска, реестр ----------
const env = fs.mkdtempSync(path.join(os.tmpdir(), 'pt6v-'))
const vault = path.join(env, 'vault')
fs.mkdirSync(path.join(vault, 'unorbis', '_meta'), { recursive: true })
fs.mkdirSync(path.join(vault, 'unorbis', 'Хроника'), { recursive: true })
const F1 = path.join(vault, 'CLAUDE.md')
const F2 = path.join(vault, 'unorbis', '_meta', 'Субагенты.md')
const F3 = path.join(env, 'home-claude.md') // третий — абсолютный путь вне Vault (как «~/.claude/CLAUDE.md»)
fs.writeFileSync(F1, '# Правила цеха (проба ПТ6в)\nПравило 1: ничего не менять без ТЗ.\n')
fs.writeFileSync(F2, '# Субагенты (проба ПТ6в)\nПравило 2: один такт.\n')
fs.writeFileSync(F3, '# Автослой дирижёра (проба ПТ6в)\nПравило 3: отчёт по форме.\n')
git(vault, 'init', '-q'); git(vault, 'add', '-A'); git(vault, 'commit', '-q', '-m', 'base')

const boardDir = path.join(env, 'board')
fs.mkdirSync(boardDir)
makeBoard(boardDir, { codes: ['EXT'], cards: [{ id: 'EXT-65', status: 'review', title: 'Проба ПТ6в: перечитать правила' }] })
gitInitCommit(boardDir)
fs.mkdirSync(path.join(boardDir, '.mirror'))
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: new Date().toISOString() }))
fs.mkdirSync(path.join(boardDir, 'tools'))
fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка пробы: дотяжка карточки не запускается\n')
const regFile = path.join(env, 'registry.json')
fs.writeFileSync(regFile, JSON.stringify({ vault_root: vault, board_shared_repos: { repos: [vault] }, board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }))

const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
fs.mkdirSync(DATA, { recursive: true })
const SET_FILES = ['CLAUDE.md', 'unorbis/_meta/Субагенты.md', fwd(F3)]
const writeConfig = ({ words = true, bell = true, files = SET_FILES } = {}) => fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  ...defaults, port: PORT, toasts: false,
  paths: { ...defaults.paths, board: fwd(boardDir), registry: fwd(regFile), python: fwd(process.execPath) },
  pult: { enabled: true, words, bell, bellDir: 'data/vitrina/bell-pt6v/' }, rulesReread: { files } }, null, 2))

// ---------- HTTP ----------
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
async function post(payload, { noOrigin = false } = {}) {
  if (!token) token = (await req('GET', '/')).body.match(/name="vitrina-token" content="([^"]+)"/)[1]
  const r = await req('POST', '/api/act', { body: JSON.stringify(payload),
    headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': token } })
  return { status: r.status, outcome: r.json?.outcome ?? null, refusal: r.json?.refusal ?? r.json?.result?.code ?? null, id: r.json?.id ?? null, message: r.json?.message ?? r.body.slice(0, 200), json: r.json }
}
const reread = async (session, extra = {}) => { const r = await post({ action: 'reread', intentId: randomUUID(), session, ...extra }); await sleep(300); const st = r.id ? stepsOf(r.id).find((x) => x.startsWith('refused:')) : null; if (st) r.refusal = st.slice(8); return r }
const jl = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) } catch { return [] } }
const actionsLog = () => jl(path.join(DATA, 'actions.log'))
const stepsOf = (id) => actionsLog().filter((l) => l.id === id).map((l) => l.step + (l.refusal ? `:${l.refusal}` : ''))
const bellLog = () => jl(path.join(BELL, 'bell.log'))
const ringFiles = () => { try { return fs.readdirSync(BELL, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(BELL, d.name)).filter((f) => f.endsWith('.ring')).map((f) => `${d.name.slice(0, 8)}/${f}`)) } catch { return [] } }
const ceh = async () => (await req('GET', '/api/ceh')).json
const threadOf = async (sid) => (await ceh())?.workers?.threads?.find((t) => t.sessionId === sid) ?? null
const waitingRow = async (sid) => ((await ceh())?.waiting?.threads ?? []).find((r) => r.sessionId === sid) ?? null
const markOf = (t) => (t?.marks ?? []).find((m) => m.kind === 'oldRules') ?? null

// ---------- сервер ----------
let srv = null
const startServer = async () => {
  srv = spawn(process.execPath, ['server.mjs', '--console-log'], { cwd: REPO, windowsHide: true, stdio: 'ignore' })
  S.pids.server = srv.pid
  const up = await waitFor(async () => (await req('GET', '/api/health')).status === 200, 30000, 500)
  log(`витрина pid ${srv.pid}: ${up ? 'отвечает' : 'НЕ ПОДНЯЛАСЬ'}`)
  if (!up) { killTree(srv.pid); process.exit(1) }
  token = null
  await sleep(4000) // первый проход журналов
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }) } catch {} }
const stopServer = async () => { killTree(srv.pid); await waitFor(async () => (await req('GET', '/api/health')).status === 0, 10000, 300) }

// ---------- фоновые сессии ----------
const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${fwd(path.join(REPO, 'bell', 'waiter.mjs'))}" --port ${PORT} --bell-dir "${fwd(BELL)}"`, async: true, asyncRewake: true }] }] } }
const sFile = path.join(HERE, 'settings-pt6v.json')
fs.writeFileSync(sFile, JSON.stringify(settings, null, 2))
const WORK = path.join(env, 'work')
fs.mkdirSync(WORK)
function session(label) {
  const out = fs.createWriteStream(path.join(HERE, `pt6v-${label}.jsonl`))
  const child = spawn(BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--settings', sFile, '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'default', '--tools', 'Read', '--allowedTools', 'Read', '--include-hook-events'],
  { cwd: WORK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(HERE, `pt6v-${label}.err`), d))
  const s = { label, child, pid: child.pid, sid: null, results: [], startedAt: Date.now() }
  let buf = ''
  child.stdout.on('data', (d) => {
    out.write(d); buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.session_id && !s.sid) s.sid = e.session_id
      if (e.type === 'result') s.results.push({ at: Date.now(), text: String(e.result ?? '') })
    }
  })
  s.send = (text) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  s.nextResult = async (ms = 120000) => { const n = s.results.length; return waitFor(() => s.results[n], ms) }
  s.regFile = () => { try { return JSON.parse(fs.readFileSync(path.join(SESS_DIR, `${child.pid}.json`), 'utf8')) } catch { return null } }
  s.status = () => s.regFile()?.status ?? 'нет записи'
  s.journalLines = () => { for (const d of fs.readdirSync(PROJ_DIR)) { const f = path.join(PROJ_DIR, d, `${s.sid}.jsonl`); if (fs.existsSync(f)) return jl(f) } return [] }
  return s
}
const lockOf = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(BELL, `${sid}.lock`), 'utf8')) } catch { return null } }
const toolUses = (lines) => lines.flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input })) : []))
const ringIndex = (lines, id) => lines.findIndex((l) => JSON.stringify(l.message?.content ?? l.attachment ?? '').includes(id))
// Разбор настоящего журнала тем же разбором, что у витрины (lib/journal-parse.mjs): «прочитано» — по форме звонка (st.rings[id]),
// а звонок «перечитать» — не сообщение Ивана. Вопрос к Ивану в конце хода ставится синтетической строкой ассистента (как в test/ext65-reread.test.mjs).
// Тот же приём на форме звонка без живых сессий — test/probe-pt6v-ring.test.mjs.
const ringText = (lines, id) => { const i = ringIndex(lines, id); return i < 0 ? null : JSON.stringify(lines[i].message?.content ?? lines[i].attachment) }

;(async () => {
  S.pids = {}
  log(`старт: BIN=${BIN}, тестовый экземпляр :${PORT}, temp ${env}`)
  if ((await req('GET', '/api/health')).status !== 0) { log(`порт ${PORT} занят — стоп`); process.exit(1) }
  fs.rmSync(BELL, { recursive: true, force: true })
  try { fs.unlinkSync(path.join(DATA, 'actions.log')) } catch {}
  writeConfig()
  const sess = {}
  try {
    // 1. сессии A, D, E — до коммита строки хроники; сообщений им пока не шлём
    for (const l of ['A', 'D', 'E']) sess[l] = session(l)
    S.pids.sessions = { A: sess.A.pid, D: sess.D.pid, E: sess.E.pid }
    await waitFor(() => ['A', 'D', 'E'].every((l) => sess[l].regFile()), 30000)
    log(`реестр процессов: ${['A', 'D', 'E'].map((l) => `${l}: ${JSON.stringify(sess[l].regFile())}`).join('; ')}`)
    await sleep(3000)

    // 2. момент «правила обновлены»: коммит правки (хеш в строке), затем коммит строки хроники
    fs.appendFileSync(F1, 'Правило 1б: добавлено после открытия сессий.\n')
    git(vault, 'commit', '-q', '-am', 'rules: правка')
    const hash = git(vault, 'rev-parse', '--short=10', 'HEAD')
    const momentISO = git(vault, 'log', '-1', '--format=%cI')
    const d = new Date()
    const dd = String(d.getDate()).padStart(2, '0'); const mm = String(d.getMonth() + 1).padStart(2, '0')
    const chron = path.join(vault, 'unorbis', 'Хроника', `${d.getFullYear()}-${mm}.md`)
    const NOTE = 'в CLAUDE.md добавлено правило 1б (проба ПТ6в)'
    fs.writeFileSync(chron, `# Хроника\n\n${dd}.${mm} · 12:00 · Терминус · правила обновлены: ${NOTE} · EXT-65 · ${hash}\n`)
    git(vault, 'add', '-A'); git(vault, 'commit', '-q', '-m', 'chronicle')
    log(`момент: коммит ${hash} ${momentISO}; startedAt сессий: ${['A', 'D', 'E'].map((l) => sess[l].regFile()?.startedAt).join(', ')}`)
    S.moment = { hash, at: momentISO, note: NOTE }

    // 3. витрина (читает момент на старте); потом первые сообщения A, D, E и свежая F (после момента)
    await startServer()
    const Q = 'Брать вариант 1 или вариант 2?'
    sess.A.send(`Это проба механики по карточке EXT-65. Прочитай инструментом Read файл ${fwd(F1)} и закончи ответ вопросом: «${Q}»`)
    sess.D.send('Это проба механики без карточки. Инструменты не нужны. Ответь одним словом: «готов».')
    sess.E.send('Это проба механики по карточке EXT-65. Инструменты не нужны. Ответь одним словом: «готов».')
    await Promise.all(['A', 'D', 'E'].map((l) => sess[l].nextResult()))
    sess.F = session('F'); S.pids.sessions.F = sess.F.pid
    sess.F.send('Это проба механики по карточке EXT-65. Инструменты не нужны. Ответь одним словом: «готов».')
    await sess.F.nextResult()
    for (const l of ['A', 'D', 'E', 'F']) log(`${l}: sid ${sess[l].sid}; ответ: ${JSON.stringify(sess[l].results.at(-1)?.text?.slice(0, 120))}`)
    await waitFor(async () => { const t = await ceh().then((c) => c?.workers?.threads ?? []); return ['A', 'D', 'E', 'F'].every((l) => t.find((x) => x.sessionId === sess[l].sid)) }, 60000, 1000)
    await waitFor(() => ['A', 'D', 'E', 'F'].every((l) => sess[l].status() === 'idle' && lockOf(sess[l].sid)), 30000)
    const T = {}
    for (const l of ['A', 'D', 'E', 'F']) T[l] = await threadOf(sess[l].sid)
    log(`треды: ${['A', 'D', 'E', 'F'].map((l) => `${l}: project=${T[l]?.project} card=${T[l]?.card} state=${T[l]?.state} marks=${JSON.stringify(T[l]?.marks)} rulesReread=${T[l]?.rulesReread}`).join('\n  ')}`)

    // 4. подготовка: пометка называет ровно непрочитанные
    const mA = markOf(T.A)
    check('подготовка: A прочитал один файл из трёх — missing ровно два', { missing: mA?.missing, expect: [F2, F3].map(fwd), actual: (mA?.missing ?? []).map((x) => fwd(x.path)) })
    check('подготовка: E (не читала) — missing три; D без проекта и F свежая — пометки нет', { E: (markOf(T.E)?.missing ?? []).map((x) => fwd(x.path)), D: { project: T.D?.project, mark: markOf(T.D) }, F: { project: T.F?.project, mark: markOf(T.F) } })
    const rowBefore = await waitingRow(sess.A.sid)
    check('(а) до звонка: у A есть строка «Ждёт меня»', { row: rowBefore ? { kind: rowBefore.kind, text: rowBefore.text, key: rowBefore.key } : null })
    const ringsBefore = bellLog().length

    // 5. основной путь: нажатие → звонок → Read двух файлов → пометка сменилась
    const r1 = await reread(sess.A.sid); log(`reread A: ${r1.status} ${r1.outcome} ${r1.id} — ${r1.message}`)
    const nA = sess.A.results.length
    const woke = await waitFor(() => sess.A.results.length > nA, 150000, 500)
    await sleep(2500)
    const jA = sess.A.journalLines()
    const ringI = ringIndex(jA, r1.id)
    const text = ringText(jA, r1.id)
    const after = jA.slice(ringI + 1)
    const uses = toolUses(after)
    const reads = uses.filter((u) => u.name === 'Read').map((u) => fwd(u.input?.file_path ?? ''))
    log(`ЖУРНАЛ A, текст звонка: ${text}`)
    log(`ЖУРНАЛ A, вызовы после звонка: ${JSON.stringify(uses)}`)
    log(`ответ A на звонок: ${JSON.stringify(sess.A.results.at(-1)?.text)}`)
    const callPaths = [F2, F3].map(fwd)
    const tBack = await waitFor(async () => { const t = await threadOf(sess.A.sid); return markOf(t) ? null : t }, 20000, 1000) ?? await threadOf(sess.A.sid)
    check('основной путь', {
      http: r1.status, outcome: r1.outcome, id: r1.id, steps: stepsOf(r1.id), woke: !!woke,
      ringInJournal: ringI >= 0, ringHasBothPaths: !!text && callPaths.every((p) => text.replace(/\\\\/g, '/').includes(p)),
      ringNamesFile1: !!text && text.replace(/\\\\/g, '/').includes(fwd(F1)),
      ringFirstLine: text?.slice(0, 160), readsAfterRing: reads, readsMatchTwo: callPaths.every((p) => reads.includes(p)),
      toolsAfterRing: [...new Set(uses.map((u) => u.name))], noWriteEditBash: !uses.some((u) => ['Write', 'Edit', 'Bash'].includes(u.name)),
      markAfter: markOf(tBack), rulesRereadAfter: tBack?.rulesReread ?? null,
      missingBefore: (mA?.missing ?? []).length,
      statusProchitano_actionsApi: (await req('GET', '/api/actions')).body.includes(r1.id) })
    // (а) «прочитано» — по форме звонка в журнале сессии, а не по ответу /api/actions; (б) звонок «перечитать» — не сообщение Ивана, с отрицательным контролем
    if (ringI < 0) check('разбор журнала: звонок не найден в журнале A — проверки (а)/(б) невозможны', { ringI })
    else {
      const OTHER = 'W-261005-115900-c3d4 · 11:59 · без карточки · «да»' // обычное слово рядом с «перечитай правила» — по §1.8 «Разбор журнала» это сообщение Ивана
      const real = parseRing(jA, ringI, r1.id)
      const mixed = parseRing(jA, ringI, r1.id, (raw) => { const n = '«перечитай правила»'; if (!raw.includes(n)) throw new Error('в строке журнала нет строки слова'); return raw.replace(n, `${n}\\n${OTHER}`) })
      const wordCard = parseRing(jA, ringI, r1.id, (raw) => raw.replace('без карточки · «перечитай правила»', 'EXT-65 · «перечитай правила»'))
      check('«прочитано» по форме звонка в журнале A (st.rings из разбора витрины): id слова есть в st.rings (время — в readAt, не сверяется)', { ...real, ringId: r1.id, ok: real.read })
      check('(б) «перечитать» не сообщение Ивана: вопрос треда (строка (а)) остался, счётчик 0', { ...real, ok: real.ivanCount === 0 && real.questionBefore === true && real.questionAfter === true })
      check('(б) отрицательный контроль: тот же звонок + обычное слово «да» — сообщение Ивана, вопрос снят; с карточкой — тоже', { mixed, wordCard, ok: mixed.ivanCount === 1 && mixed.questionAfter == null && mixed.read && wordCard.ivanCount === 1 && wordCard.questionAfter == null })
    }
    const rowAfter = await waitingRow(sess.A.sid)
    check('(а) после звонка: у A строка «Ждёт меня» есть', { before: rowBefore ? { key: rowBefore.key, text: rowBefore.text } : null, after: rowAfter ? { kind: rowAfter.kind, key: rowAfter.key, text: rowAfter.text } : null,
      answerEndsWithQuestion: sess.A.results.at(-1)?.text?.includes(Q) ?? false })

    // 6. отрицательные контроли (фаза 1: words+bell)
    const sigs0 = ringFiles(); const lines0 = bellLog().length
    const rA2 = await reread(sess.A.sid)
    const rD = await reread(sess.D.sid)
    const rF = await reread(sess.F.sid)
    const rGhost = await reread(randomUUID())
    await sleep(1500)
    check('контроли: already-read / no-mark (D без проекта, F свежая) / thread-closed — 200, звонка нет', {
      A_after_read: { http: rA2.status, refusal: rA2.refusal, outcome: rA2.outcome }, D_noProject: { http: rD.status, refusal: rD.refusal, outcome: rD.outcome },
      F_fresh: { http: rF.status, refusal: rF.refusal, outcome: rF.outcome }, ghost: { http: rGhost.status, refusal: rGhost.refusal, outcome: rGhost.outcome },
      signalsBefore: sigs0, signalsAfter: ringFiles(), newBellLogLines: bellLog().slice(lines0), actionsLogged: [rA2, rD, rF, rGhost].map((r) => stepsOf(r.id)) })
    const sigsE = ringFiles()
    const bad = {}
    for (const [name, extra] of [['missing', { missing: [F1] }], ['paths', { paths: [F1] }], ['q', { q: 'x' }], ['confirm', { confirm: randomUUID() }], ['text', { text: 'x' }], ['card', { card: 'EXT-65' }]]) {
      const r = await reread(sess.E.sid, extra); bad[name] = { http: r.status, outcome: r.outcome, logged: stepsOf(r.id) }
    }
    check('контроль: POST с полем missing/путями/q/confirm/text/card — 400, звонка нет', { results: bad, signalsUnchanged: JSON.stringify(sigsE) === JSON.stringify(ringFiles()) })

    // 7. фаза 2: words=false, bell=true; E: STOP до первого Stop → положено, второе нажатие — queued, один звонок; «да» — 503
    await stopServer(); writeConfig({ words: false, bell: true }); await startServer()
    fs.writeFileSync(path.join(BELL, 'STOP'), '')
    await sleep(3000) // ждущие уходят по STOP на тике
    const e1 = await reread(sess.E.sid); const e2 = await reread(sess.E.sid)
    const yes = await post({ action: 'yes', intentId: randomUUID(), card: 'EXT-65', q: { at: new Date().toISOString(), head: 'Проба?' }, pick: sess.E.sid })
    check('words=false, bell=true: reread проходит (положено), второе нажатие — queued, один звонок, «да» — 503', {
      first: { http: e1.status, outcome: e1.outcome, id: e1.id, steps: stepsOf(e1.id) }, second: { http: e2.status, outcome: e2.outcome, refusal: e2.refusal, prev: e2.json?.prev ?? e2.json?.extra?.prev ?? null, steps: stepsOf(e2.id) },
      signals: ringFiles(), yesWords503: { http: yes.status, outcome: yes.outcome, message: yes.message } })

    // 8. фаза 3: bell=false → bell-off
    await stopServer(); writeConfig({ words: false, bell: false }); await startServer()
    const bo = await reread(sess.E.sid)
    check('bell=false: reread → bell-off, 200', { http: bo.status, outcome: bo.outcome, refusal: bo.refusal, id: bo.id, signals: ringFiles() })

    // 9. фаза 4: набор выключен (пустой) → reread-off на A (пометка есть, поля missing нет); signals нет
    await stopServer(); fs.rmSync(BELL, { recursive: true, force: true }); writeConfig({ words: true, bell: true, files: [] }); await startServer()
    const tOff = await threadOf(sess.A.sid)
    const off = await reread(sess.A.sid); const offE = await reread(sess.E.sid)
    check('набор выключен: reread-off, 200, сигналов в bell/ нет', { markA: markOf(tOff), A: { http: off.status, refusal: off.refusal, outcome: off.outcome }, E: { http: offE.status, refusal: offE.refusal }, signals: ringFiles(), rereadOffHealth: (await req('GET', '/api/health')).json?.readers?.journals?.rereadOff ?? null })
  } finally {
    S.actions = actionsLog().map((l) => ({ id: l.id, step: l.step, action: l.action, refusal: l.refusal, session: l.session?.slice(0, 8) }))
    for (const s of Object.values(sess)) killTree(s.pid)
    if (srv) killTree(srv.pid)
    S.killed = { sessions: Object.fromEntries(Object.entries(sess).map(([k, s]) => [k, s.pid])), server: srv?.pid }
    await sleep(1500)
    fs.writeFileSync(path.join(HERE, 'pt6v-summary.json'), JSON.stringify(S, null, 2))
    log('конец пробы')
  }
  process.exit(0)
})().catch((e) => { log(`СБОЙ: ${e.stack}`); try { fs.writeFileSync(path.join(HERE, 'pt6v-summary.json'), JSON.stringify(S, null, 2)) } catch {} process.exit(1) })
