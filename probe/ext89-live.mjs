// Проба EXT-89, такт 3: живая проверка отметки процесса-источника (client.proc в строке asked) на ТЕСТОВОМ экземпляре.
//   node probe/ext89-live.mjs
// Устройство: во временной папке %TEMP%\ext89-live-<случайный токен>\ — свои данные, пустая доска PRB, пустые журналы
// и реестр, заглушка index.html (интерфейс не собран, нужен только токен страницы). Сервер этой копии — отдельный
// процесс node (windowsHide, без shell) на свободном порту, не 4317; действие — пустышка ping (во внешний мир не пишет,
// Plane и звонок не задействованы: pult.bell=false, words=false). Живая витрина и её порт не трогаются.
//   1. POST из node (токен страницы, подставные Origin и Sec-Fetch-Site) — строка asked, client.proc (image node.exe).
//   2. POST со страницы под headless Edge (свой --user-data-dir с токеном, windowsHide) — client.proc (image msedge.exe).
//   3. Время определения: ms из proc — первый запрос сервера и тёплые; плюс холодный/тёплый замер самого помощника.
//   4. Окна нет: опции spawn помощника (перехват: windowsHide), сервера и Edge + у процессов дерева нет главного окна.
// Конец: проверка метки (образ + токен в командной строке) и снятие деревом по pid: taskkill /T /F /PID.
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fwd = (p) => p.replace(/\\/g, '/')

