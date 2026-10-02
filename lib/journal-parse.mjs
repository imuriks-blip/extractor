// Разбор строк журналов Claude Code (спека витрины 1.4, 1.5, 2.1–2.3). Один модуль разбора — дрейф формата
// правится здесь (нюанс 11 плана). Чистые функции над разобранными строками: состояние — простой объект,
// его можно сохранить в индекс (data/vitrina/index) и продолжить с хвоста. Текстов сообщений, промптов и
// результатов состояние не хранит — только время, id, номера карточек, числа, первую строку записи на доску.

// Типы строк, форма которых известна (разбираются или сознательно пропускаются). Новый тип — счётчик непонятых
// строк по версии CLI (/api/health), не ошибка. Список — только типы, увиденные проходом по всем журналам машины 02.10.
export const KNOWN_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment', 'queue-operation', 'custom-title', 'last-prompt',
  'atis-latch', 'agent-name', 'mode', 'frame-link', 'file-history-snapshot', 'file-history-delta',
  'artifact-comment-monitor', 'artifact-autoreact-ledger',
  // служебные строки без version, найденные живым проходом 02.10: разбору не нужны
  'ai-title', 'bridge-session', 'relocated', 'cost-state',
]);

// Служебные начала текста строки user (2.1). Новая служебная форма, принятая за сообщение Ивана, — дрейф
// (Остаточный риск 1). «[Request interrupted by user» — форма, которой нет в спеке (снята с журналов 02.10).
export const SERVICE_PREFIXES = ['<task-notification>', '<system-reminder>', '<command-', '<local-command', '[Request interrupted by user'];

// Номер карточки (1.4): без \b — рядом кириллица.
export const CARD_RE = /(?<![A-Z0-9-])([A-Z]{2,6})-(\d+)(?!\d)/g;
// Ориентир из ТЗ — та же регулярка, что agent-contract.mjs (строка 132).
export const TARGET_RE = /(?:потолок|ориентир)\s*:?\s*~?\s*(\d+)\s*(?:вызов|действ|ход)/i;
export const PARTIAL_RE = /stopped at its (\d+)-turn limit/;

const END_STATUSES = new Set(['completed', 'stopped', 'failed', 'killed', 'cancelled', 'error']);

export function userText(d) {
  const c = d?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.some((p) => p?.type === 'text')) return c.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n');
  return null;
}

const isService = (t) => { const s = t.trimStart(); return SERVICE_PREFIXES.some((p) => s.startsWith(p)); };

// Картинки сообщения (2.1, слово Ивана 02.10 «картинка — да, считается»): части image верхнего уровня
// (строка user — message.content, вложение queued_command — prompt-массив). Картинка внутри tool_result — не в счёт.
const imagesOf = (c) => (Array.isArray(c) ? c.filter((p) => p?.type === 'image') : []);
const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) && c.some((p) => p?.type === 'text') ? c.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n') : null);

// 2.1 + формы, найденные на живых журналах: isCompactSummary (сводка сжатия), origin не human (peer — итог
// субагента, task-notification, coordinator).
export function isIvanMessage(d) {
  if (d?.type !== 'user' || d.isSidechain === true || d.isMeta === true || d.isCompactSummary === true) return false;
  if (d.hookAdditionalContext || d.attachment) return false;
  if (d.origin && d.origin.kind !== 'human') return false;
  const t = userText(d);
  if (t !== null) return !isService(t);
  return imagesOf(d.message?.content).length > 0; // картинка без текста — слово Ивана
}

// Граница захода в журнале субагента (1.5): сообщение дирижёра. Исключения 2.1, кроме isSidechain (в журнале
// субагента он у всех строк) и isMeta у продолжения: продолжение SendMessage пишется строкой user isMeta с
// origin.kind = coordinator (форма снята с журналов 02.10, в спеке не названа).
export function isConductorMessage(d) {
  if (d?.type !== 'user') return false;
  const t = userText(d);
  if (t === null) return false;
  if (d.origin?.kind === 'coordinator') return true;
  if (d.isMeta === true || d.isCompactSummary === true || d.hookAdditionalContext) return false;
  if (d.origin && d.origin.kind !== 'human') return false;
  return !isService(t);
}

export function cardsIn(text) {
  return [...new Set([...String(text ?? '').matchAll(CARD_RE)].map((m) => `${m[1]}-${m[2]}`))];
}

