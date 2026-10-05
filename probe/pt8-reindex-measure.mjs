// Замер пересбора индекса журналов на настоящем объёме (EXT-75, ПТ8; вердикт Голема дирижёра, Важно 2: проба шла на 31 журнале,
// rebuild держит два полных состояния в памяти). Читатель журналов этой копии — на НАСТОЯЩИХ журналах ~/.claude/projects, только
// чтение, со своим indexDir во временной папке; затем отрицательный контроль — тот же замер на 31 журнале пробы pt8-drive.
// Каждый набор — в отдельном дочернем node (windowsHide), чтобы пик памяти был его, а не соседа:
//   обычное построение индекса (как при старте: полный проход, запись индекса) → rebuild(); время каждого, пик rss и heapUsed
//   (опрос раз в 200 мс + отсчёт на границах фаз), журналов и строк.
// Запись читателя идёт через охрану fs: любая запись вне своего indexDir — отказ и красный итог (настоящие журналы не тронуты).
// Временные папки удаляются в конце unlinkSync по файлам и rmdirSync по пустым каталогам (не rmSync).
//   node probe/pt8-reindex-measure.mjs [all|probe|real] [корень журналов, по умолчанию C:/Users/imuri/.claude/projects]
// Живая витрина: только GET /api/health (rss, журналов, строк) для сравнения. Охранник — до первой записи.
import { spawnSync } from 'node:child_process'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { guardLive } from './guard-live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
guardLive(REPO, 0)
const fs = nodeFs
const REAL_ROOT = 'C:/Users/imuri/.claude/projects'
const CHILD_TIMEOUT_MS = 540000 // 9 мин на набор: дольше — сам по себе признак (порог ТЗ — пересбор 10 мин)

// ---------- удаление дерева: unlinkSync по файлам, rmdirSync по пустым каталогам ----------
function removeTree(dir) {
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of names) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) removeTree(p)
    else try { fs.unlinkSync(p) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  try { fs.rmdirSync(dir) } catch (err) { if (err.code !== 'ENOENT') throw err }
}

const inside = (dir, p) => { const r = path.relative(path.resolve(dir), path.resolve(String(p))); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

// ================= дочерний: один набор журналов =================
async function child(root, indexDir) {
  const { createJournalReader } = await import('../lib/journal-reader.mjs')
  const { resolveReread } = await import('../lib/rules-reread.mjs')
  const { EDIT_RESERVE_MS, EDIT_WINDOW_H } = await import('../lib/journal-parse.mjs')
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config.default.json'), 'utf8'))
  // охрана: запись — только в свой indexDir
  const violations = []
  const W = ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'createWriteStream', 'truncateSync', 'utimesSync']
  const gfs = { ...nodeFs }
  for (const k of W) gfs[k] = (p, ...a) => {
    const ps = k === 'renameSync' || k === 'copyFileSync' ? [p, a[0]] : [p]
    for (const x of ps) if (!inside(indexDir, x)) { violations.push(`${k} ${x}`); throw Object.assign(new Error('read-only'), { code: 'EPROBE_RO' }) }
    return nodeFs[k](p, ...a)
  }
  gfs.createReadStream = (p, o) => {
    if (o && typeof o === 'object' && o.flags && o.flags !== 'r') { violations.push(`createReadStream ${p} ${o.flags}`); throw Object.assign(new Error('read-only'), { code: 'EPROBE_RO' }) }
    return nodeFs.createReadStream(p, o)
  }
  const rr = resolveReread(cfg.rulesReread?.files ?? [], { vaultRoot: cfg.paths?.vault ?? null, home: os.homedir() })
  const cwh = cfg.thresholds?.collisionWindowH
  const opts = { root, indexDir, fs: gfs, rules: cfg.boardWriteTools ?? [], reread: rr.files, rereadOff: rr.off, indexWriteEveryS: cfg.indexWriteEveryS ?? 60,
    editKeepMs: (Number.isFinite(cwh) && cwh > 0 ? cwh : EDIT_WINDOW_H) * 3600000 + EDIT_RESERVE_MS }

  const MB = (b) => Math.round(b / 1048576)
  const peak = { phase: 'idle', build: { rss: 0, heap: 0 }, rebuild: { rss: 0, heap: 0 } }
  const sample = () => { const m = process.memoryUsage(); const p = peak[peak.phase]; if (p) { p.rss = Math.max(p.rss, m.rss); p.heap = Math.max(p.heap, m.heapUsed) } return m }
  const timer = setInterval(sample, 200)
  const base = process.memoryUsage()

  const reader = createJournalReader(opts)
  peak.phase = 'build'; sample()
  let t = performance.now()
  await reader.refresh({ full: true })
  sample()
  const buildMs = Math.round(performance.now() - t)
  const s1 = reader.state()
  const afterBuild = process.memoryUsage()

  peak.phase = 'rebuild'; peak.rebuild.rss = afterBuild.rss; peak.rebuild.heap = afterBuild.heapUsed
  let progress = 0; let total = null
  t = performance.now()
  let rebuildErr = null
  let r = null
  try { r = await reader.rebuild({ onProgress: (d, n) => { progress = d; total = n; sample() } }) } catch (e) { rebuildErr = e.code ?? String(e) }
  sample()
  const rebuildMs = Math.round(performance.now() - t)
  peak.phase = 'idle'
  clearInterval(timer)
  const s2 = reader.state()
  const afterRebuild = process.memoryUsage()
  const out = {
    root, node: process.version,
    files: s1.files, lines: s1.lines, buildErrors: s1.errors, indexBytes: s1.indexBytes,
    buildMs, rebuildMs, rebuildFiles: r?.files ?? null, rebuildLines: s2.lines, rebuildErr, progress: `${progress}/${total}`, indexBytesAfter: s2.indexBytes,
    baseRssMB: MB(base.rss), baseHeapMB: MB(base.heapUsed),
    peakBuildRssMB: MB(peak.build.rss), peakBuildHeapMB: MB(peak.build.heap),
    afterBuildRssMB: MB(afterBuild.rss), afterBuildHeapMB: MB(afterBuild.heapUsed),
    peakRebuildRssMB: MB(peak.rebuild.rss), peakRebuildHeapMB: MB(peak.rebuild.heap),
    afterRebuildRssMB: MB(afterRebuild.rss), afterRebuildHeapMB: MB(afterRebuild.heapUsed),
    violations,
  }
  console.log(`RESULT ${JSON.stringify(out)}`)
}

