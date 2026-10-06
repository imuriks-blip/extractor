// Проба EXT-77, вердикт Голема на d2f9851 (Важно 1, решение дирижёра): исход «дотянуть» — всегда в шапке. «Принять» на
// карточке в Review получает отказ stale-status с pull (подменный plane.py отвечает «In Progress»), «дотянуть» запускает
// обычный проход, а запуск падает: во временной доске НЕТ tools/mirror-hidden.js (сервер — NO_LAUNCHER, ничего не запущено).
// Проверка — при свёрнутом и при раскрытом «Служебном»: пометка исхода видна в шапке, у строки «Обновить» её нет (двойного
// показа нет). Контроль: нажатие самой «Обновить» в раскрытом «Служебном» — пометка у строки, в шапке нет.
// Устройство — как у probe/pt7-drive.mjs: тестовый экземпляр витрины этой копии в том же процессе, свой порт, своя data во
// временной папке, временная доска, подменный plane.py (test/fake-plane.mjs через python = node — Plane не вызывается).
// Страница — настоящая web/dist (собрать заранее: npm --prefix web run build). Браузер — headless Chrome со своим
// --user-data-dir во временной папке, CDP; снимки только своих окон.
//   node probe/ext77-pull-drive.mjs <папка-для-снимков> [chrome.exe]
// Охранник: из папки живой витрины и на порту 4317 — отказ до любой записи.
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
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from '../test/helpers.mjs'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4399
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext77-pull-shots'))
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

const T = Date.now()
const min = (n) => new Date(T - n * 60000)
const iso = (d) => d.toISOString()
const head = (d) => `${iso(d).slice(0, 10)} ${iso(d).slice(11, 16)} +00:00`
const CARD = 'EXT-61'

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

