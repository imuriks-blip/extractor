// Проба П.2 (EXT-33): кнопка «Принять» витрины — запись и Review → Done из node-процесса тем же инструментом
// доски (C:\projects\_plane-rest\plane.py close), без копии токена у витрины. Кириллица — аргументами процесса.
// Затем независимая сверка: plane.py show (статус) и ответ REST на комментарий (через MCP — рука дирижёра).
import { spawnSync } from 'node:child_process'

const card = process.argv[2] || 'EXT-34'
const html = '<p><b>Принято Иваном · кнопка витрины</b> (проба П.2, EXT-33): карточка Review → Done без участия Claude. Текст с кириллицей, «кавычками» и знаком №.</p>'
const t0 = Date.now()
const r = spawnSync('python', ['plane.py', 'close', 'Done', html, card], { cwd: 'C:/projects/_plane-rest', encoding: 'utf8', windowsHide: true })
const ms = Date.now() - t0
const s = spawnSync('python', ['plane.py', 'show', card], { cwd: 'C:/projects/_plane-rest', encoding: 'utf8', windowsHide: true })
console.log(JSON.stringify({ card, exit: r.status, ms, out: r.stdout.trim(), err: r.stderr.trim().slice(0, 300), show: s.stdout.trim() }, null, 2))