// ---------- журнал субагента: ходы и заходы ----------

export function newAgentState() {
  return { turns: 0, zakhods: [], cur: [], firstAt: null, lastAt: null, lastText: null, left: null, pendingW: {}, boardWrites: [] };
}

// Блок обрыва (2.3): «осталось» — строка «осталось:» / «Осталось:» последнего текста агента (от начала строки).
const LEFT_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?[Оо]сталось:.*$/m;
const LAST_TEXT_MAX = 200;

// Запись субагента на доску (В-15 (а)) — те же правила boardWriteTools (1.4), только успешные (tool_result без ошибки).
function feedAgentWrites(st, d, rules) {
  const c = d?.message?.content;
  if (!Array.isArray(c)) return;
  st.pendingW ??= {};
  st.boardWrites ??= [];
  if (d.type === 'assistant') {
    for (const p of c) { const w = p?.type === 'tool_use' ? parseBoardWrite(p, rules) : null; if (w) st.pendingW[p.id] = { at: d.timestamp ?? null, refs: w.refs, firstLine: w.firstLine }; }
  } else if (d.type === 'user') {
    for (const p of c) {
      if (p?.type !== 'tool_result' || !st.pendingW[p.tool_use_id]) continue;
      const w = st.pendingW[p.tool_use_id];
      delete st.pendingW[p.tool_use_id];
      if (!p.is_error) { st.boardWrites.push(w); if (st.boardWrites.length > 50) st.boardWrites.shift(); }
    }
  }
}

export function feedAgent(st, d, { rules = [] } = {}) {
  if (d?.timestamp) { st.firstAt ??= d.timestamp; st.lastAt = d.timestamp; }
  if (rules.length) feedAgentWrites(st, d, rules);
  if (isConductorMessage(d)) { st.zakhods.push(0); st.cur = []; return; }
  if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) return;
  const texts = d.message.content.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  if (texts.length) {
    const t = texts.at(-1).text;
    st.lastText = t.trim().slice(0, LAST_TEXT_MAX);
    st.left = t.match(LEFT_RE)?.[0].trim().slice(0, LAST_TEXT_MAX) ?? null;
  }
  if (!d.message.content.some((p) => p?.type === 'tool_use')) return;
  const id = d.message.id || d.uuid;
  if (st.cur.includes(id)) return;
  if (st.zakhods.length === 0) st.zakhods.push(0);
  st.cur.push(id);
  st.zakhods[st.zakhods.length - 1]++;
  st.turns++;
}

export function agentSummary(st) {
  return {
    turns: st.turns,
    zakhods: [...st.zakhods],
    maxZakhod: st.zakhods.length ? Math.max(...st.zakhods) : 0,
    currentZakhod: st.zakhods.at(-1) ?? 0,
    firstAt: st.firstAt,
    lastAt: st.lastAt,
    lastText: st.lastText ?? null,
    left: st.left ?? null,
    boardWrites: [...(st.boardWrites ?? [])],
  };
}

// ---------- вызовы записи на доску (1.4) ----------

function htmlFirstLine(html) {
  const text = String(html ?? '')
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
}

// Аргументы командной строки после «<script> <sub>»: слова и строки в '…' / "…".
function argsAfter(command, script, sub) {
  const i = command.search(new RegExp(`${script.replace('.', '\\.')}\\s+${sub}(?=\\s)`));
  if (i < 0) return null;
  const rest = command.slice(i).replace(new RegExp(`^${script.replace('.', '\\.')}\\s+${sub}`), '');
  const out = [];
  const re = /\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s;&|]+))/gy;
  let m;
  while ((m = re.exec(rest)) && m[0].trim()) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// rules — config.json → boardWriteTools. Возврат: {tool, refs, firstLine} или null.
export function parseBoardWrite(toolUse, rules = []) {
  if (!toolUse || toolUse.type !== 'tool_use') return null;
  for (const r of rules) {
    if (![].concat(r.tool).includes(toolUse.name)) continue;
    const input = toolUse.input ?? {};
    if (r.command) {
      const args = argsAfter(String(input.command ?? ''), r.command, r.sub);
      if (!args) continue;
      const body = args[r.bodyArg ?? 1] ?? '';
      const refs = args.slice((r.bodyArg ?? 1) + 1).flatMap((a) => cardsIn(a));
      if (refs.length === 0) continue;
      return { tool: `${toolUse.name}:${r.command} ${r.sub}`, refs, firstLine: htmlFirstLine(body) };
    }
    const ref = input[r.card];
    if (typeof ref !== 'string' || !ref) continue;
    return { tool: toolUse.name, refs: [ref], firstLine: htmlFirstLine(input[r.body]) };
  }
  return null;
}

