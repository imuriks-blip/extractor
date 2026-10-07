// Снимки экрана «Расход» (EXT-84, ПТ12) на ВЫДУМАННЫХ ответах web/fixtures/usage*.json. Запуск руками, в npm test не входит.
//   node probe/ext84-shots.mjs [папка-для-снимков] [chrome.exe]      (по умолчанию probe/ext84-shots/)
// Устройство: крошечный сервер на 127.0.0.1:4399 отдаёт web/dist и подменённый GET /api/usage; всё прочее под /api — 404 и счёт.
// Ни прокси, ни витрины, ни n8n: запросы дальше этого сервера не уходят. Браузер — headless Chrome со своим --user-data-dir во
// временной папке, CDP; тему переключают кнопкой приложения. Проверяется ВИД, не данные.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4399
const SHOTS = path.resolve(process.argv[2] ?? path.join(HERE, 'ext84-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST = path.join(REPO, 'web', 'dist')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { shots: [], checks: {}, fails: [], intercepted: { usage: 0, other: [] }, pid: null }
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

let fixture = 'usage.json'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname === '/api/usage') {
    S.intercepted.usage++
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(fs.readFileSync(path.join(REPO, 'web', 'fixtures', fixture)))
  }
  if (u.pathname.startsWith('/api/')) { S.intercepted.other.push(u.pathname); res.writeHead(404); return res.end('{}') }
  const f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname)
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(f))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const httpReq = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext84-chrome-'))
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
  const open = async (fx) => { fixture = fx; await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/usage` }); await sleep(600); await call('Page.reload'); await sleep(900); await waitFor('document.querySelector(".ucol1 .ubn, .ucol1 .urem")', 10000) }
  const shot = async (name, w, th) => { // снимок страницы целиком по высоте содержимого
    await size(w); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350)
    const h = await ev('document.documentElement.scrollHeight')
    await size(w, Math.min(h + 4, 6000)); await sleep(300)
    const x = await call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${th}-${name}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
  }

  await size(1280); await open('usage.json')
  must('экран открыт по #/usage, крошки «Экстрактор / Расход»', await waitFor('document.querySelector(".top")?.textContent.includes("Расход")'), await ev('document.querySelector(".top").textContent'))
  must('плашка warn есть', await ev('!!document.querySelector(".ubn.warn")'), await ev('document.querySelector(".ubn")?.textContent'))
  must('строка остатка с процентами', await ev('/5 ч: 62 %/.test(document.querySelector(".urem").textContent)'), await ev('document.querySelector(".urem").textContent'))
  must('кнопки «Замерить» нет', await ev('![...document.querySelectorAll("button")].some(b=>/Замерить/i.test(b.textContent))'), null)
  must('две плитки и 7 столбцов по дням', await ev('document.querySelectorAll(".utile").length===2 && document.querySelectorAll(".ud").length===7'), null)
  for (const [w, th] of [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]) await shot('usage-today', w, th)
  // переключатель «7 дней»
  await size(1280); await theme('Светлая')
  await ev('[...document.querySelectorAll(".utool .seg button")].find(b=>b.textContent.trim()==="7 дней").click()'); await sleep(300)
  must('переключатель «7 дней» нажат', await ev('document.querySelector(".utool .seg [aria-pressed=true]").textContent.trim()==="7 дней"'), null)
  for (const [w, th] of [[1280, 'light'], [400, 'dark']]) await shot('usage-week', w, th)
  await size(400); must('400: горизонтальной прокрутки нет', (await ev('document.documentElement.scrollWidth - window.innerWidth')) <= 0, await ev('document.documentElement.scrollWidth'))

  await open('usage-ok.json'); await shot('usage-ok', 1280, 'light'); await shot('usage-ok', 400, 'dark')
  must('usage-ok: «в норме» и остаток словом из ручки', await ev('!!document.querySelector(".ubn.ok") && /остаток не виден/.test(document.querySelector(".urem").textContent)'), await ev('document.querySelector(".urem").textContent'))
  await open('usage-empty.json'); await shot('usage-empty', 1280, 'light'); await shot('usage-empty', 400, 'light')
  must('usage-empty: пустое состояние', await ev('!!document.querySelector(".ucol1 .empty")'), await ev('document.querySelector(".ucol1 .empty")?.textContent'))
  // ссылка в шапке с «Цеха»
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` }); await sleep(800)
  must('на «Цехе» в шапке есть ссылка «Расход»', await ev('!![...document.querySelectorAll(".top a")].find(a=>a.textContent==="Расход"&&a.getAttribute("href")==="#/usage")'), null)
  ws.close()
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  if (child) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } }
  server.close()
  await sleep(800)
  removeTree(tmp)
  S.tmpLeft = fs.existsSync(tmp)
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; /api/usage подменён ${S.intercepted.usage} раз; прочих /api: ${S.intercepted.other.length}; профиль остался: ${S.tmpLeft}`)
process.exit(S.error || S.fails.length ? 1 : 0)
