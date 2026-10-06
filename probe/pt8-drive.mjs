// Проба ПТ8 (EXT-75, такт 3; вид по решениям Ивана 05.10 — «полный» в «Служебном», подтверждение в потоке): полный проход
// зеркала, рестарт витрины во время прохода, «Пересобрать индекс», снимки.
// Тестовый экземпляр витрины этой копии В ТОМ ЖЕ ПРОЦЕССЕ (buildApp; сигнала changed без start.mjs нет — страница перечитывается),
// свой порт, своя data во временной папке, ВРЕМЕННАЯ доска с копией настоящего tools/mirror-hidden.js (JScript-обёртка, только
// прочитана) и ПОДМЕННЫМ tools/mirror.mjs (probe/pt8-fake-mirror.mjs: формат status.json/run.lock/runs.log как у настоящего, идёт
// десятки секунд, в Plane не ходит). Настоящая доска, зеркало и Plane не трогаются. Читатель журналов — настоящий, на выдуманных
// журналах из test/fixtures, чтение замедлено подменой fs (чтобы «N из M журналов» было видно). Страница — настоящая web/dist.
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; снимки только своих окон.
//   node probe/pt8-drive.mjs <папка-для-снимков> [chrome.exe]
// Проверки с ожиданием (must): не так — код 1. Охранник: из папки живой витрины и на порту 4317 — отказ до любой записи.
import { spawn, execFileSync } from 'node:child_process'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../lib/app.mjs'
import { createBoardReader } from '../lib/board-reader.mjs'
import { createGitRead } from '../lib/git-read.mjs'
import { createRegistryReader } from '../lib/registry.mjs'
import { createJournalReader } from '../lib/journal-reader.mjs'
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'

const fs = nodeFs
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4396
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'pt8-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const REAL_HIDDEN = 'C:/projects/unorbis-board/tools/mirror-hidden.js' // только чтение: копия обёртки в временную доску
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { checks: {}, shots: [], fails: [], pids: {} }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }
const must = (k, ok, v) => { check(k, v); if (!ok) { S.fails.push(k); log(`НЕ ТАК: ${k}`) } }

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href)
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href)
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href)
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href)

const iso = (d) => d.toISOString()
const T0 = Date.now()
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FULL_SECONDS = 70
const TOTAL_CARDS = 60
const REINDEX_DELAY_MS = 1000

// ---------- удаление дерева: только unlinkSync/rmdirSync (fs.rmSync на Windows с кириллицей молча не удаляет) ----------
function removeTree(dir) {
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of names) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) removeTree(p)
    else { for (let i = 0; i < 5; i++) { try { fs.unlinkSync(p); break } catch (err) { if (err.code === 'ENOENT') break; if (i === 4) throw err; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) } } }
  }
  for (let i = 0; i < 5; i++) { try { fs.rmdirSync(dir); return } catch (err) { if (err.code === 'ENOENT') return; if (i === 4) throw err; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) } }
}
const TMP_DIRS = []
const mk = (prefix) => { const d = tmpDir(prefix); TMP_DIRS.push(d); return d }

// ---------- процессы: только чтение ----------
function procTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 20e6 })
  const m = new Map()
  for (const r of JSON.parse(out)) m.set(r.ProcessId, { ppid: r.ParentProcessId, name: String(r.Name).toLowerCase() })
  return m
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const descendants = (tab, root) => { const set = new Set([root]); let grew = true; while (grew) { grew = false; for (const [p, v] of tab) if (!set.has(p) && set.has(v.ppid)) { set.add(p); grew = true } } return [...set] }
const visibleWindows = (pids) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-File', path.join(HERE, 'pt8-windows.ps1'), ...pids.map(String)], { encoding: 'utf8', windowsHide: true }) || '[]')

