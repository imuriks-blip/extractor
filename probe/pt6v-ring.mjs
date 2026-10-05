// Разбор звонка «перечитать» в журнале тем же разбором, что у витрины (lib/journal-parse.mjs); без побочных эффектов при импорте.
// Нужен пробе probe/pt6v-drive.mjs и test/probe-pt6v-ring.test.mjs. mutate правит сырой JSON строки (отрицательные контроли).
import { newSessionState, feedSession } from '../lib/journal-parse.mjs'

// «прочитано» — по форме звонка (st.rings[id]); звонок «перечитать» — не сообщение Ивана. Вопрос к Ивану в конце хода ставится
// синтетической строкой ассистента, чтобы было что снимать.
export const parseRing = (lines, ringI, id, mutate = (raw) => raw) => {
  const st = newSessionState()
  feedSession(st, { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000070', timestamp: '2026-10-05T08:59:00.000Z', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово. Сливать?' }] } })
  const q0 = st.thread.endTurnQ
  feedSession(st, JSON.parse(mutate(JSON.stringify(lines[ringI]))))
  return { read: !!st.rings?.[id], readAt: st.rings?.[id] ?? null, ivanCount: st.ivan.count, questionBefore: q0, questionAfter: st.thread.endTurnQ }
}
