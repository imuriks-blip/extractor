// Проба EXT-79: «Готово, посмотри» с 11 карточек — подгруппы по проекту в порядке таблицы «Проекты» и чипы следа
// (вариант В макета VKxJw5DGv6VvqiY6iFreph, решения Ивана 06.10). Проверяет вид и память выбора:
//  • 32 карточки: подгруппы по порядку таблицы, все раскрыты, «Показать ещё» внутри большой подгруппы, чипы
//    «все · проверен · проверь · нет следа» с числами; свёртка подгруппы — и она же после перезагрузки;
//    чип «проверен» — «показано N из 32», пустые подгруппы скрыты, «из M» у неполных — и то же после перезагрузки;
//    «Принять» внутри подгруппы — нажатие доходит до сервера как раньше (подменный Plane), строка уходит в «Отвечено…»;
//  • 3 карточки: как раньше — без подгрупп и чипов, хотя выбор чипа в хранилище остался;
//  • 1280 и 400, светлая и тёмная (тема — кнопкой приложения); на 400 горизонтальной прокрутки нет.
// Устройство — как у probe/ext77-pull-drive.mjs: тестовый экземпляр витрины этой копии в том же процессе, свой порт, своя
// data во временной папке, временная доска, подменный plane.py (test/fake-plane.mjs через python = node — Plane не
// вызывается), след — подменный (trace.peek, выдуманные итоги). Данные выдуманные. Страница — настоящая web/dist
// (собрать заранее: npm --prefix web run build). Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP.
//   node probe/ext79-drive.mjs <папка-для-снимков> [chrome.exe]
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
const PORT = 4401
guardLive(REPO, PORT)
const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'ext79-shots'))
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
const iso = (d) => d.toISOString()
const upd = (minAgo) => `${iso(new Date(T - minAgo * 60000)).slice(0, 16)}+00:00`

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

// ---------- выдуманные данные ----------
const ORDER = ['CAR', 'LEDGER', 'MAKAR', 'ASTRO', 'INFRA', 'EXT'] // порядок реестра = порядок таблицы «Проекты»
const LABEL = { ok: 'след проверен', warn: 'коммит не найден в репозиториях — проверь глазами', bad: 'нет записи о закрытии', none: 'след без коммитов — проверь глазами' }
// [id, след, минут назад]; 32 карточки: EXT 4, ASTRO 3, INFRA 17 (больше 10 — «Показать ещё»), LEDGER 3, MAKAR 5; CAR — пусто
const BIG = [
  ['EXT-201', 'ok', 3], ['ASTRO-31', 'bad', 12], ['ASTRO-32', 'bad', 13], ['ASTRO-33', 'ok', 14], ['EXT-202', 'bad', 48], ['EXT-203', 'warn', 64],
  ['INFRA-301', 'warn', 1560], ['INFRA-302', 'ok', 1740],
  ...Array.from({ length: 15 }, (_, i) => [`INFRA-${310 + i}`, i === 7 ? 'none' : 'bad', 1980 + i]),
  ['LEDGER-401', 'bad', 7200], ['LEDGER-402', 'bad', 21600], ['LEDGER-403', 'bad', 21620],
  ['MAKAR-501', 'ok', 21800], ['MAKAR-502', 'bad', 21801], ['MAKAR-503', 'bad', 24500], ['MAKAR-504', 'bad', 25900], ['MAKAR-505', 'ok', 25950],
  ['EXT-204', 'bad', 26000],
]
const SMALL = [['EXT-201', 'ok', 3], ['ASTRO-31', 'bad', 12], ['INFRA-301', 'warn', 1560]]
const TITLES = ['Окно заказа: подсказка у пустого поля', 'Отчёт за неделю: колонка «итого» справа', 'Список машин: поиск по номеру кузова',
  'Напоминание о записи за день до визита', 'Фото к заказу: поворот снимка', 'Выгрузка в таблицу: даты по-русски', 'Экран входа: ошибка без жаргона']
const ACCEPT_CARD = 'EXT-202'