// ---------- временная доска, журналы, экземпляр ----------
const ENV = (() => {
  const boardDir = makeBoard(mk('pt8-board-'), { codes: ['EXT', 'INFRA'], cards: [
    { id: 'EXT-75', status: 'in-progress', title: 'ПТ8: полный проход и индекс' },
    { id: 'EXT-70', status: 'review', title: 'ПТ7: кнопки пульта в вёрстке' },
    { id: 'INFRA-80', status: 'in-progress', title: 'Перенос бэкапов на второй диск' },
  ] })
  gitInitCommit(boardDir)
  const mdir = path.join(boardDir, '.mirror')
  fs.mkdirSync(mdir)
  fs.writeFileSync(path.join(mdir, 'index.json'), '{}')
  fs.writeFileSync(path.join(mdir, 'status.json'), JSON.stringify({ at: iso(new Date(T0 - 6 * 3600e3)), kind: 'changed', lastOk: iso(new Date(T0 - 6 * 3600e3)), lastFullOk: iso(new Date(T0 - 3 * 86400e3)) }))
  const tools = path.join(boardDir, 'tools')
  fs.mkdirSync(tools)
  fs.copyFileSync(REAL_HIDDEN, path.join(tools, 'mirror-hidden.js'))
  fs.copyFileSync(path.join(HERE, 'pt8-fake-mirror.mjs'), path.join(tools, 'mirror.mjs'))
  const setFake = (o) => fs.writeFileSync(path.join(tools, 'fake-mirror.json'), JSON.stringify(o))
  setFake({ seconds: FULL_SECONDS, total: TOTAL_CARDS, exit: 0 })
  const regFile = path.join(mk('pt8-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: Object.fromEntries(['EXT', 'INFRA'].map((c) => [c, { projects: [], project_cards: [], repos: [] }])) }))
  // выдуманные журналы: 28 сессий из фикстур + сессия с двумя субагентами
  const FX = path.join(REPO, 'test', 'fixtures', 'journals')
  const jroot = mk('pt8-journals-')
  const proj = path.join(jroot, 'C--pt8-demo')
  fs.mkdirSync(proj)
  const SID = '2fea3135-c7db-442b-9907-4d619949881d'
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true })
  fs.copyFileSync(path.join(FX, `${SID}.jsonl`), path.join(proj, `${SID}.jsonl`))
  for (const f of fs.readdirSync(path.join(FX, SID, 'subagents'))) fs.copyFileSync(path.join(FX, SID, 'subagents', f), path.join(proj, SID, 'subagents', f))
  const tops = fs.readdirSync(FX).filter((n) => n.endsWith('.jsonl'))
  for (let i = 0; i < 28; i++) fs.copyFileSync(path.join(FX, tops[i % tops.length]), path.join(proj, `${uuid(100 + i)}.jsonl`))
  const data = mk('pt8-data-')
  return { boardDir, mdir, setFake, regFile, jroot, data, indexDir: path.join(data, 'index'), actionsFile: path.join(data, 'actions.log'), runsFile: path.join(mdir, 'runs.log') }
})()

// чтение замедляется только на время пересбора (slow.on); breakAt — сбой чтения одного журнала (проверка красного случая)
const slow = { on: false, breakAt: null }
const slowFs = { ...nodeFs,
  createReadStream: (f, o) => (slow.on ? Readable.from((async function* () { await sleep(REINDEX_DELAY_MS); yield* nodeFs.createReadStream(f, o) })()) : nodeFs.createReadStream(f, o)),
  statSync: (p, ...a) => { if (slow.breakAt && String(p).includes(slow.breakAt)) throw Object.assign(new Error('x'), { code: 'EIO' }); return nodeFs.statSync(p, ...a) } }

const spawns = [] // вызовы spawn витрины: wscript и его параметры
const realSpawn = spawn
async function startInstance() {
  const board = createBoardReader({ root: ENV.boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(ENV.regFile)
  const journals = createJournalReader({ root: ENV.jroot, indexDir: ENV.indexDir, fs: slowFs, indexWriteEveryS: 0 })
  await journals.refresh({ full: true })
  const threads = { list: () => ({ threads: [], waiting: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: iso(new Date()) }, desktop: null }) }
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: path.join(REPO, 'web', 'dist'), threads, journals,
    pult: { enabled: true, words: false, bell: false, actionsLog: ENV.actionsFile, mirrorDir: ENV.mdir, lock: lockLib, boardRoot: ENV.boardDir },
    pultSeams: { spawn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return realSpawn(cmd, args, opts) } } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const base = `http://127.0.0.1:${PORT}`
  const req = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request(base + url, { method, headers }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b })) })
    r.on('error', reject); if (body) r.write(body); r.end()
  })
  const token = (await req('GET', '/')).text.match(/name="vitrina-token" content="([^"]+)"/)?.[1]
  const api = async (method, url, payload) => {
    const body = payload ? JSON.stringify({ intentId: crypto.randomUUID(), ...payload }) : null
    const r = await req(method, url, body, body ? { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin', 'x-vitrina-token': token } : {})
    let j = null; try { j = JSON.parse(r.text) } catch { /* не JSON */ }
    return { status: r.status, body: j }
  }
  return { app, api, mirror: async () => (await api('GET', '/api/mirror')).body, close: async () => { try { journals.flush() } catch { /* нет */ } await app.close() } }
}
const actions = () => (fs.existsSync(ENV.actionsFile) ? fs.readFileSync(ENV.actionsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const runsLines = () => (fs.existsSync(ENV.runsFile) ? fs.readFileSync(ENV.runsFile, 'utf8') : '').split('\n').filter(Boolean)
const fakePid = () => { try { return JSON.parse(fs.readFileSync(path.join(ENV.mdir, 'fake-pid.json'), 'utf8')) } catch { return null } }
async function until(fn, ms, step = 400) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step) } }

// ---------- браузер по CDP ----------
const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = mk('pt8-chrome-')
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
  return { child, dir, call, ev, close: async () => { try { ws.close() } catch { /* закрыт */ } try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* уже нет */ } } }
}

