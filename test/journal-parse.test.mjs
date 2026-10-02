// Разбор журналов (спека витрины 1.4, 1.5, 2.1–2.3; гейт п.4). Фикстуры — вырезанные строки живой формы
// журнала дирижёра 2fea3135-… (30.09–01.10) и других журналов Vault, тексты заменены заглушкой «<текст>».
// Ожидаемые числа — посчитаны по исходным строкам руками (номера строк — в комментариях), не кодом под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIvanMessage, isConductorMessage, newAgentState, feedAgent, agentSummary,
  newSessionState, feedSession, parseBoardWrite, resolveRef, SERVICE_PREFIXES,
} from '../lib/journal-parse.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const SID = '2fea3135-c7db-442b-9907-4d619949881d';
const lines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MAIN = lines(`${SID}.jsonl`);
const GOLEM = 'a42239d892036e800';
const BARD = 'a6af58a91a45a6c7b';
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'config.default.json'), 'utf8')).boardWriteTools;
const clone = (d) => JSON.parse(JSON.stringify(d));
const hasText = (d) => typeof d.message?.content === 'string' || (Array.isArray(d.message?.content) && d.message.content.some((p) => p.type === 'text'));

function session(ls) {
  const st = newSessionState();
  for (const d of ls) feedSession(st, d, { rules: RULES });
  return st;
}
const upTo = (pred) => MAIN.slice(0, MAIN.findIndex(pred) + 1);
const toolUseOf = (name, i = 0) => MAIN.filter((d) => d.type === 'assistant' && d.message.content.some((p) => p.type === 'tool_use' && p.name === name))[i];
const resultFor = (useLine) => MAIN.find((d) => d.type === 'user' && Array.isArray(d.message.content) && d.message.content.some((p) => p.tool_use_id === useLine.message.content.find((q) => q.type === 'tool_use').id));

// ---------- 2.1: сообщение Ивана ----------

test('2.1: настоящее сообщение Ивана (origin human, строка) — считается', () => {
  const ivan = MAIN.filter((d) => d.type === 'user' && d.origin?.kind === 'human');
  assert.equal(ivan.length, 2); // строки 6 и 62 журнала дирижёра
  for (const d of ivan) assert.equal(isIvanMessage(d), true);
});

test('2.1: каждая служебная форма user — не сообщение Ивана (и каждая — текстовая, т.е. тест зрячий)', () => {
  const forms = {
    'результат инструмента': MAIN.find((d) => d.type === 'user' && Array.isArray(d.message.content) && d.message.content.every((p) => p.type === 'tool_result')),
    '<task-notification>': MAIN.find((d) => d.type === 'user' && typeof d.message.content === 'string' && d.message.content.startsWith('<task-notification>')),
    'isMeta (картинка)': MAIN.find((d) => d.type === 'user' && d.isMeta === true && Array.isArray(d.message.content)),
    '<local-command-caveat> isMeta': MAIN.find((d) => d.type === 'user' && String(d.message.content).startsWith('<local-command-caveat>')),
    '<command-name>': MAIN.find((d) => d.type === 'user' && String(d.message.content).startsWith('<command-name>')),
    '<local-command-stdout>': MAIN.find((d) => d.type === 'user' && String(d.message.content).startsWith('<local-command-stdout>')),
    '[Request interrupted by user] — новая форма': MAIN.find((d) => d.type === 'user' && Array.isArray(d.message.content) && d.message.content[0]?.text?.startsWith('[Request interrupted')),
    'итог субагента (origin peer, isMeta) — новая форма': MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'peer'),
    'сводка сжатия (isCompactSummary) — новая форма': lines('compact.jsonl')[0],
  };
  for (const [name, d] of Object.entries(forms)) {
    assert.ok(d, `в фикстуре нет формы ${name}`);
    if (name !== 'результат инструмента') assert.ok(hasText(d), `${name}: форма текстовая — без исключения сочлась бы`);
    assert.equal(isIvanMessage(d), false, name);
  }
  // вставка хука: строка вида attachment (hook_additional_context) и system с hookAdditionalContext
  for (const d of MAIN.filter((x) => x.type === 'attachment' || x.type === 'system')) assert.equal(isIvanMessage(d), false, d.type);
  // <system-reminder> строкой (форма из журналов субагентов) — по списку префиксов
  const sr = clone(MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'human'));
  sr.message.content = '<system-reminder>\n<текст>';
  delete sr.origin;
  assert.equal(isIvanMessage(sr), false);
  assert.ok(SERVICE_PREFIXES.includes('<system-reminder>'));
});

test('2.1: isSidechain-строка с текстом — не сообщение Ивана', () => {
  const d = clone(MAIN.find((x) => x.type === 'user' && x.origin?.kind === 'human'));
  d.isSidechain = true;
  assert.equal(isIvanMessage(d), false);
});

// ---------- 1.5: ходы и заходы ----------

function agent(id) {
  const st = newAgentState();
  for (const d of lines(`${SID}/subagents/agent-${id}.jsonl`)) feedAgent(st, d);
  return agentSummary(st);
}

