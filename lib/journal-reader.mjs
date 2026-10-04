// Читатель журналов сессий и субагентов (спека витрины 1.2, 1.3, 1.5, 2.2, 2.3). Источник —
// ~/.claude/projects/<cwd>/<sessionId>.jsonl и <sessionId>/subagents/agent-<id>.jsonl (+ .meta.json), только чтение.
// Потоковый разбор с байтового смещения (файл целиком в память не берётся); индекс — data/vitrina/index/journals.json:
// смещение до последнего полного перевода строки и выжимка разбора. Рестарт дочитывает только новый хвост;
// Удаление каталога индекса = полный пересбор; он же — при смене отпечатка (версия формата индекса, текст
// journal-parse.mjs, правила boardWriteTools): индекс хранит вычисленное состояние, старое на новых правилах не годится.
// Ошибка чтения файла или записи индекса не роняет читателя: счётчик ошибок, прежние данные остаются (2.7);
// refresh() не отклоняется никогда.
import nodeFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KNOWN_TYPES, newSessionState, feedSession, newAgentState, feedAgent, agentSummary, pathKey, DRIFT_KEYS, addDriftKey, seenUuidCount, memorySummary, editsOf, EDIT_KEEP_MS } from './journal-parse.mjs';

// Версия формата индекса. В отпечаток входят текст journal-parse.mjs и правила boardWriteTools, а сам
// journal-reader.mjs — нет: правку читателя, меняющую смысл индекса (поля состояния, смещения, разбор строк),
// сопровождать подъёмом версии вручную.
const INDEX_VERSION = 3;
// разбор + text.mjs (cutChars режет хранимый текст при разборе): правка любого из двух — полный пересбор индекса
const PARSER_SOURCE = ['./journal-parse.mjs', './text.mjs'].map((f) => nodeFs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\0');

// Отпечаток индекса: формат + текст разбора (концы строк не в счёт — checkout с autocrlf) + правила записи на доску
// + набор файлов «правила перечитаны» (EXT-54: в состоянии — чтения только файлов набора; сменился набор — пересбор)
// + срок хранения правок файлов (EXT-60: окно «Общего файла» + запас; окно выросло — старых правок в индексе нет, пересбор).
export function indexFingerprint(parserSource, rules, reread = [], editKeepMs = EDIT_KEEP_MS) {
  return crypto.createHash('sha1').update(String(INDEX_VERSION)).update('\0')
    .update(String(parserSource).replace(/\r\n/g, '\n')).update('\0').update(JSON.stringify(rules ?? []))
    .update('\0').update(JSON.stringify((reread ?? []).map(pathKey))).update('\0').update(String(editKeepMs)).digest('hex');
}
const NL = 0x0a;

// Строки файла с байта `start`: onLine(строка | null для пустой, смещение после её '\n') — смещение двигается
// построчно: сбой потока посреди файла не даёт двойного счёта на повторе. Хвост без '\n' не трогается.
async function readLines(file, start, onLine, fs) {
  const stream = fs.createReadStream(file, { start });
  let rest = Buffer.alloc(0);
  let consumed = start;
  for await (const chunk of stream) {
    let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0;
    let i;
    while ((i = buf.indexOf(NL, from)) !== -1) {
      const line = buf.toString('utf8', from, i).replace(/\r$/, '');
      consumed += i - from + 1;
      from = i + 1;
      onLine(line.trim() ? line : null, consumed);
    }
    rest = buf.subarray(from);
  }
}

// Версия CLI для счётчика непонятых строк — только вида N.N.N, иначе «?».
const VER = /^\d+\.\d+\.\d+$/;
const verKey = (v) => (typeof v === 'string' && VER.test(v) ? v : '?');
const versionOf = (line) => line.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)?.[1] ?? '?';

