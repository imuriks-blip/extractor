// Проба EXT-77, дозапрос (слово Ивана 06.10 «го, сливай EXT-77 с подсказкой»): строка (а) «Тред ждёт ответа», которой
// ответить можно только в окне десктопа (kind askUserQuestion, permission), — подсказка «ждёт тебя в десктопе — ответь там»
// на месте «Ответить», на «Цехе» и в окне проекта; отрицательный контроль — вопрос в чате (kind question): «Ответить» есть,
// подсказки нет. Спека пульта §2.4: при waiting Иван видит «тред ждёт тебя в десктопе: ответь там».
// Устройство — как у probe/pt7-drive.mjs: тестовый экземпляр витрины этой копии в том же процессе, свой порт, своя data во
// временной папке, временная доска, выдуманные треды (waitingThreads из lib/waiting.mjs — те же строки, что на живой).
// Ничего не нажимается: проверяется только вид. Страница — настоящая web/dist (собрать заранее: npm --prefix web run build).
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; снимки только своих окон.
//   node probe/ext77-desktop-hint.mjs <папка-для-снимков> [chrome.exe]
// Охранник: из папки живой витрины и на порту 4317 — отказ до любой записи.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../lib/app.mjs'
import { createBoardReader } from '../lib/board-reader.mjs'
import { createGitRead } from '../lib/git-read.mjs'
import { createRegistryReader } from '../lib/registry.mjs'
import { waitingThreads } from '../lib/waiting.mjs'
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4398
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext77-hint-shots'))
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
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href)

const HINT = 'ждёт тебя в десктопе — ответь там'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T = Date.now()
const min = (n) => new Date(T - n * 60000)
const iso = (d) => d.toISOString()
const SID = { q: uuid(11), ask: uuid(12), perm: uuid(13) }
const ROW = { q: 'EXT · пульт', ask: 'EXT · план', perm: 'INFRA · бэкапы' }

const TMP_DIRS = []
const mk = (prefix) => { const d = tmpDir(prefix); TMP_DIRS.push(d); return d }
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
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const thread = (sid, o = {}) => ({ sessionId: sid, title: 'тред', project: null, projectBy: 'title', card: null, state: 'idle', lastSeenAt: iso(min(1)), since: iso(min(60)), sinceKind: 'open', subagents: [], marks: [], ...o })