// Номер карточки из ссылки вызова: номер — как есть; UUID — через .mirror/index.json зеркала (cards: {ID: {uuid}}).
export function resolveRef(ref, mirrorIndex) {
  if (/^[A-Z]{2,6}-\d+$/.test(ref)) return ref;
  for (const [id, v] of Object.entries(mirrorIndex?.cards ?? {})) if (v?.uuid === ref) return id;
  return null;
}

// ---------- журнал сессии: сообщения Ивана, запуски, продолжения, итоги, PARTIAL, записи на доску ----------

// Что журнал сессии даёт состоянию треда (2.1, В3): (А) открытый AskUserQuestion в последнем сообщении ассистента;
// (Б) последний ответ end_turn после последнего сообщения Ивана — есть ли «?» в последнем абзаце его текста. Текст не
// хранится — только признак и время. stop_reason стоит на каждой строке сообщения (проход 02.10).
// q — абзац (Б), ask — вопрос AskUserQuestion: текст до 160 знаков, uuid строки, время (строка (а) «Ждёт меня» и ключ
// уведомления, 2.4, 4.1). Тексты в индексе — допустимо (1.3), наружу — только через маску.
const newThread = () => ({ msgId: null, askIds: [], askOpen: false, askAt: null, endTurnQ: null, endTurnAt: null, lastAt: null, customTitle: null, q: null, ask: null });
const Q_MAX = 160;
const lastParagraph = (t) => String(t).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).at(-1) ?? '';

export function newSessionState() {
  return { ivan: { count: 0, firstAt: null, lastAt: null, cards: {} }, runs: {}, pending: {}, partials: [], boardWrites: [], boardWritesFailed: 0, agentLaunchErrors: 0, thread: newThread() };
}

function feedThread(th, d, at) {
  const m = d.message;
  if (m.id !== th.msgId) { th.msgId = m.id ?? null; th.askIds = []; }
  for (const p of m.content) {
    if (p?.type !== 'tool_use' || p.name !== 'AskUserQuestion') continue;
    th.askIds.push(p.id); th.askAt = at;
    const q = Array.isArray(p.input?.questions) ? p.input.questions.find((x) => typeof x?.question === 'string') : null;
    th.ask = { text: q ? q.question.trim().slice(0, Q_MAX) : null, uuid: d.uuid ?? null, at };
  }
  th.askOpen = th.askIds.length > 0 && m.stop_reason === 'tool_use';
  const texts = m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  if (m.stop_reason === 'end_turn' && texts.length) {
    const para = lastParagraph(texts.at(-1).text);
    th.endTurnQ = para.includes('?'); th.endTurnAt = at;
    th.q = th.endTurnQ ? { text: para.slice(0, Q_MAX), uuid: d.uuid ?? null, at } : null;
  }
}

const tag = (s, t) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() ?? null;
const resultText = (p) => (typeof p.content === 'string' ? p.content
  : Array.isArray(p.content) ? p.content.map((q) => (typeof q?.text === 'string' ? q.text : '')).join('\n') : '');

function endRun(run, at, kind, toolUseId) {
  // уведомление о прошлом заходе (tool-use-id одного из прежних стартов: исходного Agent или прежнего продолжения)
  // новый заход не закрывает. Живые журналы 02.10: уведомлений с id исходного Agent после продолжения — 0; с id
  // прежнего продолжения после нового — 2 (bbd77ac1/af7ed40dfcd85ef4e, ef71a837/a2f4eb1553e318939).
  if (toolUseId && (run.prevStarts ?? []).includes(toolUseId)) return;
  run.ends++;
  run.lastEndAt = at;
  run.lastEndKind = kind;
  run.alive = false;
}

function addPartial(st, text, at, agentId, where) {
  const m = String(text).match(PARTIAL_RE);
  if (m) st.partials.push({ agentId, at, limit: Number(m[1]), where });
}