// ---------- режим сервера (дочерний процесс): node probe/ext89-live.mjs --serve <dataDir> <webDir> ----------
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
  let PORT = 4389
  while (await listening(PORT)) PORT++
  guardLive(REPO, PORT) // отказ из папки живой витрины и на порту 4317 — до любой записи

  const token = `ext89-live-${randomBytes(4).toString('hex')}`
  const base = path.join(os.tmpdir(), token)
  const dataDir = path.join(base, 'data'); const webDir = path.join(base, 'web'); const boardDir = path.join(base, 'board')
  const edgeDir = path.join(base, 'edge-profile')
  for (const d of [dataDir, webDir, boardDir, path.join(base, 'empty')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>ext89 probe</body></html>')
  const { makeBoard, gitInitCommit } = await import('../test/helpers.mjs')
  makeBoard(boardDir, { codes: ['PRB'], cards: [] }); gitInitCommit(boardDir)
  const regFile = path.join(base, 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { PRB: { projects: [], project_cards: [], repos: [] } } }))
  const empty = fwd(path.join(base, 'empty'))
  const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ...defaults, port: PORT, toasts: false,
    paths: { ...defaults.paths, board: fwd(boardDir), registry: fwd(regFile), journals: empty, sessions: empty, desktopIndex: [empty], agents: empty, vault: '' },
    backup: { dir: fwd(path.join(dataDir, 'backup')) + '/' },
    pult: { ...defaults.pult, enabled: true, words: false, bell: false, bellDir: fwd(path.join(base, 'bell')), usage: { ...defaults.pult.usage, foremanRuns: empty } } }, null, 2))

  const S = { token, port: PORT, base, spawnOptions: {}, node: [], edge: [], helper: {}, tree: {}, checks: {} }
  const out = (k, v) => { S.checks[k] = v; console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`) }
  const ps = (script) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 8e6 }, (e, o) => resolve(String(o ?? '').trim())))
  const table = async () => JSON.parse((await ps('@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = [string]$_.CommandLine } }) | ConvertTo-Json -Compress -Depth 3')) || '[]')
  const descendants = (tab, root) => { const out = []; const q = [root]; while (q.length) { const p = q.shift(); for (const r of tab) if (r.ppid === p && !out.includes(r.pid)) { out.push(r.pid); q.push(r.pid) } } return out }

  let serverPid = null, edgePid = null
  const cleanupFiles = (dir) => {
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of names) { const p = path.join(dir, e.name); if (e.isDirectory() || e.isSymbolicLink?.()) cleanupFiles(p); else { try { fs.unlinkSync(p) } catch { /* занят */ } } }
    try { fs.rmdirSync(dir) } catch { /* останется в отчёте */ }
  }
  // снятие: только своё — pid запомнен при запуске, образ и метка в командной строке сверены; дерево по pid
  const stopOwn = async (pid, image, mark) => {
    if (!pid) return null
    const tab = await table()
    const me = tab.find((r) => r.pid === pid)
    if (!me) return { pid, gone: true }
    if (me.name.toLowerCase() !== image || !me.cmd.includes(mark)) return { pid, refused: `не доказано, что процесс свой: ${me.name}` }
    const kids = descendants(tab, pid).map((p) => { const r = tab.find((x) => x.pid === p); return `${p}:${r.name}` })
    await new Promise((res) => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => res()))
    await sleep(500)
    const after = await table()
    return { pid, image: me.name, mark, descendants: kids, stillAlive: after.some((r) => r.pid === pid) }
  }

  try {
    // ---- сервер: отдельный процесс, без окна ----
    const serverOut = fs.openSync(path.join(base, 'server.out'), 'a')
    S.spawnOptions.server = { windowsHide: true, stdio: ['ignore', serverOut, serverOut] }
    const server = spawn(process.execPath, [path.join(HERE, 'ext89-live.mjs'), '--serve', dataDir, webDir], S.spawnOptions.server)
    serverPid = server.pid; S.serverPid = serverPid
    const t0 = Date.now()
    let dead = false; server.once('exit', () => { dead = true })
    while (!(await listening(PORT)) && !dead && Date.now() - t0 < 60000) await sleep(100)
    out('сервер', `pid ${serverPid}, порт ${PORT}, поднялся за ${Date.now() - t0} мс`)

    const req = (method, url, headers = {}, body = null) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, timeout: 15000 }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b) } catch { /* не JSON */ } resolve({ status: res.statusCode, body: b, json: j }) })
      })
      r.on('error', (e) => resolve({ status: 0, err: e.code })); r.on('timeout', () => r.destroy())
      if (body) r.write(body)
      r.end()
    })
    const page = await req('GET', '/')
    const pageToken = page.body?.match(/name="vitrina-token" content="([^"]+)"/)?.[1]
    if (!pageToken) throw new Error(`токена страницы нет: ${page.status}; вывод сервера: ${fs.readFileSync(path.join(base, 'server.out'), 'utf8').slice(-1500)}`)
    const actLog = path.join(dataDir, 'actions.log')
    const rows = () => { try { return fs.readFileSync(actLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }

    // ---- 1. POST из node (первый запрос сервера — сразу после старта, помощник мог ещё прогреваться) ----
    const nodePost = async () => {
      const intentId = randomUUID()
      const r = await req('POST', '/api/act', { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-vitrina-token': pageToken }, JSON.stringify({ intentId, action: 'ping' }))
      return { status: r.status, id: r.json?.id, intentId }
    }
    for (let i = 0; i < 5; i++) S.node.push(await nodePost())
    const askedByIntent = (intentId) => rows().find((l) => l.step === 'asked' && l.client?.intentId === intentId)
    out('1. строка asked от POST из node (первая)', askedByIntent(S.node[0].intentId))
    out('1. исход действия', S.node.map((x) => x.status))

    // ---- 2. POST со страницы под headless Edge ----
    S.spawnOptions.edge = { windowsHide: true, stdio: 'ignore' }
    const dbg = 9300 + Math.floor(Math.random() * 400)
    const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${dbg}`, `--user-data-dir=${edgeDir}`, 'about:blank'], S.spawnOptions.edge)
    edgePid = edge.pid; S.edgePid = edgePid
    const httpGet = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
    let tgt = null
    for (let i = 0; i < 80 && !tgt; i++) { await sleep(300); try { tgt = JSON.parse(await httpGet('PUT', `http://127.0.0.1:${dbg}/json/new?about:blank`)) } catch { /* ещё нет */ } }
    if (!tgt) throw new Error('Edge не поднялся')
    const ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let cid = 0; const pend = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
    const call = (method, params = {}) => new Promise((res, rej) => { const i = ++cid; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expr) => { const x = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description ?? 'ошибка страницы'); return x.result.value }
    await call('Page.enable'); await call('Runtime.enable')
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(1200)
    for (let i = 0; i < 3; i++) {
      const intentId = randomUUID()
      const r = await ev(`(async()=>{const t=document.querySelector('meta[name="vitrina-token"]').content;const r=await fetch('/api/act',{method:'POST',headers:{'content-type':'application/json','x-vitrina-token':t},body:JSON.stringify({intentId:${JSON.stringify(intentId)},action:'ping'})});return {status:r.status}})()`)
      S.edge.push({ status: r.status, intentId })
    }
    out('2. строка asked от POST со страницы Edge (первая)', askedByIntent(S.edge[0].intentId))
    out('2. исход действия', S.edge.map((x) => x.status))

    // ---- 3. время определения ----
    const ms = (arr) => { const a = arr.map((l) => l?.client?.proc?.ms).filter((x) => Number.isFinite(x)); const s = [...a].sort((x, y) => x - y); return { n: a.length, all: a, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] } }
    out('3. ms сервера, POST из node (1-й — первый после старта, остальные тёплые)', ms(S.node.map((x) => askedByIntent(x.intentId))))
    out('3. ms сервера, POST из Edge', ms(S.edge.map((x) => askedByIntent(x.intentId))))
    // холодный и тёплый замер самого помощника (свежий PowerShell в этом процессе; опции spawn перехвачены)
    const { createHelperReader, createSource } = await import('../lib/pult/source.mjs')
    S.spawnOptions.helper = null
    let helperPid = null
    const spySpawn = (cmd, args, opts) => { S.spawnOptions.helper = { cmd, windowsHide: opts?.windowsHide, stdio: opts?.stdio }; const c = spawn(cmd, args, opts); helperPid = c.pid; return c }
    const helper = createHelperReader({ spawn: spySpawn })
    const source = createSource({ read: helper.read, limitMs: 20000 })
    const sock = net.connect({ host: '127.0.0.1', port: PORT }); await new Promise((r) => sock.once('connect', r))
    const ident = () => source.identify({ clientPort: sock.localPort, serverPort: PORT, clientAddr: sock.localAddress, serverAddr: sock.remoteAddress })
    const cold = await ident()
    const warm = []; for (let i = 0; i < 20; i++) warm.push((await ident()).ms)
    const sw = [...warm].sort((a, b) => a - b)
    out('3. помощник, ХОЛОДНЫЙ (первый запрос: запуск PowerShell и компиляция)', { ms: cold.ms, ok: cold.ok, image: cold.image, reason: cold.reason })
    out('3. помощник, ТЁПЛЫЙ (20 запросов)', { min: sw[0], median: sw[10], max: sw[19] })

    // ---- 4. окна нет ----
    const tab = await table()
    const own = [...new Set([serverPid, edgePid, helperPid, ...descendants(tab, serverPid), ...descendants(tab, edgePid)].filter(Boolean))]
    const hasWin = await ps(own.map((p) => `Get-Process -Id ${p} -ErrorAction SilentlyContinue | ForEach-Object { '{0}:{1}:{2}' -f $_.Id,$_.ProcessName,$_.MainWindowHandle }`).join('; '))
    out('4. опции spawn помощника (перехват, идут в настоящий spawn)', S.spawnOptions.helper)
    out('4. опции spawn сервера и Edge', { server: S.spawnOptions.server, edge: S.spawnOptions.edge })
    out('4. исходник: windowsHide у spawn помощника', /spawn\('powershell\.exe'[^\n]*windowsHide: true/.test(fs.readFileSync(path.join(REPO, 'lib', 'pult', 'source.mjs'), 'utf8')))
    out('4. MainWindowHandle процессов (pid:имя:дескриптор, 0 = окна нет)', hasWin.split(/\r?\n/).filter(Boolean))
    helper.close(); sock.destroy(); ws.close()

    // ---- сводка: цепочки proc ----
    out('proc из node', askedByIntent(S.node[0].intentId)?.client?.proc)
    out('proc из Edge', askedByIntent(S.edge[0].intentId)?.client?.proc)
  } catch (e) {
    console.log('СБОЙ ПРОБЫ:', e?.stack ?? e)
    process.exitCode = 1
  } finally {
    const stopped = [await stopOwn(edgePid, 'msedge.exe', token), await stopOwn(serverPid, 'node.exe', token)]
    console.log('снято (pid, образ, метка, потомки):', JSON.stringify(stopped))
    await sleep(800)
    cleanupFiles(base)
    console.log('папка пробы убрана:', !fs.existsSync(base))
  }
}