const BASE = `http://127.0.0.1:${PORT}`
const COMBOS = [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]
function pageApi(b) {
  const P = {}
  P.size = (w, h = 1400) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  P.waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  P.goto = async (hash = '#/') => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await P.waitFor('document.querySelector(".top")', 10000) }
  P.theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  P.btn = (text, scope = 'document') => b.ev(`(()=>{const x=[...${scope}.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(text)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.text = (sel) => b.ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x=>x.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`)
  // снимок текущего вида: ширина w, тема (кнопкой приложения), полная высота страницы
  P.view = async (w, theme) => { await P.size(w, 900); await P.theme(theme === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350) }
  P.shot = async (name, w, theme) => {
    const h = Math.min(3200, Math.max(700, await b.ev('document.documentElement.scrollHeight')))
    await P.size(w, h); await sleep(300)
    const r = await b.call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${theme}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    S.shots.push(f); log(`снимок ${f}`)
    await P.size(w, 900)
  }
  P.shotAll = async (name) => { for (const [w, th] of COMBOS) { await P.view(w, th); await P.shot(name, w, th) } }
  P.overflowX = () => b.ev('document.documentElement.scrollWidth - window.innerWidth')
  P.b = b
  return P
}

// «Служебное» и замер «подтверждение ничего не накрывает» (EXT-75, решение Ивана 05.10): прямоугольник каждого элемента
// подтверждения — против прямоугольников всех прочих блоков страницы и шапки; position подтверждения; высота «Служебного»
const SVC = 'details[aria-label="Служебное"]'
const openService = async (P) => { await P.waitFor(`document.querySelector('${SVC}')`); await P.b.ev(`(()=>{const d=document.querySelector('${SVC}');if(d&&!d.open)d.querySelector('summary').click()})()`); await sleep(300) }
// страница прокручивается к началу перед замером (автофокус «отмена» её прокручивает — это не сдвиг вёрстки);
// координаты — от начала документа
const RECTS = `(()=>{const sy=window.scrollY;window.scrollTo(0,0);const R=(e)=>{const r=e.getBoundingClientRect();return {top:r.top+window.scrollY,left:r.left,right:r.right,bottom:r.bottom+window.scrollY,h:r.height}};
  const svc=document.querySelector('${SVC}');const cf=svc?svc.querySelector('.cfm'):null;
  const blocks=[...document.querySelectorAll('.blk')].filter(e=>e!==svc&&!e.contains(svc)&&!svc.contains(e)).map(e=>{const h=e.querySelector('summary,h2,h3');return {name:(h?h.textContent:e.className).replace(/›/g,'').trim().replace(/\s+/g,' ').slice(0,40),...R(e)}});
  const top=document.querySelector('.top');if(top)blocks.push({name:'шапка',...R(top)});
  return {scrolledBy:sy,blocks,svc:R(svc),pos:cf?getComputedStyle(cf).position:null,cfmBox:cf?R(cf):null,cfm:cf?[cf,...cf.querySelectorAll('*')].map(e=>({tag:e.tagName.toLowerCase()+(e.className?'.'+String(e.className).split(' ')[0]:''),...R(e)})).filter(r=>r.h>0):[]}})()`
const cross = (a, k) => a.left < k.right - 0.5 && a.right > k.left + 0.5 && a.top < k.bottom - 0.5 && a.bottom > k.top + 0.5