// Уведомление о задаче: строкой user или вложением queued_command (оба вида — в живых журналах; одно и то же
// уведомление может прийти обоими — считается один раз).
function notification(st, text, at) {
  const id = tag(text, 'task-id');
  const status = tag(text, 'status');
  const key = `${id}|${tag(text, 'tool-use-id')}|${status}|${text.length}`;
  st.seenNotes ??= [];
  if (st.seenNotes.includes(key)) return;
  st.seenNotes.push(key);
  if (st.seenNotes.length > 200) st.seenNotes.shift();
  addPartial(st, text, at, id, 'notification');
  const run = id ? st.runs[id] : null;
  if (run && (!status || END_STATUSES.has(status))) endRun(run, at, 'notification', tag(text, 'tool-use-id'));
}

// Хеш текста (FNV-1a, 32 бита): сравнить вложение и строку user, не храня текста.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

// Ключ содержимого для склейки вложения со строкой user (2.1): текст, а у сообщения с картинками — и данные
// каждой картинки. Без картинок ключ равен прежнему fnv(текст) — склейка текстов не меняется.
function contentKey(c) {
  const t = textOf(c) ?? '';
  const imgs = imagesOf(c);
  if (imgs.length === 0) return fnv(t);
  return fnv(t + imgs.map((p) => `\0img:${p.source?.media_type ?? ''}:${fnv(String(p.source?.data ?? p.source?.url ?? ''))}`).join(''));
}

function countIvan(st, text, at) {
  // новое слово Ивана: прежний вопрос треда (Б) снят, ответа на это слово ещё нет
  st.thread.endTurnQ = null;
  st.thread.endTurnAt = null;
  st.thread.q = null;
  st.ivan.count++;
  st.ivan.firstAt ??= at;
  st.ivan.lastAt = at;
  for (const id of cardsIn(text)) {
    const e = st.ivan.cards[id] ??= { n: 0, firstAt: at, lastAt: at };
    e.n++;
    e.lastAt = at;
  }
}