test('1.5: заход после продолжения начинается с нуля (Голем: 2 продолжения)', () => {
  // вырезка: ходы yk6d Sk7n RUjP | продолжение (стр. 34) | GadX | продолжение (стр. 71) | hJjL fajm; QENX и UZax — без вызовов
  const s = agent(GOLEM);
  assert.deepEqual(s.zakhods, [3, 1, 2]);
  assert.equal(s.turns, 6);
  assert.equal(s.maxZakhod, 3);
  assert.equal(s.currentZakhod, 2);
});

test('1.5: служебная user посреди захода (isMeta, загрузка навыка) заход не режет — расхождение с agent-contract названо', () => {
  // вырезка Бальда: THTs f9j6 6Ngw | isMeta-текст (стр. 30) | eqA8 | isMeta-текст (стр. 36) | CJZx | продолжение (стр. 117) | knVR
  const s = agent(BARD);
  assert.deepEqual(s.zakhods, [5, 1]);
  assert.equal(s.turns, 6);
  const sub = lines(`${SID}/subagents/agent-${BARD}.jsonl`);
  const metaText = sub.filter((d) => d.type === 'user' && d.isMeta === true && hasText(d) && d.origin?.kind !== 'coordinator');
  assert.ok(metaText.length >= 2);
  for (const d of metaText) assert.equal(isConductorMessage(d), false);
  const cont = sub.filter((d) => d.origin?.kind === 'coordinator');
  assert.equal(cont.length, 1);
  assert.equal(isConductorMessage(cont[0]), true, 'продолжение дирижёра — isMeta с origin coordinator — граница захода');
  assert.equal(isConductorMessage(sub[0]), true, 'ТЗ — первая граница');
});

// ---------- 2.2: запуски, продолжения, итоги, живость ----------

test('2.2: Голем — запуск, обрыв задачей (stopped), 2 продолжения, итоги-передачи; в конце не живой', () => {
  const st = session(MAIN);
  const r = st.runs[GOLEM];
  assert.ok(r, 'запуск Голема распознан по toolUseResult.agentId');
  assert.equal(r.agentType, 'golem');
  assert.equal(r.continuations, 2);
  assert.equal(r.alive, false);
});

test('2.2: продолженный агент без итога продолжения — живой; с итогом — не живой', () => {
  const sendRes = MAIN.filter((d) => d.type === 'user' && d.toolUseResult?.resumedAgentId === GOLEM);
  // до результата второго SendMessage (стр. 975), без передачи итога (стр. 986)
  const st = session(upTo((d) => d === sendRes[1]));
  assert.equal(st.runs[GOLEM].alive, true);
  assert.equal(st.runs[GOLEM].continuations, 2);
  const st2 = session(upTo((d) => d.origin?.kind === 'peer' && d.origin.from === GOLEM && MAIN.indexOf(d) > MAIN.indexOf(sendRes[1])));
  assert.equal(st2.runs[GOLEM].alive, false);
});

test('2.2: первый запуск async_launched без итога — живой; уведомление stopped по task-id — итог', () => {
  const launchRes = MAIN.find((d) => d.toolUseResult?.agentId === GOLEM);
  assert.equal(launchRes.toolUseResult.status, 'async_launched');
  assert.equal(session(upTo((d) => d === launchRes)).runs[GOLEM].alive, true);
  const notif = MAIN.find((d) => typeof d.message?.content === 'string' && d.message.content.includes(`<task-id>${GOLEM}</task-id>`));
  assert.equal(session(upTo((d) => d === notif)).runs[GOLEM].alive, false);
});

test('2.2: уведомление о прошлом заходе (tool-use-id старого продолжения) новый заход не закрывает', () => {
  const bard = MAIN.filter((d) => MAIN.indexOf(d) >= MAIN.findIndex((x) => x.toolUseResult?.agentId === BARD) - 1);
  const notif = bard.find((d) => typeof d.message?.content === 'string' && d.message.content.includes(`<task-id>${BARD}</task-id>`));
  const lastSend = MAIN.filter((d) => d.type === 'assistant' && d.message.content.some((p) => p.name === 'SendMessage' && p.input.to === BARD)).at(-1);
  const lastSendRes = resultFor(lastSend);
  // переставить: уведомление о заходе YURfQn приходит после старта нового захода (BeRfGS)
  const seq = [...MAIN.slice(0, MAIN.indexOf(lastSendRes) + 1).filter((d) => d !== notif), notif];
  const st = session(seq);
  assert.equal(st.runs[BARD].alive, true);
  // исправный порядок — Бальд к концу вырезки не живой
  assert.equal(session(MAIN).runs[BARD].alive, false);
});

test('2.2: SendMessage живому агенту (без resumedAgentId) — не новый старт, не продолжение', () => {
  const st = session(MAIN);
  // Бальду: 3 вызова SendMessage (стр. 1127, 1145, 1185), из них 1 — живому (стр. 1145/1146, без resumedAgentId)
  assert.equal(st.runs[BARD].continuations, 2);
  assert.equal(st.runs[BARD].messages, 3);
});