// ---------- сценарий ----------
const RUN_RE = /^(\S+) · (начало|конец) · full · pid (\d+)(?: · код (\d+) · (\d+) с · запросов (\d+))?$/
let inst = null
let b = null
let kill = [] // pid обёрток зеркала, найденные по цепочке родителей: на случай обрыва пробы
try {
  log(`снимки: ${SHOTS}; порт ${PORT}; временные папки: ${TMP_DIRS.join(', ')}`)
  inst = await startInstance()
  b = await openBrowser()
  const P = pageApi(b)
  await P.size(1280, 900)
  await P.goto('#/')
  await P.view(1280, 'light')

  // ===== 1. Полный проход =====
  const m0 = await inst.mirror()
  must('до: проход не идёт, итога нет', m0.running === false && m0.lastRun === null && runsLines().length === 0, { running: m0.running, lastRun: m0.lastRun, runsLog: runsLines().length })
  // решение Ивана 05.10: «полный» — в «Служебном» на «Цехе»; EXT-77 (слово Ивана 06.10): «Обновить» — тоже там, в шапке кнопок
  // зеркала нет (закрытые окна «Словаря» и «?» со своим «×» — не в счёт)
  const hdr0 = await b.ev(`[...document.querySelectorAll('.top button')].filter(x=>!x.closest('dialog')).map(x=>x.textContent.trim())`)
  must('покой: в шапке кнопок зеркала нет — только тема, «Словарь», «?»', hdr0.every((t) => ['Авто', 'Светлая', 'Тёмная', 'Словарь', '?'].includes(t)), hdr0)
  await P.shotAll('1-pokoy')
  await openService(P)
  const svc0 = await P.text(SVC + ' .wtb')
  must('«Служебное»: «Обновить», «Полный проход зеркала», «Пересобрать индекс», у полного — когда был последний (lastFullOk)', svc0.includes('Обновить') && svc0.includes('Пересобрать индекс') && svc0.includes('Полный проход зеркала') && /последний полный — \d\d\.\d\d/.test(svc0), svc0)
  await P.shotAll('2-sluzhebnoe')

  // первый щелчок: need-confirm с ценой, ничего не запущено; подтверждение — в потоке, ничего не накрывает (1280 и 400)
  for (const w of [1280, 400]) {
    await P.view(w, 'light')
    if (await b.ev(`!!document.querySelector('${SVC} .cfm')`)) await P.btn('отмена')
    await sleep(200)
    const before = await b.ev(RECTS)
    must(`${w}: первый щелчок «Полный проход зеркала»: нажата`, await P.btn('Полный проход зеркала'), null)
    must(`${w}: подтверждение с ценой и «запустить полный» — внутри «Служебного»`, await P.waitFor(`document.querySelector('${SVC} .cfm')`), await P.text(SVC + ' .cfm'))
    await sleep(250)
    // Голем дирижёра на экран ПТ8: фокус после раскрытия — на «отмена» (автоповтор Enter не нажимает «запустить полный»)
    const focused = await b.ev(`(()=>{const a=document.activeElement;return {tag:a?.tagName.toLowerCase()??null,text:a?.textContent.trim()??null,inCfm:!!a?.closest('.cfm')}})()`)
    must(`${w}: фокус после раскрытия подтверждения — на «отмена» внутри подтверждения`, focused.tag === 'button' && focused.text === 'отмена' && focused.inCfm, focused)
    const after = await b.ev(RECTS)
    const hit = after.cfm.flatMap((r) => after.blocks.filter((k) => cross(r, k)).map((k) => `${r.tag} × ${k.name}`))
    const moved = before.blocks.filter((k) => { const a = after.blocks.find((x) => x.name === k.name); return !a || Math.abs(a.top - k.top) > 0.5 })
    const wait = (x) => x.blocks.find((k) => k.name.startsWith('Ждёт меня'))?.top ?? null
    must(`${w}: подтверждение в потоке — position static, ни один его элемент не пересекает другие блоки и шапку, их верх не сдвинут, «Служебное» выросло на высоту подтверждения`,
      after.pos === 'static' && hit.length === 0 && moved.length === 0 && after.blocks.length >= 4 && after.svc.h - before.svc.h >= after.cfmBox.h - 1,
      { pos: after.pos, прокруткаАвтофокусом: Math.round(after.scrolledBy), пересечений: hit, сдвинуты: moved.map((k) => k.name), верхЖдётМеня: { до: wait(before), после: wait(after) }, служебное: { до: Math.round(before.svc.h), после: Math.round(after.svc.h) }, подтверждение: after.cfmBox && { top: Math.round(after.cfmBox.top), h: Math.round(after.cfmBox.h) }, элементов: after.cfm.length, блоки: after.blocks.map((k) => k.name) })
    for (const th of ['light', 'dark']) { await P.view(w, th); await P.shot('3-polnyj-podtverzhdenie', w, th) }
  }
  const cfmText = await P.text(SVC + ' .cfm')
  must('первый щелчок: цена в тексте (~1,5 ч, ~2 200 запросов)', /~1,5 ч/.test(cfmText) && /~2 200 запросов/.test(cfmText), cfmText)
  const a1 = actions()
  const first = a1.filter((l) => l.action === 'mirror')
  must('первый щелчок: в журнале нажатий asked и need-confirm, не done', first.some((l) => l.step === 'asked' && l.kind === 'full') && first.some((l) => l.step === 'need-confirm') && !first.some((l) => l.step === 'done'), first.map((l) => l.step))
  must('первый щелчок: ничего не запущено (spawn не вызывался, run.lock и runs.log нет, процесса пробы нет)', spawns.length === 0 && !fs.existsSync(path.join(ENV.mdir, 'run.lock')) && runsLines().length === 0 && fakePid() === null, { spawns: spawns.length, lock: fs.existsSync(path.join(ENV.mdir, 'run.lock')), runs: runsLines().length })
  must('первый щелчок: /api/mirror — проход не идёт', (await inst.mirror()).running === false, null)

  // второй щелчок: запуск
  must('второй щелчок «запустить полный»: нажата', await P.btn('запустить полный'), null)
  must('второй щелчок: spawn вызван один раз', await until(() => spawns.length === 1, 8000), spawns.length)
  const sp = spawns[0]
  must('запуск скрытый: wscript.exe //B //Nologo //E:JScript, windowsHide, detached, stdio ignore', /wscript\.exe$/i.test(sp.cmd) && sp.args.slice(0, 3).join(' ') === '//B //Nologo //E:JScript' && sp.opts.windowsHide === true && sp.opts.detached === true && sp.opts.stdio === 'ignore',
    { cmd: path.basename(sp.cmd), args: sp.args.slice(0, 4).map((x) => (x.includes('\\') || x.includes('/') ? path.basename(x) : x)), windowsHide: sp.opts.windowsHide, detached: sp.opts.detached, stdio: sp.opts.stdio })
  must('запуск: аргументы — --full, --root <временная доска>, --log', sp.args.includes('--full') && sp.args[sp.args.indexOf('--root') + 1] === ENV.boardDir && sp.args.includes('--log') && !sp.args.includes('--exit-with-parent'), { full: sp.args.includes('--full'), rootOk: sp.args[sp.args.indexOf('--root') + 1] === ENV.boardDir, exitWithParent: sp.args.includes('--exit-with-parent') })
  const fp = await until(() => fakePid(), 15000)
  must('подменное зеркало стартовало (fake-pid.json)', !!fp, fp && { pid: fp.pid, ppid: fp.ppid })
  const rl1 = runsLines()
  must('runs.log: строка «начало · full · pid N» (формат настоящего)', rl1.length === 1 && RUN_RE.test(rl1[0]) && /начало/.test(rl1[0]) && rl1[0].includes(`pid ${fp.pid}`), rl1)

  // процесс: цепочка родителей и окна
  const tab = procTable()
  const wsPid = fp.ppid
  const chain = [fp.pid, wsPid, tab.get(wsPid)?.ppid].map((p) => ({ pid: p, name: tab.get(p)?.name ?? '?' }))
  kill.push(wsPid)
  S.pids.mirrorNode = fp.pid; S.pids.mirrorWscript = wsPid
  must('процесс прохода: node.exe ← wscript.exe ← процесс пробы (цепочка родителей)', tab.get(fp.pid)?.name === 'node.exe' && tab.get(wsPid)?.name === 'wscript.exe' && tab.get(wsPid)?.ppid === process.pid, chain)
  const own = descendants(tab, wsPid)
  const vis = visibleWindows(own)
  must('у процессов прохода (wscript, node и потомки) видимых окон нет', vis.length === 0, { pids: own.map((p) => `${p}:${tab.get(p)?.name}`), видимых: vis.length })
  const expl = [...tab].filter(([, v]) => v.name === 'explorer.exe').map(([p]) => p)
  const ctrl = visibleWindows(expl)
  must('контроль детектора: у explorer.exe видимые окна находятся (детектор зрячий; заголовки не выводятся)', ctrl.length > 0, { видимых: ctrl.length, классы: [...new Set(ctrl.map((x) => x.cls))].slice(0, 4) })

  // ход в /api/mirror и в шапке
  const run1 = await until(async () => { const m = await inst.mirror(); return m.running && m.phase === 'cards' && Number.isFinite(m.cardsDone) && Number.isFinite(m.cardsTotal) && Number.isFinite(m.requests) ? m : null }, 30000, 700)
  must('/api/mirror во время прохода: running, kind full, фаза, N из M, запросов, rpm, startedAt', !!run1 && run1.kind === 'full' && run1.cardsTotal === TOTAL_CARDS && run1.rpm === 23 && !!run1.startedAt && run1.lastRun === null, run1)
  must('шапка: «полный проход идёт · … из … · запросов · /мин · с ЧЧ:ММ»', await P.waitFor('document.querySelector(".top .mrun")?.textContent.includes("полный проход идёт")'), await P.text('.top .mrun'))
  await sleep(4500) // опрос страницы раз в 4 с: ход в шапке должен показать числа
  const hdr = await P.text('.top .mrun')
  must('шапка: числа хода (N из M, запросов, /мин)', /\d+ из 60/.test(hdr) && /\d+ запросов/.test(hdr) && /23\/мин/.test(hdr), hdr)
  must('шапка: фаза словами (не projects/relations/write)', /карточки \d+ из 60/.test(hdr) && !/projects|relations|write|comments/.test(hdr), hdr)
  must('во время прохода: в шапке кнопок зеркала нет; в «Служебном» «Обновить» («идёт…») и «Полный проход зеркала» недоступны', await b.ev(`(()=>{const bs=[...document.querySelectorAll('.top .mst button')];const sb=[...document.querySelectorAll('${SVC} button')];const r=sb.find(y=>y.textContent.trim()==='идёт…');const f=sb.find(y=>y.textContent.trim()==='Полный проход зеркала');return bs.length===0&&!!r&&r.disabled&&!!f&&f.disabled})()`), await b.ev(`[...document.querySelectorAll('.top .mst button, ${SVC} button')].map(x=>x.textContent.trim()+(x.disabled?'(выкл)':''))`))

  // повторный запуск во время прохода
  const n0 = actions().length
  const dupFull = await inst.api('POST', '/api/act', { action: 'mirror', kind: 'full' })
  const dupChanged = await inst.api('POST', '/api/act', { action: 'mirror', kind: 'changed' })
  must('повторный «полный» во время прохода → 409 mirror-running, без вопроса про цену', dupFull.status === 409 && dupFull.body.outcome === 'refused' && /уже идёт/.test(dupFull.body.message), dupFull)
  must('повторный «обычный» во время прохода → 409', dupChanged.status === 409 && dupChanged.body.outcome === 'refused', dupChanged)
  const dl = actions().slice(n0)
  must('журнал нажатий: на каждый повтор пара asked+refused(mirror-running), второго запуска нет', dl.length === 4 && dl.filter((l) => l.step === 'asked').length === 2 && dl.filter((l) => l.step === 'refused' && l.refusal === 'mirror-running').length === 2 && spawns.length === 1 && runsLines().length === 1, { строки: dl.map((l) => `${l.step}${l.refusal ? ':' + l.refusal : ''}`), spawns: spawns.length, runs: runsLines().length })

  // ===== 2. Рестарт витрины во время прохода =====
  const pidBefore = fp.pid
  await b.close(); b = null // страница держит токен старого запуска
  await inst.close(); inst = null
  must('рестарт: витрина остановлена, проход дожил (node и wscript живы)', alive(pidBefore) && alive(wsPid), { node: alive(pidBefore), wscript: alive(wsPid) })
  await sleep(1500)
  inst = await startInstance()
  const run2 = await until(async () => { const m = await inst.mirror(); return m.running && Number.isFinite(m.cardsDone) ? m : null }, 15000, 500)
  must('после рестарта витрина снова видит ход (running, kind full, фаза, N из M, запросов)', !!run2 && run2.kind === 'full' && Number.isFinite(run2.requests) && !!run2.phase && run2.cardsTotal === TOTAL_CARDS, run2)
  must('после рестарта: тот же процесс (pid прохода не менялся), «конца» в runs.log ещё нет', fakePid()?.pid === pidBefore && runsLines().length === 1, { pid: fakePid()?.pid, runs: runsLines().length })
  const tab2 = procTable()
  const vis2 = visibleWindows(descendants(tab2, wsPid))
  must('после рестарта: окна у процесса прохода по-прежнему нет', vis2.length === 0, { видимых: vis2.length })
  b = await openBrowser()
  const P2 = pageApi(b)
  await P2.size(1280, 900); await P2.goto('#/'); await P2.view(1280, 'light')
  must('после рестарта: шапка показывает полный проход с числами', await P2.waitFor('document.querySelector(".top .mrun")?.textContent.includes("полный проход идёт")') && /\d+ из 60/.test(await P2.text('.top .mrun')), await P2.text('.top .mrun'))
  await openService(P2)
  must('после рестарта: в «Служебном» «Полный проход зеркала» недоступна, рядом «идёт — ход вверху»', await b.ev(`(()=>{const x=[...document.querySelectorAll('${SVC} button')].find(y=>y.textContent.trim()==='Полный проход зеркала');return !!x&&x.disabled})()`) && (await P2.text(SVC + ' .wtb')).includes('ход вверху'), await P2.text(SVC + ' .wtb'))
  await P2.shotAll('4-polnyj-idet')

  // дождаться конца
  const ended = await until(async () => { const m = await inst.mirror(); return m.running === false && m.lastRun ? m : null }, 150000, 1000)
  must('проход кончился: running false, lastRun с итогом', !!ended, ended)
  const rl2 = runsLines()
  const mEnd = rl2.map((l) => l.match(RUN_RE))
  must('runs.log: ровно «начало» и «конец» одного pid, «конец» — код 0, секунды, запросов (формат настоящего)', rl2.length === 2 && mEnd.every(Boolean) && mEnd[0][2] === 'начало' && mEnd[1][2] === 'конец' && mEnd[0][3] === mEnd[1][3] && mEnd[1][4] === '0' && Number(mEnd[1][5]) >= FULL_SECONDS - 3 && Number(mEnd[1][6]) > 1000, rl2)
  must('lastRun: kind full, код 0, секунды и запросы как в «конце», startedAt = «начало»', !!ended && ended.lastRun.kind === 'full' && ended.lastRun.code === 0 && ended.lastRun.seconds === Number(mEnd[1][5]) && ended.lastRun.requests === Number(mEnd[1][6]) && ended.lastRun.startedAt === mEnd[0][1] && ended.lastRun.endedAt === mEnd[1][1], ended?.lastRun)
  must('итог: lastFullOk обновлён (после «начала»), lastError нет', !!ended && Date.parse(ended.lastFullOk) > Date.parse(mEnd[0][1]) && ended.lastError === null, { lastFullOk: ended?.lastFullOk, lastError: ended?.lastError })
  const gone = await until(() => !alive(fp.pid) && !alive(wsPid), 10000, 500)
  must('после конца процессы прохода (node, wscript) ушли, run.lock снят', !!gone && !fs.existsSync(path.join(ENV.mdir, 'run.lock')), { node: alive(fp.pid), wscript: alive(wsPid), lock: fs.existsSync(path.join(ENV.mdir, 'run.lock')) })
  const doneLines = actions().filter((l) => l.action === 'mirror' && l.step === 'done')
  must('журнал нажатий: «запущено» одно (done), без error', doneLines.length === 1 && !actions().some((l) => l.action === 'mirror' && l.step === 'error'), actions().filter((l) => l.action === 'mirror').map((l) => l.step))
  await P2.goto('#/') // сигнала changed без start.mjs нет — страница перечитывается целиком
  must('шапка после конца: зелёный итог «итог · полный · … · запросов»', await P2.waitFor('document.querySelector(".top .mres")'), await P2.text('.top .mst'))
  await P2.shotAll('5-polnyj-itog')

  // красный случай: обычный проход со сбоем (код 5) — итог красный, lastRun.code 5
  ENV.setFake({ seconds: 6, total: TOTAL_CARDS, exit: 5, error: 'подменный сбой пробы ПТ8: нет доступа к Plane' })
  await openService(P2)
  must('«Обновить» в «Служебном» (обычный проход со сбоем): нажата', await P2.btn('Обновить', `document.querySelector('${SVC}')`), null)
  const bad = await until(async () => { const m = await inst.mirror(); return m.running === false && m.lastRun?.kind === 'changed' ? m : null }, 40000, 800)
  must('сбойный проход: lastRun changed код 5, lastError словами', !!bad && bad.lastRun.code === 5 && /подменный сбой/.test(bad.lastError ?? ''), bad && { lastRun: bad.lastRun, lastError: bad.lastError })
  await P2.goto('#/')
  must('шапка: красный итог с причиной', await P2.waitFor('document.querySelector(".top .mbtn-note")?.textContent.includes("красный")'), await P2.text('.top .mbtn-note'))
  await P2.shotAll('6-itog-krasnyj')
  ENV.setFake({ seconds: FULL_SECONDS, total: TOTAL_CARDS, exit: 0 })

  // ===== 3. «Пересобрать индекс» =====
  const idxFile = path.join(ENV.indexDir, 'journals.json')
  const beforeStat = fs.statSync(idxFile)
  const beforeIdx = JSON.parse(fs.readFileSync(idxFile, 'utf8'))
  const M = Object.keys(beforeIdx.files).length
  must('индекс до: журналов 31 (29 сессий + два субагента)', M === 31, { M, mtime: new Date(beforeStat.mtimeMs).toISOString() })
  // папку индекса убираем (unlinkSync/rmdirSync): после пересбора она должна появиться заново
  for (const n of fs.readdirSync(ENV.indexDir)) fs.unlinkSync(path.join(ENV.indexDir, n))
  fs.rmdirSync(ENV.indexDir)
  must('папки индекса нет (убрана пробой)', !fs.existsSync(ENV.indexDir), null)
  const aBefore = actions().length
  slow.on = true
  await P2.goto('#/')
  await P2.waitFor('document.querySelector("details[aria-label=\\"Служебное\\"]")')
  await b.ev(`(()=>{const d=document.querySelector('details[aria-label="Служебное"]');if(d&&!d.open)d.querySelector('summary').click()})()`)
  await sleep(400)
  const t1 = Date.now()
  must('«Пересобрать индекс»: нажата', await P2.btn('Пересобрать индекс'), null)
  // второй запрос во время: тот же набор, что отправила бы вторая вкладка
  await sleep(1200)
  const second = await inst.api('POST', '/api/act', { action: 'reindex' })
  must('второй запрос во время пересбора → 409 reindex-running («уже идёт»)', second.status === 409 && second.body.outcome === 'refused' && /уже пересобирается/.test(second.body.message), second)
  const seq = []
  let shotsDone = false
  const t2 = Date.now()
  for (;;) {
    const m = await inst.mirror()
    const r = m.reindex
    seq.push([r.running, r.done, r.total])
    if (!shotsDone && r.running && r.done >= 3 && r.done < 12) {
      must('шапка блока «Служебное»: «пересобираю: N из 31 журналов», кнопка «идёт…» недоступна', await P2.waitFor('document.querySelector("details[aria-label=\\"Служебное\\"]")?.textContent.includes("из 31 журналов")', 8000) && await b.ev(`(()=>{const x=[...document.querySelectorAll('details[aria-label="Служебное"] button')].find(y=>y.textContent.trim()==='идёт…');return !!x&&x.disabled})()`), await P2.text('details[aria-label="Служебное"] .wtb'))
      await P2.shotAll('7-reindex-idet')
      shotsDone = true
    }
    if (!r.running && r.lastAt) break
    if (Date.now() - t2 > 120000) break
    await sleep(600)
  }
  slow.on = false
  const fin = (await inst.mirror()).reindex
  const prog = seq.filter((x) => x[0]).map((x) => x[1])
  must('ход «N из M журналов»: total 31, done растёт без откатов, видны промежуточные значения', seq.filter((x) => x[0]).every((x) => x[2] === 31 || x[2] === null) && prog.every((v, i) => i === 0 || v >= prog[i - 1]) && prog.some((v) => v > 0 && v < 31) && new Set(prog).size >= 6, { замеров: seq.length, уникальных: new Set(prog).size, первые: prog.slice(0, 4), последние: prog.slice(-3) })
  must('итог пересбора: running false, lastFiles 31, lastError нет, lastMs ≥ 20 с (медленное чтение)', fin.running === false && fin.lastFiles === 31 && fin.lastError === null && fin.lastMs >= 20000, fin)
  const aft = fs.existsSync(idxFile) ? fs.statSync(idxFile) : null
  const newIdx = aft ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : null
  must('папка data/…/index пересоздана: journals.json есть, исправный JSON, 31 журнал, mtime новее нажатия и прежнего, тот же отпечаток', !!aft && aft.mtimeMs > t1 && aft.mtimeMs > beforeStat.mtimeMs && Object.keys(newIdx.files).length === 31 && newIdx.fp === beforeIdx.fp, aft && { mtime: new Date(aft.mtimeMs).toISOString(), files: Object.keys(newIdx.files).length })
  must('в папке индекса нет временных файлов', !fs.readdirSync(ENV.indexDir).some((n) => n.endsWith('.tmp')), fs.readdirSync(ENV.indexDir))
  const ad = actions().slice(aBefore)
  const byId = (id) => ad.filter((l) => l.id === id).map((l) => l.step)
  const ids = [...new Set(ad.map((l) => l.id))]
  must('журнал нажатий за пересбор: две записи действия — первая asked→done, вторая одна пара asked/refused(reindex-running), error нет, пачки нет (всего 4 строки)',
    ad.length === 4 && ids.length === 2 && JSON.stringify(byId(ids[0])) === '["asked","done"]' && JSON.stringify(byId(ids[1])) === '["asked","refused"]' && ad.find((l) => l.step === 'refused').refusal === 'reindex-running' && !ad.some((l) => l.step === 'error') && ad.every((l) => l.action === 'reindex'),
    ad.map((l) => `${l.id.slice(-4)}:${l.step}${l.refusal ? ':' + l.refusal : ''}`))
  await P2.goto('#/')
  await b.ev(`(()=>{const d=document.querySelector('details[aria-label="Служебное"]');if(d&&!d.open)d.querySelector('summary').click()})()`)
  must('блок «Служебное» после: «пересобран … 31 журнал», кнопка снова доступна', await P2.waitFor('document.querySelector("details[aria-label=\\"Служебное\\"]")?.textContent.includes("пересобран")') && /31 журнал/.test(await P2.text('details[aria-label="Служебное"] .wtb')), await P2.text('details[aria-label="Служебное"] .wtb'))
  await P2.shotAll('8-reindex-gotov')

  // красный случай: сбой чтения журнала — отказ, прежний индекс цел, строка error в журнале нажатий, на экране «не удалось»
  const goodBytes = fs.readFileSync(idxFile, 'utf8')
  slow.breakAt = `${uuid(105)}.jsonl`
  const aB2 = actions().length
  must('сбойный пересбор: «Пересобрать индекс» нажата', await P2.btn('Пересобрать индекс'), null)
  const bad2 = await until(async () => { const r = (await inst.mirror()).reindex; return !r.running && r.lastError ? r : null }, 60000, 500)
  slow.breakAt = null
  must('сбойный пересбор: lastError EIO, индекс прежний (подмены нет)', !!bad2 && bad2.lastError === 'EIO' && fs.readFileSync(idxFile, 'utf8') === goodBytes, bad2)
  const ad2 = actions().slice(aB2)
  must('сбойный пересбор: журнал нажатий asked→done и error с кодом EIO', ad2.some((l) => l.step === 'done') && ad2.some((l) => l.step === 'error' && l.result?.code === 'EIO'), ad2.map((l) => `${l.step}${l.result?.code ? ':' + l.result.code : ''}`))
  await P2.goto('#/')
  await b.ev(`(()=>{const d=document.querySelector('details[aria-label="Служебное"]');if(d&&!d.open)d.querySelector('summary').click()})()`)
  must('экран: «не удалось пересобрать: EIO» красным', await P2.waitFor('document.querySelector("details[aria-label=\\"Служебное\\"] .wtb .pbad")?.textContent.includes("не удалось пересобрать")'), await P2.text('details[aria-label="Служебное"] .wtb'))
  await P2.shotAll('9-reindex-sboj')
  check('горизонтальная прокрутка страницы на 400, px', await (async () => { await P2.size(400, 900); return P2.overflowX() })())
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
} finally {
  // уборка: только своё. Браузер — по своему pid (дерево); обёртки зеркала — по pid из цепочки родителей, если проход не дошёл до конца
  if (b) await b.close()
  for (const pid of kill) if (alive(pid)) { log(`снимаю обёртку зеркала pid ${pid} (цепочка: потомок процесса пробы ${process.pid})`); try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушла */ } }
  if (inst) await inst.close().catch(() => {})
  await sleep(800)
  for (const d of TMP_DIRS) { try { removeTree(d) } catch (e) { log(`не убрана ${d}: ${e.code ?? e.message}`) } }
  S.tmpLeft = TMP_DIRS.filter((d) => fs.existsSync(d))
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, alive(p)]))
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог — summary.json; проверок с ожиданием не так: ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; временных папок осталось: ${S.tmpLeft.length}; живы: ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length || S.tmpLeft.length ? 1 : 0)