export function feedSession(st, d, { rules = [] } = {}) {
  const at = d?.timestamp ?? null;
  const c = d?.message?.content;
  st.thread ??= newThread(); // состояние из индекса до В3
  if (at) st.thread.lastAt = at;
  // название треда, третья ступень (1.4): последний custom-title журнала; наружу — только через маску
  if (d?.type === 'custom-title' && typeof d.customTitle === 'string') { st.thread.customTitle = d.customTitle; return; }
  const qp = d?.type === 'attachment' && d.attachment?.type === 'queued_command' ? d.attachment.prompt : undefined;
  if (typeof qp === 'string' || (Array.isArray(qp) && (textOf(qp) !== null || imagesOf(qp).length > 0))) {
    // prompt — строка или массив частей (картинка — слово Ивана 02.10); текст массива — его части text
    const prompt = textOf(qp) ?? '';
    if (prompt.trimStart().startsWith('<task-notification>')) { notification(st, prompt, at); return; }
    // Сообщение Ивана, набранное, пока тред занят: вложение queued_command с commandMode prompt (решение дирижёра
    // 02.10). Если следом, в том же пакете ввода (до строки assistant), придёт строка user с тем же текстом — один раз.
    // Поля-ключа связи в журналах нет (source_uuid вложения не указывает ни на одну строку файла — 32 из 32, 02.10);
    // после ответа ассистента тот же текст — новое сообщение Ивана (повтор «да»).
    if (d.attachment.commandMode === 'prompt' && d.isSidechain !== true && (!d.attachment.origin || d.attachment.origin.kind === 'human') && !isService(prompt)) {
      countIvan(st, prompt, at);
      (st.queuedHashes ??= []).push(contentKey(qp));
      if (st.queuedHashes.length > 50) st.queuedHashes.shift();
    }
    return;
  }
  // ответ ассистента закрывает пакет ввода: вложения до него с последующими строками user не склеиваются
  if (d?.type === 'assistant') st.queuedHashes = [];
  if (d?.type === 'assistant' && Array.isArray(c)) {
    feedThread(st.thread, d, at);
    for (const p of c) {
      if (p?.type !== 'tool_use') continue;
      if (p.name === 'Agent' || p.name === 'Task') {
        const prompt = String(p.input?.prompt ?? '');
        const tm = prompt.match(TARGET_RE);
        st.pending[p.id] = { name: 'Agent', at, agentType: p.input?.subagent_type ?? null, description: p.input?.description ?? null, target: tm ? Number(tm[1]) : null, cards: cardsIn(prompt) };
      } else if (p.name === 'TaskStop') {
        st.pending[p.id] = { name: 'TaskStop', at, taskId: p.input?.task_id ?? p.input?.taskId ?? null };
      } else if (p.name === 'SendMessage') {
        st.pending[p.id] = { name: 'SendMessage', at, to: p.input?.to ?? p.input?.recipient ?? null };
      } else {
        const w = parseBoardWrite(p, rules);
        if (w) st.pending[p.id] = { name: 'board', at, ...w };
      }
    }
    return;
  }
  if (d?.type !== 'user') return;

  if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === 'tool_result' && st.thread.askIds.includes(p.tool_use_id)) {
        st.thread.askIds = st.thread.askIds.filter((x) => x !== p.tool_use_id);
        st.thread.askOpen = st.thread.askIds.length > 0;
      }
      if (p?.type !== 'tool_result' || !st.pending[p.tool_use_id]) continue;
      const u = st.pending[p.tool_use_id];
      delete st.pending[p.tool_use_id];
      const tr = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : {};
      if (u.name === 'Agent') {
        const agentId = tr.agentId ?? resultText(p).match(/agentId:\s*([A-Za-z0-9]+)/)?.[1] ?? null;
        if (p.is_error || !agentId) { st.agentLaunchErrors++; continue; }
        const run = st.runs[agentId] = {
          agentId, toolUseId: p.tool_use_id, agentType: u.agentType ?? tr.agentType ?? null, description: u.description,
          target: u.target, cards: u.cards, at: u.at, starts: [u.at], curStart: p.tool_use_id, continuations: 0, messages: 0,
          ends: 0, lastEndAt: null, lastEndKind: null, alive: true,
        };
        addPartial(st, resultText(p), at, agentId, 'Agent');
        if (tr.status && tr.status !== 'async_launched') endRun(run, at, 'result', null);
      } else if (u.name === 'SendMessage') {
        if (p.is_error || tr.success === false || !u.to) continue;
        // запуск — по agentId из resumedAgentId (поле to бывает и именем), иначе по to
        const key = tr.resumedAgentId ?? u.to;
        let run = st.runs[key];
        if (!run && tr.resumedAgentId) run = st.runs[key] = { agentId: key, toolUseId: null, agentType: null, description: null, target: null, cards: [], at: u.at, curStart: null, continuations: 0, messages: 0, ends: 0, lastEndAt: null, lastEndKind: null, alive: false };
        if (!run) continue;
        run.messages++;
        addPartial(st, resultText(p), at, key, 'SendMessage');
        // новый заход: агент возобновлён (resumedAgentId) или был не живой; иначе — сообщение в идущий заход
        if (tr.resumedAgentId || !run.alive) {
          run.continuations++;
          run.alive = true;
          if (run.curStart) (run.prevStarts ??= []).push(run.curStart);
          run.curStart = p.tool_use_id;
          (run.starts ??= []).push(u.at);
        }
      } else if (u.name === 'TaskStop') {
        // остановка агента дирижёром (TaskStop) — итог захода; форма снята с журналов 02.10
        if (!p.is_error && u.taskId && st.runs[u.taskId]) endRun(st.runs[u.taskId], at, 'stop', null);
      } else if (u.name === 'board') {
        if (p.is_error) { st.boardWritesFailed++; continue; }
        st.boardWrites.push({ at: u.at, tool: u.tool, refs: u.refs, firstLine: u.firstLine });
      }
    }
  }

  const text = userText(d);
  // уведомление — строкой или массивом с частью text
  if (text !== null && text.trimStart().startsWith('<task-notification>')) { notification(st, text, at); return; }
  // итог захода — передача отчёта субагентом (origin.kind = peer, isMeta) — форма снята с журналов 02.10
  if (d.origin?.kind === 'peer' && d.origin.from && st.runs[d.origin.from]) {
    endRun(st.runs[d.origin.from], at, 'handback', null);
    return;
  }
  if (isIvanMessage(d)) {
    const i = st.queuedHashes?.indexOf(contentKey(c)) ?? -1;
    if (i >= 0) { st.queuedHashes.splice(i, 1); return; } // уже учтено вложением
    countIvan(st, text ?? '', at);
  }
}
