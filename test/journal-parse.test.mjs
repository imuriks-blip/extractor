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

// ---------- формы итога, найденные живым проходом 02.10 (в спеке не названы) ----------

const golemLaunch = () => MAIN.slice(0, MAIN.findIndex((d) => d.toolUseResult?.agentId === GOLEM) + 1);
const retarget = (d, from, to) => JSON.parse(JSON.stringify(d).replaceAll(from, to));

test('итог: уведомление, пришедшее вложением queued_command (журнал bbd77ac1-…, стр. 4584), закрывает заход', () => {
  const [att] = lines('notification-attachment.jsonl');
  assert.equal(att.attachment.type, 'queued_command');
  assert.equal(session(golemLaunch()).runs[GOLEM].alive, true, 'исправный: без уведомления — живой');
  assert.equal(session([...golemLaunch(), retarget(att, 'abc69cad342028111', GOLEM)]).runs[GOLEM].alive, false);
  // уведомление о другом агенте — не итог этого
  assert.equal(session([...golemLaunch(), att]).runs[GOLEM].alive, true);
});

test('итог: PARTIAL во вложении-уведомлении считается один раз, даже если то же уведомление пришло и строкой user', () => {
  const [att] = lines('notification-attachment.jsonl');
  const a = retarget(att, '<summary><текст>', '<summary><текст> stopped at its 40-turn limit');
  const userForm = clone(MAIN.find((d) => typeof d.message?.content === 'string' && d.message.content.includes(`<task-id>${GOLEM}</task-id>`)));
  userForm.message.content = a.attachment.prompt;
  const st = session([...golemLaunch(), a, userForm]);
  assert.equal(st.partials.length, 1);
  assert.equal(st.partials[0].where, 'notification');
});

test('итог: TaskStop агента дирижёром (журнал c950e50f-…, стр. 1475/1476) закрывает заход; с ошибкой — нет', () => {
  const [use, res] = lines('task-stop.jsonl').map((d) => retarget(d, 'ad2de3ac2168c9a83', GOLEM));
  assert.equal(session([...golemLaunch(), use, res]).runs[GOLEM].alive, false);
  const bad = clone(res);
  bad.message.content[0].is_error = true;
  assert.equal(session([...golemLaunch(), use, bad]).runs[GOLEM].alive, true);
});

test('продолжение с resumedAgentId — новый старт, даже если прошлый итог не распознан', () => {
  // без итога первого захода (уведомление и передача выкинуты) продолжение всё равно считается
  const seq = MAIN.filter((d) => !(d.origin?.kind === 'peer') && !(typeof d.message?.content === 'string' && d.message.content.includes(`<task-id>${GOLEM}</task-id>`)));
  assert.equal(session(seq).runs[GOLEM].continuations, 2);
});

test('мелочь 1: уведомление массивом [{type:text}] — тоже итог', () => {
  const notif = clone(MAIN.find((d) => typeof d.message?.content === 'string' && d.message.content.includes(`<task-id>${GOLEM}</task-id>`)));
  notif.message.content = [{ type: 'text', text: notif.message.content }];
  assert.equal(session([...golemLaunch(), notif]).runs[GOLEM].alive, false);
});

test('мелочь 2: SendMessage без запуска в журнале — запуск по resumedAgentId, а не по полю to', () => {
  const send = MAIN.filter((d) => d.type === 'assistant' && d.message.content.some((p) => p.name === 'SendMessage' && p.input.to === GOLEM))[0];
  const use = retarget(send, `"to":"${GOLEM}"`, '"to":"golem-по-имени"');
  const st = session([use, resultFor(send)]);
  assert.ok(st.runs[GOLEM], 'запуск под agentId из resumedAgentId');
  assert.equal(st.runs[GOLEM].continuations, 1);
  assert.equal(st.runs['golem-по-имени'], undefined);
});

// ---------- решение дирижёра 02.10: сообщение Ивана, пришедшее вложением queued_command (commandMode: prompt) ----------

