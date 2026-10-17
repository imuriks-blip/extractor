// Снимки и проверки EXT-103 Т3: окно «Дорожная карта» на образцах web/fixtures/roadmap*.json (гейт Г3 спеки дорожной карты).
// Запуск руками, в npm test не входит.   node probe/ext103-shots.mjs <папка-для-снимков> [chrome.exe]
// Устройство — как у ext116-shots.mjs: крошечный сервер на 127.0.0.1:4398 отдаёт web/dist и ВЫДУМАННЫЕ ответы (образцы web/fixtures
// и их варианты, собранные здесь же в памяти); всё прочее под /api — 404 и счёт. Ни прокси, ни витрины (4317): запросы дальше этого
// сервера не уходят. Браузер — headless Chrome со своим --user-data-dir во временной папке, CDP; тема — кнопкой приложения.
// Проверяется ВИД, не данные.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = 4398
guardLive(REPO, PORT) // до любой записи: отказ в живой папке и на порту 4317 (CLAUDE.md репозитория)
if (!process.argv[2]) { console.error('нужна папка для снимков'); process.exit(2) }
const SHOTS = path.resolve(process.argv[2])
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIST = path.join(REPO, 'web', 'dist')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)
const S = { shots: [], checks: {}, fails: [], intercepted: {}, other: [], console: [], pid: null }
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
const clone = (o) => JSON.parse(JSON.stringify(o))

