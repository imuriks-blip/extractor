// Проба EXT-71 (ПТ7б, контроль (15) «вид»): «Мои слова за 24 ч» с кнопкой «Отозвать» — снимки 1280 и 400, светлая и тёмная, headless.
// Устройство: настоящая витрина этой копии (test/ext71-harness.mjs — подменный plane.py, временная доска и data) в том же процессе;
// страница — настоящая web/dist (собрать заранее: npm --prefix web run build). Витрину открывает не порт 4317, а свой порт-посредник
// (запросы идут в app.inject с подменой Host/Origin; /api/events не отдаётся — страница опрашивает сама). Данные выдуманные.
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; снимается он по своему pid, деревом.
//   node probe/ext71-drive.mjs <папка-для-снимков> [chrome.exe]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4403
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext71-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { checks: {}, shots: [], fails: [], pids: {} }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const must = (k, ok, v) => { check(k, v); if (!ok) { S.fails.push(k); log(`НЕ ТАК: ${k}`) } }

const { SID, Q, boot, makeEnv, thread } = await import(new URL('../test/ext71-harness.mjs', import.meta.url).href)
const env = makeEnv()
env.web = path.join(REPO, 'web', 'dist')
const s = await boot(env, { threads: [thread(SID, { card: 'EXT-20', marks: [], subagents: [] })] })
// слова: «да» (положено — кнопка есть), «нет» (отозвано), «вернуть» (отозвано — подсказка)
const w1 = await s.word('yes', 'EXT-20')
const w2 = await s.word('no', 'EXT-21')
s.setPlane({ status: 'Review' })
const w3 = (await s.press({ action: 'return', card: 'EXT-22', q: Q, text: 'доделать подсказку' })).json()
log(`слова: ${w1.outcome} ${w2.outcome} ${w3.outcome}`)
const wd2 = (await s.press({ action: 'withdraw', target: w2.id })).json()
const wd3 = (await s.press({ action: 'withdraw', target: w3.id })).json()
log(`отзывы: ${wd2.outcome} ${wd3.outcome}`)

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/events')) { res.writeHead(404); res.end(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const h = { host: '127.0.0.1:4317', ...(req.method === 'POST' ? { origin: 'http://127.0.0.1:4317', 'sec-fetch-site': 'same-origin', 'content-type': req.headers['content-type'], 'x-vitrina-token': req.headers['x-vitrina-token'] } : {}) }
    const r = await s.app.inject({ method: req.method, url: req.url, headers: h, payload: chunks.length ? Buffer.concat(chunks) : undefined })
    res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] ?? 'text/plain' })
    res.end(r.rawPayload)
  })
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

const dirs = []
const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext71-chrome-')); dirs.push(dir)
  const dbg = 9300 + Math.floor(Math.random() * 400)
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${dbg}`, `--user-data-dir=${dir}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  S.pids.chromeRoot = child.pid
  log(`chrome pid ${child.pid}, user-data-dir ${dir}, cdp ${dbg}`)
  let tgt = null
  for (let i = 0; i < 60 && !tgt; i++) { await sleep(300); try { tgt = JSON.parse(await httpReq('PUT', `http://127.0.0.1:${dbg}/json/new?about:blank`)) } catch { /* ещё не поднялся */ } }
  if (!tgt) throw new Error('chrome не поднялся')
  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await call('Page.enable'); await call('Runtime.enable')
  const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка страницы'); return r.result.value }
  return { call, ev, close: async () => { try { ws.close() } catch { /* закрыт */ } try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* уже нет */ } } }
}

