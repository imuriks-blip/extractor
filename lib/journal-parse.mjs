// Разбор строк журналов Claude Code (спека витрины 1.4, 1.5, 2.1–2.3). Один модуль разбора — дрейф формата
// правится здесь (нюанс 11 плана). Чистые функции над разобранными строками: состояние — простой объект,
// его можно сохранить в индекс (data/vitrina/index) и продолжить с хвоста. Промптов и результатов состояние не
// хранит; из текстов — только нужные экрану (§1.3 «Тексты в индексе»): вопрос и абзац (а), последний текст агента
// и «осталось» (до 2000 символов, сырыми), первую строку записи на доску. Индекс вне git; маска — на выходе (6.2).
import { cutChars } from './text.mjs';

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

// ---------- дрейф разбора (EXT-53, вердикт Голема на В10, Важно 1) ----------
// Строка знакомого типа в иной форме не даёт «непонятой» строки, а меняет смысл молча (Остаточный риск 1). Счётчики —
// в состоянии журнала (st.drift, в индексе вместе со смещением): повтор строки (uuid, EXT-41), рестарт из индекса и
// дочитывание хвоста их не растят; пересбор индекса (смена отпечатка, файл стал короче) — счёт заново. В счётчик идут
// только значения полей (status, kind, имя инструмента, task-type) — до DRIFT_VALUE_MAX знаков, не больше
// DRIFT_MAX_KEYS значений в словаре, остальное — «другие»; строк и текстов нет. Знакомые значения — сняты с живых
// журналов (прогон дирижёра 03.10 в вердикте В10 и прогон EXT-53 04.10).
export const KNOWN_ORIGIN_KINDS = new Set(['human', 'task-notification', 'coordinator', 'peer']);
export const LAUNCH_STATUSES = new Set(['completed', 'async_launched']);
export const LAUNCH_TOOLS = new Set(['Agent', 'Task']);
export const DRIFT_KEYS = ['noteStatus', 'noteNoId', 'noteForeignId', 'resultStatus', 'launchName', 'originKind'];
export const DRIFT_OTHER = 'другие';
const DRIFT_MAX_KEYS = 20;
const DRIFT_VALUE_MAX = 40;
const AGENT_ID_SHAPE = /^a[0-9a-f]{16}$/;

// +n к значению словаря; ключ — своё свойство объекта (значение «__proto__» из журнала не трогает прототип).
// Алфавит значения (ревью Голема на EXT-53, Мелочь 3): [A-Za-z0-9_.:-] и «—», прочее — «?», до обрезки: /api/health
// идёт без маски, текст в значении поля не должен выйти наружу.
const DRIFT_ALPHABET = /[^A-Za-z0-9_.:\-—]/gu;
export function bumpDrift(dict, value, n = 1) {
  addDriftKey(dict, cutChars(String(value).replace(DRIFT_ALPHABET, '?'), DRIFT_VALUE_MAX), n);
}
// +n к готовому ключу (сумма словарей журналов в /api/health: «другие» и обрезка «…» — как есть) с тем же пределом
export function addDriftKey(dict, key, n = 1) {
  let k = key;
  if (!Object.hasOwn(dict, k) && Object.keys(dict).filter((x) => x !== DRIFT_OTHER).length >= DRIFT_MAX_KEYS) k = DRIFT_OTHER;
  Object.defineProperty(dict, k, { value: (Object.hasOwn(dict, k) ? dict[k] : 0) + n, enumerable: true, writable: true, configurable: true });
}
const drift = (st, key, value) => bumpDrift((st.drift ??= {})[key] ??= {}, value);

// origin строки или вложения: kind вне знакомых (нет kind — «—»)
function countOrigin(st, origin) {
  if (!origin || typeof origin !== 'object') return;
  if (!KNOWN_ORIGIN_KINDS.has(origin.kind)) drift(st, 'originKind', origin.kind ?? '—');
}

