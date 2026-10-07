// Проба EXT-81 (ПТ9, вид): кнопка и форма «Новая карточка» на «Цехе» и в окне проекта — снимки 1280 и 400, светлая и тёмная, headless.
// Устройство: настоящая витрина этой копии в том же процессе (временная доска с несколькими карточками и кодом RADAR, временная data,
// подменный plane.py test/fake-plane.mjs — настоящий plane.py и Plane не запускаются); страница — настоящая web/dist
// (собрать заранее: npm --prefix web run build). Витрину открывает не порт 4317, а свой порт-посредник (запросы идут в app.inject).
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; снимается по своему pid, деревом. Данные выдуманные.
//   node probe/ext81-drive.mjs <папка-для-снимков> [chrome.exe]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'
import { buildApp } from '../lib/app.mjs'
import { createBoardReader } from '../lib/board-reader.mjs'
import { createGitRead } from '../lib/git-read.mjs'
import { createRegistryReader } from '../lib/registry.mjs'
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from '../test/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4481
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext81-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { checks: {}, shots: [], fails: [], pids: {} }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const must = (k, ok, v) => { check(k, v); if (!ok) { S.fails.push(k); log(`НЕ ТАК: ${k}`) } }

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href)
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href)
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href)
const { similar } = await import(new URL(`file:///${BOARD_LIB}/similar.mjs`).href)

// --- стенд: доска, подменный plane.py, витрина ---
const BACKUP = 'Настроить резервное копирование базы'
const cards = [
  { id: 'EXT-3', status: 'in-progress', title: `${BACKUP} номер 3` },
  { id: 'EXT-4', status: 'backlog', title: `${BACKUP} номер 4` },
  { id: 'EXT-5', status: 'review', title: 'Показать отчёт по выгрузкам' },
  { id: 'EXT-6', status: 'done', title: 'Совершенно другое занятие про выгрузку отчётов' },
  { id: 'CAR-3', status: 'backlog', title: 'Проверить каталог машин' },
  { id: 'RADAR-1', status: 'backlog', title: 'Наблюдение за рынком' },
]
const boardDir = makeBoard(tmpDir('ext81p-board-'), { codes: ['EXT', 'CAR', 'RADAR'], cards })
gitInitCommit(boardDir)
fs.mkdirSync(path.join(boardDir, '.mirror'))
fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOk: new Date(Date.now() - 12 * 60000).toISOString() }))
const regFile = path.join(tmpDir('ext81p-reg-'), 'registry.json')
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] }, CAR: { repos: [] }, RADAR: { repos: [] } } }))
const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
await board.init()
const registry = createRegistryReader(regFile)
const data = tmpDir('ext81p-data-')
const pdir = tmpDir('ext81p-plane-')
fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
const stateFile = path.join(pdir, 'state.json')
fs.writeFileSync(stateFile, JSON.stringify({ status: 'Backlog', cardSeq: 40 }))
const plane = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const setFail = (create) => fs.writeFileSync(stateFile, JSON.stringify({ ...plane(), fail: create ? { create } : {} }))
const web = path.join(REPO, 'web', 'dist')
const app = await buildApp({ port: 4317, board, registry, scan, similar, webDir: web,
  pult: { enabled: true, words: true, actionsLog: path.join(data, 'actions.log'), boardRoot: boardDir, python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') } })

let intercepted = 0
let drop = false // «нет связи»: запрос обрывается, не дойдя до app.inject
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/events')) { res.writeHead(404); res.end(); return }
  if (drop && req.method === 'POST') { req.socket.destroy(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    intercepted++
    const h = { host: '127.0.0.1:4317', ...(req.method === 'POST' ? { origin: 'http://127.0.0.1:4317', 'sec-fetch-site': 'same-origin', 'content-type': req.headers['content-type'], 'x-vitrina-token': req.headers['x-vitrina-token'] } : {}) }
    const r = await app.inject({ method: req.method, url: req.url, headers: h, payload: chunks.length ? Buffer.concat(chunks) : undefined })
    res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] ?? 'text/plain' })
    res.end(r.rawPayload)
  })
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

