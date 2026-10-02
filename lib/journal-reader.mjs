// Читатель журналов сессий и субагентов (спека витрины 1.2, 1.3, 1.5, 2.2, 2.3). Источник —
// ~/.claude/projects/<cwd>/<sessionId>.jsonl и <sessionId>/subagents/agent-<id>.jsonl (+ .meta.json), только чтение.
// Потоковый разбор с байтового смещения (файл целиком в память не берётся); индекс — data/vitrina/index/journals.json:
// смещение до последнего полного перевода строки и выжимка разбора. Рестарт дочитывает только новый хвост;
// файл стал короче смещения — разбор с начала. Удаление каталога индекса = полный пересбор.
// Ошибка чтения файла не роняет читателя: счётчик ошибок, прежние данные остаются (2.7).
import nodeFs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './config.mjs';
import { KNOWN_TYPES, newSessionState, feedSession, newAgentState, feedAgent, agentSummary } from './journal-parse.mjs';

const INDEX_VERSION = 1;
const NL = 0x0a;

// Строки файла с байта `start`; возврат — новое смещение (после последнего '\n'). Хвост без '\n' не трогается.
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
      if (line.trim()) onLine(line);
    }
    rest = buf.subarray(from);
  }
  return consumed;
}

const versionOf = (line) => line.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;

export function createJournalReader({ root, indexDir, rules = [], fs = nodeFs, now = () => new Date() }) {
  const indexFile = path.join(indexDir, 'journals.json');
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
      if (j?.v === INDEX_VERSION && j.files && typeof j.files === 'object') files = j.files;
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
    if (!e || size < e.offset) {
      e = files[f.file] = { ...f, offset: 0, lines: 0, unknown: {}, lastVersion: null, meta: f.kind === 'agent' ? readMeta(f.file) : null, st: f.kind === 'agent' ? newAgentState() : newSessionState() };
    }
    if (size === e.offset) return 0;
    let n = 0;
    const unknownAt = (v) => { const k = v ?? e.lastVersion ?? 'unknown'; e.unknown[k] = (e.unknown[k] ?? 0) + 1; };
    e.offset = await readLines(f.file, e.offset, (line) => {
      n++;
      let d;
      try { d = JSON.parse(line); } catch { unknownAt(versionOf(line)); return; }
      if (!d || typeof d !== 'object' || !KNOWN_TYPES.has(d.type)) { unknownAt(d?.version); return; }
      if (d.version) e.lastVersion = d.version;
      if (e.kind === 'agent') feedAgent(e.st, d);
      else feedSession(e.st, d, { rules });
    }, fs);
    e.lines += n;
    return n;
  }

  async function pass() {
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
    if (n > 0 || !fs.existsSync(indexFile)) {
      fs.mkdirSync(indexDir, { recursive: true });
      writeAtomic(indexFile, JSON.stringify({ v: INDEX_VERSION, files }));
    }
    if (!failed) lastOkAt = now().toISOString();
  }

  function sessions() {
    const agents = new Map();
    for (const e of Object.values(files)) if (e.kind === 'agent') agents.set(`${e.sessionId}/${e.agentId}`, e);
    const out = [];
    for (const e of Object.values(files)) {
      if (e.kind !== 'session') continue;
      const runs = Object.values(e.st.runs).map((r) => {
        const a = agents.get(`${e.sessionId}/${r.agentId}`);
        const s = a ? agentSummary(a.st) : null;
        return {
          agentId: r.agentId, agentType: r.agentType ?? a?.meta?.agentType ?? null, description: a?.meta?.description ?? r.description,
          at: r.at, target: r.target, cards: r.cards, continuations: r.continuations, messages: r.messages,
          alive: r.alive, lastEndAt: r.lastEndAt, lastEndKind: r.lastEndKind,
          turns: s?.turns ?? null, zakhods: s?.zakhods ?? null, maxZakhod: s?.maxZakhod ?? null, currentZakhod: s?.currentZakhod ?? null,
        };
      });
      out.push({
        sessionId: e.sessionId, project: e.project, file: e.file, lines: e.lines,
        ivan: e.st.ivan, runs, partials: e.st.partials, boardWrites: e.st.boardWrites, boardWritesFailed: e.st.boardWritesFailed,
      });
    }
    return out;
  }

  return {
    // один проход за раз: опрос не наслаивается на долгий начальный проход
    refresh() { running ??= pass().finally(() => { running = null; }); return running; },
    sessions,
    state() {
      const unknown = {};
      let lines = 0;
      let runsOpen = 0;
      for (const e of Object.values(files)) {
        lines += e.lines;
        for (const [v, c] of Object.entries(e.unknown)) unknown[v] = (unknown[v] ?? 0) + c;
        if (e.kind === 'session') for (const r of Object.values(e.st.runs)) if (r.alive) runsOpen++;
      }
      return { lastOkAt, errors, lastError, files: Object.keys(files).length, lines, lastPassLines, unknown, runsOpen };
    },
  };
}
