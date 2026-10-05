// Проверки (а)/(б) пробы probe/pt6v-drive.mjs без живых сессий: тот же приём (разбор строки журнала разбором витрины,
// строка слова правится на сыром JSON) на строке в форме звонка. Живой прогон пробы с настоящим журналом claude.exe — не делался.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringText } from '../lib/pult/bell.mjs';
import { parseRing as parseRingLines } from '../probe/pt6v-ring.mjs';
const parseRing = (line, id, mutate) => parseRingLines([line], 0, id, mutate);

const ID = 'W-261005-120000-a1b2';
const reread = { id: ID, at: '2026-10-05T09:00:00.000Z', action: 'reread', card: null, word: 'перечитай правила', paths: ['C:/v/CLAUDE.md', 'C:/v/Субагенты.md'], note: 'проба' };
const ringLine = { parentUuid: null, isSidechain: false, type: 'user', uuid: '00000000-0000-4000-8000-000000000077', timestamp: '2026-10-05T09:02:00.000Z',
  message: { role: 'user', content: `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${ringText([reread])}\n</system-reminder>` },
  origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', userType: 'external', sessionId: '00000000-0000-4000-8000-000000000001' };

const OTHER = 'W-261005-115900-c3d4 · 11:59 · без карточки · «да»';
const addWord = (raw) => { const n = '«перечитай правила»'; assert.ok(raw.includes(n)); return raw.replace(n, `${n}\\n${OTHER}`); };

test('проба ПТ6в (а): «прочитано» — по форме звонка в журнале (st.rings)', () => {
  assert.equal(parseRing(ringLine, ID).read, true);
});

test('проба ПТ6в (б): звонок «перечитать» не сообщение Ивана — вопрос треда остался', () => {
  const r = parseRing(ringLine, ID);
  assert.deepEqual([r.ivanCount, r.questionBefore, r.questionAfter], [0, true, true]);
});

test('проба ПТ6в (б), отрицательный контроль: «перечитай» + обычное слово или карточка — сообщение Ивана, вопрос снят', () => {
  const mixed = parseRing(ringLine, ID, addWord);
  assert.equal(mixed.ivanCount, 1); assert.equal(mixed.questionAfter, null); assert.equal(mixed.read, true);
  const card = parseRing(ringLine, ID, (raw) => raw.replace('без карточки · «перечитай правила»', 'EXT-65 · «перечитай правила»'));
  assert.equal(card.ivanCount, 1); assert.equal(card.questionAfter, null);
});