// Имя инструмента по id вызова — для результата «как у запуска агента» под другим именем. Только в памяти, последние
// 100 вызовов журнала: в индекс не идёт (вызов и его результат — рядом); после рестарта вызов до смещения — имя «?».
const toolNameMaps = new WeakMap();
function toolNames(st) {
  let m = toolNameMaps.get(st);
  if (!m) { m = new Map(); toolNameMaps.set(st, m); }
  return m;
}

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
// Сырой текст (вопрос, абзац, последний текст агента, «осталось») хранится с запасом, по символам (cutChars), не по
// UTF-16: разметка снимается и окончательная обрезка (160 / 200, с «…») делается один раз на выходе, в waiting.mjs
// (вердикт Голема на В6, Важно 1; EXT-31). Запас 2000 — чтобы снятая разметка не укоротила текст ниже окончательной обрезки.
const RAW_MAX = 2000;
const keep = (s) => cutChars(s, RAW_MAX);

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
  countOrigin(st, d?.origin); // дрейф origin.kind — и в журнале субагента (граница захода, isConductorMessage)
  if (d?.timestamp) { st.firstAt ??= d.timestamp; st.lastAt = d.timestamp; }
  if (rules.length) feedAgentWrites(st, d, rules);
  if (isConductorMessage(d)) { st.zakhods.push(0); st.cur = []; return; }
  if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) return;
  const texts = d.message.content.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  if (texts.length) {
    const t = texts.at(-1).text;
    st.lastText = keep(t.trim());
    const left = t.match(LEFT_RE)?.[0];
    st.left = left ? keep(left.trim()) : null;
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
// Путь к скрипту бывает в кавычках (python "C:\…\plane.py" comment …) — кавычка после имени необязательна (EXT-56).
// Вызов — только после интерпретатора python: упоминание «plane.py comment» в тексте (сообщение коммита) не запись
// (вердикт Голема на EXT-56, Важно 2).
function argsAfter(command, script, sub) {
  const call = new RegExp(`python[\\w.]*["']?\\s+["']?(?:[^"'\\n;&|]*?[\\\\/])?${script.replace('.', '\\.')}["']?\\s+${sub}(?=\\s)`, 'i');
  const m0 = call.exec(command);
  if (!m0) return null;
  const rest = command.slice(m0.index + m0[0].length);
  const out = [];
  const re = /\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s;&|]+))/gy;
  let m;
  while ((m = re.exec(rest)) && m[0].trim()) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const VAR_ONLY = /^\$(?:[A-Za-z_][\w:]*|\{[^}]*\}|\([^)]*\))$/;

// rules — config.json → boardWriteTools. Возврат: {tool, refs, firstLine} или null; firstLine null — тело неизвестно.
export function parseBoardWrite(toolUse, rules = []) {
  if (!toolUse || toolUse.type !== 'tool_use') return null;
  for (const r of rules) {
    if (![].concat(r.tool).includes(toolUse.name)) continue;
    const input = toolUse.input ?? {};
    if (r.command) {
      const args = argsAfter(String(input.command ?? ''), r.command, r.sub);
      if (!args) continue;
      // bodyArg — место тела среди аргументов после подкоманды (close: 1, после статуса; comment: 0); карточки — после
      const body = args[r.bodyArg ?? 1] ?? '';
      const refs = args.slice((r.bodyArg ?? 1) + 1).flatMap((a) => cardsIn(a));
      if (refs.length === 0) continue;
      // тело целиком из переменной ($t, ${t}, $(…)) — первая строка неизвестна: ни ▶, ни ⏸ (EXT-56)
      const firstLine = VAR_ONLY.test(body) ? null : htmlFirstLine(body);
      return { tool: `${toolUse.name}:${r.command} ${r.sub}`, refs, firstLine };
    }
    const ref = input[r.card];
    if (typeof ref !== 'string' || !ref) continue;
    return { tool: toolUse.name, refs: [ref], firstLine: htmlFirstLine(input[r.body]) };
  }
  return null;
}

