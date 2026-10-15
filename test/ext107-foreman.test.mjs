// EXT-107 Р4 (спека витрины, раздел «EXT-107», Р4): тред прораба Тарантоги на витрине. Признак прораба — в одном месте
// (buildWorkers: семья по запуску или имя из журнала foremanTitle), у прораба (Б)/(В) «ждёт тебя» не дают (state сразу idle,
// И-5 (а) — слово Ивана 14.10), строки user сессии с foremanTitle — не слова Ивана, метка «прораб · без окна», автор
// «Тарантога (trurl:<КОД>)» в ленте карточки. Гейт Р4 — случаи 1–6 (+ 1а, 2а: семья по запуску).
// Фикстура ext107-foreman.jsonl — журнал прораба d30580af (C--projects-extractor-ext91), строки 1–5 и 156: имя
// (custom-title, agent-name), queue-operation ×2, первая строка user (ТЗ, без origin) и последний end_turn. Тексты под
// заглушкой, служебные поля с путями (cwd, gitBranch, вложения) убраны; в ТЗ вписаны номера EXT-91 и LEDGER-5 (гейт 6).
// Ожидаемое — из фикстуры и спеки, не из кода под тестом. Разбор — настоящим читателем журналов во временной папке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { buildWorkers, buildWaiting } from '../lib/waiting.mjs';
import { WHO } from '../lib/threads.mjs';
import { buildFeed } from '../lib/card-feed.mjs';
import { toastRows } from '../lib/notify.mjs';
import * as fmt from '../web/src/format.js'; // foremanLabel — новое (Р4): через пространство имён, чтобы до правки падал только свой случай
import { tmpDir } from './helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'fixtures', 'journals');
const F = fs.readFileSync(path.join(FX, 'ext107-foreman.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SID = 'd30580af-5149-484e-a7f1-022a7b812016';
const NOW = Date.parse('2026-10-10T19:00:00.000Z');
const MIN = 60000;
const H = 3600000;
const clone = (d) => structuredClone(d);
const src = (...p) => fs.readFileSync(path.join(ROOT, '..', ...p), 'utf8');

const board = { hasCard: (id) => ['EXT-91', 'EXT-92', 'LEDGER-5'].includes(id), hasCode: (c) => c === 'EXT' || c === 'LEDGER', card: () => null, cardsList: () => [] };

async function workers(journals, procs) {
  const root = tmpDir('ext107-foreman-');
  const proj = path.join(root, 'C--projects-extractor-ext91');
  fs.mkdirSync(proj, { recursive: true });
  for (const [sid, ls] of Object.entries(journals)) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), ls.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''));
  const r = createJournalReader({ root, indexDir: tmpDir('ext107-foreman-index-') });
  await r.refresh();
  const sessions = r.sessions();
  const w = buildWorkers({ procs, sessions, board, now: NOW, thresholds: {}, exists: () => true });
  const api = buildWaiting({ threads: w.waiting, board, now: NOW });
  return { w, sessions, rows: api.threads, toasts: toastRows(api), row: (sid) => w.threads.find((t) => t.sessionId === sid), sess: (sid) => sessions.find((s) => s.sessionId === sid) };
}
const proc = (sid, name, status = 'idle') => ({ pid: 1, sessionId: sid, ...(name ? { name } : {}), live: true, status, startedAt: '2026-10-10T16:49:50.000Z', observedAt: NOW, statusUpdatedAt: '2026-10-10T18:48:32.000Z' });
// последний end_turn с «?» в последнем абзаце (живого случая нет — спека: «в обоих журналах EXT-91 последний абзац без „?“»)
const asking = (ls) => ls.map((d, i) => (i === ls.length - 1 ? { ...clone(d), message: { ...clone(d.message), content: [{ type: 'text', text: 'Такт 1 сделан.\n\nБерём такт 2?' }] } } : d));
const noName = (ls) => ls.filter((d) => d.type !== 'custom-title' && d.type !== 'agent-name');
const NAME = 'EXT · Тарантога · EXT-91';