test('2.1: вложение queued_command с commandMode prompt (журнал дирижёра, стр. 767) — сообщение Ивана, с номерами карточек', () => {
  const [q] = lines('queued-prompt.jsonl');
  assert.equal(q.attachment.commandMode, 'prompt');
  const withCard = clone(q);
  withCard.attachment.prompt = 'заглушка EXT-26 заглушка';
  const st = session([withCard]);
  assert.equal(st.ivan.count, 1);
  assert.deepEqual(Object.keys(st.ivan.cards), ['EXT-26']);
  assert.equal(st.ivan.lastAt, q.timestamp);
});

test('2.1: вложение и следом строка user с тем же текстом — одно сообщение; с другим текстом — два', () => {
  const [q] = lines('queued-prompt.jsonl');
  const ivan = clone(MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'human'));
  ivan.message.content = q.attachment.prompt;
  assert.equal(session([q, ivan]).ivan.count, 1);
  const other = clone(ivan);
  other.message.content = 'другая заглушка';
  assert.equal(session([q, other]).ivan.count, 2, 'исправный случай: разные тексты — два сообщения');
});

test('2.1: вложение queued_command с уведомлением — не сообщение Ивана', () => {
  const [att] = lines('notification-attachment.jsonl');
  assert.equal(session([att]).ivan.count, 0);
  const [q] = lines('queued-prompt.jsonl');
  const notif = clone(q);
  notif.attachment.prompt = att.attachment.prompt;
  assert.equal(session([notif]).ivan.count, 0, 'даже с commandMode prompt');
});

test('2.1: «да» вложением → ответ ассистента → «да» строкой user — два сообщения (повтор Ивана, не дубль)', () => {
  const [q] = lines('queued-prompt.jsonl');
  const reply = MAIN.find((d) => d.type === 'assistant');
  const again = clone(MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'human'));
  again.message.content = q.attachment.prompt;
  again.timestamp = new Date(Date.parse(q.timestamp) + 120000).toISOString(); // через 2 мин
  const st = session([q, reply, again]);
  assert.equal(st.ivan.count, 2);
  assert.equal(st.ivan.lastAt, again.timestamp, 'время последнего сообщения Ивана сдвинулось');
});

test('2.1: склейка — по связи «тот же пакет ввода» (между вложением и строкой нет assistant), не по времени', () => {
  const [q] = lines('queued-prompt.jsonl');
  const same = clone(MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'human'));
  same.message.content = q.attachment.prompt;
  same.timestamp = new Date(Date.parse(q.timestamp) + 10 * 60000).toISOString(); // 10 мин, ответа между нет
  assert.equal(session([q, same]).ivan.count, 1);
});

// ---------- слово Ивана 02.10 «картинка — да, считается»: сообщение из одной картинки без текста (EXT-27) ----------
// Фикстура image-only.jsonl — две строки живой формы (журнал 01cb2e54-…, стр. 2338; журнал 59a4e21c-…, стр. 2170),
// данные картинки заменены заглушкой 1×1. Живой проход 02.10: таких строк user 202, вложений с картинкой — 3.
const [IMG_USER, IMG_QUEUED] = lines('image-only.jsonl');
const otherImage = (d) => { const x = clone(d); const parts = x.message?.content ?? x.attachment.prompt; parts[0].source.data = 'AAAA'; return x; };

test('2.1: строка user только с картинкой (origin human) — сообщение Ивана', () => {
  assert.equal(IMG_USER.message.content.every((p) => p.type === 'image'), true, 'форма без текста');
  assert.equal(isIvanMessage(IMG_USER), true);
  const st = session([IMG_USER]);
  assert.equal(st.ivan.count, 1);
  assert.equal(st.ivan.lastAt, IMG_USER.timestamp);
});

test('2.1: картинка с isMeta, isSidechain или в паре со служебным текстом — не сообщение Ивана (контроль)', () => {
  assert.equal(isIvanMessage({ ...clone(IMG_USER), isMeta: true }), false);
  assert.equal(isIvanMessage({ ...clone(IMG_USER), isSidechain: true }), false);
  const svc = clone(IMG_USER);
  svc.message.content.push({ type: 'text', text: '<system-reminder>заглушка</system-reminder>' });
  assert.equal(isIvanMessage(svc), false);
  const tr = clone(IMG_USER);
  tr.message.content = [{ type: 'tool_result', tool_use_id: 'x', content: [IMG_USER.message.content[0]] }];
  assert.equal(isIvanMessage(tr), false, 'картинка внутри результата инструмента — не слово Ивана');
});

