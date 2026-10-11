// Проба EXT-91, такт 4: живая проверка режима live на ТЕСТОВОМ экземпляре витрины.
//   node probe/ext91-live.mjs
// Устройство: во временной папке %TEMP%\ext91-live-<токен>\ (имя ASCII) — данные экземпляра, ВРЕМЕННАЯ доска (свой git init,
// tools копия кода доски, board.config.json), подменный plane.py (копия test/fake-plane.mjs: Plane не трогается), заглушка
// index.html. Сервер — отдельный node (windowsHide, без shell) на свободном высоком порту, не 4317. claude.exe не запускается,
// звонок выключен (pult.bell=false). C:\projects\unorbis-board читается только как источник кода tools/ для копии.
// Сценарии идут HTTP-ручкой /api/act экземпляра:
//   4. mirror → live на лету: действие в mirror (подменный plane.py, board не зовётся), затем смена mode в board.config.json
//      без перезапуска (тот же pid), следующее действие — в board.
//   1. «Принять» → запись «решение» + статус done, автор ivan, трейлер Board-As: ivan.
//   2. «Вернуть» без владельца → ready.
//   3. Новая карточка → создана (запись создания в журнале).
// Вывод: probe/out/ext91-live/ (журналы карточек, git log с трейлерами, строки actions.log). Конец: снятие своего процесса
// деревом по pid (образ node.exe + метка-токен в командной строке), удаление временной папки.
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fwd = (p) => p.replace(/\\/g, '/')

// ---------- режим сервера (дочерний процесс): node probe/ext91-live.mjs --serve <dataDir> <webDir> ----------
if (process.argv[2] === '--serve') {
  const [dataDir, webDir] = process.argv.slice(3)
  const { loadConfig } = await import('../lib/config.mjs')
  const { startServer } = await import('../lib/start.mjs')
  const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
  const config = loadConfig({ dataDir, defaults })
  guardLive(REPO, config.port)
  await startServer({ config, dataDir, webDir, toast: () => {}, readEvents: async () => [] })
  console.log('serve: up', config.port)
} else {
  await drive()
}