async function startInstance(set) {
  const codes = ORDER
  const cards = set.map(([id, , m], i) => ({ id, status: 'review', title: `${TITLES[i % TITLES.length]} (${id})`, updated: upd(m) }))
  const boardDir = makeBoard(mk('ext79-board-'), { codes, cards })
  gitInitCommit(boardDir)
  fs.mkdirSync(path.join(boardDir, '.mirror'))
  fs.writeFileSync(path.join(boardDir, '.mirror', 'index.json'), '{}')
  fs.writeFileSync(path.join(boardDir, '.mirror', 'status.json'), JSON.stringify({ lastOkAt: iso(new Date(T - 300 * 60000)), lastOk: iso(new Date(T - 300 * 60000)) }))
  fs.mkdirSync(path.join(boardDir, 'tools')) // mirror-hidden.js нет: дотяжка карточки после «Принять» ничего не запускает
  const regFile = path.join(mk('ext79-reg-'), 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify({ board_codes: Object.fromEntries(codes.map((c) => [c, { projects: [], project_cards: [], repos: [] }])) }))
  const data = mk('ext79-data-')
  const pdir = mk('ext79-plane-')
  fs.copyFileSync(path.join(REPO, 'test', 'fake-plane.mjs'), path.join(pdir, 'fake-plane.mjs'))
  fs.writeFileSync(path.join(pdir, 'state.json'), JSON.stringify({ status: 'Review', title: 'Выдуманная карточка', comments: [{ id: 'q1', created_at: '2026-09-25T10:00:00.000000Z', html: '<p>Готово, проверь</p>' }] }))
  const traces = Object.fromEntries(set.map(([id, st]) => [id, { state: st, label: LABEL[st], hint: null, reasons: [] }]))
  const board = createBoardReader({ root: boardDir, git: createGitRead(), parseCard, parseLog, latest })
  await board.init()
  const registry = createRegistryReader(regFile)
  const threadsApi = { list: () => ({ threads: [], waiting: [], subagentsCount: 0, unknownStatus: {} }), state: () => ({ processes: { lastOkAt: iso(new Date()) }, desktop: null }) }
  const journals = { state: () => ({ lastOkAt: iso(new Date()) }), sessions: () => [] }
  const spawns = []
  const app = await buildApp({ port: PORT, board, registry, scan, webDir: path.join(REPO, 'web', 'dist'), threads: threadsApi, journals,
    trace: { peek: (id) => traces[id] ?? null },
    pult: { enabled: true, words: false, bell: false, actionsLog: path.join(data, 'actions.log'), mirrorDir: path.join(boardDir, '.mirror'), lock: lockLib, boardRoot: boardDir,
      python: process.execPath, planePy: path.join(pdir, 'fake-plane.mjs') },
    pultSeams: { spawn: (cmd, args) => { spawns.push({ cmd, args }); throw new Error('проба не запускает процессов') } } })
  await app.listen({ host: '127.0.0.1', port: PORT })
  const actions = () => (fs.existsSync(path.join(data, 'actions.log')) ? fs.readFileSync(path.join(data, 'actions.log'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const plane = () => JSON.parse(fs.readFileSync(path.join(pdir, 'state.json'), 'utf8'))
  return { actions, plane, spawns, close: () => app.close() }
}

// ---------- браузер по CDP ----------
const httpReq = (method, url) => new Promise((resolve, reject) => {
  const r = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
  r.on('error', reject); r.end()
})
async function openBrowser() {
  const dir = mk('ext79-chrome-')
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
const REV = `[...document.querySelectorAll('details.grp')].find(d=>d.querySelector(':scope>summary')?.textContent.includes('Готово, посмотри'))`
function pageApi(b) {
  const P = {}
  P.size = (w, h = 900) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  P.waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  P.goto = async (hash = '#/') => { await b.call('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(900); await P.waitFor('document.querySelector(".top")', 10000); await P.waitFor(REV, 10000) }
  P.reload = async () => { await b.call('Page.reload', {}); await sleep(900); await P.waitFor(REV, 10000); await sleep(300) }
  P.theme = (name) => b.ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.click()`)
  P.view = async (w, theme) => { await P.size(w); await P.theme(theme === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(350) }
  P.shot = async (name, w, theme) => {
    const h = Math.min(4000, Math.max(700, await b.ev('document.documentElement.scrollHeight')))
    await P.size(w, h); await sleep(300)
    const r = await b.call('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, `${w}-${theme}-${name}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    S.shots.push(f); log(`снимок ${f}`)
    await P.size(w)
  }
  P.overflowX = () => b.ev('document.documentElement.scrollWidth - window.innerWidth')
  P.shotAll = async (name) => {
    for (const [w, th] of COMBOS) {
      await P.view(w, th)
      if (w === 400) must(`${name}: на 400 (${th}) горизонтальной прокрутки нет`, (await P.overflowX()) <= 0, await P.overflowX())
      await P.shot(name, w, th)
    }
  }
  // состояние группы «Готово, посмотри»
  P.rev = () => b.ev(`(()=>{const g=${REV};if(!g)return null;const t=(x)=>x?.textContent.trim().replace(/\\s+/g,' ')??null;
    return {head:t(g.querySelector(':scope>summary .cnt')),
      chips:[...g.querySelectorAll('.rf .filt button')].map(x=>({t:t(x),on:x.getAttribute('aria-pressed')==='true'})),
      subs:[...g.querySelectorAll(':scope>details.sg')].map(d=>({code:t(d.querySelector('summary .code')),n:t(d.querySelector('summary .cnt')),of:t(d.querySelector('summary .of')),sum:t(d.querySelector('summary .sgt')),open:d.open,
        rows:[...d.querySelectorAll(':scope>.wrow')].map(r=>t(r.querySelector('.src'))),more:t(d.querySelector(':scope>.more')),accept:d.querySelectorAll('.wrow button.pmain').length})),
      flat:[...g.querySelectorAll(':scope>.wrow')].map(r=>t(r.querySelector('.src'))),
      empty:t(g.querySelector(':scope>.foot'))}})()`)
  P.clickChip = (word) => b.ev(`(()=>{const x=[...${REV}.querySelectorAll('.rf .filt button')].find(y=>y.textContent.includes(${JSON.stringify(word)}));if(!x)return false;x.click();return true})()`)
  P.toggleSub = (code) => b.ev(`(()=>{const d=[...${REV}.querySelectorAll(':scope>details.sg')].find(x=>x.querySelector('summary .code')?.textContent.trim()===${JSON.stringify(code)});if(!d)return null;d.querySelector('summary').click();return true})()`)
  P.ls = (k) => b.ev(`localStorage.getItem(${JSON.stringify(k)})`)
  P.rowBtn = (rowText, btnText) => b.ev(`(()=>{const r=[...document.querySelectorAll('.wrow')].find(x=>x.querySelector('.src')?.textContent.trim()===${JSON.stringify(rowText)});const x=r&&[...r.querySelectorAll('button')].find(y=>y.textContent.trim()===${JSON.stringify(btnText)}&&!y.disabled);if(!x)return false;x.click();return true})()`)
  return P
}

let inst = null
let b = null
try {
  log(`снимки: ${SHOTS}; порт ${PORT}`)
  // ===================== 32 карточки =====================
  inst = await startInstance(BIG)
  b = await openBrowser()
  const P = pageApi(b)
  await P.size(1280); await P.goto('#/'); await P.view(1280, 'light')
  await P.waitFor(`${REV}?.querySelector('details.sg')`, 10000)
  const r0 = await P.rev()
  const codes0 = r0.subs.map((s) => s.code)
  must('32: подгруппы в порядке таблицы «Проекты» (реестра), CAR без карточек — нет', JSON.stringify(codes0) === JSON.stringify(['LEDGER', 'MAKAR', 'ASTRO', 'INFRA', 'EXT']), codes0)
  const tableOrder = await b.ev(`[...document.querySelectorAll('.ptable tbody td.code')].map(x=>x.textContent.trim())`)
  must('32: порядок подгрупп совпадает с таблицей «Проекты» на экране', JSON.stringify(tableOrder.filter((c) => codes0.includes(c))) === JSON.stringify(codes0), tableOrder)
  must('32: заголовок группы — «32», без «показано»', r0.head === '32', r0.head)
  must('32: все подгруппы раскрыты по умолчанию', r0.subs.every((s) => s.open), r0.subs.map((s) => [s.code, s.open]))
  must('32: чипы «все · ✓ проверен · ! проверь · ✕ нет следа» с числами, выбран «все»',
    JSON.stringify(r0.chips.map((c) => c.t)) === JSON.stringify(['все', '✓ проверен5', '! проверь2', '✕ нет следа24']) && r0.chips[0].on && r0.chips.slice(1).every((c) => !c.on), r0.chips)
  const infra = r0.subs.find((s) => s.code === 'INFRA')
  must('32: в INFRA (17) — 10 свежих и «Показать ещё 7» внутри подгруппы', infra.rows.length === 10 && infra.more === 'Показать ещё 7' && infra.rows[0] === 'INFRA-301', infra)
  must('32: сводка подгруппы INFRA — ✕ 14 ! 1 ✓ 1 и давность', /✕.*14.*!.*1.*✓.*1/.test(infra.sum), infra.sum)
  must('32: «Принять» есть у строк внутри подгрупп', r0.subs.every((s) => s.accept === s.rows.length), r0.subs.map((s) => [s.code, s.accept, s.rows.length]))
  await P.shotAll('1-32-vse')

  // свёртка подгруппы и её память
  await P.view(1280, 'light')
  must('32: свёртка INFRA — щелчок по строке подгруппы', await P.toggleSub('INFRA'), null)
  await sleep(300)
  must('32: свёрнутая INFRA записана в хранилище (ceh-open:grp-review-INFRA = 0)', (await P.ls('ceh-open:grp-review-INFRA')) === '0', await P.ls('ceh-open:grp-review-INFRA'))
  await P.reload()
  const r1 = await P.rev()
  must('32 после перезагрузки: INFRA свёрнута, остальные раскрыты', r1.subs.every((s) => s.open === (s.code !== 'INFRA')), r1.subs.map((s) => [s.code, s.open]))
  must('32: у свёрнутой INFRA в заголовке видны число, сводка и давность', r1.subs.find((s) => s.code === 'INFRA').n === '17' && /✕/.test(r1.subs.find((s) => s.code === 'INFRA').sum), r1.subs.find((s) => s.code === 'INFRA'))
  await P.shotAll('2-32-infra-svernuta')

  // чип «проверен» и «показано N из M»
  await P.view(1280, 'light')
  must('32: чип «проверен» нажат', await P.clickChip('проверен'), null)
  await sleep(300)
  const r2 = await P.rev()
  must('32 «проверен»: в заголовке «показано 5 из 32»', r2.head === 'показано 5 из 32', r2.head)
  must('32 «проверен»: только подгруппы с проверенными (MAKAR, ASTRO, INFRA, EXT), LEDGER скрыт', JSON.stringify(r2.subs.map((s) => s.code)) === '["MAKAR","ASTRO","INFRA","EXT"]', r2.subs.map((s) => s.code))
  must('32 «проверен»: у неполной подгруппы «из M» (EXT 1 из 4, MAKAR 2 из 5)', r2.subs.find((s) => s.code === 'EXT').of === 'из 4' && r2.subs.find((s) => s.code === 'MAKAR').of === 'из 5' && r2.subs.find((s) => s.code === 'MAKAR').n === '2', r2.subs.map((s) => [s.code, s.n, s.of]))
  must('32 «проверен»: выбор записан в хранилище', (await P.ls('ceh-review-trace')) === 'ok', await P.ls('ceh-review-trace'))
  await P.reload()
  const r3 = await P.rev()
  must('32 после перезагрузки: «проверен» выбран, «показано 5 из 32»', r3.head === 'показано 5 из 32' && r3.chips.find((c) => c.t.includes('проверен')).on, { head: r3.head, chips: r3.chips })
  // раскроем INFRA для снимка фильтра
  await P.toggleSub('INFRA'); await sleep(200)
  await P.shotAll('3-32-proveren')
  await P.view(1280, 'light')
  must('32: повторный щелчок по «проверен» снимает фильтр', (await P.clickChip('проверен')) && (await P.rev()).head === '32', (await P.rev()).head)
  await P.clickChip('проверен'); await sleep(200) // выбор оставлен в хранилище — для проверки на 3 карточках
  must('32: «проверен» снова выбран перед «Принять»', (await P.rev()).head === 'показано 5 из 32', (await P.rev()).head)
  await P.clickChip('все'); await sleep(200)
  must('32: «все» снимает фильтр', (await P.rev()).head === '32' && (await P.ls('ceh-review-trace')) === 'all', await P.ls('ceh-review-trace'))

  // «Принять» внутри подгруппы — как раньше
  const n0 = inst.actions().length
  must(`32: «Принять» ${ACCEPT_CARD} в подгруппе EXT нажата`, await P.rowBtn(ACCEPT_CARD, 'Принять'), null)
  // исход нажатия — у строки в подгруппе (кнопки «Принять» у неё больше нет); на живой страница перечитывается по сигналу
  // changed (start.mjs), у пробы на buildApp его нет — перечитываем сами, как после сигнала
  const rowTxt = `[...${REV}.querySelectorAll('details.sg .wrow')].find(r=>r.querySelector('.src')?.textContent.trim()==='${ACCEPT_CARD}')`
  await P.waitFor(`${rowTxt} && ![...${rowTxt}.querySelectorAll('button')].some(x=>x.textContent.trim()==='Принять')`, 20000)
  await sleep(500)
  check('32: строка после нажатия, до перечитывания (в подгруппе EXT)', await b.ev(`${rowTxt}?.textContent.replace(/\\s+/g,' ').trim() ?? null`))
  await P.reload()
  const gone = await P.waitFor(`![...${REV}.querySelectorAll('details.sg .wrow .src')].some(x=>x.textContent.trim()==='${ACCEPT_CARD}')`, 8000)
  const acts = inst.actions().slice(n0).map((l) => `${l.action}:${l.step}${l.card ? ':' + l.card : ''}${l.refusal ? ':' + l.refusal : ''}`)
  const pl = inst.plane()
  must('32: нажатие дошло до сервера — журнал нажатий: accept по карточке', acts.some((a) => a.startsWith('accept:') && a.includes(ACCEPT_CARD)), acts)
  must('32: подменный Plane: show → comment → state Done', pl.status === 'Done' && pl.calls?.some((c) => c[0] === 'comment') && pl.calls?.some((c) => c[0] === 'state'), { status: pl.status, calls: pl.calls?.map((c) => c[0]) })
  const answered = await b.ev(`[...document.querySelectorAll('details.grp.ans .wrow .src')].map(x=>x.textContent.trim())`)
  must('32: строка ушла из подгруппы в «Отвечено, ждёт зеркала»', gone && answered.includes(ACCEPT_CARD), { gone, answered })
  const r4 = await P.rev()
  must('32 после «Принять»: в заголовке 31, EXT — 3', r4.head === '31' && r4.subs.find((s) => s.code === 'EXT').n === '3', { head: r4.head, ext: r4.subs.find((s) => s.code === 'EXT') })
  await P.shotAll('4-32-posle-prinyat')
  S.spawns32 = inst.spawns.length

  // ===================== 3 карточки =====================
  await P.view(1280, 'light')
  await P.clickChip('проверен'); await sleep(200)
  must('перед 3: в хранилище выбран «проверен»', (await P.ls('ceh-review-trace')) === 'ok', await P.ls('ceh-review-trace'))
  await inst.close(); inst = null
  inst = await startInstance(SMALL)
  await P.reload() // тот же адрес с # — переход без перезагрузки страницы; нужна настоящая перезагрузка
  await P.waitFor(`${REV}?.querySelector('.wrow')`, 10000)
  const r5 = await P.rev()
  must('3: как раньше — без подгрупп и чипов, плоский список свежие сверху', r5.subs.length === 0 && r5.chips.length === 0 && JSON.stringify(r5.flat) === '["EXT-201","ASTRO-31","INFRA-301"]', r5)
  must('3: сохранённый «проверен» не действует — заголовок «3», подсказки нет', r5.head === '3' && r5.empty === null, { head: r5.head, empty: r5.empty })
  await P.shotAll('5-3-kak-ranshe')
  S.spawns3 = inst.spawns.length
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