const BLK = `[...document.querySelectorAll('details.blk')].find(d=>d.getAttribute('aria-label')==='Мои слова за 24 ч')`
let b = null
try {
  b = await openBrowser()
  const size = (w, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  const rows = () => b.ev(`[...${BLK}.querySelectorAll('.mw')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())`)
  const btns = () => b.ev(`[...${BLK}.querySelectorAll('.mw')].map(r=>[r.querySelector('.wd')?.textContent.replace(/\\s+/g,' ').trim(), [...r.querySelectorAll('button')].map(x=>x.textContent.trim()+(x.disabled?'(неактивна)':''))])`)
  const theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  const shot = async (name, w, th) => {
    await size(w); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350)
    await b.ev(`(()=>{const d=${BLK};if(d&&!d.open)d.open=true;d?.scrollIntoView()})()`)
    const rect = await b.ev(`(()=>{const r=${BLK}.getBoundingClientRect();return {x:0,y:Math.max(0,r.top+window.scrollY-6),w:window.innerWidth,h:Math.ceil(r.height)+12}})()`)
    const r = await b.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
    const f = path.join(SHOTS, `${w}-${th}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
    if (w === 400) { const ov = await b.ev('document.documentElement.scrollWidth - window.innerWidth'); must(`на 400 (${th}) горизонтальной прокрутки нет`, ov <= 0, ov) }
  }
  await size(1280)
  const idx = await httpReq('GET', `http://127.0.0.1:${PORT}/`)
  const js = idx.match(/src="([^"]+\.js)"/)?.[1]
  log(`script ${js}: ${(await httpReq('GET', `http://127.0.0.1:${PORT}${js}`)).slice(0, 80)}`)
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errs=[];addEventListener("error",e=>__errs.push(String(e.message)+" "+(e.error&&e.error.stack||"").slice(0,300)));addEventListener("unhandledrejection",e=>__errs.push("rej "+String(e.reason)))' })
  await b.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` })
  if (!(await waitFor(`${BLK}?.querySelector('.mw')`, 15000))) log(`страница: ${JSON.stringify(await b.ev('JSON.stringify(window.__errs)'))}`)
  const r0 = await rows()
  log(`строки: ${JSON.stringify(r0)}`)
  const b0 = await btns()
  must('у слова «да» (положено) кнопка «Отозвать» есть', JSON.stringify(b0.find((x) => x[0].includes('EXT-20'))?.[1]) === '["Отозвать"]', b0.find((x) => x[0].includes('EXT-20')))
  must('у отозванного «нет»: кнопки нет, подпись «отозвано · <id отзыва>»', b0.find((x) => x[0].includes('EXT-21') && !x[0].includes('отозвать'))?.[1].length === 0 && r0.some((x) => x.includes(`отозвано · ${wd2.id}`)), r0.filter((x) => x.includes('EXT-21')))
  must('у отозванного «вернуть»: подсказка про дирижёра', r0.some((x) => x.includes('карточка осталась в In Progress — попроси дирижёра вернуть в Review')), r0.filter((x) => x.includes('EXT-22')))
  must('своя строка «отозвать <номер слова>» у отзыва', r0.some((x) => x.includes(`отозвать ${w2.id}`)), null)
  for (const [w, th] of [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]) await shot('moi-slova', w, th)
  // щелчок по кнопке
  await size(1280); await theme('Светлая')
  must('щелчок по «Отозвать» у слова «да»', await b.ev(`(()=>{const x=[...${BLK}.querySelectorAll('.mw button')].find(y=>y.textContent.trim()==='Отозвать'&&!y.disabled);if(!x)return false;x.click();return true})()`), null)
  await waitFor(`/EXT-20.*отозвано · W-/.test(${BLK}.textContent)`, 15000)
  await sleep(500)
  const r1 = await rows()
  must('после щелчка у слова «отозвано · <id отзыва>», кнопки у него нет', r1.some((x) => x.includes('EXT-20') && /отозвано · W-/.test(x)) && (await btns()).find((x) => x[0].includes('EXT-20') && !x[0].includes('отозвать'))[1].length === 0, r1.filter((x) => x.includes('EXT-20')))
  const lines = s.lines().filter((l) => l.action === 'withdraw' && l.step === 'asked')
  must('нажатие дошло до сервера: в журнале три отзыва, последний — слова «да»', lines.length === 3 && lines.at(-1).withdraws === w1.id, lines.map((l) => l.withdraws))
  must('подменный Plane: запись об отзыве на EXT-20', s.pl().comments.some((c) => c.html.includes(`«отозвать ${w1.id}»`)), null)
  await shot('posle-shchelchka', 1280, 'light')
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
} finally {
  if (b) await b.close()
  srv.close()
  await sleep(800)
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, (() => { try { process.kill(p, 0); return true } catch { return false } })()]))
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { log(`не убрана ${d}: ${e.code ?? e.message}`) } }
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог: проверок не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; живы: ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length ? 1 : 0)
