// Проба EXT-83, такт 2: вид «Рабочих копий» и второго щелчка уборки на тестовом экземпляре этой копии.
// Устройство — как probe/ext77-drive.mjs: экземпляр витрины в этом же процессе, свой порт (4398), ВРЕМЕННЫЕ репозитории в os.tmpdir
// (git init, `git worktree add`), временная доска и реестр; настоящие копии машины в списке не появляются. Страница — настоящая web/dist.
// Браузер — headless Chrome со своим --user-data-dir, CDP. Нажимается «убрать годные» → окно подтверждения → «убрать N» (только на временных копиях).
//   node probe/ext83-shots.mjs <папка-для-снимков> [chrome.exe]
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
import { mkRepo, addWt, G, mkJunction, emptySessions } from '../test/ext83-harness.mjs'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4398
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext83-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { checks: {}, shots: [], fails: [], pids: {}, requests: [] }
const must = (k, ok, v) => { S.checks[k] = v; log(`${ok ? 'ок' : 'НЕ ТАК'} ${k}: ${JSON.stringify(v)}`); if (!ok) S.fails.push(k) }

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href)
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href)
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href)
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href)

function removeTree(dir) { // только unlink/rmdir; ссылки — сами, не рекурсивно
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of names) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) { try { fs.unlinkSync(p) } catch { try { fs.rmdirSync(p) } catch { /* нет */ } } continue }
    if (e.isDirectory()) removeTree(p)
    else { try { fs.chmodSync(p, 0o666) } catch { /* нет */ } try { fs.unlinkSync(p) } catch { /* занят — останется в отчёте */ } }
  }
  try { fs.rmdirSync(dir) } catch { /* останется в отчёте */ }
}
const TMP = []
const mk = (prefix) => { const d = tmpDir(prefix); TMP.push(d); return d }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// ---------- временные репозитории и копии: выдуманные имена ----------
const r = mkRepo(); TMP.push(r.root)
const car = mkRepo('carmain'); TMP.push(car.root)
const w = {
  done1: addWt(r, 'ext-501-lenta', { commits: 1, merge: true }),
  done2: addWt(r, 'ext-507-filtr', { commits: 1, merge: true }),
  fresh: addWt(r, 'ext-502-novaya'),
  dirty: addWt(r, 'ext-503-pravki', { commits: 1, merge: true }),
  unmerged: addWt(r, 'ext-504-v-rabote', { commits: 1 }),
  env: addWt(r, 'ext-505-nastroyki', { commits: 1, merge: true }),
  locked: addWt(r, 'ext-506-zapert', { commits: 1, merge: true }),
  link: addWt(r, 'ext-508-ssylka', { commits: 1, merge: true }),
}
const carDone = addWt(car, 'car-1-gotovo', { commits: 1, merge: true })
fs.writeFileSync(path.join(w.dirty, 'new.txt'), 'x')
fs.writeFileSync(path.join(w.env, '.env'), 'ПРИМЕР=пустышка') // выдуманное содержимое
G(r.main, 'worktree', 'lock', w.locked)
const target = mk('ext83-linkto-')
fs.mkdirSync(path.join(w.link, 'node_modules'), { recursive: true })
mkJunction(target, path.join(w.link, 'node_modules', 'pakiet-svyaz'))
const status = { 'EXT-501': 'done', 'EXT-502': 'in-progress', 'EXT-503': 'done', 'EXT-504': 'done', 'EXT-505': 'cancelled', 'EXT-506': 'done', 'EXT-507': 'done', 'EXT-508': 'done', 'CAR-1': 'done' }

