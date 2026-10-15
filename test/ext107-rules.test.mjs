// EXT-107 Р3 (спека, раздел EXT-107 «Р3. Набор «перечитай правила» и жирная строка хроники (EXT-104)»): набор
// rulesReread.files из 4 файлов (И-4 (а), слово Ивана 14.10) — паспорт Трурля, Vault CLAUDE.md, протокол, автослой;
// строка хроники с «· **правила обновлены:**» (форма с 11.10) — момент правил, note без «**». Гейт Р3: №1–5.
// Строки хроники — живые, из unorbis/Хроника/2026-10.md (строки 211, 213; 14.10) и 2026-09.md (строка 55), без правок.
// Границы слов — явные («· » перед словами); \b на кириллице не работает. Ожидания — из спеки, не из кода под тестом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../lib/app.mjs';
import { createBoardReader } from '../lib/board-reader.mjs';
import { createGitRead } from '../lib/git-read.mjs';
import { createRegistryReader } from '../lib/registry.mjs';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { newSessionState, feedSession } from '../lib/journal-parse.mjs';
import { createRulesMoment, parseChronicle } from '../lib/rules-moment.mjs';
import { resolveReread } from '../lib/rules-reread.mjs';
import { buildWorkers } from '../lib/waiting.mjs';
import { BOARD_LIB, tmpDir, makeBoard, gitInitCommit } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8')).rulesReread.files;
const VAULT = 'C:\\Users\\imuri\\Documents\\Obsidian Vault';
const HOME = 'C:\\Users\\imuri';
// пути — как их пишет Read в журнале (file_path, обратные косые)
const P_PASS = `${VAULT}\\unorbis\\_meta\\agents\\trurl.md`;
const P_RULES = `${VAULT}\\CLAUDE.md`;
const P_PROTO = `${VAULT}\\unorbis\\_meta\\Субагенты Claude Code.md`;
const P_LAYER = `${HOME}\\.claude\\CLAUDE.md`;

// живые строки хроники
const SIMPLE = '20.09 · цех · правила обновлены: Бальду — набор плагина «дизайн» с полки · INFRA-57 · df01015';
const BOLD_NOHASH = '14.10 · цех · **правила обновлены:** строка хроники — одна фраза до ~40 слов (что, чем подтверждено, важная оговорка) вместо «до ~12 слов»; слово Ивана в чате · INFRA-93';
const BOLD = '14.10 · цех · **правила обновлены:** протокол субагентов — ядро и приложения (71 → ~50 тыс. знаков): моды — отдельным файлом, грабли прогонов и порядок постов — в «Граблях» и «Постах» дословно, в протоколе — выжимки с поводом читать; Голем — два круга, Критично нет · INFRA-93 · e8bd962';
const BOLD_NOTE = 'протокол субагентов — ядро и приложения (71 → ~50 тыс. знаков): моды — отдельным файлом, грабли прогонов и порядок постов — в «Граблях» и «Постах» дословно, в протоколе — выжимки с поводом читать; Голем — два круга, Критично нет · INFRA-93 · e8bd962';
// время коммитов — подменный git: хеш → время (как git log -1 --format=%cI)
const COMMITS = { df01015: '2026-09-20T15:00:00+03:00', e8bd962: '2026-10-14T21:10:00+03:00' };
const fakeGit = async (_repo, args) => {
  const h = args[3];
  if (args[0] === 'log' && COMMITS[h]) return `${COMMITS[h]}\n`;
  throw new Error('нет коммита');
};
const iso = (s) => new Date(s).toISOString();

async function momentOf(text, name = '2026-10.md') {
  const dir = tmpDir('ext107r3-chron-');
  fs.writeFileSync(path.join(dir, name), text);
  const m = createRulesMoment({ dir, git: fakeGit, repos: ['C:/vault'], vaultRepo: null });
  await m.refresh();
  return m.get();
}

// ---------------- №1 поломка: жирная строка — момент ----------------

