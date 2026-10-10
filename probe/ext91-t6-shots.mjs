// Снимки и проверки EXT-91 такт 6: серые строки warnings под исходом действия в live.
// Запуск руками, в npm test не входит.   node probe/ext91-t6-shots.mjs [папка-для-снимков] [chrome.exe]   (по умолчанию snapshots/ext91-t3/)
// Устройство — как у ext87-shots.mjs: крошечный сервер на 127.0.0.1:4399 отдаёт web/dist и ВЫДУМАННЫЕ ответы web/fixtures (GET /api/ceh
// с полем boardMode, GET /api/mirror, POST /api/act); всё прочее под /api — 404 и счёт. Ни прокси, ни витрины (4317), ни n8n, ни
// Plane: запросы дальше этого сервера не уходят. Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; тему
// переключают кнопкой приложения. Проверяется ВИД и поведение меню, не данные.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4399
const SHOTS = path.resolve(process.argv[2] ?? path.join(REPO, 'snapshots', 'ext91-t3'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST = process.env.EXT91_DIST ? path.resolve(process.env.EXT91_DIST) : path.join(REPO, 'web', 'dist')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { shots: [], checks: {}, fails: [], intercepted: { ceh: 0, mirror: 0, act: [], other: [] }, pid: null }
const must = (k, ok, v) => { S.checks[k] = v; log(`${ok ? 'ок' : 'НЕ ТАК'} ${k}: ${JSON.stringify(v)}`); if (!ok) S.fails.push(k) }

function removeTree(dir) { // только unlink/rmdir
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of names) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) removeTree(p)
    else { try { fs.unlinkSync(p) } catch { /* занят — останется в отчёте */ } }
  }
  try { fs.rmdirSync(dir) } catch { /* останется в отчёте */ }
}