// ================= родитель =================
function probeJournals(dst) {
  // тот же набор, что у pt8-drive: сессия с двумя субагентами + 28 сессий из фикстур = 31 журнал
  const FX = path.join(REPO, 'test', 'fixtures', 'journals')
  const proj = path.join(dst, 'C--pt8-demo')
  const SID = '2fea3135-c7db-442b-9907-4d619949881d'
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true })
  fs.copyFileSync(path.join(FX, `${SID}.jsonl`), path.join(proj, `${SID}.jsonl`))
  for (const f of fs.readdirSync(path.join(FX, SID, 'subagents'))) fs.copyFileSync(path.join(FX, SID, 'subagents', f), path.join(proj, SID, 'subagents', f))
  const tops = fs.readdirSync(FX).filter((n) => n.endsWith('.jsonl'))
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  for (let i = 0; i < 28; i++) fs.copyFileSync(path.join(FX, tops[i % tops.length]), path.join(proj, `${uuid(100 + i)}.jsonl`))
}

function runChild(label, root, indexDir) {
  const t = Date.now()
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', root, indexDir], { encoding: 'utf8', windowsHide: true, timeout: CHILD_TIMEOUT_MS, maxBuffer: 20e6 })
  const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '))
  console.log(`${label}: дочерний pid ${r.pid}, код ${r.status}, сигнал ${r.signal ?? '-'}, ${Math.round((Date.now() - t) / 1000)} с`)
  if (r.stderr?.trim()) console.log(`${label} stderr: ${r.stderr.trim().slice(-2000)}`)
  if (!line) return { label, failed: r.error?.code ?? r.signal ?? `exit ${r.status}` }
  return { label, ...JSON.parse(line.slice(7)) }
}

const liveHealth = () => new Promise((resolve) => {
  const req = http.get('http://127.0.0.1:4317/api/health', { timeout: 5000 }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } }) })
  req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null))
})

async function parent(mode, realRoot) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt8-measure-'))
  console.log(`временная папка: ${tmp}`)
  const results = []
  let bad = false
  try {
    if (mode === 'all' || mode === 'probe') {
      const jroot = path.join(tmp, 'probe-journals')
      fs.mkdirSync(jroot)
      probeJournals(jroot)
      results.push(runChild('проба (31)', jroot, path.join(tmp, 'probe-index')))
    }
    if (mode === 'all' || mode === 'real') results.push(runChild('настоящие', realRoot, path.join(tmp, 'real-index')))
  } finally {
    removeTree(tmp)
    console.log(`временная папка удалена: ${!fs.existsSync(tmp)}`)
  }
  for (const r of results) {
    console.log(`${r.label}: ${JSON.stringify(r)}`)
    if (r.failed || r.rebuildErr || r.buildErrors || r.violations?.length) bad = true
  }
  console.log('| набор | журналов | строк | построение, с | пересбор, с | пик rss построения, МБ | пик heapUsed построения, МБ | rss после построения, МБ | пик rss пересбора, МБ | пик heapUsed пересбора, МБ | индекс, МБ |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) if (!r.failed) console.log(`| ${r.label} | ${r.files} | ${r.lines} | ${(r.buildMs / 1000).toFixed(1)} | ${(r.rebuildMs / 1000).toFixed(1)} | ${r.peakBuildRssMB} | ${r.peakBuildHeapMB} | ${r.afterBuildRssMB} | ${r.peakRebuildRssMB} | ${r.peakRebuildHeapMB} | ${(r.indexBytes / 1048576).toFixed(1)} |`)
  const h = await liveHealth()
  if (h) console.log(`живая витрина (GET /api/health): rss ${Math.round(h.rss / 1048576)} МБ, журналов ${h.readers?.journals?.files}, строк ${h.readers?.journals?.lines}, индекс ${((h.readers?.journals?.indexBytes ?? 0) / 1048576).toFixed(1)} МБ, uptime ${h.uptimeS} с`)
  else console.log('живая витрина: /api/health не ответил')
  console.log(bad ? 'ИТОГ: красный' : 'ИТОГ: зелёный')
  process.exitCode = bad ? 1 : 0
}

if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4])
else await parent(process.argv[2] ?? 'all', process.argv[3] ?? REAL_ROOT)