test('фикстура: строки 1–2 — имя прораба, 3–4 — queue-operation, 5 — первая строка user без origin (ТЗ с EXT-91 и LEDGER-5), последняя — end_turn без «?»', () => {
  assert.deepEqual(F.map((d) => d.type), ['custom-title', 'agent-name', 'queue-operation', 'queue-operation', 'user', 'assistant']);
  assert.equal(F[0].customTitle, NAME);
  assert.equal(F[1].agentName, NAME);
  assert.equal('origin' in F[4], false);
  assert.match(F[4].message.content, /EXT-91.*LEDGER-5/);
  assert.equal(F[5].message.stop_reason, 'end_turn');
  assert.ok(!F[5].message.content[0].text.includes('?'));
});

// ---------- 1: поломка — метка ----------

test('1 (поломка): живой тред «EXT · Тарантога · EXT-91» — foreman: true, метка «прораб · без окна»; Ceh.jsx берёт метку из foremanLabel', async () => {
  const r = await workers({ [SID]: F }, [proc(SID, NAME)]);
  const t = r.row(SID);
  assert.equal(t.foreman, true);
  assert.equal(typeof fmt.foremanLabel, 'function', 'format.js: foremanLabel');
  assert.equal(fmt.foremanLabel(t), 'прораб · без окна');
  assert.match(src('web', 'src', 'Ceh.jsx'), /foremanLabel\(t\)/);
  // обычный тред — метки нет
  assert.equal(fmt.foremanLabel({ ...t, foreman: undefined, foremanFrom: undefined }), null);
});

// ---------- 1а, 2а: семья по запуску (EXT-74) ----------