const fx = (n) => JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'fixtures', n), 'utf8'))
const MIRROR = fx('mirror.json')
let boardMode = 'mirror'
let mirrorState = MIRROR._states.idle_green
let act = { status: 200, body: { id: 'A-1', step: 'done', outcome: 'ok', message: 'запущено' }, delay: 0 }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' }
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname === '/api/ceh') { S.intercepted.ceh++; return send(res, 200, { ...fx('ceh.json'), boardMode }) }
  if (u.pathname === '/api/mirror') { S.intercepted.mirror++; return send(res, 200, { ...mirrorState, reindex: MIRROR.reindex }) }
  if (u.pathname === '/api/act' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c))
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b) } catch { /* пусто */ }
      S.intercepted.act.push(j.action + (j.kind ? `:${j.kind}` : '')); S.actTotal = (S.actTotal ?? 0) + 1
      // «Обновить» пошёл — проход начался: дальше /api/mirror отдаёт «идёт»
      if (j.action === 'mirror') mirrorState = MIRROR._states.changed_running
      setTimeout(() => send(res, act.status, act.body), act.delay)
    })
    return
  }
  if (u.pathname.startsWith('/api/')) { S.intercepted.other.push(u.pathname); res.writeHead(404); return res.end('{}') }
  const f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname)
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(f))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const httpReq = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext91t6-chrome-'))
let child = null
try {
  const dbg = 9300 + Math.floor(Math.random() * 400)
  child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${dbg}`, `--user-data-dir=${tmp}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  S.pid = child.pid; log(`chrome pid ${child.pid}, user-data-dir ${tmp}`)
  let tgt = null
  for (let i = 0; i < 60 && !tgt; i++) { await sleep(300); try { tgt = JSON.parse(await httpReq('PUT', `http://127.0.0.1:${dbg}/json/new?about:blank`)) } catch { /* ещё нет */ } }
  if (!tgt) throw new Error('chrome не поднялся')
  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pend = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await call('Page.enable'); await call('Runtime.enable')
  const ev = async (expr) => { const x = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description ?? 'ошибка страницы'); return x.result.value }
  const size = (w, h = 900) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  const theme = (n) => ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(n)})?.click()`)
  const open = async (mode, mirror) => {
    boardMode = mode; mirrorState = mirror ?? MIRROR._states.idle_green; S.intercepted.act = []
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` }); await sleep(500); await call('Page.reload'); await sleep(900)
    await waitFor('[...document.querySelectorAll(".top .hbtn")].some(b=>b.textContent.trim()==="Служебное")', 10000)
    await sleep(400)
  }
  const btnSvc = `[...document.querySelectorAll('.top .hbtn')].find(b=>b.textContent.trim()==='Служебное')`
  const menuOpen = () => ev('!!document.querySelector(".smenu")')
  const clickSvc = () => ev(`${btnSvc}.click()`)
  const labels = () => ev(`[...document.querySelectorAll('.smenu .pbtn')].map(b=>b.textContent.trim())`)
  const key = (k) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: 27 }).then(() => call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: 27 }))
  const shot = async (name, w, th, h) => {
    await size(w, h); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350)
    const x = await call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${name}-${w}-${th}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
  }
  const rect = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),r:Math.round(r.right)}})()`)
  const inWin = (r, w) => r && r.x >= 0 && r.r <= w
  const headText = () => ev('[...document.querySelectorAll(".top > .fresh, .top > .mst")].map(e=>e.textContent).join(" ")')

  // ===== EXT-91 такт 6: исход действия в live с предупреждениями board (§3.3 п.6) =====
  act = { status: 200, delay: 0, body: { id: 'A-7', step: 'done', outcome: 'ok', message: 'записано в доску 14:05 · тред: положено',
    warnings: ['⚠ не отправлено на GitHub: нет связи с удалённым репозиторием', '⚠ грязное дерево: в доске есть незафиксированные правки'] } }
  for (const w of [1280, 400]) {
    await open('live'); await size(w, 900)
    const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='да'&&!b.disabled);if(!b)return false;b.click();return true})()`)
    must(`${w}: нашлась кнопка «да» на выдуманных данных`, clicked, clicked)
    await sleep(600)
    const t = await ev(`(()=>{const e=document.querySelector('.pwarn');return e?e.parentElement.textContent:null})()`)
    must(`${w}: под исходом две серые строки предупреждений`, !!t && /не отправлено на GitHub/.test(t) && /грязное дерево/.test(t) && /записано в доску/.test(t), t)
    must(`${w}: нет горизонтальной прокрутки`, (await ev('document.documentElement.scrollWidth - window.innerWidth')) <= 0, await ev('document.documentElement.scrollWidth - window.innerWidth'))
    const y = await ev(`Math.max(0, document.querySelector('.pwarn').getBoundingClientRect().top - 140)`)
    await ev(`window.scrollTo(0, ${y})`)
    for (const th of ['light', 'dark']) await shot('ext91-t6-warnings', w, th, w === 400 ? 640 : 420)
  }
  // нет warnings — ничего
  act = { status: 200, delay: 0, body: { id: 'A-8', step: 'done', outcome: 'ok', message: 'записано в доску 14:06 · тред: положено' } }
  await open('live'); await size(1280, 900)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='да'&&!b.disabled).click()`); await sleep(600)
  must('без warnings — строк предупреждений нет, исход есть', (await ev('!document.querySelector(".pwarn")')) && (await ev('document.body.textContent.includes("записано в доску 14:06")')), null)
  ws.close()
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  if (child) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } }
  server.close()
  await sleep(800)
  removeTree(tmp)
  S.tmpLeft = fs.existsSync(tmp)
}
fs.writeFileSync(path.join(SHOTS, 'ext91-t6-summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; перехвачено: ceh ${S.intercepted.ceh}, mirror ${S.intercepted.mirror}, act ${S.actTotal ?? 0}; прочих /api: ${S.intercepted.other.length} (${[...new Set(S.intercepted.other)].join(', ')}); профиль остался: ${S.tmpLeft}`)
process.exit(S.error || S.fails.length ? 1 : 0)
