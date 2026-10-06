// Проба EXT-77: «Обновить» из шапки в «Служебное» на «Цехе» (слово Ивана 06.10 «перенеси кнопку обновить в служебное»).
// Проверяет вид и путь нажатия: в шапке ни одной кнопки прохода (покой, проход идёт, итог; «Цех» и окно проекта); «Служебное» —
// три строки по порядку «Обновить», «Полный проход зеркала», «Пересобрать индекс»; нажатие «Обновить» в «Служебном» запускает
// обычный проход (--changed) один раз, ход виден в шапке (и в окне проекта), строка «Обновить» — «зеркало идёт — ход вверху»,
// обе кнопки зеркала недоступны; после конца — итог в шапке.
// Устройство — как у probe/pt8-drive.mjs: тестовый экземпляр витрины этой копии в том же процессе, свой порт, своя data во
// временной папке, ВРЕМЕННАЯ доска с копией настоящего tools/mirror-hidden.js (только прочитан) и подменным tools/mirror.mjs
// (probe/pt8-fake-mirror.mjs: в Plane не ходит). Страница — настоящая web/dist (собрать заранее: npm --prefix web run build).
// Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; снимки только своих окон.
//   node probe/ext77-drive.mjs <папка-для-снимков> [chrome.exe]
// Проверки с ожиданием (must): не так — код 1. Охранник: из папки живой витрины и на порту 4317 — отказ до любой записи.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../lib/app.mjs'
import { createBoardReader } from '../lib/board-reader.mjs'
import { createGitRead } from '../lib/git-read.mjs'
import { createRegistryReader } from '../lib/registry.mjs'
import { createJournalReader } from '../lib/journal-reader.mjs'
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4397
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext77-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const REAL_HIDDEN = 'C:/projects/unorbis-board/tools/mirror-hidden.js' // только чтение: копия обёртки во временную доску
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
const RUN_SECONDS = 45
const TOTAL_CARDS = 40