async function drive() {
  const listening = (p) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port: p }); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
  let PORT = 4391
  while (await listening(PORT)) PORT++
  guardLive(REPO, PORT)

  const token = `ext91-live-${randomBytes(4).toString('hex')}`
  const base = path.join(os.tmpdir(), token)
  const dataDir = path.join(base, 'data'); const webDir = path.join(base, 'web'); const boardDir = path.join(base, 'board'); const planeDir = path.join(base, 'plane')
  for (const d of [dataDir, webDir, boardDir, planeDir, path.join(base, 'empty')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><head><meta name="vitrina-token" content="__VITRINA_TOKEN__"></head><body>ext91 probe</body></html>')

  // ---- временная доска: формат живой, tools — копия кода доски, git init, mode: mirror (переключим на лету) ----
  const { BOARD_LIB, makeBoard, gitInitCommit, git } = await import('../test/helpers.mjs')
  const TOOLS = path.join(BOARD_LIB, '..')
  const Q_MD = '**Ветка** готова — `ext-7` можно принимать?'
  const Q = { at: '2026-10-03T09:00:00.000Z', head: Q_MD }
  const ids = ['EXT-7', 'EXT-8', 'EXT-9', 'EXT-10']
  makeBoard(boardDir, { codes: ['EXT', 'CAR'], cards: ids.map((id) => ({ id, status: 'review', title: `Пробная ${id}` })) })
  const cfgFile = path.join(boardDir, 'board.config.json')
  const setMode = (mode) => fs.writeFileSync(cfgFile, JSON.stringify({ mode, push: false, tz: 'Europe/Riga' }) + '\n')
  setMode('mirror')
  fs.cpSync(TOOLS, path.join(boardDir, 'tools'), { recursive: true, filter: (s) => !/node_modules|[\\/]test([\\/]|$)/.test(s) })
  for (const id of ids) fs.writeFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), `### 2026-10-03 12:00 +03:00 · trurl:EXT · коммент\n\n${Q_MD}\n\n`)
  gitInitCommit(boardDir)
  git(boardDir, 'config', 'user.name', 'Иван Проба'); git(boardDir, 'config', 'user.email', 'ivan@probe.local')
  const commitCount = () => Number(git(boardDir, 'rev-list', '--count', 'HEAD').trim())

  // подменный plane.py: копия test/fake-plane.mjs + state.json рядом
  fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(planeDir, 'fake-plane.mjs'))
  const planeState = path.join(planeDir, 'state.json')
  fs.writeFileSync(planeState, JSON.stringify({ status: 'Review', comments: [], clock: '2026-10-03T09:20:00.123456Z' }))
  const planeCalls = () => JSON.parse(fs.readFileSync(planeState, 'utf8')).calls ?? []

  const regFile = path.join(base, 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, CAR: { projects: [], project_cards: [], repos: [] } } }))
  const empty = fwd(path.join(base, 'empty'))
  const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ...defaults, port: PORT, toasts: false,
    paths: { ...defaults.paths, board: fwd(boardDir), registry: fwd(regFile), journals: empty, sessions: empty, desktopIndex: [empty], agents: empty, vault: '', python: fwd(process.execPath) },
    backup: { dir: fwd(path.join(dataDir, 'backup')) + '/' },
    pult: { ...defaults.pult, enabled: true, words: true, bell: false, bellDir: fwd(path.join(base, 'bell')), planePy: fwd(path.join(planeDir, 'fake-plane.mjs')), usage: { ...defaults.pult.usage, foremanRuns: empty } } }, null, 2))

  const results = []
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' · ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`) }

  const ps = (script) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 8e6 }, (e, o) => resolve(String(o ?? '').trim())))
  const table = async () => JSON.parse((await ps('@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = [string]$_.CommandLine } }) | ConvertTo-Json -Compress -Depth 3')) || '[]')
  const descendants = (tab, root) => { const out = []; const q = [root]; while (q.length) { const p = q.shift(); for (const r of tab) if (r.ppid === p && !out.includes(r.pid)) { out.push(r.pid); q.push(r.pid) } } return out }
  const cleanupFiles = (dir) => {
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of names) { const p = path.join(dir, e.name); if (e.isDirectory()) cleanupFiles(p); else { try { fs.chmodSync(p, 0o666) } catch { /* нет */ } try { fs.unlinkSync(p) } catch { /* занят */ } } }
    try { fs.rmdirSync(dir) } catch { /* останется в отчёте */ }
  }
  const stopOwn = async (pid, image, mark) => {
    if (!pid) return null
    const tab = await table()
    const me = tab.find((r) => r.pid === pid)
    if (!me) return { pid, gone: true }
    if (me.name.toLowerCase() !== image || !me.cmd.includes(mark)) return { pid, refused: `не доказано, что процесс свой: ${me.name}` }
    const kids = descendants(tab, pid).map((p) => `${p}:${tab.find((x) => x.pid === p)?.name}`)
    await new Promise((res) => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => res()))
    await sleep(500)
    const after = await table()
    return { pid, image: me.name, mark, descendants: kids, stillAlive: after.some((r) => r.pid === pid) }
  }

  let serverPid = null
  try {
    const serverOut = fs.openSync(path.join(base, 'server.out'), 'a')
    const server = spawn(process.execPath, [path.join(HERE, 'ext91-live.mjs'), '--serve', dataDir, webDir], { windowsHide: true, stdio: ['ignore', serverOut, serverOut] })
    serverPid = server.pid
    const t0 = Date.now(); let dead = false; server.once('exit', () => { dead = true })
    while (!(await listening(PORT)) && !dead && Date.now() - t0 < 60000) await sleep(100)
    console.log(`сервер: pid ${serverPid}, порт ${PORT}, метка ${token}, поднялся за ${Date.now() - t0} мс`)

    const req = (method, url, headers = {}, body = null) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, timeout: 90000 }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b) } catch { /* не JSON */ } resolve({ status: res.statusCode, body: b, json: j }) })
      })
      r.on('error', (e) => resolve({ status: 0, err: e.code })); r.on('timeout', () => r.destroy())
      if (body) r.write(body)
      r.end()
    })
    const page = await req('GET', '/')
    const pageToken = page.body?.match(/name="vitrina-token" content="([^"]+)"/)?.[1]
    if (!pageToken) throw new Error(`токена страницы нет: ${page.status}; вывод сервера: ${fs.readFileSync(path.join(base, 'server.out'), 'utf8').slice(-1500)}`)
    const press = (body) => req('POST', '/api/act', { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': pageToken }, JSON.stringify({ intentId: randomUUID(), ...body }))
    const actLog = path.join(dataDir, 'actions.log')
    const rows = () => { try { return fs.readFileSync(actLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
    const rowsOf = (id) => rows().filter((l) => l.id === id)
    const header = (id) => fs.readFileSync(path.join(boardDir, 'EXT', `${id}.md`), 'utf8').match(/^status: (\S+)/m)?.[1]
    const journal = (id) => fs.readFileSync(path.join(boardDir, 'EXT', `${id}.log.md`), 'utf8')
    const trailers = (key) => git(boardDir, 'log', `--format=%h %s%n${key}: %(trailers:key=${key},valueonly,separator=%x2C)`, '--', '.').trim()
    const lastTrailer = (key, file) => git(boardDir, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`, '--', file).trim()

    // ===== 4а. mirror: действие идёт старым путём (подменный plane.py), board не зовётся =====
    const c0 = commitCount()
    const m = await press({ action: 'accept', card: 'EXT-9', q: Q })
    const mRows = rowsOf(m.json?.id)
    check('4а. mirror: «Принять» EXT-9 — outcome ok', m.json?.outcome === 'ok', m.json)
    check('4а. mirror: строки действия несут mode=mirror', mRows.length > 0 && mRows.every((l) => l.mode === 'mirror'), mRows.map((l) => `${l.step}:${l.mode}`))
    check('4а. mirror: подменный plane.py вызван (comment, state)', planeCalls().some((a) => a[0] === 'comment') && planeCalls().some((a) => a[0] === 'state'), planeCalls().map((a) => a[0]))
    check('4а. mirror: шага board нет, коммитов на доске не прибавилось', !mRows.some((l) => l.step === 'board') && commitCount() === c0, { commits: commitCount() })
    check('4а. mirror: статус EXT-9 в файле доски не менялся (review)', header('EXT-9') === 'review', header('EXT-9'))
    const pidBefore = serverPid; const planeBefore = planeCalls().length

    // ===== 4б. смена mode на лету — тот же процесс, без перезапуска =====
    setMode('live')
    git(boardDir, 'add', 'board.config.json'); git(boardDir, '-c', 'user.name=Иван Проба', '-c', 'user.email=ivan@probe.local', 'commit', '-q', '-m', 'проба: mode live')
    const tab1 = await table()
    check('4б. процесс сервера тот же и жив (перезапуска нет)', pidBefore === serverPid && tab1.some((r) => r.pid === serverPid && r.name.toLowerCase() === 'node.exe'), { pid: serverPid })
    const c1 = commitCount()
    const l4 = await press({ action: 'accept', card: 'EXT-10', q: Q })
    const l4Rows = rowsOf(l4.json?.id)
    check('4б. live после смены: «Принять» EXT-10 — outcome ok', l4.json?.outcome === 'ok', l4.json)
    check('4б. live: строки действия mode=live, есть шаги board', l4Rows.length > 0 && l4Rows.every((l) => l.mode === 'live') && l4Rows.some((l) => l.step === 'board'), l4Rows.map((l) => `${l.step}:${l.mode}`))
    check('4б. live: на доске прибавились коммиты, статус EXT-10 done', commitCount() > c1 && header('EXT-10') === 'done', { commits: commitCount(), status: header('EXT-10') })
    check('4б. live: к подменному plane.py новых вызовов нет (в mirror было 3: show, comment, state)', planeCalls().length === planeBefore,planeCalls().map((a) => a[0]))

    // ===== 1. «Принять» =====
    const a = await press({ action: 'accept', card: 'EXT-7', q: Q })
    check('1. «Принять» EXT-7 — outcome ok', a.json?.outcome === 'ok', a.json)
    check('1. статус done в шапке', header('EXT-7') === 'done', header('EXT-7'))
    const j7 = journal('EXT-7')
    check('1. в журнале запись «решение» автора ivan с номером действия в первой строке', new RegExp(`### [^\\n]+ · ivan · решение\\n\\n\\*\\*Слово Ивана · кнопка витрины · ${a.json?.id}\\*\\*: «принято»`).test(j7), j7.split('\n').filter((l) => l.startsWith('###')))
    check('1. в журнале запись смены статуса автора ivan', /### [^\n]+ · ivan · статус/.test(j7))
    check('1. трейлер Board-As: ivan у коммита журнала и карточки', lastTrailer('Board-As', 'EXT/EXT-7.log.md') === 'ivan' && lastTrailer('Board-As', 'EXT/EXT-7.md') === 'ivan', { log: lastTrailer('Board-As', 'EXT/EXT-7.log.md'), card: lastTrailer('Board-As', 'EXT/EXT-7.md') })
    check('1. контроль: начальный коммит без трейлера Board-As', lastTrailer('Board-As', 'EXT/EXT-8.md') === '', lastTrailer('Board-As', 'EXT/EXT-8.md'))

    // ===== 2. «Вернуть» без владельца =====
    const hasOwner = /^owner: ""/m.test(fs.readFileSync(path.join(boardDir, 'EXT', 'EXT-8.md'), 'utf8'))
    const r = await press({ action: 'return', card: 'EXT-8', q: Q, text: 'нет теста — доделай' })
    check('2. владельца в шапке EXT-8 нет (условие сценария)', hasOwner)
    check('2. «Вернуть» EXT-8 — outcome ok', r.json?.outcome === 'ok', r.json)
    check('2. статус ready', header('EXT-8') === 'ready', header('EXT-8'))
    check('2. запись «решение» с причиной и Board-As: ivan', /Причина: нет теста — доделай/.test(journal('EXT-8')) && lastTrailer('Board-As', 'EXT/EXT-8.log.md') === 'ivan')

    // ===== 3. Новая карточка =====
    const title = 'Проверка живой пробы режима live'
    const n = await press({ action: 'new-card', project: 'EXT', title, text: 'описание пробной карточки' })
    const created = n.json?.result?.created ?? n.json?.created
    check('3. «Новая карточка» — outcome ok, id создан', n.json?.outcome === 'ok' && /^EXT-\d+$/.test(created ?? ''), n.json)
    check('3. исход board new узнан сразу, запасного поиска (board read) не было', !rowsOf(n.json?.id).some((l) => l.step === 'board' && l.cmd === 'read'), rowsOf(n.json?.id).map((l) => `${l.step}:${l.cmd ?? ''}`))
    const nFile =created ? path.join(boardDir, 'EXT', `${created}.md`) : ''
    check('3. файл карточки есть, заголовок и Backlog', !!created && fs.existsSync(nFile) && fs.readFileSync(nFile, 'utf8').includes(title) && header(created) === 'backlog', created && header(created))
    // у board new отдельного .log.md нет: запись создания — коммит «<ID>: new · backlog» (журнал доски = git) с трейлером Board-As
    const subj = created ? git(boardDir, 'log', '-1', '--diff-filter=A', '--format=%s', '--', `EXT/${created}.md`).trim() : ''
    check('3. запись создания в журнале доски: коммит «<ID>: new · backlog»', subj === `${created}: new · backlog`, subj)
    check('3. трейлер Board-As: ivan у создающего коммита', !!created && git(boardDir, 'log', '-1', '--diff-filter=A', '--format=%(trailers:key=Board-As,valueonly)', '--', `EXT/${created}.md`).trim() === 'ivan')
    check('3. Plane (подменный) за всё время live не звали', planeCalls().length === planeBefore,planeCalls().map((x) => x[0]))

    await sleep(16000) // фоновый такт витрины (15 с): строки mirror-missing / mirror-seen для действия, начатого в mirror
    // ---- вывод ----
    const out = path.join(REPO, 'probe', 'out', 'ext91-live')
    fs.mkdirSync(out, { recursive: true })
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f))
    for (const id of ['EXT-7', 'EXT-8', 'EXT-10', ...(created ? [created] : [])]) {
      if (fs.existsSync(path.join(boardDir, 'EXT', `${id}.log.md`))) fs.writeFileSync(path.join(out, `${id}.log.md`), journal(id))
      fs.writeFileSync(path.join(out, `${id}.md`), fs.readFileSync(path.join(boardDir, 'EXT', `${id}.md`), 'utf8'))
    }
    fs.writeFileSync(path.join(out, 'git-log.txt'), git(boardDir, 'log', '--reverse', '--format=%h %an <%ae>%n  %s%n  Board-As: %(trailers:key=Board-As,valueonly,separator=%x2C)%n  Board-Session: %(trailers:key=Board-Session,valueonly,separator=%x2C)%n  Board-Cmd: %(trailers:key=Board-Cmd,valueonly,separator=%x2C)').replace(/\r/g, ''))
    fs.writeFileSync(path.join(out, 'git-log-full.txt'), git(boardDir, 'log', '--reverse', '--name-only', '--format=--- %h %s%n%b').replace(/\r/g, ''))
    const all = rows()
    fs.writeFileSync(path.join(out, 'actions-board.log'), all.filter((l) => l.step === 'board' || l.step === 'asked' || l.step === 'done').map((l) => JSON.stringify({ id: l.id, step: l.step, action: l.action, card: l.card, mode: l.mode, cmd: l.cmd, result: l.result })).join('\n') + '\n')
    fs.writeFileSync(path.join(out, 'actions.log'), all.map((l) => JSON.stringify(l)).join('\n') + '\n')
    console.log(`вывод: ${out}`)
    console.log('--- git log ---\n' + fs.readFileSync(path.join(out, 'git-log.txt'), 'utf8'))
    console.log('--- actions.log: mode и шаг ---\n' + all.map((l) => `${l.id.slice(-9)} ${l.step}${l.cmd ? ' ' + l.cmd : ''} mode=${l.mode}${l.step === 'board' ? ' ' + JSON.stringify(l.result) : ''}`).join('\n'))
  } catch (e) {
    check('проба без сбоя', false, e?.stack ?? String(e))
  } finally {
    const stopped = await stopOwn(serverPid, 'node.exe', token)
    console.log('снято (pid, образ, метка, потомки):', JSON.stringify(stopped))
    await sleep(800)
    cleanupFiles(base)
    console.log('папка пробы убрана:', !fs.existsSync(base))
    const bad = results.filter((x) => !x.ok)
    console.log(`ИТОГ: ${results.length - bad.length} из ${results.length}${bad.length ? ' · не прошли: ' + bad.map((x) => x.name).join('; ') : ''}`)
    if (bad.length) process.exitCode = 1
  }
}
