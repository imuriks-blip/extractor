// Проба ПТ7 (EXT-70, вёрстка кнопок-слов): тестовый экземпляр витрины этой копии В ТОМ ЖЕ ПРОЦЕССЕ (buildApp), свой порт,
// своя data во временной папке (actions.log, defer.json, звонок), временная доска, подменный plane.py (test/fake-plane.mjs
// через python = node — настоящий Plane не вызывается), выдуманные треды. Страница — настоящая web/dist этой копии.
// Браузер — headless Chrome со своим --user-data-dir во временной папке, управление по протоколу CDP (без видимых окон).
// Нажатия вживую: «да» (панель), «сливай» (второй щелчок и выбор треда), «Ответить» и «го <ID>» из строки (а), «Принять»
// с частичным исходом; снимки 1280 и 400, светлая и тёмная (тема — кнопкой приложения); words=false и bell=false — по DOM.
//   node probe/pt7-drive.mjs <папка-для-снимков> [chrome.exe]
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
const PORT = 4395
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'pt7-shots'))
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { checks: {}, shots: [] }
const check = (k, v) => { S.checks[k] = v; log(`ПРОВЕРКА ${k}: ${JSON.stringify(v)}`) }

const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href)
const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href)
const { scan } = await import(new URL(`file:///${BOARD_LIB}/secrets.mjs`).href)
const lockLib = await import(new URL(`file:///${BOARD_LIB}/lock.mjs`).href)

// ---------- выдуманные данные ----------
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T = Date.now()
const min = (n) => new Date(T - n * 60000)
const iso = (d) => d.toISOString()
const head = (d) => `${iso(d).slice(0, 10)} ${iso(d).slice(11, 16)} +00:00`
const SID = { ext: uuid(11), extV: uuid(12), led1: uuid(13), led2: uuid(14), infra: uuid(15) }
const QU = { ext: uuid(21), extV: uuid(22) }