// Номер карточки из ссылки вызова: номер — как есть; UUID — через .mirror/index.json зеркала (cards: {ID: {uuid}}).
// Карта UUID → номер строится один раз на объект cards (EXT-37: перебор ~730 карточек на каждую ссылку каждые 2 с был
// главной нагрузкой покоя). Объект cards новый при каждом новом mtime index.json (board-reader, mirrorIndex) —
// новый объект, новая карта; при повторе UUID — первый по порядку, как прежний перебор.
const uuidMaps = new WeakMap();
function uuidMap(cards) {
  let m = uuidMaps.get(cards);
  if (!m) {
    m = new Map();
    for (const [id, v] of Object.entries(cards)) if (typeof v?.uuid === 'string' && !m.has(v.uuid)) m.set(v.uuid, id);
    uuidMaps.set(cards, m);
  }
  return m;
}
export function resolveRef(ref, mirrorIndex) {
  if (/^[A-Z]{2,6}-\d+$/.test(ref)) return ref;
  const cards = mirrorIndex?.cards;
  if (!cards || typeof cards !== 'object') return null;
  return uuidMap(cards).get(ref) ?? null;
}

// ---------- журнал сессии: сообщения Ивана, запуски, продолжения, итоги, PARTIAL, записи на доску ----------

// Что журнал сессии даёт состоянию треда (2.1, В3): (А) открытый AskUserQuestion в последнем сообщении ассистента;
// (Б) последний ответ end_turn после последнего сообщения Ивана — есть ли «?» в последнем абзаце его текста. Текст не
// хранится — только признак и время. stop_reason стоит на каждой строке сообщения (проход 02.10).
// q — абзац (Б), ask — вопрос AskUserQuestion: сырой текст до 2000 символов (обрезка 160 с «…» — на выходе, waiting.mjs), uuid строки, время (строка (а) «Ждёт меня» и ключ
// уведомления, 2.4, 4.1). Тексты в индексе — допустимо (1.3), наружу — только через маску.
const newThread = () => ({ msgId: null, askIds: [], askOpen: false, askAt: null, endTurnQ: null, endTurnAt: null, lastAt: null, customTitle: null, q: null, ask: null });
const lastParagraph = (t) => String(t).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).at(-1) ?? '';

export function newSessionState() {
  return { ivan: { count: 0, firstAt: null, lastAt: null, cards: {} }, runs: {}, pending: {}, partials: [], boardWrites: [], boardWritesFailed: 0, agentLaunchErrors: 0, thread: newThread(), reread: {} };
}

// «Правила перечитаны» (EXT-54, спека 2.3): ключ пути файла правил — без учёта регистра и вида разделителя.
// Набор (config.json → rulesReread.files, уже с vault_root) приходит в feedSession как reread; в состоянии сессии —
// последнее время удачного Read по каждому файлу набора (время строки вызова), ключ — pathKey.
export const pathKey = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