test('Р3 №1: последняя строка хроники «· **правила обновлены:** … · INFRA-93 · e8bd962» — момент = время коммита e8bd962', async () => {
  const m = await momentOf(`${SIMPLE}\n${BOLD}\n`);
  assert.equal(m?.at, iso(COMMITS.e8bd962), 'момент — коммит хеша жирной строки, не прежней простой');
  assert.equal(m.by, 'commit');
  assert.equal(m.hash, 'e8bd962');
  // жирная строка без хеша (живая 211) — тоже момент, хешей нет
  const r = parseChronicle([{ name: '2026-10.md', text: `${SIMPLE}\n${BOLD_NOHASH}\n` }]);
  assert.deepEqual([r?.day, r?.month, r?.hashes], [14, 10, []]);
});

// ---------------- №2 поломка: набор из 4 файлов ----------------

// строки Read из фикстуры rules-reread.jsonl (живой журнал 2fea3135, обезличен): пара вызов/результат, путь и время — свои
const FX = fs.readFileSync(path.join(HERE, 'fixtures', 'journals', 'rules-reread.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let nRead = 0;
function readPair(file, at) {
  const id = `toolu_ext107r3_${++nRead}`;
  const call = structuredClone(FX[6]);
  const res = structuredClone(FX[7]);
  call.message.id = `msg_ext107r3_${nRead}`;
  call.requestId = `req_ext107r3_${nRead}`;
  call.message.content[0].id = id;
  call.message.content[0].input = { file_path: file };
  call.wireToolInputs = { [id]: { file_path: file } };
  call.timestamp = at;
  call.uuid = `00000000-0000-4000-8000-a${String(nRead).padStart(11, "0")}`;
  res.message.content[0].tool_use_id = id;
  res.timestamp = at;
  res.uuid = `00000000-0000-4000-8000-b${String(nRead).padStart(11, "0")}`; // повтор uuid отсекается по 12 последним знакам — у пары они разные
  return [call, res];
}
const MOMENT = iso(COMMITS.e8bd962);
const NOW = Date.parse('2026-10-14T20:00:00Z');
const AFTER = '2026-10-14T19:00:00.000Z';
const SID = '00000000-0000-4000-8000-0000000000a1';
const board = { hasCard: () => false, card: () => null, hasCode: (c) => c === 'EXT' };
const proc = (sessionId, name) => ({ pid: 1, sessionId, name, live: true, startedAt: Date.parse('2026-10-14T08:00:00Z'), status: 'idle', observedAt: NOW, statusUpdatedAt: NOW });

function threadOf(files, name = 'EXT') {
  const set = resolveReread(DEF, { vaultRoot: VAULT, home: HOME });
  assert.equal(set.off, null);
  const st = newSessionState();
  for (const f of files) for (const d of readPair(f, AFTER)) feedSession(st, d, { reread: set.files });
  const w = buildWorkers({ procs: [proc(SID, name)], desktop: () => null, sessions: [{ sessionId: SID, ivan: { cards: {} }, runs: [], partials: [], boardWrites: [], thread: st.thread, reread: st.reread }],
    board, maxTurns: () => 90, now: NOW, thresholds: {}, rulesAt: MOMENT, reread: set.files, vaultRoot: VAULT, home: HOME });
  return w.threads.find((t) => t.sessionId === SID);
}

test('Р3 №2: тред после момента прочитал CLAUDE.md, протокол и автослой, но не паспорт — «Старые правила», missing = [trurl.md]', () => {
  const t = threadOf([P_RULES, P_PROTO, P_LAYER]);
  assert.equal(t.rulesReread, null);
  assert.deepEqual(t.marks, [{ kind: 'oldRules', rulesUpdatedAt: MOMENT, missing: [{ path: path.join(VAULT, 'unorbis/_meta/agents/trurl.md'), short: 'unorbis/_meta/agents/trurl.md' }] }]);
});

test('Р3 №2: прочитал и паспорт — «правила перечитаны», пометки нет', () => {
  const t = threadOf([P_PASS, P_RULES, P_PROTO, P_LAYER]);
  assert.deepEqual(t.marks, []);
  assert.equal(t.rulesReread, AFTER);
});

test('Р3 №2: набор по умолчанию — ровно 4 файла: паспорт, CLAUDE.md, протокол, автослой; приложений протокола нет', () => {
  assert.deepEqual(DEF, ['unorbis/_meta/agents/trurl.md', 'CLAUDE.md', 'unorbis/_meta/Субагенты Claude Code.md', '~/.claude/CLAUDE.md']);
});

// ---------------- №3 исправный ----------------

test('Р3 №3: простая строка «· правила обновлены:» — момент как раньше; note — текст после двоеточия', async () => {
  const m = await momentOf(`${SIMPLE}\n`, '2026-09.md');
  assert.equal(m?.at, iso(COMMITS.df01015));
  assert.equal(m.note, 'Бальду — набор плагина «дизайн» с полки · INFRA-57 · df01015');
});

test('Р3 №3: «; правила обновлены:» и «; **правила обновлены:**» — не момент (граница — «· » перед словами)', () => {
  for (const line of ['24.09 · портал · пост; правила обновлены: x · INFRA-71 · adaee7f', '14.10 · портал · пост; **правила обновлены:** x · INFRA-71 · adaee7f']) {
    assert.equal(parseChronicle([{ name: '2026-10.md', text: `${line}\n` }]), null, line);
  }
});

test('Р3 №1: жирная строка, за ней «; **правила обновлены:**» — момент задаёт жирная («;»-строка не перебивает)', () => {
  assert.equal(parseChronicle([{ name: '2026-10.md', text: `${BOLD}\n14.10 · портал · пост; **правила обновлены:** x · INFRA-71 · adaee7f\n` }])?.hashes[0], 'e8bd962');
});

test('Р3 №3: тред без проекта — без пометки и без «перечитаны» при наборе из 4 файлов', () => {
  const t = threadOf([P_RULES], 'Поиск билетов Рига–Малага');
  assert.equal(t.project, null);
  assert.deepEqual(t.marks, []);
  assert.equal(t.rulesReread, null);
});

// ---------------- №4 край: путь паспорта не разрешился ----------------

test('Р3 №4: vault_root нет — путь паспорта (элемент 0) не разрешился: набор выключен, причина в /api/health', async () => {
  const rr = resolveReread(DEF, { vaultRoot: null, home: HOME });
  assert.deepEqual(rr, { files: [], off: 'NO_VAULT_ROOT', item: 0 });
  // Р5б (ревью Голема): не разрешился именно паспорт — элемент набора по номеру item, а не «первый какой-то»
  assert.equal(DEF[rr.item], 'unorbis/_meta/agents/trurl.md');
  const journals = createJournalReader({ root: tmpDir('ext107r3-j-'), indexDir: tmpDir('ext107r3-i-'), reread: rr.files, rereadOff: rr.off });
  const bdir = tmpDir('ext107r3-board-');
  makeBoard(bdir, { codes: ['EXT'] });
  gitInitCommit(bdir);
  const { parseCard } = await import(new URL(`file:///${BOARD_LIB}/header.mjs`).href);
  const { parseLog, latest } = await import(new URL(`file:///${BOARD_LIB}/log.mjs`).href);
  const b = createBoardReader({ root: bdir, git: createGitRead(), parseCard, parseLog, latest });
  await b.init();
  const registry = createRegistryReader(path.join(tmpDir('ext107r3-reg-'), 'registry.json'));
  const app = await buildApp({ port: 4317, board: b, registry, journals, scan: () => [] });
  try {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4317' } });
    assert.equal(r.statusCode, 200);
    const j = r.json().readers.journals;
    assert.equal(j.rereadOff, 'NO_VAULT_ROOT');
    assert.equal(j.rereadFiles, 0);
  } finally { await app.close(); }
});

// ---------------- №5 текст момента ----------------

test('Р3 №5: note жирной строки — без «**», начинается с текста после «правила обновлены:»', async () => {
  const r = parseChronicle([{ name: '2026-10.md', text: `${BOLD}\n` }]);
  assert.equal(r?.note, BOLD_NOTE);
  const m = await momentOf(`${BOLD}\n`);
  assert.equal(m?.note, BOLD_NOTE);
  assert.ok(!m.note.includes('**'));
});