const spawns = []
async function startInstance() {
  const boardDir = makeBoard(mk('ext77p-board-'), { codes: ['EXT'], cards: [{ id: CARD, status: 'review', title: 'Витрина: кнопка «Словарь» рядом с «?»' }] })
  fs.writeFileSync(path.join(boardDir, 'EXT', `${CARD}.log.md`), `### ${head(min(25))} · plane · коммент\n\nВетка готова, проверь экран.\n`)
  gitInitCommit(boardDir)
  fs.mkdirSync(path.join(boardDir, '.mirror'))
  fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
  fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: iso(min(300)), lastOk: iso(min(300)) }))
  fs.mkdirSync(path.join(boardDir, 'tools')) // mirror-hidden.js нарочно нет: запуск зеркала падает (NO_LAUNCHER)
  const regFile = path.join(mk('ext77p-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: { EXT: { projects: [], project_cards: [], repos: [] } } }))
  const data = mk('ext77p-data-')
  const pdir = mk('ext77p-plane-')
  fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
  // подменный Plane: карточка уже не в Review — «Принять» отказывает stale-status с pull («дотянуть?»)
  fs.writeFileSync(path.join(pdir, 'state.json'), JSON.stringify({ status: 'In Progress', title: 'Выдуманная карточка', comments: [{ id: 'q1', created_at: iso(min(300)), html: '<p>Старая запись</p>' }] }))
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(regFile)
  const threadsApi = { list: () => ({ threads: [], waiting: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: iso(min(0)) }, desktop: null }) }
  const journals = { state: () => ({ lastOkAt: iso(min(0)) }), sessions: () => [] }
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: path.join(REPO, 'web', 'dist'), threads: threadsApi, journals,
    pult: { enabled: true, words: false, bell: false, actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: (cmd, args) => { spawns.push({ cmd, args }); throw new Error('проба не запускает процессов') } } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const actions = () => (fs.existsSync(path.join(data, 'actions.log')) ? fs.readFileSync(path.join(data, 'actions.log'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { actions, close: () => app.close() }
}

const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = mk('ext77p-chrome-')
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
  P.rowBtn = (rowText, btnText) => b.ev(`(()=>{const r=[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes(${JSON.stringify(rowText)}));const x=r&&[...r.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(btnText)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.btn = (text, scope = 'document') => b.ev(`(()=>{const x=[...${scope}.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(text)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.setService = (open) => b.ev(`(()=>{const d=document.querySelector('${SVC}');if(d&&d.open!==${open})d.querySelector('summary').click();return !!d&&d.open})()`)
  // где видна пометка исхода нажатия зеркала: шапка (.top .mbtn-note, «зеркало: запускаю…», «пульт выключен») и строка «Обновить»
  // (первая .wtb «Служебного», красная .pbad)
  P.where = () => b.ev(`(()=>{const h=document.querySelector('.top .mbtn-note');const r=document.querySelector('${SVC} > .wtb');const rb=r?.querySelector('.pbad');
    return {header:h?.textContent.trim()??null,headerTitle:h?.getAttribute('title')??null,row:rb?.textContent.trim()??null,rowLine:r?.textContent.trim().replace(/\\s+/g,' ')??null,svcOpen:!!document.querySelector('${SVC}')?.open}})()`)
  return P
}
const NOTES = ['ошибка', 'отказ', 'нет связи']

let inst = null
let b = null
try {
  log(`снимки: ${SHOTS}; порт ${PORT}`)
  inst = await startInstance()
  b = await openBrowser()
  const P = pageApi(b)
  await P.size(1280); await P.goto('#/'); await P.view(1280, 'light')
  await P.waitFor(`[...document.querySelectorAll('.wrow')].some(x=>x.textContent.includes('${CARD}'))`, 10000)

  // «дотянуть» при данном состоянии «Служебного»: «Принять» → отказ с pull → «дотянуть» → запуск падает
  const pullOnce = async (open, tag) => {
    await P.setService(open); await sleep(300)
    const n0 = inst.actions().length
    must(`${tag}: «Принять» ${CARD} нажата`, await P.rowBtn(CARD, 'Принять'), null)
    must(`${tag}: отказ stale-status с «дотянуть»`, await P.waitFor(`[...document.querySelectorAll('.wrow')].some(r=>r.textContent.includes('${CARD}')&&[...r.querySelectorAll('button')].some(x=>x.textContent.trim()==='дотянуть'))`, 15000),
      inst.actions().slice(n0).map((l) => `${l.action}:${l.step}${l.refusal ? ':' + l.refusal : ''}`))
    must(`${tag}: «дотянуть» нажата`, await P.rowBtn(CARD, 'дотянуть'), null)
    must(`${tag}: пометка исхода появилась в шапке`, await P.waitFor(`(document.querySelector('.top .mbtn-note')?.textContent.trim()??'').length>0`, 10000), null)
    const w = await P.where()
    const ma = inst.actions().slice(n0).filter((l) => l.action === 'mirror')
    must(`${tag}: исход «дотянуть» — в шапке («ошибка»/«отказ»/«нет связи»), у строки «Обновить» пометки нет, «Служебное» ${open ? 'раскрыто' : 'свёрнуто'}`,
      NOTES.includes(w.header) && w.row === null && w.svcOpen === open, w)
    must(`${tag}: на сервере нажатие зеркала дошло и упало (asked → error), ничего не запущено`, ma.some((l) => l.step === 'asked') && ma.some((l) => l.step === 'error') && !ma.some((l) => l.step === 'done') && spawns.length === 0,
      { шаги: ma.map((l) => l.step), spawns: spawns.length })
    return w
  }

  await pullOnce(false, 'свёрнуто')
  await P.shotAll('1-dotyanut-svernuto')
  await P.view(1280, 'light')
  await pullOnce(true, 'раскрыто')
  const rl = (await P.where()).rowLine
  must('раскрыто: строка «Обновить» без пометки — кнопка и обычная подсказка', rl === 'Обновить свежее из Plane, несколько минут' || rl === 'Обновитьсвежее из Plane, несколько минут', rl)
  await P.shotAll('2-dotyanut-raskryto')

  // контроль: сама «Обновить» в раскрытом «Служебном» — пометка у строки, в шапке нет
  await P.view(1280, 'light')
  await P.setService(true); await sleep(300)
  must('контроль: «Обновить» в «Служебном» нажата', await P.btn('Обновить', `document.querySelector('${SVC}')`), null)
  must('контроль: пометка у строки «Обновить»', await P.waitFor(`document.querySelector('${SVC} > .wtb .pbad')`, 10000), null)
  const wc = await P.where()
  must('контроль: исход кнопки «Обновить» — у строки, в шапке пометки нет', NOTES.includes(wc.row) && wc.header === null, wc)
  await P.shotAll('3-obnovit-kontrol')
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