// удаление дерева: только unlinkSync/rmdirSync (fs.rmSync на Windows с кириллицей молча не удаляет)
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
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// ---------- временная доска, журналы, экземпляр ----------
const ENV = (() => {
  const boardDir = makeBoard(mk('ext77-board-'), { codes: ['EXT', 'INFRA'], cards: [
    { id: 'EXT-77', status: 'in-progress', title: 'Обновить — из шапки в Служебное' },
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
  fs.writeFileSync(path.join(tools, 'fake-mirror.json'), JSON.stringify({ seconds: RUN_SECONDS, total: TOTAL_CARDS, exit: 0 }))
  const regFile = path.join(mk('ext77-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: Object.fromEntries(['EXT', 'INFRA'].map((c) => [c, { projects: [], project_cards: [], repos: [] }])) }))
  const jroot = mk('ext77-journals-') // журналов нет: проба про шапку и «Служебное»
  const data = mk('ext77-data-')
  return { boardDir, mdir, regFile, jroot, data, indexDir: path.join(data, 'index'), actionsFile: path.join(data, 'actions.log'), runsFile: path.join(mdir, 'runs.log') }
})()

const spawns = []
async function startInstance() {
  const board = createBoardReader({ root: ENV.boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(ENV.regFile)
  const journals = createJournalReader({ root: ENV.jroot, indexDir: ENV.indexDir, indexWriteEveryS: 0 })
  await journals.refresh({ full: true })
  const threads = { list: () => ({ threads: [], waiting: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: iso(new Date()) }, desktop: null }) }
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: path.join(REPO, 'web', 'dist'), threads, journals,
    pult: { enabled: true, words: false, bell: false, actionsLog: ENV.actionsFile, mirrorDir: ENV.mdir, lock: lockLib, boardRoot: ENV.boardDir },
    pultSeams: { spawn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return spawn(cmd, args, opts) } } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const mirror = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/api/mirror`, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject)
  })
  return { mirror, close: async () => { try { journals.flush() } catch { /* нет */ } await app.close() } }
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
  const dir = mk('ext77-chrome-')
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
const SVC = 'details[aria-label="Служебное"]'
function pageApi(b) {
  const P = {}
  P.size = (w, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  P.waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  P.goto = async (hash = '#/') => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await P.waitFor('document.querySelector(".top")', 10000) }
  // тема — кнопкой приложения в шапке, не атрибутом
  P.theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  P.btn = (text, scope = 'document') => b.ev(`(()=>{const x=[...${scope}.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(text)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.text = (sel) => b.ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x=>x.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`)
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
  P.overflowX = () => b.ev('document.documentElement.scrollWidth - window.innerWidth')
  // кнопки шапки (текст): должны быть только тема, «Словарь» и «?» (закрытые окна «Словаря» и «?» со своим «×» — не в счёт)
  P.headerButtons = () => b.ev(`[...document.querySelectorAll('.top button')].filter(x=>!x.closest('dialog')).map(x=>x.textContent.trim())`)
  P.serviceRows = () => b.ev(`[...document.querySelectorAll('${SVC} > .wtb')].map(r=>{const x=r.querySelector('button');return {btn:x?.textContent.trim()??null,off:!!x?.disabled,line:r.textContent.trim().replace(/\\s+/g,' ')}})`)
  P.openService = async () => { await P.waitFor(`document.querySelector('${SVC}')`); await b.ev(`(()=>{const d=document.querySelector('${SVC}');if(d&&!d.open)d.querySelector('summary').click()})()`); await sleep(300) }
  return P
}
const HEADER_OK = (bs) => bs.every((t) => ['Авто', 'Светлая', 'Тёмная', 'Словарь', '?'].includes(t))
const MIRROR_WORDS = ['Обновить', 'идёт…', 'запускаю…', 'Полный проход зеркала']

let inst = null
let b = null
const kill = [] // pid обёрток зеркала по цепочке родителей — на случай обрыва пробы
try {
  log(`снимки: ${SHOTS}; порт ${PORT}`)
  inst = await startInstance()
  b = await openBrowser()
  const P = pageApi(b)
  await P.size(1280); await P.goto('#/'); await P.view(1280, 'light')
  await P.waitFor('document.querySelector(".top .fresh")?.textContent.includes("зеркало")')

  // ===== 1. «Цех» в покое: в шапке время зеркала, кнопки прохода нет =====
  const hb0 = await P.headerButtons()
  must('покой «Цех»: в шапке только тема, «Словарь», «?» — кнопки прохода нет', HEADER_OK(hb0) && !hb0.some((t) => MIRROR_WORDS.includes(t)), hb0)
  must('покой «Цех»: время зеркала в шапке («зеркало Plane от …»)', /зеркало Plane от/.test(await P.text('.top .fresh')), await P.text('.top .fresh'))
  must('покой «Цех»: хода и итога в шапке нет (проходов не было)', !(await b.ev('!!document.querySelector(".top .mst")')), null)
  await P.shotAll('1-ceh-pokoy')

  // ===== 2. «Служебное»: три строки по порядку =====
  await P.openService()
  const rows0 = await P.serviceRows()
  must('«Служебное»: строки «Обновить», «Полный проход зеркала», «Пересобрать индекс» — по порядку, все доступны',
    JSON.stringify(rows0.map((r) => r.btn)) === '["Обновить","Полный проход зеркала","Пересобрать индекс"]' && rows0.every((r) => !r.off), rows0)
  await P.shotAll('2-sluzhebnoe')

  // ===== 3. Нажатие «Обновить» в «Служебном» =====
  await P.view(1280, 'light')
  must('«Обновить» в «Служебном»: нажата', await P.btn('Обновить', `document.querySelector('${SVC}')`), null)
  must('запуск один, обычный проход (--changed, не --full), скрытый (wscript, windowsHide)', !!(await until(() => spawns.length === 1, 8000)) && spawns[0].args.includes('--changed') && !spawns[0].args.includes('--full') && /wscript\.exe$/i.test(spawns[0].cmd) && spawns[0].opts.windowsHide === true,
    spawns.map((s) => ({ cmd: path.basename(s.cmd), changed: s.args.includes('--changed'), full: s.args.includes('--full'), windowsHide: s.opts.windowsHide })))
  const fp = await until(() => fakePid(), 15000)
  must('подменное зеркало стартовало (fake-pid.json), вид changed', !!fp && fp.kind === 'changed', fp && { pid: fp.pid, ppid: fp.ppid, kind: fp.kind })
  if (fp) { kill.push(fp.ppid); S.pids.mirrorNode = fp.pid; S.pids.mirrorWscript = fp.ppid }
  const ma = actions().filter((l) => l.action === 'mirror')
  must('журнал нажатий: «Обновить» — asked → done, вид changed, без второго щелчка', ma.some((l) => l.step === 'asked' && (l.kind ?? 'changed') === 'changed') && ma.some((l) => l.step === 'done') && !ma.some((l) => l.step === 'need-confirm'), ma.map((l) => `${l.step}${l.kind ? ':' + l.kind : ''}`))
  must('шапка: «зеркало идёт» с числами (N из M, запросов)', await P.waitFor('/\\d+ из 40/.test(document.querySelector(".top .mrun")?.textContent ?? "")', 15000), await P.text('.top .mrun'))
  const hb1 = await P.headerButtons()
  must('проход идёт: в шапке кнопки прохода нет', HEADER_OK(hb1) && !hb1.some((t) => MIRROR_WORDS.includes(t)), hb1)
  const rows1 = await P.serviceRows()
  must('проход идёт: «Обновить» → «идёт…» недоступна, рядом «зеркало идёт — ход вверху»; «Полный проход зеркала» недоступна; «Пересобрать индекс» доступна',
    rows1[0]?.btn === 'идёт…' && rows1[0].off && rows1[0].line.includes('зеркало идёт — ход вверху') && rows1[1]?.btn === 'Полный проход зеркала' && rows1[1].off && rows1[2]?.btn === 'Пересобрать индекс' && !rows1[2].off, rows1)
  await P.shotAll('3-prohod-idet')

  // ===== 4. Окно проекта во время прохода: ход в шапке, кнопки нет, «Служебного» нет =====
  await P.goto('#/project/EXT'); await P.view(1280, 'light')
  must('окно проекта: ход в шапке «зеркало идёт»', await P.waitFor('document.querySelector(".top .mrun")?.textContent.includes("зеркало идёт")', 10000), await P.text('.top .mrun'))
  const hb2 = await P.headerButtons()
  const all2 = await b.ev(`[...document.querySelectorAll('button')].map(x=>x.textContent.trim())`)
  must('окно проекта: в шапке кнопки прохода нет, на странице нет ни «Обновить», ни «Полный проход зеркала», «Служебного» нет',
    HEADER_OK(hb2) && !all2.some((t) => MIRROR_WORDS.includes(t)) && !(await b.ev(`!!document.querySelector('${SVC}')`)), { шапка: hb2, кнопокЗеркала: all2.filter((t) => MIRROR_WORDS.includes(t)) })
  await P.shotAll('4-proekt-idet')

  // ===== 5. Конец прохода: итог в шапке («Цех» и окно проекта), кнопка снова доступна в «Служебном» =====
  const ended = await until(async () => { const m = await inst.mirror(); return m.running === false && m.lastRun ? m : null }, (RUN_SECONDS + 40) * 1000, 1000)
  must('проход кончился: lastRun changed, код 0; runs.log — «начало» и «конец»', !!ended && ended.lastRun.kind === 'changed' && ended.lastRun.code === 0 && runsLines().length === 2, ended && { lastRun: ended.lastRun, runs: runsLines().length })
  await P.goto('#/project/EXT')
  must('окно проекта после конца: итог в шапке «итог · обычный · …», кнопки нет', await P.waitFor('document.querySelector(".top .mres")?.textContent.includes("итог · обычный")') && HEADER_OK(await P.headerButtons()), await P.text('.top .mst'))
  await P.shotAll('5-proekt-itog')
  await P.goto('#/')
  await P.openService()
  const rows2 = await P.serviceRows()
  must('«Цех» после конца: итог в шапке, «Обновить» в «Служебном» снова доступна', await P.waitFor('document.querySelector(".top .mres")') && rows2[0]?.btn === 'Обновить' && !rows2[0].off && HEADER_OK(await P.headerButtons()), { шапка: await P.text('.top .mst'), строки: rows2 })
  await P.shotAll('6-ceh-itog')
  await P.size(400)
  must('400: горизонтальной прокрутки нет', (await P.overflowX()) <= 0, await P.overflowX())
  must('после конца процессы прохода ушли', !!(await until(() => fp && !alive(fp.pid) && !alive(fp.ppid), 10000, 500)), fp && { node: alive(fp.pid), wscript: alive(fp.ppid) })
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
} finally {
  // уборка: только своё. Браузер — по своему pid (дерево); обёртка зеркала — по pid из цепочки (ppid подменного зеркала)
  if (b) await b.close()
  for (const pid of kill) if (alive(pid)) { log(`снимаю обёртку зеркала pid ${pid} (родитель подменного зеркала этой пробы)`); try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушла */ } }
  if (inst) await inst.close().catch(() => {})
  await sleep(800)
  for (const d of TMP_DIRS) { try { removeTree(d) } catch (e) { log(`не убрана ${d}: ${e.code ?? e.message}`) } }
  S.tmpLeft = TMP_DIRS.filter((d) => fs.existsSync(d))
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, alive(p)]))
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог — summary.json; проверок с ожиданием не так: ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; временных папок осталось: ${S.tmpLeft.length}; живы: ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length || S.tmpLeft.length ? 1 : 0)
