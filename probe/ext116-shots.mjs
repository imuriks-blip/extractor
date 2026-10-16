// Снимки и проверки EXT-116 Т2: окно «Агенты цеха» на образцах web/fixtures/agents*.json (гейт Т2 спеки витрины, раздел EXT-116).
// Запуск руками, в npm test не входит.   node probe/ext116-shots.mjs <папка-для-снимков> [chrome.exe]
// Устройство — как у ext91-t6-shots.mjs: крошечный сервер на 127.0.0.1:4399 отдаёт web/dist и ВЫДУМАННЫЕ ответы web/fixtures
// (GET /api/ceh, /api/glossary, /api/agents — образец по сценарию); всё прочее под /api — 404 и счёт. Ни прокси, ни витрины (4317):
// запросы дальше этого сервера не уходят. Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; тему
// переключают кнопкой приложения (до открытия окна: под модальным окном шапка недоступна). Проверяется ВИД, не данные.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4399
guardLive(REPO, PORT) // до любой записи: отказ в живой папке и на порту 4317 (CLAUDE.md репозитория)
if (!process.argv[2]) { console.error('нужна папка для снимков'); process.exit(2) }
const SHOTS = path.resolve(process.argv[2])
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST = path.join(REPO, 'web', 'dist')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { shots: [], checks: {}, fails: [], intercepted: { ceh: 0, glossary: 0, agents: 0, other: [] }, pid: null }
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
let agentsFile = 'agents.json'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname === '/api/ceh') { S.intercepted.ceh++; return send(res, 200, fx('ceh.json')) }
  if (u.pathname === '/api/glossary') { S.intercepted.glossary++; return send(res, 200, fx('glossary.json')) }
  if (u.pathname === '/api/agents') { S.intercepted.agents++; return send(res, 200, fx(agentsFile)) }
  if (u.pathname.startsWith('/api/')) { S.intercepted.other.push(u.pathname); res.writeHead(404); return res.end('{}') }
  if (u.pathname === '/sw.js') { res.writeHead(404); return res.end() } // служебного работника нет — страница не слепнет
  const f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname)
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(f))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const httpReq = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext116-chrome-'))
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
  const size = (w, h) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  const theme = (n) => ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(n)})?.click()`)
  const btnOf = (t) => `[...document.querySelectorAll('.top .hbtn')].find(b=>b.textContent.trim()===${JSON.stringify(t)})`
  const dlgOpen = () => ev('!!document.querySelector("dialog.ags")?.open')
  const mouse = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }) }
  const key = (k) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: 27 }).then(() => call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: 27 }))
  const typeQ = async (s) => { await ev(`(()=>{const i=document.querySelector('dialog.ags .gls-q');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(s)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(200) }
  const rowByName = (n) => `[...document.querySelectorAll('dialog.ags tr.ags-r')].find(r=>r.querySelector('.ags-n').textContent.includes(${JSON.stringify(n)}))`
  const clickRow = (n) => ev(`${rowByName(n)}.querySelector('.ags-n').click()`)

  // страница с образцом, тема — кнопкой, окно открыто кнопкой «Агенты»
  const page = async (file, w, h, th) => {
    agentsFile = file
    await size(w, h)
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` }); await sleep(300); await call('Page.reload', { ignoreCache: true }); await sleep(600)
    await waitFor(btnOf('Агенты'), 10000)
    await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(150)
    await ev(`${btnOf('Агенты')}.click()`)
    await waitFor('document.querySelector("dialog.ags .hlp-b")?.textContent && !document.querySelector("dialog.ags .hlp-b").textContent.includes("читаю реестр")', 5000)
    await sleep(250)
  }
  const shot = async (name, w, th) => {
    const x = await call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${name}-${w}-${th}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
  }
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
  const all = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent)`)
  const noHScroll = () => ev('(()=>{const b=document.querySelector("dialog.ags .hlp-b");const d=document.querySelector("dialog.ags");return Math.max(b.scrollWidth-b.clientWidth, d.getBoundingClientRect().right-innerWidth, document.documentElement.scrollWidth-innerWidth)})()')

  for (const w of [1280, 400]) {
    const H = w === 400 ? 812 : 800
    for (const th of ['light', 'dark']) {
      const tag = `${w}/${th}`
      // ===== исправный образец: 11 ролей, ошибки нет, «с определениями сходится», legend свёрнут; Терминус и Цереброн раскрыты =====
      await page('agents.json', w, H, th)
      if (th === 'light') {
        must(`${tag} ok: заголовок`, (await text('#ags-title')) === 'Агенты цеха · 11 ролей', await text('#ags-title'))
        must(`${tag} ok: 11 строк, ошибки нет`, (await all('dialog.ags tr.ags-r')).length === 11 && !(await text('dialog.ags .ags-err')), (await all('dialog.ags tr.ags-r')).length)
        must(`${tag} ok: серое «с определениями сходится», жёлтого нет`, (await text('dialog.ags .ags-m .ags-gray')) === 'с определениями сходится' && !(await text('dialog.ags .ags-warn')) && !(await text('dialog.ags .ags-dr')), await text('dialog.ags .ags-m'))
        must(`${tag} ok: шапка «реестр от …»`, /^реестр от \d\d\.\d\d \d\d:\d\d · выжимка, прав источник/.test(await text('dialog.ags .ags-m')), await text('dialog.ags .ags-m'))
        const lg = await text('dialog.ags .ags-lg')
        must(`${tag} ok: legend свёрнут до первой фразы`, lg === 'Как читать «держит». …', lg)
        must(`${tag} ok: у действующей роли без проблем меток нет`, (await ev(`${rowByName('Терминус')}.querySelectorAll('.tag,.ags-dr,.ags-un').length`)) === 0, null)
        must(`${tag} ok: Сводка свёрнута`, (await ev('document.querySelector("dialog.ags details.ags-sum")?.open')) === false, null)
      }
      await clickRow('Цереброн'); await clickRow('Терминус'); await sleep(150)
      if (th === 'light') {
        must(`${tag} ok: раскрытие — 14 разделов в порядке формы`, (await ev('[...document.querySelectorAll("dialog.ags dl.ags-d")].map(d=>d.querySelectorAll("dt").length).join()')) === '14,14', await ev('[...document.querySelectorAll("dialog.ags dl.ags-d dt")].slice(0,14).map(d=>d.textContent).join(" | ")'))
        must(`${tag} ok: предложение — метка и серая строка`, (await ev(`${rowByName('Цереброн')}.querySelector('.tag.proposal')?.textContent`)) === 'предложение — INFRA-97' && (await ev('document.body.textContent.includes("Роль не действует: ниже — предложение, а не права")')), null)
        must(`${tag} ok: путь с обратными косыми`, await ev('document.querySelector("dialog.ags").textContent.includes(String.fromCharCode(67,58,92)+"projects"+String.fromCharCode(92)+"_wt")'), null)
        must(`${tag} ok: «Нет.» серым`, await ev('[...document.querySelectorAll("dialog.ags dd.faint")].some(d=>d.textContent==="Нет.")'), null)
        await ev('document.querySelector("dialog.ags .ags-lg").click()'); await sleep(100)
        must(`${tag} ok: legend раскрывается щелчком`, (await text('dialog.ags .ags-lg')).includes('Механика') && (await ev('document.querySelector("dialog.ags .ags-lg").getAttribute("aria-expanded")')) === 'true', await text('dialog.ags .ags-lg'))
        await ev('document.querySelector("dialog.ags .ags-lg").click()'); await sleep(100)
      }
      must(`${tag} ok: нет горизонтальной прокрутки`, (await noHScroll()) <= 0, await noHScroll())
      await shot('ext116-ok', w, th)
      // прокрутка к сводке — раскрыть и снять низ
      await ev('(()=>{const d=document.querySelector("dialog.ags details.ags-sum");d.open=true;d.scrollIntoView({block:"end"})})()'); await sleep(150)
      await shot('ext116-ok-summary', w, th)

      // ===== расхождения =====
      await page('agents-drift.json', w, H, th)
      await clickRow('Электрибальд'); await sleep(150)
      if (th === 'light') {
        must(`${tag} drift: жёлтая сводка`, (await text('dialog.ags .ags-warn')) === 'расхождений с определениями: 2', await text('dialog.ags .ags-warn'))
        must(`${tag} drift: тормоз Клапауция — оба значения`, (await ev(`${rowByName('Клапауций')}.querySelector('.a-brake .ags-dr')?.textContent`)) === 'реестр: 40 · определение: 60', null)
        must(`${tag} drift: модель Голема — жёлтым`, /^реестр: Opus.* · определение: sonnet$/.test(await ev(`${rowByName('Голем')}.querySelector('.a-model .ags-dr')?.textContent`)), null)
        must(`${tag} drift: unchecked — серое «не сверяется», не жёлтое`, (await ev(`${rowByName('Ийон Тихий')}.querySelector('.a-model .ags-un')?.textContent`)) === ' · не сверяется' && !(await ev(`${rowByName('Ийон Тихий')}.querySelector('.ags-dr')`)), null)
        must(`${tag} drift: def null — «определение не читается»`, (await ev(`${rowByName('Демон')}.querySelector('.tag.nodef')?.textContent`)) === 'определение не читается', null)
        must(`${tag} drift: check null — пометок нет`, (await ev(`${rowByName('Иван')}.querySelectorAll('.tag,.ags-dr,.ags-un').length`)) === 0, null)
        must(`${tag} drift: проблемы — «разобрано не всё: 2» и «раздела нет в реестре»`, (await ev(`${rowByName('Электрибальд')}.querySelector('.tag.problems')?.textContent`)) === 'разобрано не всё: 2' && (await ev('[...document.querySelectorAll("dialog.ags dd.ags-gray")].some(d=>d.textContent==="раздела нет в реестре")')), null)
        must(`${tag} drift: проблема файла серой строкой`, (await all('dialog.ags .ags-m.ags-gray')).some((t) => t.includes('нет раздела «Сводные таблицы»')), await all('dialog.ags .ags-m.ags-gray'))
      }
      must(`${tag} drift: нет горизонтальной прокрутки`, (await noHScroll()) <= 0, await noHScroll())
      await ev(`${rowByName('Клапауций')}.scrollIntoView({block:"center"})`); await sleep(100)
      await shot('ext116-drift', w, th)

      // ===== ошибка с прежними ролями =====
      await page('agents-error.json', w, H, th)
      if (th === 'light') {
        must(`${tag} error: строка ошибки`, (await text('dialog.ags .ags-err')).startsWith('реестр не разобран: форма раздела роли изменилась'), await text('dialog.ags .ags-err'))
        must(`${tag} error: «данные на …, чтение не удаётся N мин» и список виден`, /^данные на .+, чтение не удаётся \d+ мин$/.test((await all('dialog.ags .ags-m.ags-gray'))[0] ?? '') && (await all('dialog.ags tr.ags-r')).length === 11, await all('dialog.ags .ags-m.ags-gray'))
      }
      await shot('ext116-error', w, th)

      // ===== ошибка без ролей (agents-empty.json): строка ошибки, списка и legend нет, окно живо =====
      await page('agents-empty.json', w, H, th)
      if (th === 'light') {
        must(`${tag} empty: строка ошибки`, (await text('dialog.ags .ags-err')) === 'реестр не разобран: файла нет (unorbis/_meta/Реестр ролей цеха.md)', await text('dialog.ags .ags-err'))
        must(`${tag} empty: ни списка, ни legend, ни «данные на»`, !(await text('dialog.ags .ags-t')) && !(await text('dialog.ags .ags-lg')) && (await all('dialog.ags .ags-m.ags-gray')).length === 0, null)
        must(`${tag} empty: заголовок без числа`, (await text('#ags-title')) === 'Агенты цеха', await text('#ags-title'))
      }
      await shot('ext116-empty', w, th)
    }
  }

  // ===== поиск и закрытие (1280, светлая) =====
  await page('agents.json', 1280, 800, 'light')
  await typeQ('база')
  const found = await ev('[...document.querySelectorAll("dialog.ags tr.ags-r .ags-n")].map(b=>b.textContent.trim())')
  must('поиск «база»: роли найдены, разделы с совпадением раскрыты', found.length > 0 && (await ev('[...document.querySelectorAll("dialog.ags tr.ags-xr dd")].every(d=>/баз/i.test(d.textContent)||/баз/i.test(d.previousElementSibling.textContent))')), found)
  must('поиск «база»: Сводка раскрыта на «Базах»', (await ev('document.querySelector("dialog.ags details.ags-sum")?.open')) === true && (await all('dialog.ags .ags-ss h3')).includes('Базы'), await all('dialog.ags .ags-ss h3'))
  await shot('ext116-search', 1280, 'light')
  await typeQ('zzz')
  must('поиск «zzz»: «ничего не найдено»', (await text('dialog.ags .hlp-b')) === 'ничего не найдено', await text('dialog.ags .hlp-b'))
  await typeQ('')
  // клавиатура: строка роли раскрывается Enter на её кнопке (CR — через fromCharCode, без экрана в тексте правки)
  await ev(`${rowByName('Терминус')}.querySelector('.ags-n').focus()`)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(150)
  must('Enter на кнопке строки раскрывает роль', (await ev(`${rowByName('Терминус')}.querySelector('.ags-n').getAttribute('aria-expanded')`)) === 'true', null)
  await key('Escape'); await sleep(150)
  must('Escape закрывает, фокус на «Агенты»', !(await dlgOpen()) && (await ev('document.activeElement?.textContent')) === 'Агенты', await ev('document.activeElement?.textContent'))
  await ev(`${btnOf('Агенты')}.click()`); await sleep(200)
  await ev('document.querySelector("dialog.ags .close").click()'); await sleep(150)
  must('крестик закрывает, фокус на «Агенты»', !(await dlgOpen()) && (await ev('document.activeElement?.textContent')) === 'Агенты', null)
  await ev(`${btnOf('Агенты')}.click()`); await sleep(200)
  await mouse(4, 4); await sleep(150)
  must('щелчок мимо закрывает, фокус на «Агенты»', !(await dlgOpen()) && (await ev('document.activeElement?.textContent')) === 'Агенты', null)
  // шапка с кнопкой «Агенты» рядом со «Словарём»
  must('кнопка «Агенты» в группе tbtns после «Словаря»', JSON.stringify(await ev('[...document.querySelectorAll(".top .tbtns > button")].map(b=>b.textContent.trim())')).includes('"Словарь","Агенты","?"'), await ev('[...document.querySelectorAll(".top .tbtns > button")].map(b=>b.textContent.trim())'))

  // ===== соседи для сверки плотности: окно «Словарь» на тех же размерах =====
  for (const w of [1280, 400]) {
    for (const th of ['light', 'dark']) {
      await size(w, w === 400 ? 812 : 800)
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` }); await sleep(300); await call('Page.reload', { ignoreCache: true }); await sleep(600)
      await waitFor(btnOf('Словарь'), 10000)
      await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(150)
      await ev(`${btnOf('Словарь')}.click()`); await sleep(500)
      await shot('neighbor-glossary', w, th)
      await key('Escape'); await sleep(100)
      if (w === 400 && th === 'light') await shot('header', w, th)
    }
  }
  ws.close()
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  // снимаем свой Chrome деревом — только пока он жив (номер вышедшего процесса может быть уже чужим, EXT-112)
  if (child && child.exitCode === null && child.signalCode === null) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } }
  server.close()
  await sleep(800)
  removeTree(tmp)
  S.tmpLeft = fs.existsSync(tmp)
}
fs.writeFileSync(path.join(SHOTS, 'ext116-summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; перехвачено: ceh ${S.intercepted.ceh}, glossary ${S.intercepted.glossary}, agents ${S.intercepted.agents}; прочих /api: ${S.intercepted.other.length} (${[...new Set(S.intercepted.other)].join(', ')}); профиль остался: ${S.tmpLeft}`)
process.exit(S.error || S.fails.length ? 1 : 0)