const boardDir = makeBoard(mk('ext83-board-'), { codes: ['EXT', 'CAR'], cards: Object.entries(status).map(([id, st]) => ({ id, status: st, title: 'Пример' })) })
gitInitCommit(boardDir)
const mdir = path.join(boardDir, '.mirror'); fs.mkdirSync(mdir); fs.writeFileSync(path.join(mdir, 'index.json'), '{}')
fs.writeFileSync(path.join(mdir, 'status.json'), JSON.stringify({ at: new Date().toISOString(), kind: 'changed', lastOk: new Date().toISOString() }))
fs.mkdirSync(path.join(boardDir, 'tools')); fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '')
const regFile = path.join(mk('ext83-reg-'), 'registry.json')
fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [r.main] }, CAR: { projects: [], project_cards: [], repos: [car.main] } } }))
const data = mk('ext83-data-')
const iso = (d) => d.toISOString()

const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
await board.init()
const journals = createJournalReader({ root: mk('ext83-journals-'), indexDir: path.join(data, 'index'), indexWriteEveryS: 0 })
await journals.refresh({ full: true })
const threads = { list: () => ({ threads: [], waiting: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: iso(new Date()) }, desktop: null }) }
// cacheMs 500: кэш ручки 30 с после уборки показывает убранные копии как годные (замечание Терминусу); на снимках — короткий
const app = await buildApp({ port: PORT, board, registry: createRegistryReader(regFile), scan, webDir: path.join(REPO, 'web', 'dist'), threads, journals, sessionsDir: emptySessions(),
  pult: { enabled: true, words: false, bell: false, actionsLog: path.join(data, 'actions.log'), mirrorDir: mdir, lock: lockLib, boardRoot: boardDir },
  pultSeams: { worktrees: { cacheMs: 500 } } })
await app.listen({ host: '127.0.0.1', port: PORT })

const httpReq = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
async function openBrowser() {
  const dir = mk('ext83-chrome-')
  const dbg = 9300 + Math.floor(Math.random() * 400)
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${dbg}`, `--user-data-dir=${dir}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  S.pids.chromeRoot = child.pid; log(`chrome pid ${child.pid}, user-data-dir ${dir}`)
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
  return { call, ev, close: async () => { try { ws.close() } catch { /* нет */ } try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } } }
}