// feeders — разбор строк (подмена — только в тестах сбоя разбора).
// indexWriteEveryS — индекс пишется не чаще раза в N с (и flush() при штатной остановке); смещения в памяти идут
// как раньше, после рестарта хвост дочитывается от последнего записанного смещения (состояние записано с ним вместе).
// EXT-37 (нагрузка покоя): полный обход (discover — readdir всех каталогов, stat всех журналов) — раз в fullEveryMs;
// между ними — горячий проход: stat журналов, менявшихся за hotMs (mtime последнего stat), и журналов живых сессий
// (liveSessions() — sessionId реестра процессов), readdir каталогов проектов (новый .jsonl), subagents горячих сессий.
// runSilentMin (EXT-53) — config.json → thresholds.runSilentMin: живой запуск без вестей дольше — runsSilent, не runsLive.
export function createJournalReader({ root, indexDir, rules = [], reread = [], rereadOff = null, fs = nodeFs, now = () => new Date(), feeders = {}, parserSource = PARSER_SOURCE, indexWriteEveryS = 0, fullEveryMs = 30000, hotMs = 15 * 60000, liveSessions = () => [], runSilentMin = 30, editKeepMs = EDIT_KEEP_MS }) {
  let lastWriteAt = -Infinity;
  let lastFullAt = -Infinity;
  const indexFile = path.join(indexDir, 'journals.json');
  const fp = indexFingerprint(parserSource, rules, reread, editKeepMs);
  const feed = { session: feeders.session ?? feedSession, agent: feeders.agent ?? feedAgent };
  let dirty = true;
  let indexBytes = null;
  let indexWriteMs = null;
  let indexWrites = 0;
  let files = {}; // путь → { kind, sessionId, agentId, project, offset, lines, unknown, lastVersion, meta, st }
  let lastOkAt = null;
  let failingSince = null; // 2.7: с первого неудачного прохода подряд, удачный снимает
  let errors = 0;
  let lastError = null;
  let lastPassLines = 0;
  let loaded = false;
  let running = null;
  let runningFull = false; // идущий проход — полный (решено в начале passBody, до первого await)
  let queuedFull = null; // полный обход, запрошенный во время горячего (мелочь 1 Голема на В10)

  function loadIndex() {
    loaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (j?.fp === fp && j.files && typeof j.files === 'object') { files = j.files; dirty = false; }
    } catch { /* нет индекса или битый — полный пересбор */ }
  }

  function discover() {
    const out = [];
    for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const pd = path.join(root, proj.name);
      for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ file: path.join(pd, e.name), kind: 'session', project: proj.name, sessionId: e.name.slice(0, -6), agentId: null });
        } else if (e.isDirectory()) {
          const sd = path.join(pd, e.name, 'subagents');
          let names = [];
          try { names = fs.readdirSync(sd); } catch { continue; }
          for (const n of names) {
            const m = n.match(/^agent-([A-Za-z0-9]+)\.jsonl$/);
            if (m) out.push({ file: path.join(sd, n), kind: 'agent', project: proj.name, sessionId: e.name, agentId: m[1] });
          }
        }
      }
    }
    return out;
  }

  // Горячее: известные журналы, менявшиеся за hotMs или живых сессий; новые .jsonl каталогов проектов; новые журналы
  // в subagents горячих сессий (корень читается целиком — новый каталог проекта виден и здесь). Журнал субагента
  // остывшей сессии — на полном обходе.
  function discoverHot(nowMs) {
    const live = new Set(liveSessions() ?? []);
    const out = [];
    const hotSessions = new Map(); // каталог проекта + sessionId → {pd, project, sessionId}
    const hotSession = (pd, project, sessionId) => hotSessions.set(`${pd}|${sessionId}`, { pd, project, sessionId });
    for (const e of Object.values(files)) {
      if (!live.has(e.sessionId) && !(nowMs - (e.mtimeMs ?? -Infinity) < hotMs)) continue;
      out.push({ file: e.file, kind: e.kind, project: e.project, sessionId: e.sessionId, agentId: e.agentId });
      const pd = e.kind === 'agent' ? path.dirname(path.dirname(path.dirname(e.file))) : path.dirname(e.file);
      hotSession(pd, e.project, e.sessionId);
    }
    for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const pd = path.join(root, proj.name);
      for (const n of fs.readdirSync(pd)) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(pd, n);
        if (files[file]) continue;
        out.push({ file, kind: 'session', project: proj.name, sessionId: n.slice(0, -6), agentId: null });
        hotSession(pd, proj.name, n.slice(0, -6));
      }
    }
    for (const { pd, project, sessionId } of hotSessions.values()) {
      const sd = path.join(pd, sessionId, 'subagents');
      let names = [];
      try { names = fs.readdirSync(sd); } catch { continue; }
      for (const n of names) {
        const m = n.match(/^agent-([A-Za-z0-9]+)\.jsonl$/);
        const file = path.join(sd, n);
        // новый журнал субагента или известный, чей .meta.json ещё не прочитан (он мог появиться позже)
        if (m && (!files[file] || !files[file].meta)) out.push({ file, kind: 'agent', project, sessionId, agentId: m[1] });
      }
    }
    return out;
  }

  function readMeta(file) {
    try {
      const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      return { agentType: m.agentType ?? null, description: m.description ?? null, toolUseId: m.toolUseId ?? null };
    } catch { return null; }
  }

  async function readFile(f) {
    const stat = fs.statSync(f.file);
    const size = stat.size;
    let e = files[f.file];
    // Допущение: журналы Claude Code только дописываются. Переписанный файл узнаётся лишь по размеру меньше
    // смещения; переписанный той же или большей длины не узнаётся (тогда — удалить data/vitrina/index).
    if (!e || size < e.offset) {
      e = files[f.file] = { ...f, offset: 0, lines: 0, unknown: {}, lastVersion: null, meta: f.kind === 'agent' ? readMeta(f.file) : null, st: f.kind === 'agent' ? newAgentState() : newSessionState() };
    }
    // .meta.json мог появиться позже журнала — дочитывать, пока его нет
    if (e.kind === 'agent' && !e.meta) e.meta = readMeta(f.file);
    e.mtimeMs = stat.mtimeMs; // горячий ли журнал (EXT-37)
    // время создания файла (EXT-60): чья копия строки правки — у сессии, чей файл появился позже (copyOwners)
    e.bornMs ??= Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
    // время последнего удачного чтения этого журнала («устарело» треда — по своему журналу, вердикт Голема)
    if (size === e.offset) { e.okAt = now().toISOString(); return 0; }
    let n = 0;
    // строка без version (служебные типы) — версией последней строки файла; есть, но не N.N.N — «?»
    const unknownAt = (v) => { const k = v === undefined || v === null ? (e.lastVersion ?? '?') : verKey(v); e.unknown[k] = (e.unknown[k] ?? 0) + 1; };
    await readLines(f.file, e.offset, (line, offset) => {
      e.offset = offset;
      if (line === null) return;
      n++;
      e.lines++;
      let d;
      try { d = JSON.parse(line); } catch { unknownAt(versionOf(line)); return; }
      if (!d || typeof d !== 'object' || !KNOWN_TYPES.has(d.type)) { unknownAt(d?.version); return; }
      if (VER.test(d.version ?? '')) e.lastVersion = d.version;
      // исключение разбора на строке — строка «непонятая», проход идёт дальше
      try { if (e.kind === 'agent') feed.agent(e.st, d, { rules, editKeepMs }); else feed.session(e.st, d, { rules, reread, editKeepMs }); } catch { unknownAt(d.version); }
    }, fs);
    e.okAt = now().toISOString();
    return n;
  }

  function writeIndex() {
    const tmp = `${indexFile}.${process.pid}.tmp`;
    const t0 = performance.now();
    try {
      fs.mkdirSync(indexDir, { recursive: true });
      const text = JSON.stringify({ v: INDEX_VERSION, fp, files });
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, indexFile);
      indexBytes = Buffer.byteLength(text);
      indexWriteMs = Math.round(performance.now() - t0);
      dirty = false;
      lastWriteAt = now().getTime();
      indexWrites++;
    } catch (err) {
      // запись индекса не удалась (каталог заперт, диск) — данные в памяти целы, повтор на следующем проходе
      errors++;
      lastError = err.code ?? 'ERR';
      try { fs.unlinkSync(tmp); } catch { /* не было */ }
    }
  }

  async function pass(full) {
    try { await passBody(full); } catch (err) { errors++; lastError = err.code ?? 'ERR'; failingSince ??= now().toISOString(); }
  }

  async function passBody(forceFull) {
    if (!loaded) loadIndex();
    let n = 0;
    let failed = false;
    const seen = new Set();
    let found = [];
    const nowMs = now().getTime();
    const full = forceFull || nowMs - lastFullAt >= fullEveryMs;
    try { found = full ? discover() : discoverHot(nowMs); } catch (err) { errors++; lastError = err.code ?? 'ERR'; failingSince ??= now().toISOString(); return; }
    if (full) lastFullAt = nowMs;
    runningFull = full;
    for (const f of found) {
      seen.add(f.file);
      try { n += await readFile(f); } catch (err) {
        // горячий журнал удалён между проходами — не сбой: полный обход уберёт его из индекса
        if (!full && err.code === 'ENOENT') continue;
        failed = true; errors++; lastError = err.code ?? 'ERR';
      }
    }
    if (full) for (const k of Object.keys(files)) if (!seen.has(k)) delete files[k];
    lastPassLines = n;
    if (n > 0) dirty = true;
    if (dirty && now().getTime() - lastWriteAt >= indexWriteEveryS * 1000) writeIndex();
    if (!failed) { lastOkAt = now().toISOString(); failingSince = null; } else failingSince ??= now().toISOString();
  }

  function refresh({ full = false } = {}) {
    if (!running) {
      runningFull = full;
      running = pass(full).finally(() => { running = null; });
      return running;
    }
    if (!full || runningFull) return running;
    queuedFull ??= running.then(() => { queuedFull = null; return refresh({ full: true }); });
    return queuedFull;
  }

  function sessions() {
    const agents = agentIndex();
    const sessionIds = new Set(Object.values(files).filter((e) => e.kind === 'session').map((e) => e.sessionId));
    const out = [];
    for (const e of Object.values(files)) {
      if (e.kind !== 'session') continue;
      const runs = Object.values(e.st.runs).map((r) => {
        // журнал субагента — у своей сессии; у копии сессии (продолженный тред, другой id) — по agentId
        const a = agents.get(`${e.sessionId}/${r.agentId}`) ?? agents.get(r.agentId);
        const s = a ? agentSummary(a.st) : null;
        return {
          agentId: r.agentId, // тип и описание: сначала .meta.json субагента, потом ввод вызова Agent у родителя
          agentType: a?.meta?.agentType ?? r.agentType ?? null, description: a?.meta?.description ?? r.description ?? null,
          at: r.at, target: r.target, cards: r.cards, continuations: r.continuations, messages: r.messages,
          alive: r.alive, lastEndAt: r.lastEndAt, lastEndKind: r.lastEndKind, lastAt: s?.lastAt ?? null,
          turns: s?.turns ?? null, zakhods: s?.zakhods ?? null, maxZakhod: s?.maxZakhod ?? null, currentZakhod: s?.currentZakhod ?? null,
          // В4: начала заходов, последний текст и «осталось» (блок обрыва), успешные записи субагента на доску (В-15)
          starts: r.starts ?? [r.at], lastText: s?.lastText ?? null, left: s?.left ?? null, boardWrites: s?.boardWrites ?? [],
          // EXT-60: правки файлов субагента — владельцу-треду («Общий файл»). Владелец — сессия, к которой журнал привязан
          // по своей сессии; запасной путь по agentId (запуск — копия строк прежней сессии в продолженном треде) правок не
          // даёт, если журнал своей сессии на месте: иначе у правки два владельца (вердикт Голема, Важно 2)
          edits: a && (a.sessionId === e.sessionId || !sessionIds.has(a.sessionId)) ? s.edits : [],
        };
      });
      out.push({
        sessionId: e.sessionId, project: e.project, okAt: e.okAt ?? null, file: e.file, lines: e.lines,
        ivan: e.st.ivan, runs, partials: e.st.partials, thread: e.st.thread ?? null, boardWrites: e.st.boardWrites, boardWritesFailed: e.st.boardWritesFailed,
        rings: e.st.rings ?? {}, // EXT-63: звонки витрины в журнале треда — id → время (статус «прочитано», спека пульта §2.8)
        // EXT-60: правки файлов треда (Edit/MultiEdit/Write/NotebookEdit с удачным результатом): [{p, at}] — только из строк
        // со sessionId этого файла (копии строк прежних сессий — не его правки; вердикт Голема, Важно 2)
        edits: editsOf(e.st, e.sessionId), // id вызовов — до отсечения копий ниже (dropCopies)
        reread: e.st.reread ?? {}, // EXT-54: последнее удачное чтение каждого файла набора rulesReread (ключ — pathKey)
        // EXT-49: память треда {tokens, model, at, compactions} или null; сжатия — строки с sessionId этого файла
        memory: memorySummary(e.st, e.sessionId),
      });
    }
    return dropCopies(out);
  }

  // EXT-60, вторая форма копий (решение дирижёра по развилке, вариант а): продолженный или форкнутый тред несёт в своём
  // файле копии строк прежней сессии с переписанным sessionId (uuid, время и id вызова — те же; живые журналы 04.10:
  // 1 950 id вызовов правки в 2+ файлах сессий). Ключ копии — id вызова (tool_use id): правка с id, который есть у правки
  // другой сессии, считается только у сессии, чей файл появился раньше (bornMs — время создания файла; нет его — позже
  // всех; при равенстве — меньший sessionId). Своя новая правка после продолжения или форка — новый id, считается.
  // Время правки пути — самая поздняя из оставшихся; не осталось ни одной — пути у сессии нет. Наружу — {p, at}.
  function dropCopies(out) {
    const born = new Map();
    for (const e of Object.values(files)) if (e.kind === 'session') born.set(e.sessionId, e.bornMs ?? Infinity);
    const before = (a, b) => (born.get(a) ?? Infinity) - (born.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
    const owner = new Map();
    for (const s of out) for (const ed of s.edits) for (const [id] of ed.ids ?? []) {
      const o = owner.get(id);
      if (o === undefined || before(s.sessionId, o) < 0) owner.set(id, s.sessionId);
    }
    for (const s of out) {
      s.edits = s.edits.flatMap((ed) => {
        const mine = (ed.ids ?? []).filter(([id]) => owner.get(id) === s.sessionId);
        if (!mine.length) return [];
        const at = mine.reduce((x, [, t]) => (Date.parse(t) > Date.parse(x) ? t : x), mine[0][1]);
        return [{ p: ed.p, at }];
      });
    }
    return out;
  }

  // Журнал субагента: сначала своей сессии, потом по agentId (копия сессии — продолженный тред с другим id)
  function agentIndex() {
    const agents = new Map();
    for (const e of Object.values(files)) if (e.kind === 'agent') { agents.set(`${e.sessionId}/${e.agentId}`, e); if (!agents.has(e.agentId)) agents.set(e.agentId, e); }
    return agents;
  }

  // Дрейф разбора (EXT-53) — /api/health → readers.journals.drift. Словари — сумма st.drift журналов (тот же предел
  // значений), agentLaunchErrors — сумма по сессиям, orphanAgentJournals — журналы agent-*.jsonl, чьего запуска нет в
  // их сессии (ни среди запусков, ни ждущим вызовом Agent по toolUseId из .meta.json); до первого полного обхода — null.
  // Счёт живёт в индексе: после пересбора индекса (смена отпечатка разбора, удаление data/vitrina/index) — заново.
  function driftState() {
    const out = Object.fromEntries(DRIFT_KEYS.map((k) => [k, {}]));
    let agentLaunchErrors = 0;
    const sessionsById = new Map();
    for (const e of Object.values(files)) {
      for (const k of DRIFT_KEYS) for (const [v, c] of Object.entries(e.st?.drift?.[k] ?? {})) addDriftKey(out[k], v, c);
      if (e.kind === 'session') { agentLaunchErrors += e.st.agentLaunchErrors ?? 0; sessionsById.set(e.sessionId, e.st); }
    }
    let orphanAgentJournals = null;
    if (lastFullAt > -Infinity) {
      orphanAgentJournals = 0;
      for (const e of Object.values(files)) {
        if (e.kind !== 'agent') continue;
        const st = sessionsById.get(e.sessionId);
        const tu = e.meta?.toolUseId;
        if (!st?.runs?.[e.agentId] && !(tu && st?.pending?.[tu])) orphanAgentJournals++;
      }
    }
    return { ...out, agentLaunchErrors, orphanAgentJournals };
  }

  // runsOpen (запуск без итога) = runsLive + runsSilent (EXT-53). Свежая весть — последнее из: время строки журнала
  // субагента, событие запуска в журнале сессии (старт, продолжение, сообщение, уведомление); без вестей дольше
  // runSilentMin — runsSilent (чаще всего запуск без распознанного конца, «Остаточный риск» 11).
  function runsSplit() {
    const agents = agentIndex();
    const nowMs = now().getTime();
    let live = 0;
    let silent = 0;
    for (const e of Object.values(files)) {
      if (e.kind !== 'session') continue;
      for (const r of Object.values(e.st.runs)) {
        if (!r.alive) continue;
        const a = agents.get(`${e.sessionId}/${r.agentId}`) ?? agents.get(r.agentId);
        const last = Math.max(...[a?.st?.lastAt, r.lastEventAt, r.at, ...(r.starts ?? [])].map((x) => Date.parse(x ?? '')).filter(Number.isFinite));
        if (nowMs - last <= runSilentMin * 60000) live++; else silent++;
      }
    }
    return { runsLive: live, runsSilent: silent };
  }

  return {
    // один проход за раз: опрос не наслаивается на долгий начальный проход
    // { full: true } — полный обход сейчас (пробуждение); иначе полный — раз в fullEveryMs, между ними горячий
    // полный, пришедший во время горячего, — сразу после него (мелочь 1 Голема на В10: иначе пробуждение получало горячий)
    refresh,
    sessions,
    // штатная остановка: записать индекс сразу, если есть незаписанное
    flush() { if (dirty) writeIndex(); },
    // ключей во множествах прочитанных uuid всех сессий (EXT-41) — для строки stats (EXT-53)
    uuidKeys() {
      let n = 0;
      for (const e of Object.values(files)) if (e.kind === 'session') n += seenUuidCount(e.st);
      return n;
    },
    state() {
      const unknown = {};
      let lines = 0;
      for (const e of Object.values(files)) {
        lines += e.lines;
        for (const [v, c] of Object.entries(e.unknown)) unknown[v] = (unknown[v] ?? 0) + c;
      }
      const { runsLive, runsSilent } = runsSplit();
      // runsOpen — сумма, ради совместимости (прежний счётчик «запусков без распознанного конца»)
      return { lastOkAt, failingSince, errors, lastError, files: Object.keys(files).length, lines, lastPassLines, unknown, runsOpen: runsLive + runsSilent, runsLive, runsSilent, drift: driftState(), indexBytes, indexWriteMs, indexWrites,
        // EXT-54: файлов в наборе «правила перечитаны» и код причины выключения функции (null — включена)
        rereadFiles: reread.length, rereadOff };
    },
  };
}