async function startInstance() {
  const boardDir = makeBoard(mk('ext77h-board-'), { codes: ['EXT', 'INFRA'], cards: [
    { id: 'EXT-77', status: 'in-progress', title: 'Обновить — из шапки в Служебное' },
    { id: 'INFRA-80', status: 'in-progress', title: 'Перенос бэкапов на второй диск' },
  ] })
  gitInitCommit(boardDir)
  fs.mkdirSync(path.join(boardDir, '.mirror'))
  fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
  fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: iso(min(300)), lastOk: iso(min(300)) }))
  fs.mkdirSync(path.join(boardDir, 'tools'))
  fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка пробы\n')
  const regFile = path.join(mk('ext77h-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: Object.fromEntries(['EXT', 'INFRA'].map((c) => [c, { projects: [], project_cards: [], repos: [] }])) }))
  const data = mk('ext77h-data-')
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(regFile)
  const live = [
    thread(SID.q, { title: ROW.q, project: 'EXT', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(min(14)) }),
    thread(SID.ask, { title: ROW.ask, project: 'EXT', state: 'waiting', waitingKind: 'askUserQuestion', statusUpdatedAt: iso(min(9)) }),
    thread(SID.perm, { title: ROW.perm, project: 'INFRA', state: 'waiting', waitingKind: 'permission', statusUpdatedAt: iso(min(5)) }),
  ]
  const sessions = [
    { sessionId: SID.q, lines: 10, thread: { q: { text: 'Верстаем по варианту Б или ждём твоего выбора?', uuid: uuid(21), at: iso(min(14)) } } },
    { sessionId: SID.ask, lines: 10, thread: { ask: { text: 'Какой вариант плана берём: короткий или полный?', uuid: uuid(22), at: iso(min(9)) }, askOpen: true } },
  ]
  const threadsApi = {
    list: () => ({ threads: live, waiting: waitingThreads({ threads: live, sessions, now: Date.now() }), subagentsCount: 0, unknownStatus: {} }),
    state: () => ({ processes: { lastOkAt: iso(min(0)) }, desktop: null }) }
  const journals = { state: () => ({ lastOkAt: iso(min(0)) }), sessions: () => sessions }
  const spawnStub = () => { const ch = new EventEmitter(); ch.pid = 9100; ch.unref = () => {}; process.nextTick(() => ch.emit('spawn')); return ch }
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: path.join(REPO, 'web', 'dist'), threads: threadsApi, journals,
    pult: { enabled: true, words: true, bell: true, bellDir: path.join(data, 'bell'), actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir },
    pultSeams: { spawn: spawnStub } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const ceh = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/api/ceh`, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject)
  })
  return { ceh, close: () => app.close() }
}

const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = mk('ext77h-chrome-')
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

const BASE = `http://127.0.0.1:${PORT}`
const COMBOS = [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]
function pageApi(b) {
  const P = {}
  P.size = (w, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  P.waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  P.goto = async (hash = '#/') => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await P.waitFor('document.querySelector(".top")', 10000) }
  P.theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  P.view = async (w, theme) => { await P.size(w); await P.theme(theme === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350) }
  P.shot = async (name, w, theme) => {
    const h = Math.min(3200, Math.max(700, await b.ev('document.documentElement.scrollHeight')))
    await P.size(w, h); await sleep(300)
    const r = await b.call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${theme}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    S.shots.push(f); log(`снимок ${f}`)
    await P.size(w)
  }
  P.shotAll = async (name) => { for (const [w, th] of COMBOS) { await P.view(w, th); await P.shot(name, w, th) } }
  // строка (а) по названию треда: «Цех» — .wrow с .src[title], окно проекта — .prow[title]; кнопки, подсказка, её шрифт и цвет
  // против соседней пометки строки («ждёт больше суток» нет — сравнение с текстом давности .age того же ряда)
  P.row = (title) => b.ev(`(()=>{const t=${JSON.stringify(title)};
    const el=[...document.querySelectorAll('.wrow')].find(r=>r.querySelector('.src')?.getAttribute('title')===t)
      ?? (()=>{const p=[...document.querySelectorAll('.prow')].find(r=>r.getAttribute('title')===t);return p?(p.closest('.pwr')??p):null})();
    if(!el)return null;
    const h=[...el.querySelectorAll('.mline')].find(x=>x.textContent.trim()===${JSON.stringify(HINT)});
    const cs=h?getComputedStyle(h):null;const age=el.querySelector('.age');const ca=age?getComputedStyle(age):null;
    return {buttons:[...el.querySelectorAll('button')].filter(x=>!x.closest('.dmenu')).map(x=>x.textContent.trim()).filter(Boolean),hint:!!h,
      hintFont:cs?.fontSize??null,hintColor:cs?.color??null,ageColor:ca?.color??null}})()`)
  P.overflowX = () => b.ev('document.documentElement.scrollWidth - window.innerWidth')
  return P
}

let inst = null
let b = null
try {
  log(`снимки: ${SHOTS}; порт ${PORT}`)
  inst = await startInstance()
  const api = await inst.ceh()
  const kinds = Object.fromEntries((api.waiting?.threads ?? []).map((r) => [r.title, r.kind]))
  must('/api/ceh → waiting.threads[].kind: question, askUserQuestion, permission', kinds[ROW.q] === 'question' && kinds[ROW.ask] === 'askUserQuestion' && kinds[ROW.perm] === 'permission', kinds)
  b = await openBrowser()
  const P = pageApi(b)
  await P.size(1280); await P.goto('#/'); await P.view(1280, 'light')
  await P.waitFor(`[...document.querySelectorAll('.wrow .src')].some(x=>x.getAttribute('title')===${JSON.stringify(ROW.perm)})`, 10000)

  for (const w of [1280, 400]) {
    await P.view(w, 'light')
    const q = await P.row(ROW.q)
    const ask = await P.row(ROW.ask)
    const perm = await P.row(ROW.perm)
    must(`${w} «Цех»: askUserQuestion — подсказка есть, «Ответить» нет, «Отложить» есть`, !!ask && ask.hint && !ask.buttons.includes('Ответить') && ask.buttons.includes('Отложить'), ask)
    must(`${w} «Цех»: permission — подсказка есть, «Ответить» нет`, !!perm && perm.hint && !perm.buttons.includes('Ответить'), perm)
    must(`${w} «Цех»: контроль — question: «Ответить» есть, подсказки нет`, !!q && !q.hint && q.buttons.includes('Ответить'), q)
    must(`${w} «Цех»: подсказка 12px, цветом давности строки (приглушённый)`, ask?.hintFont === '12px' && ask.hintColor === ask.ageColor, ask && { font: ask.hintFont, color: ask.hintColor, age: ask.ageColor })
  }
  await P.shotAll('1-ceh')

  await P.goto('#/project/EXT'); await P.view(1280, 'light')
  await P.waitFor(`document.querySelector('.prow[title=${JSON.stringify(ROW.ask)}]')`, 10000)
  for (const w of [1280, 400]) {
    await P.view(w, 'light')
    const q = await P.row(ROW.q)
    const ask = await P.row(ROW.ask)
    must(`${w} окно проекта: askUserQuestion — подсказка есть, «Ответить» нет`, !!ask && ask.hint && !ask.buttons.includes('Ответить'), ask)
    must(`${w} окно проекта: контроль — question: подсказки нет`, !!q && !q.hint, q)
    must(`${w} окно проекта: подсказка 12px, цветом давности строки`, ask?.hintFont === '12px' && ask.hintColor === ask.ageColor, ask && { font: ask.hintFont, color: ask.hintColor, age: ask.ageColor })
  }
  await P.shotAll('2-proekt-EXT')
  await P.size(400)
  must('400: горизонтальной прокрутки нет', (await P.overflowX()) <= 0, await P.overflowX())
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
} finally {
  if (b) await b.close() // браузер — по своему pid, деревом
  if (inst) await inst.close().catch(() => {})
  await sleep(800)
  for (const d of TMP_DIRS) { try { removeTree(d) } catch (e) { log(`не убрана ${d}: ${e.code ?? e.message}`) } }
  S.tmpLeft = TMP_DIRS.filter((d) => fs.existsSync(d))
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, alive(p)]))
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог — summary.json; проверок с ожиданием не так: ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; временных папок осталось: ${S.tmpLeft.length}; живы: ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length || S.tmpLeft.length ? 1 : 0)