function makeEnv() {
  const boardDir = makeBoard(tmpDir('pt7-board-'), { codes: ['EXT', 'LEDGER', 'INFRA', 'BW'], cards: [
    { id: 'EXT-70', status: 'in-progress', title: 'ПТ7: кнопки пульта в вёрстке' },
    { id: 'EXT-58', status: 'in-progress', title: 'Проба Н-П1: цена продолжения' },
    { id: 'EXT-61', status: 'review', title: 'Витрина: кнопка «Словарь» рядом с «?»' },
    { id: 'LEDGER-168', status: 'review', title: 'Одна кнопка съёмки — родная камера' },
    { id: 'INFRA-80', status: 'in-progress', title: 'Перенос бэкапов на второй диск', markB: true },
    { id: 'BW-41', status: 'in-progress', title: 'Фото сметы: один снимок или по листам' },
  ] })
  const logs = { 'EXT-70': ['Трурль: вёрстка готова, смотришь?', 30], 'EXT-58': ['Нужна цена продолжения — принимаем план пробы?', 40], 'EXT-61': ['Ветка готова, проверь экран.', 25],
    'LEDGER-168': ['Ветка готова. Сливай в main после твоего «да»? Тесты 396/396.', 20], 'INFRA-80': ['Нужно решение по второму диску.', 90], 'BW-41': ['Развилка: один снимок или по листам?', 180] }
  for (const [id, [body, ago]] of Object.entries(logs)) fs.writeFileSync(path.join(boardDir, id.split('-')[0], `${id}.log.md`), `### ${head(min(ago))} · plane · коммент\n\n${body}\n`)
  gitInitCommit(boardDir)
  fs.mkdirSync(path.join(boardDir, '.mirror'))
  fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
  fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: iso(min(300)), lastOk: iso(min(300)) }))
  fs.mkdirSync(path.join(boardDir, 'tools'))
  fs.writeFileSync(path.join(boardDir, 'tools', 'mirror-hidden.js'), '// заглушка пробы: дотяжка не запускается\n')
  const codes = Object.fromEntries(['EXT', 'LEDGER', 'INFRA', 'BW'].map((c) => [c, { projects: [], project_cards: [], repos: [] }]))
  const regFile = path.join(tmpDir('pt7-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: codes }))
  return { boardDir, regFile }
}

const thread = (sid, o = {}) => ({ sessionId: sid, title: 'тред', project: null, projectBy: 'title', card: null, state: 'idle', lastSeenAt: iso(min(1)), since: iso(min(60)), sinceKind: 'open', subagents: [], marks: [], ...o })
const sessionOf = (sid, text, uuidQ) => ({ sessionId: sid, lines: 10, thread: { q: { text, uuid: uuidQ, at: iso(min(14)) } } })

// opts: words, bell
async function startInstance({ words = true, bell = true } = {}) {
  const { boardDir, regFile } = makeEnv()
  const data = tmpDir('pt7-data-')
  const pdir = tmpDir('pt7-plane-')
  fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
  const stateFile = path.join(pdir, 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'Review', title: 'Выдуманная карточка', comments: [{ id: 'q1', created_at: iso(min(300)), html: '<p>Старая запись</p>' }] }))
  const web = path.join(REPO, 'web', 'dist')
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(regFile)
  const live = [
    thread(SID.ext, { title: 'EXT · пульт', project: 'EXT', card: 'EXT-70', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(min(14)) }),
    thread(SID.extV, { title: 'EXT · витрина', project: 'EXT', state: 'waiting', waitingKind: 'question', statusUpdatedAt: iso(min(9)) }),
    thread(SID.infra, { title: 'INFRA · бэкапы', project: 'INFRA', state: 'waiting', waitingKind: 'permission', statusUpdatedAt: iso(min(5)) }),
    thread(SID.led1, { title: 'LEDGER · учётка', project: 'LEDGER', state: 'idle' }),
    thread(SID.led2, { title: 'LEDGER · шасси', project: 'LEDGER', state: 'stale', lastSeenAt: iso(min(14)), lastState: 'idle' }),
  ]
  const sessions = [
    sessionOf(SID.ext, 'Трурль: ПТ7 — верстаем по варианту Б из макета или ждём твоего выбора? Карточка EXT-70.', QU.ext),
    sessionOf(SID.extV, 'Трурль: Снимок бланка — оставляем сжатие 1500 точек или поднимаем до 2000? Смотри EXT-58.', QU.extV),
  ]
  const threadsApi = {
    list: () => ({ threads: live, waiting: waitingThreads({ threads: live, sessions, now: Date.now() }), subagentsCount: 0, unknownStatus: {} }),
    state: () => ({ processes: { lastOkAt: iso(min(0)) }, desktop: null }) }
  const journals = { state: () => ({ lastOkAt: iso(min(0)) }), sessions: () => sessions }
  const spawnStub = () => { const ch = new EventEmitter(); ch.pid = 9100; ch.unref = () => {}; process.nextTick(() => ch.emit('spawn')); return ch }
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: web, threads: threadsApi, journals,
    pult: { enabled: true, words, bell, bellDir: path.join(data, 'bell'), actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: spawnStub } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const planeSt = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const setPlane = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...planeSt(), ...patch }))
  const actions = () => (fs.existsSync(path.join(data, 'actions.log')) ? fs.readFileSync(path.join(data, 'actions.log'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { app, data, planeSt, setPlane, actions, close: () => app.close() }
}

// ---------- браузер по CDP ----------
const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
let intercepted = 0 // запросов страницы, ушедших куда-либо кроме своего тестового экземпляра: проверяется ниже

async function openBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt7-chrome-'))
  const dbg = 9300 + Math.floor(Math.random() * 400)
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${dbg}`, `--user-data-dir=${dir}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  log(`chrome pid ${child.pid}, user-data-dir ${dir}, cdp ${dbg}`)
  let tgt = null
  for (let i = 0; i < 60 && !tgt; i++) { await sleep(300); try { tgt = JSON.parse(await httpReq('PUT', `http://127.0.0.1:${dbg}/json/new?about:blank`)) } catch { /* ещё не поднялся */ } }
  if (!tgt) throw new Error('chrome не поднялся')
  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  const reqs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url)
  }
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable')
  const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка страницы'); return r.result.value }
  return { child, dir, call, ev, reqs, close: async () => { try { ws.close() } catch { /* закрыт */ } try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* уже нет */ } } }
}