// ---------- 2.3: PARTIAL ----------

test('2.3: PARTIAL — внутри tool_result вызова Agent и внутри уведомления о задаче', () => {
  const st = session(lines('partial.jsonl'));
  const where = st.partials.map((p) => p.where).sort();
  assert.deepEqual(where, ['Agent', 'notification']);
  for (const p of st.partials) assert.equal(p.limit, 3);
});

test('2.3: цитата фразы обрыва вне результата Agent/SendMessage/уведомления — не PARTIAL; исправный запуск не помечен', () => {
  const phrase = ' stopped at its 90-turn limit ';
  const inject = (d) => JSON.parse(JSON.stringify(d).replaceAll('<текст>', `<текст>${phrase}`));
  const quoted = [
    ...MAIN.filter((d) => d.origin?.kind === 'peer'), // отчёт субагента цитирует
    ...MAIN.filter((d) => d.type === 'queue-operation'),
    MAIN.find((d) => d.type === 'user' && Array.isArray(d.message.content) && d.message.content.some((p) => p.type === 'tool_result') && !d.toolUseResult?.agentId && typeof d.toolUseResult === 'object' && !('resumedAgentId' in d.toolUseResult)),
    toolUseOf('Agent'), // prompt вызова Agent
  ].map(inject);
  // тест зрячий: фраза в подменённых строках есть
  for (const d of quoted) assert.ok(JSON.stringify(d).includes('stopped at its 90-turn limit'));
  const st = session([...MAIN.filter((d) => !d.origin || d.origin.kind !== 'peer'), ...quoted]);
  assert.deepEqual(st.partials, []);
  // тот же поток, но фраза — в результате вызова Agent → PARTIAL есть (отрицательный контроль)
  const launchRes = inject(MAIN.find((d) => d.toolUseResult?.agentId === GOLEM));
  const st2 = session(MAIN.map((d) => (d.toolUseResult?.agentId === GOLEM ? launchRes : d)));
  assert.equal(st2.partials.length, 1);
  assert.equal(st2.partials[0].agentId, GOLEM);
});

// ---------- 1.4: вызовы записи на доску ----------

test('1.4: boardWriteTools в config.default.json — имена, снятые с живого журнала', () => {
  const tools = RULES.flatMap((r) => [].concat(r.tool));
  assert.ok(tools.includes('mcp__plane__create_work_item_comment'));
  assert.ok(tools.includes('Bash'));
  assert.ok(RULES.some((r) => r.command === 'plane.py' && r.sub === 'close'));
});

test('1.4: успешные записи MCP «⏸ получен» и «▶ выдан» — первая строка и UUID карточки; разрешение UUID через index.json зеркала', () => {
  // вырезка: журнал 01cb2e54-…, стр. 6501/6502 (⏸) и 6803/6804 (▶)
  const st = session(lines('board-write.jsonl'));
  assert.equal(st.boardWrites.length, 2);
  assert.match(st.boardWrites[0].firstLine, /^⏸ получен:/);
  assert.match(st.boardWrites[1].firstLine, /^▶ выдан:/);
  const w = st.boardWrites[1];
  assert.equal(w.tool, 'mcp__plane__create_work_item_comment');
  assert.match(w.refs[0], /^[0-9a-f-]{36}$/);
  const idx = { cards: { 'EXT-6': { uuid: w.refs[0] } } };
  assert.equal(resolveRef(w.refs[0], idx), 'EXT-6');
  assert.equal(resolveRef('EXT-7', idx), 'EXT-7');
  assert.equal(resolveRef('00000000-0000-0000-0000-000000000000', idx), null);
});

test('1.4: запись с ошибкой в результате — не учитывается; чтение комментов — не запись', () => {
  const [use, res] = lines('board-write.jsonl');
  assert.equal(session([use, res]).boardWrites.length, 1, 'исправный случай');
  const bad = clone(res);
  bad.message.content[0].is_error = true;
  assert.equal(session([use, bad]).boardWrites.length, 0);
  const list = clone(use);
  list.message.content.find((p) => p.type === 'tool_use').name = 'mcp__plane__list_work_item_comments';
  assert.equal(parseBoardWrite(list.message.content.find((p) => p.type === 'tool_use'), RULES), null);
});

test('1.4: plane.py close через Bash — номер карточки из командной строки', () => {
  const use = MAIN.find((d) => d.type === 'assistant' && d.message.content.some((p) => /plane\.py close/.test(p.input?.command ?? '')));
  const st = session([use, resultFor(use)]);
  assert.equal(st.boardWrites.length, 1);
  assert.deepEqual(st.boardWrites[0].refs, ['EXT-23']);
});

test('1.4: журнал дирижёра: MCP-коммент и plane.py close учтены, оба успешны', () => {
  const st = session(MAIN);
  assert.equal(st.boardWrites.filter((w) => w.tool === 'mcp__plane__create_work_item_comment').length, 1);
  assert.equal(st.boardWrites.length, 2); // + plane.py close (стр. 1372/1373)
});