const A = '11111111-1111-4111-8111-111111111111'; // дирижёр
const B = '22222222-2222-4222-8222-222222222222'; // прораб по запуску, имени в журнале нет
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const P = 'C:\\w\\x';
const L = 3 * H;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const launch = (sid, time) => {
  const id = `b-${uid().slice(-4)}`;
  return [
    { type: 'assistant', uuid: uid(), sessionId: sid, timestamp: time, message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `node C:\\projects\\_foreman\\foreman-launch.mjs --card EXT-91 --project EXT --cwd ${P} --task C:\\t\\tz.md` } }] } },
    { type: 'user', uuid: uid(), sessionId: sid, timestamp: time, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Command running in background' }] } },
  ];
};
const familyScene = ({ withLaunch = true } = {}) => ({
  [A]: [{ type: 'user', uuid: uid(), sessionId: A, timestamp: at(20 * H), cwd: 'C:\\other', message: { role: 'user', content: 'го' } }, ...(withLaunch ? launch(A, at(L)) : [])],
  [B]: [
    { type: 'user', uuid: uid(), sessionId: B, timestamp: at(L - MIN), cwd: P, message: { role: 'user', content: 'Твоё задание — в файле …' } },
    { type: 'assistant', uuid: uid(), sessionId: B, timestamp: at(L - 30 * MIN), message: { id: 'm-end', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово наполовину.\n\nПродолжать?' }] } },
  ],
});
const famProcs = [proc(A, 'EXT-91 · дирижёр'), proc(B, 'EXT-91 · прораб')];

test('1а: семья известна (запуск дирижёра) — метка «прораб · без окна · от <название треда-дирижёра>»', async () => {
  const r = await workers(familyScene(), famProcs);
  assert.equal(r.row(B).foreman, true);
  assert.equal(fmt.foremanLabel(r.row(B)), 'прораб · без окна · от EXT-91 · дирижёр');
  assert.equal(fmt.foremanLabel(r.row(A)), null, 'дирижёр — не прораб');
});

test('2а: прораб по семье (имени нет), end_turn с «?» — не «ждёт тебя»; без запуска — «ждёт тебя» (тест зрячий)', async () => {
  const r = await workers(familyScene(), famProcs);
  assert.equal(r.row(B).state, 'idle');
  assert.equal(r.row(B).waitingKind, null);
  assert.equal(r.rows.length, 0);
  const plain = await workers(familyScene({ withLaunch: false }), famProcs);
  assert.equal(plain.row(B).state, 'waiting');
  assert.equal(plain.rows.length, 1);
});

// ---------- 2: поломка — ожидание ----------

test('2 (ещё поломка): прораб, последний end_turn с «?», status idle — «свободен», строки (а) и тоста нет; тот же журнал без имени — «ждёт тебя»', async () => {
  const r = await workers({ [SID]: asking(F) }, [proc(SID, NAME)]);
  assert.equal(r.row(SID).state, 'idle');
  assert.equal(r.row(SID).waitingKind, null);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.toasts, []);
  // тот же журнал без строк имени (имя процесса в реестре то же — признак берётся из журнала, не из реестра)
  const plain = await workers({ [SID]: noName(asking(F)) }, [proc(SID, NAME)]);
  assert.equal(plain.row(SID).foreman, undefined);
  assert.equal(plain.row(SID).state, 'waiting');
  assert.equal(plain.rows.length, 1);
  assert.equal(plain.rows[0].kind, 'question');
  assert.equal(plain.toasts.length, 1);
});

// ---------- 3: исправный ----------

test('3 (исправный): обычный тред EXT с вопросом — «ждёт тебя», строка (а) и тост, как раньше', async () => {
  const C = '33333333-3333-4333-8333-333333333333';
  const ls = [
    { type: 'user', uuid: uid(), sessionId: C, timestamp: at(2 * H), message: { role: 'user', content: 'Что с EXT-91?' } },
    { type: 'assistant', uuid: uid(), sessionId: C, timestamp: at(H), message: { id: 'm-c', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Сделано.\n\nСливать?' }] } },
  ];
  const r = await workers({ [C]: ls }, [proc(C, 'EXT · тред')]);
  assert.equal(r.row(C).state, 'waiting');
  assert.equal(r.row(C).foreman, undefined);
  assert.equal(fmt.foremanLabel?.(r.row(C)) ?? null, null);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, 'question');
  assert.equal(r.toasts.length, 1);
  assert.equal(r.sess(C).ivan.count, 1);
});

// ---------- 4: по имени ----------

test('4 (по имени): custom-title «EXT · Тарантога · EXT-92» до первой строки user, семьи нет — метка есть', async () => {
  const ls = F.map(clone);
  ls[0].customTitle = 'EXT · Тарантога · EXT-92';
  ls[1].agentName = 'EXT · Тарантога · EXT-92';
  const r = await workers({ [SID]: ls }, [proc(SID)]);
  assert.equal(r.row(SID).foreman, true);
  assert.equal(fmt.foremanLabel(r.row(SID)), 'прораб · без окна');
  assert.equal(r.sess(SID).ivan.count, 0);
});

test('4 (по имени, после первой строки user): то же имя после ТЗ — метки нет, слова Ивана считаются', async () => {
  const ls = F.map(clone);
  ls[0].customTitle = 'EXT · Тарантога · EXT-92';
  ls[1].agentName = 'EXT · Тарантога · EXT-92';
  // EXT-109: у треда с окном строка Ивана без turnOrigin sdk (sdk — ТЗ сессии без окна, словом Ивана с такта EXT-109 не считается)
  delete ls[4].turnOrigin;
  const moved = [ls[2], ls[3], ls[4], ls[0], ls[1], ls[5]]; // имя — после первой строки user (тред с окном переименован)
  const r = await workers({ [SID]: moved }, [proc(SID)]);
  assert.equal(r.row(SID).foreman, undefined);
  assert.equal(fmt.foremanLabel?.(r.row(SID)) ?? null, null);
  assert.equal(r.sess(SID).ivan.count, 1);
  // и вопрос такого треда — «ждёт тебя», как у всех
  const q = await workers({ [SID]: asking(moved) }, [proc(SID)]);
  assert.equal(q.row(SID).state, 'waiting');
});

test('4 (не то имя): «EXT · Терминус · EXT-92» до первой строки user — не прораб', async () => {
  const ls = F.map(clone);
  ls[0].customTitle = 'EXT · Терминус · EXT-92';
  ls[1].agentName = 'EXT · Терминус · EXT-92';
  delete ls[4].turnOrigin; // EXT-109: строка без sdk — иначе её отсекает разрешающий список, а не признак прораба
  const r = await workers({ [SID]: ls }, [proc(SID)]);
  assert.equal(r.row(SID).foreman, undefined);
  assert.equal(r.sess(SID).ivan.count, 1);
});

// ---------- 5: лента карточки ----------

test('5 (лента): запись без «Пишет: Тарантога» — автор как раньше; с ней последней строкой — «Тарантога (trurl:EXT)»', () => {
  const e = (body, as = 'trurl:EXT', index = 0) => ({ ms: Date.parse('2026-10-11T10:00:00.000Z') + index, as, kind: 'коммент', body, index });
  const { feed } = buildFeed({ logEntries: [
    e('▶ выдан: terminus · ext-91 · такт 1', 'trurl:EXT', 0),
    e('▶ выдан: terminus · ext-91 · такт 2\n\nПишет: Тарантога\n', 'trurl:EXT', 1),
    e('Пишет: Тарантога — так подписывается прораб.\nдальше текст', 'trurl:EXT', 2),
    e('принято', 'ivan', 3),
  ] });
  const by = (i) => feed.find((f) => f.body === [
    '▶ выдан: terminus · ext-91 · такт 1',
    '▶ выдан: terminus · ext-91 · такт 2\n\nПишет: Тарантога\n',
    'Пишет: Тарантога — так подписывается прораб.\nдальше текст',
    'принято',
  ][i]).author;
  assert.equal(by(0), 'trurl:EXT');
  assert.equal(by(1), 'Тарантога (trurl:EXT)');
  assert.equal(by(2), 'trurl:EXT', 'не последняя строка — автор как раньше');
  assert.equal(by(3), 'ivan');
});

// ---------- 6: ТЗ — не слово Ивана ----------

test('6 (ТЗ): журнал прораба — ivan.count 0, ivan.cards пуст, проект EXT по названию, карточка EXT-91 по названию', async () => {
  const r = await workers({ [SID]: F }, [proc(SID)]);
  const s = r.sess(SID);
  assert.equal(s.ivan.count, 0);
  assert.deepEqual(s.ivan.cards, {});
  assert.equal(s.ivan.firstAt, null);
  const t = r.row(SID);
  assert.equal(t.project, 'EXT');
  assert.equal(t.projectBy, 'title');
  assert.equal(t.card, 'EXT-91');
});

// EXT-109 (Важно 1 Голема): у живой ТЗ-строки turnOrigin sdk — её отсекает и разрешающий список, и защита прораба по
// имени (countIvan: foremanTitle) остаётся без стража. Журнал без поля (старые версии CLI) — держит только имя.
test('6 (ТЗ без turnOrigin): журнал прораба, ТЗ без поля — ivan.count 0, ivan.cards пуст, ivan.firstAt null (держит имя)', async () => {
  const ls = F.map(clone);
  delete ls[4].turnOrigin;
  const r = await workers({ [SID]: ls }, [proc(SID)]);
  const s = r.sess(SID);
  assert.equal(r.row(SID).foreman, true);
  assert.equal(s.ivan.count, 0);
  assert.deepEqual(s.ivan.cards, {});
  assert.equal(s.ivan.firstAt, null);
});

test('словарь агентов: прораб не субагент — в WHO его нет', () => {
  assert.equal(Object.values(WHO).includes('Тарантога'), false);
});