const BASE = `http://127.0.0.1:${PORT}`
function pageApi(b, w, theme) {
  const P = {}
  P.size = async (h = 1400) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  P.goto = async (hash = '#/') => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await P.waitFor('document.querySelector(".top")', 8000) }
  P.waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  P.theme = async (name) => { // кнопкой приложения, не атрибутом
    await b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`) }
  P.rowBtn = (rowText, btnText) => b.ev(`(()=>{const r=[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes(${JSON.stringify(rowText)}));const x=r&&[...r.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(btnText)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.btn = (text, scope = 'document') => b.ev(`(()=>{const x=[...${scope}.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(text)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.btnLike = (re, scope = 'document') => b.ev(`(()=>{const x=[...${scope}.querySelectorAll('button')].find(y=>${re}.test(y.textContent.trim())&&!y.disabled);if(!x)return false;x.click();return true})()`)
  P.type = async (sel, text) => { await b.ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await b.call('Input.insertText', { text }) }
  P.text = (sel) => b.ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x=>x.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`)
  P.shot = async (name) => {
    const h = Math.min(3200, Math.max(700, await b.ev('document.documentElement.scrollHeight')))
    await P.size(h); await sleep(250)
    const r = await b.call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${theme}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    S.shots.push(f); log(`снимок ${f}`)
    await P.size(900)
  }
  P.overflowX = () => b.ev('document.documentElement.scrollWidth - window.innerWidth')
  return P
}

// ---------- сценарий ----------
async function scenario(w, theme, full) {
  const inst = await startInstance()
  const b = await openBrowser()
  const P = pageApi(b, w, theme)
  try {
    await P.size(900)
    await P.goto('#/')
    await P.waitFor('document.querySelector(".wrow")')
    if (theme !== 'light') await P.theme(theme === 'dark' ? 'Тёмная' : 'Светлая')
    else await P.theme('Светлая')
    await sleep(300)
    // раскрыть группы, свёрнутые по умолчанию
    await b.ev(`document.querySelectorAll('details.grp').forEach(d=>d.open=true)`)
    await P.shot('01-ceh-pokoj')
    if (!full) { check(`${w}/${theme} горизонтальная прокрутка страницы, px`, await P.overflowX()); return }

    // 1. «сливай» LEDGER-168: второй щелчок и выбор треда
    check('«сливай» первый щелчок', await P.rowBtn('LEDGER-168', 'сливай'))
    await P.waitFor('document.querySelector(".cfm")')
    check('подтверждение под строкой (не окно)', await b.ev('!!document.querySelector(".wrow .cfm") && !document.querySelector("dialog[open]")'))
    check('«сливай — подтверждаю» неактивна до выбора треда', await b.ev(`[...document.querySelectorAll('.cfm button')].find(x=>/подтверждаю/.test(x.textContent))?.disabled`))
    await P.shot('02-confirm-sliyay-vybor-treda')
    await b.ev(`document.querySelector('.cfm .pick input')?.click()`)
    await sleep(200)
    await P.shot('03-confirm-sliyay-vybran')
    const calls0 = inst.planeSt().calls?.length ?? 0
    check('«подтверждаю» нажата', await P.btnLike('/подтверждаю/'))
    await P.waitFor('!document.querySelector(".going") && document.body.textContent.includes("записано")', 12000)
    await sleep(2500) // следующий опрос данных страницы
    const sl = inst.actions().filter((l) => l.action === 'merge')
    check('«сливай»: журнал шагов', sl.map((l) => l.step + (l.pick ? '+pick' : '') + (l.confirm ? '+confirm' : '')).join(','))
    check('«сливай»: вызовы plane.py (show/comment, не state)', (inst.planeSt().calls ?? []).slice(calls0).map((c) => c[0]).join(','))
    await b.ev(`document.querySelectorAll('details.grp').forEach(d=>d.open=true)`)
    await P.shot('04-posle-sliyay')

    // 2. «Ответить» из строки (а) EXT · пульт
    check('«Ответить» строки (а)', await P.rowBtn('EXT · пульт', 'Ответить'))
    await P.waitFor('document.querySelector(".pret textarea")')
    await P.type('.pret textarea', 'делай по варианту Б, но проверь на узком экране')
    await P.shot('05-forma-otveta-stroka-a')
    check('«отправить» ответа', await P.btn('отправить'))
    await P.waitFor('[...document.querySelectorAll(".wrow")].find(x=>x.textContent.includes("EXT · пульт"))?.textContent.includes("записано")', 12000)
    const rowA = await b.ev(`[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes('EXT · пульт'))?.textContent.replace(/\\s+/g,' ')`)
    check('строка (а) после ответа', { text: rowA, кнопкиНеактивны: await b.ev(`[...[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes('EXT · пульт')).querySelectorAll('.pbtns button')].every(x=>x.disabled)`) })
    await P.shot('06-stroka-a-posle-otveta')

    // 3. «го <ID>» из строки (а) EXT · витрина
    check('кнопка «го EXT-58» есть у строки (а) с card', await b.ev(`[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes('EXT · витрина'))?.textContent.includes('го EXT-58')`))
    check('у строки (а) EXT · пульт «го» нет только если поля card нет (текст: EXT-70 — поле есть)', await b.ev(`[...document.querySelectorAll('.wrow')].find(x=>x.textContent.includes('EXT · пульт'))?.textContent.includes('го EXT-70')`))
    check('«го EXT-58» нажата', await P.rowBtn('EXT · витрина', 'го EXT-58'))
    await P.waitFor('[...document.querySelectorAll(".wrow")].find(x=>x.textContent.includes("EXT · витрина"))?.textContent.includes("положено")', 12000)
    const goLine = inst.actions().filter((l) => l.action === 'reply')
    check('«го»: журнал (reply, session, без card строки)', goLine.map((l) => ({ step: l.step, text: l.text, session: !!l.session, card: l.card ?? null })))
    await P.shot('07-stroka-a-go')

    // 4. Б-дело «да» на INFRA-80 (mark_b) — второй щелчок, один тред
    check('«да» INFRA-80', await P.rowBtn('INFRA-80', 'да'))
    await P.waitFor('document.querySelector(".cfm.b")')
    await P.shot('08-confirm-b-delo-odin-tred')
    await P.btnLike('/отмена/', 'document.querySelector(".cfm")')

    // 5. «Принять»: частичный исход
    inst.setPlane({ fail: { state: 'mismatch' } })
    check('«Принять» EXT-61', await P.rowBtn('EXT-61', 'Принять'))
    await P.waitFor('document.body.textContent.includes("частично")', 12000)
    await P.shot('09-prinyat-chastichno')
    inst.setPlane({ fail: {} })

    // 6. панель карточки: Review, меню «ещё»; «да» из панели
    await P.goto('#/project/LEDGER/LEDGER-168')
    await P.waitFor('document.querySelector(".panel .pult")')
    await sleep(600)
    await P.shot('10-panel-review')
    await P.goto('#/project/EXT/EXT-58')
    await P.waitFor('document.querySelector(".panel .pult")')
    await sleep(600)
    await b.ev(`document.querySelector('.panel .pult button[aria-haspopup]')?.click()`)
    await P.shot('11-panel-v-rabote-menu-eshche')
    await b.ev(`document.querySelector('.panel .pult button[aria-haspopup]')?.click()`)
    check('«да» нажата в панели', await P.btn('да', 'document.querySelector(".panel")'))
    await P.waitFor('document.querySelector(".panel .cfm")')
    await P.shot('12-panel-da-vybor-treda')
    await b.ev(`document.querySelector('.panel .cfm .pick input')?.click()`)
    check('«да — отправить» в панели', await P.btnLike('/отправить/', 'document.querySelector(".panel .cfm")'))
    await P.waitFor('document.querySelector(".panel .pult")?.textContent.includes("записано")', 12000)
    await sleep(2500)
    await P.shot('13-panel-posle-da')
    const da = inst.actions().filter((l) => l.action === 'yes')
    check('«да» из панели: журнал', da.map((l) => l.step + (l.card ? ':' + l.card : '')).join(','))

    // 7. «Мои слова» и «Рабочие копии» на «Цехе»
    await P.goto('#/')
    await P.waitFor('document.querySelector(".mw")', 8000)
    await sleep(600)
    await b.ev(`document.querySelectorAll('details').forEach(d=>d.open=true)`)
    await P.shot('14-ceh-moi-slova')
    const reqUrls = b.reqs.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('blob:'))
    check('запросы страницы вне тестового экземпляра', reqUrls)
    check('горизонтальная прокрутка страницы, px', await P.overflowX())
  } finally {
    await b.close()
    await inst.close()
    S.profiles = [...(S.profiles ?? []), b.dir]
  }
}

// узкие ширины: таблица «Проекты» (EXT-72)
async function narrow(w) {
  const inst = await startInstance()
  const b = await openBrowser()
  const P = pageApi(b, w, 'light')
  try {
    await P.size(900); await P.goto('#/'); await P.waitFor('document.querySelector(".ptable")'); await P.theme('Светлая')
    await b.ev(`document.querySelectorAll('details').forEach(d=>d.open=true)`)
    const m = await b.ev(`(()=>{const t=document.querySelector('.ptable');const tw=document.querySelector('.tw');return {cols:[...t.querySelectorAll('thead th')].filter(x=>x.offsetWidth>0).length, thTotal:t.querySelectorAll('thead th').length, tableW:t.scrollWidth, wrapW:tw.clientWidth, pageOverflow:document.documentElement.scrollWidth-window.innerWidth}})()`)
    check(`EXT-72: таблица «Проекты» на ${w}`, m)
    await P.shot('16-ceh-proekty')
  } finally { await b.close(); await inst.close(); S.profiles = [...(S.profiles ?? []), b.dir] }
}

// флаги: words=false — кнопок-слов нет; bell=false — звонковых нет
async function flags() {
  for (const [words, bell] of [[false, true], [true, false]]) {
    const inst = await startInstance({ words, bell })
    const b = await openBrowser()
    const P = pageApi(b, 1280, 'light')
    try {
      await P.size(900); await P.goto('#/'); await P.waitFor('document.querySelector(".wrow")'); await sleep(500)
      await b.ev(`document.querySelectorAll('details.grp').forEach(d=>d.open=true)`)
      const labels = await b.ev(`[...document.querySelectorAll('.wrow button.pbtn')].map(x=>x.textContent.trim()).filter(t=>t!=='Отложить')`)
      check(`pult.words=${words}, pult.bell=${bell}: кнопки в строках «Ждёт меня» (кроме «Отложить»)`, labels)
      await P.goto('#/project/EXT/EXT-58'); await P.waitFor('document.querySelector(".panel")'); await sleep(700)
      check(`pult.words=${words}, pult.bell=${bell}: кнопки панели EXT-58`, await b.ev(`[...document.querySelectorAll('.panel .pult button')].map(x=>x.textContent.trim())`))
      await P.shot(`17-flags-words-${words}-bell-${bell}`)
    } finally { await b.close(); await inst.close(); S.profiles = [...(S.profiles ?? []), b.dir] }
  }
}

try {
  log(`снимки: ${SHOTS}; порт ${PORT}`)
  const only = process.env.PT7_ONLY // отладка: один шаг, например PT7_ONLY=1280-light
  const run = (k, f) => (!only || only === k ? f() : null)
  await run('1280-light', () => scenario(1280, 'light', true))
  await run('1280-dark', () => scenario(1280, 'dark', true))
  await run('400-light', () => scenario(400, 'light', true))
  await run('400-dark', () => scenario(400, 'dark', true))
  await run('narrow', async () => { await narrow(360); await narrow(400) })
  await run('flags', () => flags())
} catch (e) {
  S.error = String(e?.stack ?? e)
  log(`СБОЙ: ${S.error}`)
}
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(S, null, 2))
log('итог — summary.json')
process.exit(S.error ? 1 : 0)