const BASE = `http://127.0.0.1:${PORT}`
const BLK = 'details[aria-label="Рабочие копии"]'
let b = null
try {
  b = await openBrowser()
  const size = (wd, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: wd, height: h, deviceScaleFactor: 1, mobile: wd < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  const goto = async (hash) => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await waitFor('document.querySelector(".top")', 10000) }
  const theme = (n) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(n)})?.click()`)
  const btn = (label) => b.ev(`(()=>{const x=[...document.querySelector('${BLK}').querySelectorAll('button')].find(y=>y.textContent.trim().startsWith(${JSON.stringify(label)})&&!y.disabled);if(!x)return false;x.click();return true})()`)
  const text = (sel) => b.ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x=>x.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`)
  const openBlock = () => b.ev(`(()=>{const d=document.querySelector('${BLK}');if(d&&!d.open)d.querySelector('summary').click()})()`)
  const rect = () => b.ev(`(()=>{const e=document.querySelector('${BLK}').getBoundingClientRect();return {x:e.left+scrollX,y:e.top+scrollY,w:e.width,h:e.height}})()`)
  const shot = async (name, wd, th) => { // снимок блока «Рабочие копии» с полями
    await size(wd); await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350)
    const a = await rect()
    await size(wd, Math.ceil(a.y + a.h + 40)); await sleep(300)
    const rr = await rect()
    const x = await b.call('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, rr.x - 8), y: Math.max(0, rr.y - 8), width: Math.min(wd, rr.w + 16), height: rr.h + 16, scale: 1 } })
    const f = path.join(SHOTS, `${wd}-${th}-${name}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
    await size(wd)
  }
  const COMBOS = [[1280, 'light'], [1280, 'dark'], [400, 'light'], [400, 'dark']]
  const rowsNow = () => b.ev(`[...document.querySelectorAll('${BLK} .wt')].map(x=>x.textContent.replace(/\\s+/g,' ').trim())`)

  await size(1280); await goto('#/'); await theme('Светлая')
  must('«Рабочие копии» на «Цехе»: блок есть', await waitFor(`document.querySelector('${BLK} .wt') || document.querySelector('${BLK}')`, 15000), await text(`${BLK} summary`))
  await openBlock(); await waitFor(`document.querySelector('${BLK} .wt')`, 10000); await sleep(400)
  const rows0 = await rowsNow()
  must('«Цех»: 9 копий (8 EXT + 1 CAR), настоящих копий машины нет', rows0.length === 9 && !rows0.some((t) => /extractor/.test(t)), rows0)
  must('заголовок: 9 копий, годны 3', /Рабочие копии\s*9.*годны к уборке: 3/.test(await text(`${BLK} summary`)), await text(`${BLK} summary`))

  // первый щелчок → окно подтверждения со списком сервера
  must('первый щелчок: «убрать годные: 3» нажата', await btn('убрать годные'), null)
  must('окно подтверждения со списком', await waitFor(`document.querySelector('${BLK} .cfm dl')`, 8000), await text(`${BLK} .cfm`))
  must('первый щелчок ничего не убрал', fs.existsSync(w.done1) && fs.existsSync(w.done2) && fs.existsSync(carDone), null)
  for (const [wd, th] of COMBOS) await shot('1-spisok-okno', wd, th)

  // второй щелчок → итог
  await size(1280); await theme('Светлая')
  must('второй щелчок: «убрать 3» нажата', await btn('убрать 3'), null)
  must('итог «убрано 3, пропущено 0»', await waitFor(`/убрано 3, пропущено 0/.test(document.querySelector('${BLK}').textContent)`, 20000), await text(`${BLK} .wtb`))
  await sleep(5000) // второе чтение страницы — через 3 с после итога
  const after = await rowsNow()
  must('убранные строки пропали (остались 6 негодных), папки убраны, грязная цела', after.length === 6 && !fs.existsSync(w.done1) && !fs.existsSync(w.done2) && !fs.existsSync(carDone) && fs.existsSync(w.dirty), after)
  must('кнопки «убрать годные» больше нет (годных 0)', !(await btn('убрать годные')), null)
  for (const [wd, th] of COMBOS) await shot('2-itog', wd, th)

  // окно проекта: свои репозитории (EXT) — блок есть, ?project= в запросе
  await goto('#/project/EXT'); await theme('Светлая'); await sleep(400)
  must('окно проекта EXT: блок «Рабочие копии» есть', await waitFor(`document.querySelector('${BLK}')`, 10000), null)
  await openBlock(); await waitFor(`document.querySelector('${BLK} .wt')`, 10000); await sleep(300)
  must('окно проекта: 6 строк своих копий', (await rowsNow()).length === 6, await rowsNow())
  must('запрос с ?project=EXT', (S.requests = await b.ev("performance.getEntriesByType('resource').map(e=>new URL(e.name).pathname+new URL(e.name).search).filter(u=>/worktrees/.test(u))")).includes('/api/worktrees?project=EXT'), S.requests)
  await size(400); must('400: горизонтальной прокрутки нет', (await b.ev('document.documentElement.scrollWidth - window.innerWidth')) <= 0, null)
  await shot('3-proekt-ext', 1280, 'light'); await shot('3-proekt-ext', 400, 'dark')
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  if (b) await b.close()
  await app.close().catch(() => {})
  await sleep(800)
  try { fs.unlinkSync(path.join(w.link, 'node_modules', 'pakiet-svyaz')) } catch { try { fs.rmdirSync(path.join(w.link, 'node_modules', 'pakiet-svyaz')) } catch { /* нет */ } } // саму ссылку
  try { G(r.main, 'worktree', 'unlock', w.locked) } catch { /* нет */ }
  for (const d of TMP) removeTree(d)
  S.tmpLeft = TMP.filter((d) => fs.existsSync(d))
  S.alive = Object.fromEntries(Object.entries(S.pids).map(([k, p]) => [k, alive(p)]))
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; временных папок осталось ${S.tmpLeft.length}; живы ${JSON.stringify(S.alive)}`)
process.exit(S.error || S.fails.length ? 1 : 0)