test('2.1: вложение queued_command с prompt-массивом из картинки — сообщение Ивана', () => {
  assert.ok(Array.isArray(IMG_QUEUED.attachment.prompt));
  assert.equal(IMG_QUEUED.attachment.commandMode, 'prompt');
  assert.equal(session([IMG_QUEUED]).ivan.count, 1);
});

test('2.1: картинка вложением и следом та же картинка строкой user в том же пакете — одно сообщение; другая картинка — два; после ответа — два', () => {
  const same = clone(IMG_USER);
  same.message.content = clone(IMG_QUEUED.attachment.prompt);
  assert.equal(session([IMG_QUEUED, same]).ivan.count, 1);
  assert.equal(session([IMG_QUEUED, otherImage(same)]).ivan.count, 2, 'исправный случай: другое содержимое — два');
  assert.equal(session([IMG_QUEUED, MAIN.find((d) => d.type === 'assistant'), same]).ivan.count, 2, 'после ответа ассистента — новое сообщение');
});

// ---------- В3 (EXT-27): что журнал сессии даёт состоянию треда (2.1, правила (А) и (Б)) ----------
// thread-state.jsonl — три строки живой формы, тексты — заглушки: вызов AskUserQuestion (журнал 040635f3-…),
// его результат с ответом, ответ ассистента end_turn одной частью text. Факт прохода 02.10 по журналам сессий:
// stop_reason стоит на каждой строке сообщения (thinking/text/tool_use) и равен итоговому; вызовов AskUserQuestion 348,
// все — stop_reason tool_use, без результата — 1.
const [ASK_USE, ASK_RES, END_TEXT] = lines('thread-state.jsonl');
const IVAN = () => clone(MAIN.find((d) => d.type === 'user' && d.origin?.kind === 'human'));
const endWith = (text, at) => { const x = clone(END_TEXT); x.message.content[0].text = text; if (at) x.timestamp = at; x.message.id = `msg_${text.length}_${at ?? ''}`; return x; };

test('В3 (А): открытый AskUserQuestion — в состоянии сессии; результат на него закрывает', () => {
  assert.equal(ASK_USE.message.stop_reason, 'tool_use');
  assert.equal(ASK_USE.message.content[0].name, 'AskUserQuestion');
  const open = session([IVAN(), ASK_USE]).thread;
  assert.equal(open.askOpen, true);
  assert.equal(open.askAt, ASK_USE.timestamp);
  assert.equal(session([IVAN(), ASK_USE, ASK_RES]).thread.askOpen, false, 'исправный случай: ответ получен');
});

test('В3 (Б): end_turn с «?» в последнем абзаце после сообщения Ивана — вопрос; «?» не в последнем абзаце — нет; новое слово Ивана снимает', () => {
  assert.equal(END_TEXT.message.stop_reason, 'end_turn');
  const q = session([IVAN(), endWith('Сделано.\n\nСливаю — да?')]).thread;
  assert.equal(q.endTurnQ, true);
  assert.equal(session([IVAN(), endWith('Вопрос был?\n\nСделано, слито.')]).thread.endTurnQ, false);
  assert.equal(session([IVAN(), endWith('Сливаю — да?'), IVAN()]).thread.endTurnQ, null, 'после нового слова Ивана ответа ещё нет');
  // последнее end_turn важнее прежнего: ответ на уведомление без вопроса снимает «ждёт»
  assert.equal(session([IVAN(), endWith('Да?', '2026-10-02T10:00:00Z'), endWith('Готово.', '2026-10-02T10:05:00Z')]).thread.endTurnQ, false);
});

test('В3: время последнего события сессии — по последней строке', () => {
  const st = session([IVAN(), endWith('Готово.', '2026-10-02T10:05:00Z')]);
  assert.equal(st.thread.lastAt, '2026-10-02T10:05:00Z');
});

test('В3: последний custom-title журнала — в состоянии треда (третья ступень названия, 1.4)', () => {
  const ct = (t) => ({ type: 'custom-title', customTitle: t, sessionId: SID });
  assert.equal(session([ct('EXT · раз'), ct('CAR · два')]).thread.customTitle, 'CAR · два');
  assert.equal(session([IVAN()]).thread.customTitle ?? null, null);
});
