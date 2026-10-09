// Снимки и проверки EXT-87, такт 2: меню «Служебное» в шапке и экран «Расход» на ВЫДУМАННЫХ ответах web/fixtures/*.json.
// Запуск руками, в npm test не входит.   node probe/ext87-shots.mjs [папка-для-снимков] [chrome.exe]   (по умолчанию snapshots/ext87/)
// Устройство: крошечный сервер на 127.0.0.1:4399 отдаёт web/dist и подменённые GET /api/usage, /api/ceh, /api/mirror и POST /api/act
// (ответ задаёт сценарий); всё прочее под /api — 404 и счёт. Ни прокси, ни витрины, ни n8n: запросы дальше этого сервера не уходят.
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; тему переключают кнопкой приложения. Проверяется ВИД
// и поведение меню, не данные.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4399
const SHOTS = path.resolve(process.argv[2] ?? path.join(REPO, 'snapshots', 'ext87'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST = path.join(REPO, 'web', 'dist')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { shots: [], checks: {}, fails: [], intercepted: { usage: 0, ceh: 0, mirror: 0, act: [], other: [] }, pid: null }
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
let fixture = 'usage.json'
// ответ на POST /api/act: сценарий задаёт тест; delay — чтобы увидеть «замеряю…»
let act = { status: 200, body: { outcome: 'ok', message: '5 ч: 62 % · сброс 16:20 · 7 дн: 41 % · замер 13:51' }, delay: 0 }
const MEASURE_OK = { status: 200, body: { id: 'A-1', step: 'done', outcome: 'ok', message: '5 ч: 62 % · сброс 16:20 · 7 дн: 41 % · замер 13:51' }, delay: 600 }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' }
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname === '/api/usage') { S.intercepted.usage++; return send(res, 200, fx(fixture)) }
  if (u.pathname === '/api/ceh') { S.intercepted.ceh++; return send(res, 200, fx('ceh.json')) }
  if (u.pathname === '/api/mirror') { S.intercepted.mirror++; return send(res, 200, { ...fx('mirror.json'), running: false }) }
  if (u.pathname === '/api/act' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c))
    req.on('end', () => { let j = {}; try { j = JSON.parse(b) } catch { /* пусто */ } S.intercepted.act.push(j.action + (j.kind ? `:${j.kind}` : '')); setTimeout(() => send(res, act.status, act.body), act.delay) })
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext87-chrome-'))
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
  const open = async (hash, fxName) => { fixture = fxName ?? fixture; await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${hash}` }); await sleep(500); await call('Page.reload'); await sleep(900); await waitFor('[...document.querySelectorAll(".top .hbtn")].some(b=>b.textContent.trim()==="Служебное")', 10000) }
  const btnSvc = `[...document.querySelectorAll('.top .hbtn')].find(b=>b.textContent.trim()==='Служебное')`
  const menuOpen = () => ev('!!document.querySelector(".smenu")')
  const clickSvc = () => ev(`${btnSvc}.click()`)
  const key = (k) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }).then(() => call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }))
  const clickAt = async (x, y) => { await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }) }
  const shot = async (name, w, th, h) => { // h не задана — страница целиком по высоте содержимого; задана — окно этой высоты (меню поверх)
    await size(w, h ?? 900); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350)
    const hh = h ?? Math.min((await ev('document.documentElement.scrollHeight')) + 4, 6000)
    await size(w, hh); await sleep(300)
    const x = await call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${th}-${name}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
  }
  const rect = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),r:Math.round(r.right)}})()`)

  // ===== «Расход», 1280: шапка, остаток свежий, тревога, замеры сегодня =====
  await size(1280); await open('#/usage', 'usage.json')
  must('шапка «Расход»: порядок кнопок Служебное, Словарь, ?', await ev(`[...document.querySelectorAll('.top .tbtns .hbtn')].map(b=>b.textContent.trim()).join('|')`) === 'Служебное|Словарь|?', await ev(`[...document.querySelectorAll('.top .tbtns .hbtn')].map(b=>b.textContent.trim()).join('|')`))
  const remTxt = await ev('document.querySelector(".urem").textContent')
  must('остаток: проценты, сброс, источник и возраст рядом с числом', /5 ч: 62 % · сброс \d\d:\d\d · 7 дн: 41 % · замер 5 мин назад/.test(remTxt), remTxt)
  must('строка «замеры сегодня: 3, ≈$0,08»', remTxt.includes('замеры сегодня: 3, ≈$0,08'), remTxt)
  const warnTxt = await ev('document.querySelector(".ubn.warn")?.textContent')
  must('тревога с подписью веса', /условных токенов против медианы/.test(warnTxt) && /вес: вывод ×5, чтение кэша ×0,1/.test(warnTxt), warnTxt)
  for (const [w, th] of [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]) await shot('usage', w, th)

  // ===== меню открыто на «Расходе» =====
  await size(1280, 640); await theme('Светлая')
  await clickSvc(); await sleep(500)
  must('меню открылось щелчком, ничего не затемняет (нет dialog/подложки)', (await menuOpen()) && await ev('!document.querySelector("dialog[open]")'), null)
  const labels = await ev(`[...document.querySelectorAll('.smenu .pbtn')].map(b=>b.textContent.trim())`)
  must('пункты по порядку: Обновить, Полный проход зеркала, Пересобрать индекс, Замерить остаток', JSON.stringify(labels) === JSON.stringify(['Обновить', 'Полный проход зеркала', 'Пересобрать индекс', 'Замерить остаток']), labels)
  const mrow = await ev(`[...document.querySelectorAll('.smenu .wtb')].find(r=>r.textContent.includes('Замерить остаток')).textContent`)
  must('подпись замера в меню: «5 ч: N % · сброс ЧЧ:ММ · 7 дн: M % · замер ЧЧ:ММ»', /5 ч: 62 % · сброс \d\d:\d\d · 7 дн: 41 % · замер \d\d:\d\d/.test(mrow), mrow)
  const rb = await rect('.smenu'); const rbt = await rect(`.top .tbtns .smw .hbtn`)
  must('меню под кнопкой, не вылезает за окно справа', rb && rbt && rb.y >= rbt.y + rbt.h && rb.r <= 1280, { меню: rb, кнопка: rbt })
  for (const [w, th] of [[1280, 'light'], [1280, 'dark']]) await shot('usage-menu-open', w, th, 640)
  // закрытие
  await clickSvc(); await sleep(200)
  must('повторный щелчок по кнопке закрывает', !(await menuOpen()), null)
  await clickSvc(); await sleep(200); await key('Escape'); await sleep(200)
  must('Escape закрывает меню, фокус — на кнопке «Служебное»', !(await menuOpen()) && await ev(`document.activeElement===${btnSvc}`), await ev('document.activeElement?.textContent'))
  await clickSvc(); await sleep(200); await clickAt(600, 500); await sleep(250)
  must('щелчок мимо закрывает', !(await menuOpen()), null)

  // ===== подтверждение полного: закрыл меню — сброшено =====
  act = { status: 200, delay: 0, body: { id: 'A-9', step: 'asked', outcome: 'need-confirm', message: 'нужно подтверждение', confirm: { what: 'полный проход зеркала', follows: ' Около 1,5 ч, ~2 200 запросов; треды это время делят лимит Plane.', q: 'x', mirrorAt: '2026-10-09T09:00:00.000Z' } } }
  await clickSvc(); await sleep(300)
  await ev(`[...document.querySelectorAll('.smenu .pbtn')].find(b=>b.textContent.trim()==='Полный проход зеркала').click()`); await sleep(500)
  must('первый щелчок «Полный проход зеркала» — подтверждение внутри меню (в потоке)', await ev('!!document.querySelector(".smenu .cfm")') && (await ev('getComputedStyle(document.querySelector(".smenu .cfm")).position')) === 'static', null)
  await shot('usage-menu-confirm', 1280, 'light', 640)
  await key('Escape'); await sleep(200); await clickSvc(); await sleep(300)
  must('закрыл меню и открыл снова — ждущего подтверждения нет', await ev('!document.querySelector(".smenu .cfm")'), null)
  await clickSvc(); await sleep(200)

  // ===== «Замерить остаток»: состояние measuring и ответы =====
  const measureFromMenu = async (scenario, expect, name) => {
    act = scenario
    if (await menuOpen()) { await clickSvc(); await sleep(200) }
    await clickSvc(); await sleep(300)
    await ev(`[...document.querySelectorAll('.smenu .pbtn')].find(b=>b.textContent.includes('Замерить')||b.textContent.includes('замеряю')).click()`)
    await sleep(150)
    const during = await ev(`(()=>{const r=[...document.querySelectorAll('.smenu .wtb')].find(r=>/Замерить|замеряю/.test(r.textContent));return (r.querySelector('button').disabled?'[неактивна] ':'[активна] ')+r.textContent})()`)
    await sleep(900)
    const after = await ev(`[...document.querySelectorAll('.smenu .wtb')].find(r=>/Замерить|замеряю/.test(r.textContent)).textContent`)
    must(`замер, ${name}`, expect.test(after), { во_время: during, после: after })
    return during
  }
  const during = await measureFromMenu(MEASURE_OK, /замер 13:51/, 'удача: подпись обновилась')
  must('замер: во время — «замеряю…», кнопка неактивна', during.startsWith('[неактивна] замеряю'), during)
  await shot('usage-menu-measured', 400, 'light', 760)
  await measureFromMenu({ status: 200, delay: 0, body: { outcome: 'ok', reused: true, message: 'замер был в 13:51: 5 ч: 62 % · сброс 16:20 · 7 дн: 41 % · замер 13:51' } }, /замер был в 13:51/, 'reused: «замер был в ЧЧ:ММ»')
  await measureFromMenu({ status: 409, delay: 0, body: { outcome: 'refused', refusal: 'measure-running', message: 'замер уже идёт (с 13:50)' } }, /замер уже идёт/, '409 measure-running: «замер уже идёт»')
  await measureFromMenu({ status: 200, delay: 0, body: { id: 'A-3', outcome: 'error', message: 'замер не удался: вход Claude истёк — войди в Claude в обычном терминале' } }, /вход Claude истёк — войди в Claude в обычном терминале/, 'вход истёк: словами')
  await shot('usage-menu-auth-error', 1280, 'light', 640)
  await key('Escape'); await sleep(200)

  // кнопка на экране
  act = MEASURE_OK
  await ev(`[...document.querySelectorAll('.urem .pbtn')].find(b=>b.textContent.includes('Замерить')).click()`); await sleep(200)
  must('экран «Расход»: кнопка «Замерить остаток» во время замера — «замеряю…», неактивна', await ev(`(()=>{const b=document.querySelector('.urem .pbtn');return b.disabled&&/замеряю/.test(b.textContent)})()`), await ev('document.querySelector(".urem").textContent'))
  await sleep(1200)
  must('экран «Расход»: после замера кнопка снова доступна, ответ словами рядом', await ev(`(()=>{const b=document.querySelector('.urem .pbtn');return !b.disabled&&/замер 13:51/.test(document.querySelector('.urem').textContent)})()`), await ev('document.querySelector(".urem").textContent'))
  await clickSvc(); await sleep(250)
  must('число замеров в мире страницы: POST measure ушли только в перехватчик', S.intercepted.act.filter((a) => a === 'measure').length >= 5, S.intercepted.act)
  await key('Escape'); await sleep(200)

  // ===== несвежее и частично свежее =====
  await open('#/usage', 'usage-stale.json')
  const st = await ev('document.querySelector(".urem").textContent')
  must('несвежее: «остаток не виден — последнее событие лимита 2 дн назад», числа процентов нет, подсказка', /остаток не виден — последнее событие лимита 2 дн назад/.test(st) && !/\d+ %/.test(st) && st.includes('Служебное → Замерить остаток'), st)
  for (const [w, th] of [[1280, 'light'], [400, 'dark']]) await shot('usage-stale', w, th)
  await clickSvc(); await sleep(300)
  const stm = await ev(`[...document.querySelectorAll('.smenu .wtb')].find(r=>r.textContent.includes('Замерить')).textContent`)
  must('меню при несвежем: тот же текст, без процентов', /последнее событие лимита 2 дн назад/.test(stm) && !/\d+ %/.test(stm), stm)
  await shot('usage-stale-menu', 400, 'light', 760)
  await key('Escape'); await sleep(200)
  await open('#/usage', 'usage-ok.json')
  const part = await ev('document.querySelector(".urem").textContent')
  must('частично: 5 ч виден, 7 дн «не виден»; прораб — «не моложе»; тревоги нет, «в норме»', /5 ч: 35 %/.test(part) && /7 дн: не виден/.test(part) && /прогон прораба, не моложе 20 мин/.test(part) && await ev('!!document.querySelector(".ubn.ok")'), part)
  for (const [w, th] of [[1280, 'light'], [400, 'dark']]) await shot('usage-partial', w, th)
  await open('#/usage', 'usage-empty.json')
  must('событий нет: remainingNote и подсказка; кнопка есть', /остаток не виден \(событий лимита нет\)/.test(await ev('document.querySelector(".urem").textContent')) && await ev('!!document.querySelector(".urem .pbtn")'), await ev('document.querySelector(".urem").textContent'))
  await shot('usage-empty', 400, 'light')

  // ===== 400: меню во всю ширину, кнопка в той же группе =====
  await open('#/usage', 'usage.json'); await size(400, 760); await theme('Светлая')
  must('400: «Служебное», «Словарь», «?» в одной группе .tbtns', await ev(`[...document.querySelectorAll('.top .tbtns .hbtn')].length===3`), null)
  await clickSvc(); await sleep(400)
  const mb = await rect('.smenu'); const tp = await rect('.top')
  must('400: меню во всю ширину шапки (с полями), без горизонтальной прокрутки', mb && tp && Math.abs(mb.x - tp.x) <= 1 && Math.abs(mb.r - tp.r) <= 1 && (await ev('document.documentElement.scrollWidth - window.innerWidth')) <= 0, { меню: mb, шапка: tp })
  for (const th of ['light', 'dark']) await shot('usage-menu-open', 400, th, 760)
  await key('Escape'); await sleep(200)

  // ===== «Цех»: блока нет, меню есть =====
  await open('#/', 'usage.json'); await size(1280, 900)
  must('«Цех»: блока «Служебное» (details) нет, кнопка в шапке есть', await ev('!document.querySelector("details[aria-label=\\"Служебное\\"]")') && await ev(`!!${btnSvc}`), null)
  await clickSvc(); await sleep(400)
  for (const [w, th] of [[1280, 'light'], [1280, 'dark']]) await shot('ceh-menu-open', w, th, 760)
  await key('Escape'); await sleep(200)
  ws.close()
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  if (child) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } }
  server.close()
  await sleep(800)
  removeTree(tmp)
  S.tmpLeft = fs.existsSync(tmp)
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; перехвачено: usage ${S.intercepted.usage}, ceh ${S.intercepted.ceh}, mirror ${S.intercepted.mirror}, act ${S.intercepted.act.length}; прочих /api: ${S.intercepted.other.length} (${[...new Set(S.intercepted.other)].join(', ')}); профиль остался: ${S.tmpLeft}`)
process.exit(S.error || S.fails.length ? 1 : 0)