// ---------- варианты образцов (выдуманные данные) ----------
// все проекты: EXT из образца, INFRA с картой, IPTV без карты (counts null — серое «карты нет»)
const ALL = (() => {
  const d = clone(fx('roadmap.json'))
  d.projects.push(
    { code: 'INFRA', name: 'имя-infra', hasMap: true, counts: { askOpen: 0, ideasDiscuss: 2, ahead: 1 }, where: { updated: '2026-10-17 09:00', by: 'cerebron:INFRA', phase: 'Фаза.', next: 'Шаг.', text: [] }, broken: null },
    { code: 'IPTV', name: 'имя-iptv', hasMap: false, counts: null, where: null, broken: null })
  d.total.ahead = 3
  return d
})()
const NOMAP = { available: true, error: null, code: 'IPTV', name: 'имя-iptv', hasMap: false, map: null, counts: null, broken: null }
const OK_TRACE = { state: 'ok', label: 'след сходится: 1 коммит в origin/main', hint: null, reasons: [], checked: { lines: [], who: null, commits: [] }, contractAt: '2026-10-17T08:00:00.000Z', laterRecords: 0 }
// карта EXT: образец + идеи → T-1 (EXT-12) со статусом step ('in-progress' | 'done'), → EXT-14 в cancelled; красный след not-in-main;
// step108 — подпись EXT-108 у пункта 2 (только в своём случае)
function mapEXT({ t1 = 'in-progress', step108 = false } = {}) {
  const d = clone(fx('roadmap-EXT.json'))
  d.map.ideas.push(
    { n: 'i4', status: 'стала карточкой', shown: t1 === 'done' ? 'сделана' : 'в работе', date: '2026-10-16', from: 'чат EXT 16.10', text: 'Окно карты', ask: null, card: 'EXT-12', cardStatus: t1, cardTrace: t1 === 'done' ? OK_TRACE : null, why: null },
    { n: 'i5', status: 'стала карточкой', shown: 'стала карточкой · карточка снята', date: '2026-10-15', from: 'чат EXT 15.10', text: 'Снятая затея', ask: null, card: 'EXT-14', cardStatus: 'cancelled', cardTrace: null, why: null },
    { n: 'i6', status: 'ждёт Ивана', shown: 'ждёт Ивана', date: '2026-10-17', from: 'чат EXT 17.10', text: 'Нужен выбор', ask: 'q1', card: null, cardStatus: null, cardTrace: null, why: null })
  const it1 = d.map.cards.ahead[0].plan.items[0]
  it1.traces.push({ part: 'extractor@abc1234', state: 'bad', label: 'abc1234 не в main (extractor)', hint: null, reasons: [{ level: 'bad', code: 'not-in-main', text: 'abc1234 не в main (extractor)' }], checked: { lines: [], who: null, commits: [] }, contractAt: null, laterRecords: 0 })
  if (step108) d.map.cards.ahead[0].plan.items[1].step = { thread: 'EXT', n: 3, of: 6 }
  // «ждёт: слово Ивана» — не номер карточки: текстом, без ссылки (ревью Голема, Важно 1); рядом 2.2 «ждёт EXT-9» — ссылкой
  const items = d.map.cards.ahead[0].plan.items
  items.splice(4, 0, { depth: 1, mark: '!', shownMark: '!', num: '2.3', text: 'Выбор', card: null, cardStatus: null, cardTrace: null, wait: 'слово Ивана', why: null, traces: [] })
  d.map.cards.ahead[0].plan.summary.total = items.length
  return d
}
let scenario = { all: ALL, one: mapEXT() }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const hit = (k) => { S.intercepted[k] = (S.intercepted[k] ?? 0) + 1 }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname === '/api/ceh') { hit('ceh'); return send(res, 200, fx('ceh.json')) }
  if (u.pathname === '/api/project/EXT') { hit('project'); return send(res, 200, fx('project-EXT.json')) }
  if (u.pathname === '/api/roadmap') { hit('roadmap'); return send(res, 200, scenario.all) }
  if (u.pathname === '/api/roadmap/IPTV') { hit('roadmap/IPTV'); return send(res, 200, scenario.off ?? NOMAP) }
  if (u.pathname === '/api/roadmap/EXT') { hit('roadmap/EXT'); return send(res, 200, scenario.one) }
  if (u.pathname.startsWith('/api/')) { S.other.push(u.pathname); res.writeHead(404); return res.end('{}') }
  if (u.pathname === '/sw.js') { res.writeHead(404); return res.end() } // служебного работника нет — страница не слепнет
  const f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname)
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(f))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const httpReq = (method, url) => new Promise((resolve, reject) => { const q = http.request(url, { method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) }); q.on('error', reject); q.end() })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext103-chrome-'))
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') S.console.push(`исключение: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) S.console.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`)
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
  }
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await call('Page.enable'); await call('Runtime.enable')
  const ev = async (expr) => { const x = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description ?? 'ошибка страницы'); return x.result.value }
  const size = (w, h) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(150) } return false }
  const theme = (n) => ev(`[...document.querySelectorAll('.top .seg button')].find(x=>x.textContent.trim()===${JSON.stringify(n)})?.click()`)
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
  const all = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent)`)
  const noHScroll = () => ev('document.documentElement.scrollWidth-innerWidth')
  const go = async (hash, w, h, th) => {
    await size(w, h)
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${hash}` }); await sleep(300); await call('Page.reload', { ignoreCache: true }); await sleep(500)
    await waitFor("document.querySelector('.top .seg button')", 10000)
    await theme(th === 'dark' ? 'Тёмная' : 'Светлая'); await sleep(150)
    await waitFor("document.querySelector('.rm-col, .beacon, .ptable')", 8000); await sleep(250)
  }
  const shot = async (name, w, th, full = false) => {
    let clip
    if (full) { const hgt = await ev('Math.min(document.documentElement.scrollHeight, 3000)'); clip = { x: 0, y: 0, width: w, height: hgt, scale: 1 } }
    const x = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) })
    const f = path.join(SHOTS, `${name}-${w}-${th}.png`); fs.writeFileSync(f, Buffer.from(x.data, 'base64')); S.shots.push(f); log(`снимок ${f}`)
  }

  // ===== вход из шапки: «Карта» на «Цехе» → #/roadmap; строка EXT → #/roadmap/EXT; «Карта EXT» в окне проекта =====
  await go('#/', 1280, 800, 'light')
  must('шапка: ссылка «Карта» рядом с «Расход»', JSON.stringify(await all('.top .navl')) === JSON.stringify(['Карта', 'Расход']), await all('.top .navl'))
  await ev("[...document.querySelectorAll('.top .navl')].find(a=>a.textContent==='Карта').click()"); await sleep(400)
  must('«Карта» открывает #/roadmap', (await ev('location.hash')) === '#/roadmap' && (await waitFor("document.querySelector('.rm-all')")), await ev('location.hash'))
  await ev("[...document.querySelectorAll('.rm-all tr.p')].find(r=>r.querySelector('.code').textContent==='EXT').click()"); await sleep(400)
  must('строка EXT открывает #/roadmap/EXT', (await ev('location.hash')) === '#/roadmap/EXT' && (await waitFor("document.querySelector('[data-sec=where]')")), await ev('location.hash'))
  must('крошки: Цех / Карта / EXT', (await text('.top')).includes('Цех/Карта/EXT'), (await text('.top')).slice(0, 40))
  must('заголовок вкладки', (await ev('document.title')).endsWith('Экстрактор · Карта EXT'), await ev('document.title'))
  await go('#/project/EXT', 1280, 800, 'light')
  await waitFor("document.querySelector('.bmap')")
  must('окно проекта: ссылка «Карта EXT» → #/roadmap/EXT', (await ev("document.querySelector('.bmap')?.getAttribute('href')")) === '#/roadmap/EXT', await text('.bmap'))

  for (const w of [1280, 400]) {
    const H = w === 400 ? 812 : 800
    for (const th of ['light', 'dark']) {
      const tag = `${w}/${th}`
      // ===== Г3 п.1 (поломка): проект без карты — серое «карты нет», остальные видны =====
      scenario = { all: ALL, one: mapEXT() }
      await go('#/roadmap', w, H, th)
      const rows = await ev("[...document.querySelectorAll('.rm-all tr.p')].map(r=>r.querySelector('.code').textContent+'|'+r.querySelector('.rm-cnt').textContent)")
      must(`${tag} все: три проекта, IPTV — «карты нет», EXT и INFRA — счётчики`, rows.length === 3 && rows.includes('IPTV|карты нет') && rows.includes('EXT|ждёт Ивана 1 · идей в обсуждении 1 · впереди 2'), rows)
      must(`${tag} все: «карты нет» серым`, (await ev("getComputedStyle([...document.querySelectorAll('.rm-all tr.p')].find(r=>r.textContent.includes('IPTV')).querySelector('.rm-cnt .faint')).color")) === (await ev("getComputedStyle(document.documentElement).getPropertyValue('--faint').trim()")).replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`), null)
      must(`${tag} все: нет горизонтальной прокрутки`, (await noHScroll()) <= 0, await noHScroll())
      await shot('ext103-all', w, th)
      await go('#/roadmap/IPTV', w, H, th)
      must(`${tag} IPTV: «карты нет», без ошибки`, (await text('[data-sec=nomap]'))?.startsWith('карты нет') && !(await text('.rm-warn')), await text('[data-sec=nomap]'))
      await shot('ext103-nomap', w, th)

      // ===== Г3 п.3 (исправный) + п.2 (поломка): карта EXT =====
      await go('#/roadmap/EXT', w, H, th)
      const order = await ev("[...document.querySelectorAll('[data-sec]')].map(e=>e.dataset.sec).join()")
      must(`${tag} EXT: порядок разделов`, order === 'where,ask,ideas,ahead,done,cancelled', order)
      must(`${tag} EXT: «Ждёт Ивана» = открытые qN (1)`, (await ev("document.querySelector('[data-sec=ask]>summary .cnt').textContent")) === '1', await ev("document.querySelector('[data-sec=ask]>summary').textContent"))
      const closedState = await ev("({q:document.querySelector('[data-sec=ask] details.grp').open, i:document.querySelector('[data-sec=ideas] details.grp').open, c:document.querySelector('[data-sec=cancelled]').open})")
      must(`${tag} EXT: закрытые вопросы, отброшенные идеи, «Снято» свёрнуты`, !closedState.q && !closedState.i && !closedState.c, closedState)
      const idea = (n) => `[...document.querySelectorAll('[data-sec=ideas] .rm-row')].find(r=>r.querySelector('.rm-n').textContent==='${n}')`
      must(`${tag} EXT: i4 → EXT-12 in-progress — «в работе», без следа`, (await ev(`${idea('i4')}.querySelector('.rm-st').textContent`)) === 'в работе' && !(await ev(`${idea('i4')}.querySelector('.rm-trc')`)), await ev(`${idea('i4')}.textContent`))
      must(`${tag} EXT: i5 → EXT-14 cancelled — «стала карточкой · карточка снята» серым, не «сделана»`, (await ev(`${idea('i5')}.querySelector('.rm-st').textContent`)) === 'стала карточкой · карточка снята' && (await ev(`${idea('i5')}.querySelector('.rm-st').classList.contains('s-gone')`)), await ev(`${idea('i5')}.textContent`))
      must(`${tag} EXT: номер карточки — ссылка на #/project/EXT/EXT-12`, (await ev(`${idea('i4')}.querySelector('a.rm-id').getAttribute('href')`)) === '#/project/EXT/EXT-12', null)
      const trc = await ev("[...document.querySelectorAll('[data-sec=ahead] .rm-trc')].map(t=>({cls:t.className,text:t.querySelector('.mono').textContent,title:t.title}))")
      must(`${tag} EXT: жёлтый след с подсказкой причины (no-origin)`, trc.some((t) => t.cls.includes('t-warn') && t.text === 'extractor@0c80182' && t.title.includes('no-origin') && t.title.includes('origin/main')), trc)
      must(`${tag} EXT: красный след с подсказкой причины (not-in-main)`, trc.some((t) => t.cls.includes('t-bad') && t.text === 'extractor@abc1234' && t.title.includes('not-in-main')), trc)
      must(`${tag} EXT: нет EXT-108 в данных → подписи «шаг» нет`, (await ev("document.querySelectorAll('.rm-step').length")) === 0 && !(await ev("document.body.textContent.includes('шаг 3 из')")), null)
      must(`${tag} EXT: маленькие под большой, «закрыто 1 из 2»`, (await ev("document.querySelector('[data-id=EXT-6] .rm-kids')?.textContent")).includes('EXT-7') && (await ev("document.querySelector('[data-id=EXT-6]>summary').textContent")).includes('закрыто 1 из 2'), await ev("document.querySelector('[data-id=EXT-6]>summary').textContent"))
      must(`${tag} EXT: «Сделано» — EXT-10, красный значок следа (нет контракта)`, (await ev("document.querySelector('[data-sec=done] [data-id=EXT-10] .trc.t-bad')?.textContent")) === '✕контракта закрытия нет', await ev("document.querySelector('[data-sec=done] [data-id=EXT-10]')?.textContent"))
      const waits = await ev("[...document.querySelectorAll('[data-sec=ahead] .rm-pi')].filter(p=>p.textContent.includes('ждёт')).map(p=>({num:p.querySelector('.rm-num').textContent,link:p.querySelector('.rm-amb a.rm-id')?.getAttribute('href')??null,text:p.querySelector('.rm-amb').textContent}))")
      must(`${tag} EXT: «ждёт EXT-9» — ссылкой, «ждёт слово Ивана» — текстом без ссылки`, JSON.stringify(waits) === JSON.stringify([{ num: '2.2', link: '#/project/EXT/EXT-9', text: 'ждёт EXT-9' }, { num: '2.3', link: null, text: 'ждёт слово Ивана' }]), waits)
      must(`${tag} EXT: «слово Ивана» не моноширинным`, (await ev("getComputedStyle([...document.querySelectorAll('.rm-wt')].find(e=>e.textContent==='слово Ивана')).fontFamily")).includes('Plex Sans'), await ev("getComputedStyle(document.querySelector('.rm-wt')).fontFamily"))
      const ml = await ev("getComputedStyle(document.querySelector('[data-sec=ahead] .rm-trc')).marginLeft")
      must(`${tag} EXT: у знака следа отступ слева (margin-left 4px)`, ml === '4px', ml)
      must(`${tag} EXT: кнопок записи нет`, (await ev("document.querySelectorAll('.rm-col button').length")) === 0, await ev("document.querySelectorAll('.rm-col button').length"))
      must(`${tag} EXT: нет горизонтальной прокрутки`, (await noHScroll()) <= 0, await noHScroll())
      await shot('ext103-map', w, th)
      await shot('ext103-map-full', w, th, true)
      // свой опрос: T-1 (EXT-12) → done без перезагрузки страницы — «сделана» со значком следа за ≤ 5 с
      scenario = { all: ALL, one: mapEXT({ t1: 'done' }) }
      const turned = await waitFor(`${idea('i4')}?.querySelector('.rm-st')?.textContent === 'сделана'`, 8000)
      must(`${tag} EXT: после done (опрос, без перезагрузки) — «сделана» со значком следа`, turned && (await ev(`${idea('i4')}.querySelector('.rm-trc.t-ok')?.title`)) != null, await ev(`${idea('i4')}.textContent`))
      if (w === 1280) await shot('ext103-map-done', w, th)

      // ===== EXT-108 в данных — подпись справа серым =====
      scenario = { all: ALL, one: mapEXT({ step108: true }) }
      await go('#/roadmap/EXT', w, H, th)
      must(`${tag} EXT-108: «тред EXT: шаг 3 из 6» у пункта 2`, JSON.stringify(await all('.rm-step')) === JSON.stringify(['тред EXT: шаг 3 из 6']), await all('.rm-step'))

      // ===== карта недоступна (roadmap-off) =====
      scenario = { all: fx('roadmap-off.json'), one: fx('roadmap-off.json'), off: fx('roadmap-off.json') }
      await go('#/roadmap', w, H, th)
      must(`${tag} off: строка «карта недоступна …», окно живо`, (await text('.rm-off'))?.startsWith('карта недоступна: модуль доски не найден'), await text('.rm-off'))
      await shot('ext103-off', w, th)
      await go('#/roadmap/EXT', w, H, th)
      must(`${tag} off: и в карте проекта`, (await text('.rm-off'))?.startsWith('карта недоступна'), await text('.rm-off'))
      scenario = { all: ALL, one: mapEXT() }

      // ===== соседи для сверки плотности: окно проекта EXT и «Цех» =====
      await go('#/project/EXT', w, H, th); await sleep(300)
      await shot('neighbor-project', w, th)
      await go('#/', w, H, th); await sleep(300)
      await shot('neighbor-ceh', w, th)
    }
  }
  // ===== опрос стоит, пока вкладка скрыта; вкладка снова видна — сразу запрос (ревью Голема, Мелочь 1) =====
  scenario = { all: ALL, one: mapEXT() }
  await go('#/roadmap/EXT', 1280, 800, 'light')
  await ev("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
  await sleep(1000)
  const h0 = S.intercepted['roadmap/EXT']; await sleep(11000); const h1 = S.intercepted['roadmap/EXT']
  must('скрытая вкладка: за 11 с ни одного запроса карты', h1 === h0, { before: h0, after: h1 })
  await ev("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))")
  await sleep(800)
  const h2 = S.intercepted['roadmap/EXT']
  must('вкладка снова видна: запрос сразу (≤ 0,8 с)', h2 === h1 + 1, { after: h1, back: h2 })
  await sleep(5600)
  must('и опрос пошёл дальше раз в 5 с', S.intercepted['roadmap/EXT'] >= h2 + 1, { back: h2, later: S.intercepted['roadmap/EXT'] })
  must('консоль: ни исключений, ни console.error / warning', S.console.length === 0, S.console)
  ws.close()
} catch (e) { S.error = String(e?.stack ?? e); log(`СБОЙ: ${S.error}`) } finally {
  // снимаем свой Chrome деревом — только пока он жив (номер вышедшего процесса может быть уже чужим, EXT-112)
  if (child && child.exitCode === null && child.signalCode === null) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ушёл */ } }
  server.close()
  await sleep(800)
  removeTree(tmp)
  S.tmpLeft = fs.existsSync(tmp)
}
fs.writeFileSync(path.join(SHOTS, 'ext103-summary.json'), JSON.stringify(S, null, 2))
log(`итог: не так ${S.fails.length}${S.fails.length ? ` (${S.fails.join('; ')})` : ''}; перехвачено: ${JSON.stringify(S.intercepted)}; прочих /api (404): ${S.other.length} (${[...new Set(S.other)].join(', ')}); профиль остался: ${S.tmpLeft}`)
process.exit(S.error || S.fails.length ? 1 : 0)