// --- браузер ---
const dirs = []
const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext81-chrome-')); dirs.push(dir)
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

const PRJ = `[...document.querySelectorAll('details.blk')].find(d=>d.querySelector('summary').textContent.includes('Проекты'))`
const BRD = `document.querySelector('details.pboard')`
const F = '.nc-bar'
let b = null
try {
  b = await openBrowser()
  const size = (w, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(120) } return false }
  const theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  const txt = (sel = F) => b.ev(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g,' ').trim()`)
  const btnsOf = () => b.ev(`[...document.querySelectorAll('${F} button')].map(x=>x.textContent.trim()+(x.disabled?'(неактивна)':''))`)
  const click = (label) => b.ev(`(()=>{const x=[...document.querySelectorAll('${F} button')].find(y=>y.textContent.trim()===${JSON.stringify(label)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  const setSel = (v) => b.ev(`(()=>{const s=document.querySelector('${F} select');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,${JSON.stringify(v)});s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const setVal = (sel, v) => b.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value').set;set.call(e,${JSON.stringify(v)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const TITLE = `${F} input[aria-label="Заголовок"]`
  const TEXT = `${F} textarea`
  const fill = async (title, text = '') => { await setVal(TITLE, title); await setVal(TEXT, text) }
  const BLOCK = (where) => (where === 'ceh' ? PRJ : BRD)
  const shot = async (name, w, th, where = 'ceh') => {
    await size(w); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(300)
    await b.ev(`(()=>{const d=${BLOCK(where)};if(d&&!d.open)d.open=true;d?.scrollIntoView()})()`)
    const rect = await b.ev(`(()=>{const r=${BLOCK(where)}.getBoundingClientRect();return {x:0,y:Math.max(0,r.top+window.scrollY-6),w:window.innerWidth,h:Math.ceil(r.height)+12}})()`)
    const r = await b.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
    const f = path.join(SHOTS, `${w}-${th}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
    if (w === 400) { const ov = await b.ev('document.documentElement.scrollWidth - window.innerWidth'); must(`на 400 (${th}, ${name}) горизонтальной прокрутки нет`, ov <= 0, ov) }
  }
  const shots4 = async (name, where = 'ceh') => { for (const [w, th] of [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]) await shot(name, w, th, where); await size(1280); await theme('Светлая') }

  await size(1280)
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errs=[];addEventListener("error",e=>__errs.push(String(e.message)));addEventListener("unhandledrejection",e=>__errs.push("rej "+String(e.reason)))' })
  await b.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` })
  must('на «Цехе» кнопка «Новая карточка» есть', await waitFor(`document.querySelector('${F} button')`, 15000), await btnsOf().catch(() => null))

  // (1) пустая форма: проект не выбран — «создать» неактивна; в списке нет RADAR
  await click('Новая карточка')
  await waitFor(`document.querySelector('${F} form')`); await sleep(200)
  const opts = await b.ev(`[...document.querySelectorAll('${F} select option')].map(o=>o.value)`)
  must('в списке проектов нет RADAR, остальные есть', !opts.includes('RADAR') && opts.includes('EXT') && opts.includes('CAR'), opts)
  must('фокус — на заголовке при открытии', await b.ev(`document.activeElement?.getAttribute('aria-label')==='Заголовок'`), null)
  must('пока проект не выбран «создать» неактивна', (await btnsOf()).includes('создать(неактивна)'), await btnsOf())
  await shots4('1-pustaya')

  // (2) заполнена
  await fill(`${BACKUP} номер 3`, 'Нужна автоматическая выгрузка раз в сутки; проверить, что копия читается.')
  must('заголовок и текст введены, проект не выбран — «создать» всё ещё неактивна', (await btnsOf()).includes('создать(неактивна)'), null)
  await setSel('EXT')
  must('проект выбран — «создать» активна', (await btnsOf()).includes('создать'), await btnsOf())
  await shots4('2-zapolnena')

  // (2б) поллинг данных форму не сбрасывает
  await sleep(6500)
  must('через 6,5 с (опрос данных) черновик на месте', await b.ev(`document.querySelector(${JSON.stringify(TITLE)})?.value==='${BACKUP} номер 3' && document.querySelector('${F} select').value==='EXT'`), null)

  // (3) похожие
  await click('создать')
  must('пришёл блок «похожие» с EXT-3 и EXT-4', await waitFor(`/похожие/.test(document.querySelector('${F} .cfm')?.textContent??'')`, 10000), await txt())
  const sim = await txt(`${F} .cfm`)
  must('в блоке: оба похожих, возраст зеркала, «всё равно создать» и «отмена»', /EXT-3/.test(sim) && /EXT-4/.test(sim) && /зеркало/.test(sim) && (await btnsOf()).includes('всё равно создать') && (await btnsOf()).includes('отмена'), sim)
  await shots4('3-pokhozhie')
  // поправить → форма с тем же текстом
  await click('поправить')
  must('«поправить» возвращает форму с введённым текстом', await b.ev(`document.querySelector(${JSON.stringify(TITLE)})?.value==='${BACKUP} номер 3'`), null)
  await click('создать')
  await waitFor(`document.querySelector('${F} .cfm')`)
  const before = plane().creates?.length ?? 0
  await click('всё равно создать')
  must('после «всё равно создать»: «создана EXT-41 · Backlog»', await waitFor(`/создана EXT-41/.test(document.querySelector('${F}')?.innerText??'')`, 15000), await txt())
  must('подменный Plane получил ровно одно создание', (plane().creates?.length ?? 0) === before + 1 && plane().creates.at(-1).code === 'EXT', plane().creates?.length)
  must('форма закрыта и очищена; после «создана» кнопка снова обычная', await b.ev(`!document.querySelector('${F} form')`), await btnsOf())
  await shots4('4-sozdana')

  // (4) секрет
  await click('Новая карточка'); await waitFor(`document.querySelector('${F} form')`)
  await setSel('CAR')
  await fill('Уборка ключей', 'токен лежит тут: ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d')
  await click('создать')
  must('секрет: отказ и «поправить текст», кнопки «это не секрет» нет', await waitFor(`/секрет/.test(document.querySelector('${F} .pnote')?.textContent??'')`, 10000) && !(await btnsOf()).includes('это не секрет — отправить') && (await btnsOf()).includes('поправить текст'), await txt())
  must('карточка не создавалась (в подменном Plane по-прежнему одна)', plane().creates.length === 1, plane().creates.length)
  await shots4('5-sekret')
  // «может быть секретом»
  await setVal(TEXT, 'ключ лежит тут: Zq8vK3mP9xLr2TnW')
  await click('создать')
  must('«может быть секретом»: есть «это не секрет — отправить» и «поправить текст»', await waitFor(`/может быть/.test(document.querySelector('${F} .pnote')?.textContent??'')`, 10000) && (await btnsOf()).includes('это не секрет — отправить'), await btnsOf())
  await shots4('6-sekret-mozhet')
  await click('это не секрет — отправить')
  must('после «это не секрет»: создана CAR-42', await waitFor(`/создана CAR-42/.test(document.querySelector('${F}')?.innerText??'')`, 15000), await txt())

  // (4б) нет связи: «повторить» есть; «отмена» ведёт в «исход неясен», а не молча закрывает
  await click('Новая карточка'); await waitFor(`document.querySelector('${F} form')`)
  await setSel('EXT'); await fill('Заметка про связь', 'текст на случай обрыва')
  const nBefore = plane().creates.length
  drop = true
  await click('создать')
  must('нет связи: заметка и «повторить»', await waitFor(`/нет связи/.test(document.querySelector('${F} .pnote')?.textContent??'')`, 10000) && (await btnsOf()).includes('повторить'), await txt())
  await shots4('7a-net')
  await click('отмена')
  must('«отмена» из «нет связи» — «исход неясен» с текстом, без «создать»/«повторить»', await waitFor(`/исход неясен/.test(document.querySelector('${F} .nc-un')?.textContent??'')`) && !(await btnsOf()).some((x) => /создать|повторить/.test(x)) && /Заметка про связь/.test(await txt()), await btnsOf())
  must('на доску ничего не ушло', plane().creates.length === nBefore, plane().creates.length)
  await shots4('7b-net-neyasno')
  await click('закрыть')
  must('после «закрыть» поля очищены', await b.ev(`!document.querySelector('${F} form')`), null)
  drop = false

  // (5) исход неясен
  setFail('unclear')
  await click('Новая карточка'); await waitFor(`document.querySelector('${F} form')`)
  await setSel('EXT')
  await fill('Подготовить отчёт для партнёров', 'Сводка по неделе, без цен.')
  await click('создать')
  must('исход неясен: красный блок', await waitFor(`/исход неясен/.test(document.querySelector('${F} .nc-un')?.textContent??'')`, 15000), await txt())
  const bu = await btnsOf()
  must('при неясном: только «скопировать текст» и «закрыть» (+ кнопка «Новая карточка»), «создать»/«повторить» нет', !bu.some((x) => /создать|повторить/.test(x)) && bu.includes('скопировать текст') && bu.includes('закрыть'), bu)
  must('в блоке видны заголовок и текст', /Подготовить отчёт для партнёров/.test(await txt()) && /Сводка по неделе/.test(await txt()), null)
  await shots4('7-neyasno')
  await click('закрыть')
  setFail(null)

  // (6) «не создана»: форма остаётся с текстом
  setFail('refuse')
  await click('Новая карточка'); await waitFor(`document.querySelector('${F} form')`)
  await setSel('EXT'); await fill('Сломанное создание', 'текст остаётся')
  await click('создать')
  must('«не создана»: сообщение и форма с введённым текстом, «создать» снова доступна', await waitFor(`/не создана/.test(document.querySelector('${F} .pnote')?.textContent??'')`, 10000) && await b.ev(`document.querySelector(${JSON.stringify(TITLE)})?.value==='Сломанное создание'`) && (await btnsOf()).includes('создать'), await txt())
  await shot('8-ne-sozdana', 1280, 'light')
  setFail(null)
  // Esc закрывает
  await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  must('Esc закрывает форму', await waitFor(`!document.querySelector('${F} form')`), null)

  // (7) окно проекта EXT: проект подставлен
  await b.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/project/EXT` })
  must('в окне проекта EXT кнопка есть', await waitFor(`document.querySelector('${F} button')`, 15000), null)
  await click('Новая карточка'); await waitFor(`document.querySelector('${F} form')`)
  must('в форме проекта: подпись «в EXT», списка проектов нет', /в EXT/.test(await txt()) && !(await b.ev(`!!document.querySelector('${F} select')`)), await txt())
  await fill('Проверить подпись проекта', '')
  must('в окне проекта «создать» активна без выбора', (await btnsOf()).includes('создать'), await btnsOf())
  await shots4('9-okno-proekta', 'project')
  await click('отмена')
  await shots4('9b-okno-proekta-knopka', 'project')
  // RADAR: кнопки нет
  await b.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/project/RADAR` })
  await waitFor(`document.querySelector('details.pboard')`, 15000)
  await sleep(800)
  must('в окне RADAR кнопки «Новая карточка» нет', (await b.ev(`document.querySelectorAll('${F}').length`)) === 0, null)
  must('на странице нет ошибок', (await b.ev('JSON.stringify(window.__errs)')) === '[]', await b.ev('JSON.stringify(window.__errs)'))
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
} finally {
  if (b) await b.close()
  S.intercepted = intercepted
  srv.close()
  await sleep(800)
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, (() => { try { process.kill(p, 0); return true } catch { return false } })()]))
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { log(`не убрана ${d}: ${e.code ?? e.message}`) } }
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог: запросов страницы ${intercepted} (все — в app.inject, дальше не ушли); проверок не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; живы: ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length ? 1 : 0)