function feedThread(th, d, at) {
  const m = d.message;
  if (m.id !== th.msgId) { th.msgId = m.id ?? null; th.askIds = []; }
  for (const p of m.content) {
    if (p?.type !== 'tool_use' || p.name !== 'AskUserQuestion') continue;
    th.askIds.push(p.id); th.askAt = at;
    const q = Array.isArray(p.input?.questions) ? p.input.questions.find((x) => typeof x?.question === 'string') : null;
    th.ask = { text: q ? keep(q.question.trim()) : null, uuid: d.uuid ?? null, at };
  }
  th.askOpen = th.askIds.length > 0 && m.stop_reason === 'tool_use';
  const texts = m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  if (m.stop_reason === 'end_turn' && texts.length) {
    const para = lastParagraph(texts.at(-1).text);
    th.endTurnQ = para.includes('?'); th.endTurnAt = at;
    th.q = th.endTurnQ ? { text: keep(para), uuid: d.uuid ?? null, at } : null;
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
  const tu = tag(text, 'tool-use-id');
  // дрейф (EXT-53): статус вне END_STATUSES (уведомление без <status> — живая форма событий Monitor, не дрейф);
  // нет <task-id> — по <task-type>; id не среди запусков — agentCall, если <tool-use-id> — старт одного из запусков
  // сессии (уведомление об агенте с чужим id), иначе other (фоновые Bash/PowerShell/Monitor — живая форма 04.10)
  if (status && !END_STATUSES.has(status)) drift(st, 'noteStatus', status);
  if (!id) drift(st, 'noteNoId', tag(text, 'task-type') ?? '—');
  // agentShape — id формы id агента (a + 16 hex), но не запуск сессии и не его вызов (ревью Голема на EXT-53, Мелочь 1)
  else if (!run) drift(st, 'noteForeignId', tu && Object.values(st.runs).some((r) => r.toolUseId === tu || r.curStart === tu || (r.prevStarts ?? []).includes(tu)) ? 'agentCall' : AGENT_ID_SHAPE.test(id) ? 'agentShape' : 'other');
  if (run && at) run.lastEventAt = at; // событие запуска в журнале сессии (runsLive / runsSilent)
  if (run && (!status || END_STATUSES.has(status))) endRun(run, at, 'notification', tu);
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

// Звонок витрины в журнале треда (спека пульта §0, §2.8; ПТ4а, EXT-63): уведомление хука Stop «Stop hook blocking error
// from command …: <текст звонка>» с первой строкой звонка «Слово Ивана · кнопка витрины.» — сообщение Ивана, а id слов
// (W-…) — «прочитано» (st.rings: id → время строки). Форма снята с журнала фоновой сессии пробы П.1 (02.10).
// Тот же звонок второй раз (вложение и строка user) — не второе сообщение. Иное уведомление хука — не звонок.
const RING_FORM = /Stop hook blocking error from command [^\n]*?: Слово Ивана · кнопка витрины\. /;
const RING_ID = /(?:^|\n)(W-\d{6}-\d{6}-[0-9a-f]{4}) · /g;
// поле карточки строки слова (третье поле ringLine: <id> · <ЧЧ:ММ> · <КАРТОЧКА или «без карточки»> · …)
const RING_CARD = /(?:^|\n)W-\d{6}-\d{6}-[0-9a-f]{4} · \d\d:\d\d · ([^·\n]*?) · /g;
function ring(st, text, at) {
  const m = RING_FORM.exec(text);
  if (!m) return false;
  const body = text.slice(m.index + m[0].length - 'Слово Ивана · кнопка витрины. '.length);
  const ids = [...body.matchAll(RING_ID)].map((x) => x[1]);
  st.rings ??= {};
  const fresh = ids.filter((id) => !st.rings[id]);
  if (ids.length && !fresh.length) return true;
  for (const id of fresh) st.rings[id] = at;
  // карточки Ивана — только поле карточки каждой строки слова, не «в ответ на» и не текст (вердикт Голема на ПТ4а)
  countIvan(st, body, at, [...body.matchAll(RING_CARD)].flatMap((x) => cardsIn(x[1])));
  return true;
}

function countIvan(st, text, at, cards = cardsIn(text)) {
  // новое слово Ивана: прежний вопрос треда (Б) снят, ответа на это слово ещё нет
  st.thread.endTurnQ = null;
  st.thread.endTurnAt = null;
  st.thread.q = null;
  st.ivan.count++;
  st.ivan.firstAt ??= at;
  st.ivan.lastAt = at;
  for (const id of cards) {
    const e = st.ivan.cards[id] ??= { n: 0, firstAt: at, lastAt: at };
    e.n++;
    e.lastAt = at;
  }
}

// Повтор цепочки (EXT-41). Claude Code при /compact бывает дописывает в журнал сессии копию уже записанной цепочки —
// те же строки с теми же uuid и временами (2fea3135, 02.10 17:11: стр. 6264–8135 = копия стр. 3–3154). Разбор такой
// копии заново открывал закончившиеся запуски (старт и продолжения повторяются, а уведомления-итоги — нет: их ключи
// уже в seenNotes или их строк в копии нет) и второй раз считал слова Ивана. Проход по журналам машины 03.10:
// повторных uuid 3 711 в 4 журналах сессий, в журналах субагентов — 0. Время повтор не отличает: строк с временем
// в прошлом без повтора uuid — десятки тысяч. Поэтому — множество прочитанных uuid; в индекс идёт строкой
// (12 последних знаков uuid через запятую — случайная часть uuid v4/v7), в памяти — Set, восстанавливаемый из строки.
const seenSets = new WeakMap();
const uuidKey = (u) => u.replace(/-/g, '').slice(-12);
function replayed(st, uuid) {
  if (typeof uuid !== 'string' || !uuid) return false;
  let set = seenSets.get(st);
  if (!set) { set = new Set(st.uuids ? st.uuids.split(',') : []); seenSets.set(st, set); }
  const k = uuidKey(uuid);
  if (set.has(k)) return true;
  set.add(k);
  st.uuids = st.uuids ? `${st.uuids},${k}` : k;
  return false;
}

// Число ключей во множестве прочитанных uuid (строка stats, EXT-53: наблюдение роста памяти под Г4). Множество
// в памяти — если уже собрано, иначе — по строке индекса (без сборки Set).
export function seenUuidCount(st) {
  const set = seenSets.get(st);
  if (set) return set.size;
  if (!st?.uuids) return 0;
  let n = 1;
  for (let i = st.uuids.indexOf(','); i !== -1; i = st.uuids.indexOf(',', i + 1)) n++;
  return n;
}

// ---------- память треда (EXT-49, спека 2.1 «Память треда») ----------
// st.mem: usage — последний ответ главного треда (isSidechain не true) {tokens, model, at}, tokens = input +
// cache_creation + cache_read (output не входит); post — compact_boundary после него {tokens: postTokens, at}, снимается
// следующим ответом; cb — sessionId каждой строки compact_boundary (сжатия текущей сессии считает читатель по sessionId
// файла: продолженный тред несёт строки прежних сессий с их sessionId). Строка с нулевой суммой — не чтение модели
// (<synthetic> — ошибка API; живые журналы 04.10: 93 таких строки, 29 из них <synthetic>), прежний ответ остаётся.
// Копия цепочки после /compact (EXT-41) сюда не доходит — отсекается по uuid раньше.
const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
function feedMemory(st, d, at) {
  if (d?.type === 'system' && d.subtype === 'compact_boundary') {
    const mem = st.mem ??= { usage: null, post: null, cb: [] };
    mem.cb.push(typeof d.sessionId === 'string' ? d.sessionId : '?');
    const post = d.compactMetadata?.postTokens;
    mem.post = Number.isFinite(post) ? { tokens: post, at } : null;
    return;
  }
  const u = d?.type === 'assistant' && d.isSidechain !== true ? d.message?.usage : null;
  if (!u || typeof u !== 'object') return;
  const tokens = USAGE_KEYS.reduce((a, k) => a + (Number.isFinite(u[k]) ? u[k] : 0), 0);
  if (tokens <= 0) return;
  const mem = st.mem ??= { usage: null, post: null, cb: [] };
  mem.usage = { tokens, model: typeof d.message.model === 'string' ? d.message.model : null, at };
  mem.post = null;
}

// Выжимка памяти для читателя: null — строки с usage ещё не было (спека 2.1); после сжатия без ответа — postTokens и
// время сжатия, модель — последнего ответа; compactions — сжатия строк с sessionId текущей сессии.
export function memorySummary(st, sessionId) {
  const m = st?.mem;
  if (!m?.usage) return null;
  const compactions = m.cb.filter((s) => s === sessionId).length;
  return m.post ? { tokens: m.post.tokens, model: m.usage.model, at: m.post.at, compactions } : { ...m.usage, compactions };
}

export function feedSession(st, d, { rules = [], reread = [] } = {}) {
  if (replayed(st, d?.uuid)) return; // строка уже прочитана: копия цепочки после /compact (EXT-41)
  countOrigin(st, d?.origin);
  if (d?.type === 'attachment') countOrigin(st, d.attachment?.origin);
  const at = d?.timestamp ?? null;
  const c = d?.message?.content;
  st.thread ??= newThread(); // состояние из индекса до В3
  if (at) st.thread.lastAt = at;
  feedMemory(st, d, at);
  // название треда, третья ступень (1.4): последний custom-title журнала; наружу — только через маску
  if (d?.type === 'custom-title' && typeof d.customTitle === 'string') { st.thread.customTitle = d.customTitle; return; }
  const qp = d?.type === 'attachment' && d.attachment?.type === 'queued_command' ? d.attachment.prompt : undefined;
  if (typeof qp === 'string' || (Array.isArray(qp) && (textOf(qp) !== null || imagesOf(qp).length > 0))) {
    // prompt — строка или массив частей (картинка — слово Ивана 02.10); текст массива — его части text
    const prompt = textOf(qp) ?? '';
    if (prompt.trimStart().startsWith('<task-notification>')) { if (d.isSidechain !== true && ring(st, prompt, at)) return; notification(st, prompt, at); return; }
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
      const names = toolNames(st);
      names.set(p.id, p.name);
      if (names.size > 100) names.delete(names.keys().next().value);
      if (p.name === 'Agent' || p.name === 'Task') {
        const prompt = String(p.input?.prompt ?? '');
        const tm = prompt.match(TARGET_RE);
        st.pending[p.id] = { name: 'Agent', at, agentType: p.input?.subagent_type ?? null, description: p.input?.description ?? null, target: tm ? Number(tm[1]) : null, cards: cardsIn(prompt) };
      } else if (p.name === 'TaskStop') {
        st.pending[p.id] = { name: 'TaskStop', at, taskId: p.input?.task_id ?? p.input?.taskId ?? null };
      } else if (p.name === 'SendMessage') {
        st.pending[p.id] = { name: 'SendMessage', at, to: p.input?.to ?? p.input?.recipient ?? null };
      } else if (p.name === 'Read') {
        // чтение файла правил самим тредом (строка субагента — не в счёт); засчитывается по результату без ошибки
        const key = pathKey(p.input?.file_path);
        if (d.isSidechain !== true && reread.some((f) => pathKey(f) === key)) st.pending[p.id] = { name: 'Read', at, key };
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
      if (p?.type !== 'tool_result') continue;
      const tr = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : {};
      // дрейф: результат как у запуска агента (agentId или async_launched) у инструмента не с именем запуска
      if (tr.agentId || tr.status === 'async_launched') {
        // имени нет в памяти (вызов до рестарта) — из ждущего вызова в индексе ('Agent' и для Task); нет и там — «?»
        const name = toolNames(st).get(p.tool_use_id) ?? st.pending[p.tool_use_id]?.name ?? '?';
        if (!LAUNCH_TOOLS.has(name)) drift(st, 'launchName', name);
      }
      if (!st.pending[p.tool_use_id]) continue;
      const u = st.pending[p.tool_use_id];
      delete st.pending[p.tool_use_id];
      if (u.name === 'Agent') {
        const agentId = tr.agentId ?? resultText(p).match(/agentId:\s*([A-Za-z0-9]+)/)?.[1] ?? null;
        if (p.is_error || !agentId) { st.agentLaunchErrors++; continue; }
        // дрейф: статус результата запуска вне знакомых (нет статуса — «—»: запуск остался бы живым молча)
        if (!LAUNCH_STATUSES.has(tr.status)) drift(st, 'resultStatus', tr.status ?? '—');
        const run = st.runs[agentId] = {
          agentId, toolUseId: p.tool_use_id, agentType: u.agentType ?? tr.agentType ?? null, description: u.description,
          target: u.target, cards: u.cards, at: u.at, starts: [u.at], curStart: p.tool_use_id, continuations: 0, messages: 0,
          ends: 0, lastEndAt: null, lastEndKind: null, alive: true, lastEventAt: at ?? u.at,
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
        if (at) run.lastEventAt = at; // событие запуска в журнале сессии (runsLive / runsSilent, EXT-53)
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
      } else if (u.name === 'Read') {
        if (p.is_error || !u.at) continue;
        st.reread ??= {};
        const prev = st.reread[u.key];
        if (!prev || Date.parse(u.at) > Date.parse(prev)) st.reread[u.key] = u.at;
      } else if (u.name === 'board') {
        if (p.is_error) { st.boardWritesFailed++; continue; }
        st.boardWrites.push({ at: u.at, tool: u.tool, refs: u.refs, firstLine: u.firstLine });
      }
    }
  }

  const text = userText(d);
  // уведомление — строкой или массивом с частью text
  if (text !== null && text.trimStart().startsWith('<task-notification>')) { if (d.isSidechain !== true && ring(st, text, at)) return; notification(st, text, at); return; }
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
