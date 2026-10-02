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
import { KNOWN_TYPES, newSessionState, feedSession, newAgentState, feedAgent, agentSummary } from './journal-parse.mjs';

// Версия формата индекса. В отпечаток входят текст journal-parse.mjs и правила boardWriteTools, а сам
// journal-reader.mjs — нет: правку читателя, меняющую смысл индекса (поля состояния, смещения, разбор строк),
// сопровождать подъёмом версии вручную.
const INDEX_VERSION = 2;
const PARSER_SOURCE = nodeFs.readFileSync(new URL('./journal-parse.mjs', import.meta.url), 'utf8');

// Отпечаток индекса: формат + текст разбора (концы строк не в счёт — checkout с autocrlf) + правила записи на доску.
export function indexFingerprint(parserSource, rules) {
  return crypto.createHash('sha1').update(String(INDEX_VERSION)).update('\0')
    .update(String(parserSource).replace(/\r\n/g, '\n')).update('\0').update(JSON.stringify(rules ?? [])).digest('hex');
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
export function createJournalReader({ root, indexDir, rules = [], fs = nodeFs, now = () => new Date(), feeders = {}, parserSource = PARSER_SOURCE, indexWriteEveryS = 0 }) {
  let lastWriteAt = -Infinity;
  const indexFile = path.join(indexDir, 'journals.json');
  const fp = indexFingerprint(parserSource, rules);
  const feed = { session: feeders.session ?? feedSession, agent: feeders.agent ?? feedAgent };
  let dirty = true;
  let indexBytes = null;
  let indexWriteMs = null;
  let indexWrites = 0;
  let files = {}; // путь → { kind, sessionId, agentId, project, offset, lines, unknown, lastVersion, meta, st }
  let lastOkAt = null;
  let errors = 0;
  let lastError = null;
  let lastPassLines = 0;
  let loaded = false;
  let running = null;

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

  function readMeta(file) {
    try {
      const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      return { agentType: m.agentType ?? null, description: m.description ?? null, toolUseId: m.toolUseId ?? null };
    } catch { return null; }
  }

  async function readFile(f) {
    const size = fs.statSync(f.file).size;
    let e = files[f.file];
    // Допущение: журналы Claude Code только дописываются. Переписанный файл узнаётся лишь по размеру меньше
    // смещения; переписанный той же или большей длины не узнаётся (тогда — удалить data/vitrina/index).
    if (!e || size < e.offset) {
      e = files[f.file] = { ...f, offset: 0, lines: 0, unknown: {}, lastVersion: null, meta: f.kind === 'agent' ? readMeta(f.file) : null, st: f.kind === 'agent' ? newAgentState() : newSessionState() };
    }
    // .meta.json мог появиться позже журнала — дочитывать, пока его нет
    if (e.kind === 'agent' && !e.meta) e.meta = readMeta(f.file);
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
      try { if (e.kind === 'agent') feed.agent(e.st, d); else feed.session(e.st, d, { rules }); } catch { unknownAt(d.version); }
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

  async function pass() {
    try { await passBody(); } catch (err) { errors++; lastError = err.code ?? 'ERR'; }
  }

  async function passBody() {
    if (!loaded) loadIndex();
    let n = 0;
    let failed = false;
    const seen = new Set();
    let found = [];
    try { found = discover(); } catch (err) { errors++; lastError = err.code ?? 'ERR'; return; }
    for (const f of found) {
      seen.add(f.file);
      try { n += await readFile(f); } catch (err) { failed = true; errors++; lastError = err.code ?? 'ERR'; }
    }
    for (const k of Object.keys(files)) if (!seen.has(k)) delete files[k];
    lastPassLines = n;
    if (n > 0) dirty = true;
    if (dirty && now().getTime() - lastWriteAt >= indexWriteEveryS * 1000) writeIndex();
    if (!failed) lastOkAt = now().toISOString();
  }

  function sessions() {
    const agents = new Map();
    for (const e of Object.values(files)) if (e.kind === 'agent') { agents.set(`${e.sessionId}/${e.agentId}`, e); if (!agents.has(e.agentId)) agents.set(e.agentId, e); }
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
        };
      });
      out.push({
        sessionId: e.sessionId, project: e.project, okAt: e.okAt ?? null, file: e.file, lines: e.lines,
        ivan: e.st.ivan, runs, partials: e.st.partials, thread: e.st.thread ?? null, boardWrites: e.st.boardWrites, boardWritesFailed: e.st.boardWritesFailed,
      });
    }
    return out;
  }

  return {
    // один проход за раз: опрос не наслаивается на долгий начальный проход
    refresh() { running ??= pass().finally(() => { running = null; }); return running; },
    sessions,
    // штатная остановка: записать индекс сразу, если есть незаписанное
    flush() { if (dirty) writeIndex(); },
    state() {
      const unknown = {};
      let lines = 0;
      let runsOpen = 0;
      for (const e of Object.values(files)) {
        lines += e.lines;
        for (const [v, c] of Object.entries(e.unknown)) unknown[v] = (unknown[v] ?? 0) + c;
        if (e.kind === 'session') for (const r of Object.values(e.st.runs)) if (r.alive) runsOpen++;
      }
      return { lastOkAt, errors, lastError, files: Object.keys(files).length, lines, lastPassLines, unknown, runsOpen, indexBytes, indexWriteMs, indexWrites };
    },
  };
}
