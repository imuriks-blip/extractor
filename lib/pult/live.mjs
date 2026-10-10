// Запись на доску в режиме live (спека пульта §3.3, EXT-91): инструменты «Принять»/«Вернуть», слов, новой карточки и отзыва.
// Свежая сверка — по файлам доски (шапка и журнал карточки читаются заново, не из кэша витрины); запись — board.mjs через
// очередь (board-run.mjs): log решение → status; новая карточка — new … --force-new после своего поиска дублей. Секреты —
// сетью доски (scan из boardLib) по всему файлу тела. Местных отметок и дотяжки зеркала у live нет (§3.3 п.14).
import nodeFs from 'node:fs';
import path from 'node:path';
import { classify } from './board-run.mjs';
import { PULT_MARK, B_NOTE, ddmmhhmm, newerThanQ } from './accept.mjs';
import { SERVICE_KINDS } from '../trace.mjs'; // записи, которые пишут сами board status/take: «последней записью» (вопросом) не бывают (§3.3 п.9)
const minute = (ms) => Math.floor(ms / 60000);

// ---------- тексты записей (§1.2, режим live: markdown, метка и номер — в первой строке) ----------

export function recordMd({ id, word, q, reason = null, answer = null, bNote = false }) {
  const asked = q?.at ? `В ответ на: ${q.uuid ? 'сообщение треда' : 'запись'} ${ddmmhhmm(Date.parse(q.at))}${q.uuid ? '' : ` «${q.head ?? ''}»`}` : 'В ответ на: записей не было';
  return [`**${PULT_MARK}${id}**: «${word}»`, asked, reason ? `Причина: ${reason}` : null, answer ? String(answer) : null, bNote ? B_NOTE : null,
    `Кто решил: слово Ивана · кнопка витрины · ${id}`].filter((x) => x !== null).join('\n\n');
}

export function withdrawMd({ id, number, at, word }) {
  return [`**${PULT_MARK}${id}**: «отозвать ${number}»`,
    `Отзывает: ${number} · ${ddmmhhmm(Date.parse(at))} · «${word}» — не исполнять; если уже исполнено — сказать Ивану в чате`,
    `Кто решил: слово Ивана · кнопка витрины · ${id}`].join('\n\n');
}

export const newCardMd = ({ id, text }) => [text ? String(text) : null, `Кто решил: слово Ивана · кнопка витрины · ${id}`].filter((x) => x !== null).join('\n\n');

// слово исхода board → отказ пульта (REFUSAL_CODE, все — 200)
export function refusalOf(c, mask = (t) => t) {
  switch (c.kind) {
    case 'busy': return { refusal: 'board-busy', message: 'доска занята — повтори' };
    case 'conflict': return { refusal: 'board-conflict', message: 'на карточке конфликт шапки — решает владелец, зови дирижёра' };
    case 'secret': return { refusal: 'secret', message: `запись не прошла: ${mask(c.line)}` };
    case 'encoding': return { refusal: 'board-encoding', message: 'запись не прошла: испорченная кодировка — зови дирижёра' };
    default: return { refusal: 'board-refused', message: `доска не приняла: ${mask(c.line) || 'отказ без строки'}` };
  }
}

// board — читатель доски (readCard, readLog({fresh}), latestOf, readCards); runner — board-run.mjs; scan — сеть секретов доски;
// tmpDir — data/vitrina/tmp; trailerOf(file) → Promise<строка Board-As создающего коммита>
export function createLive({ board, runner, scan = null, mask = (t) => t, now = Date.now, tmpDir, fs = nodeFs, trailerOf = null, serverLog = { write() {} } }) {
  // один вызов board: исход разобран, строка шага `board` в actions.log, ⚠-строки — в server.log и в ответ серой подсказкой
  async function call(ctx, cmd, args) {
    const r = await runner.run(args);
    const c = classify(r);
    ctx.warnings ??= [];
    for (const w of c.warnings) {
      const m = mask(w);
      serverLog.write('board-warn', { cmd, line: m });
      if (!ctx.warnings.includes(m)) ctx.warnings.push(m);
    }
    ctx.step({ step: 'board', cmd, result: { code: c.code, line: mask(c.line ?? ''), ms: r.ms } });
    return c;
  }

  // тело — файлом (--body-file), удаляется после вызова
  async function withFile(ctx, text, fn) {
    const file = path.join(tmpDir, `body-${ctx.id}.md`);
    try { fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(file, text, 'utf8'); } catch (e) {
      return { kind: 'not-run', code: null, line: typeof e?.code === 'string' ? e.code : 'ERR', warnings: [] };
    }
    try { return await fn(file); } finally { try { fs.unlinkSync(file); } catch { /* файла нет — не меняет исход */ } }
  }

  // Секреты (§3.3 п.7): весь файл тела и заголовок — сетью доски. Класс 2 — отказ; класс 5 — только виды, которые Иван подтвердил в
  // тексте этого действия (ctx.notSecret) → флаги --not-secret ровно по ним; иной класс 5 — отказ без флага.
  function guard(ctx, texts, project) {
    if (!scan) return { flags: [] };
    const found = texts.flatMap((t) => scan(t, { project: project ?? 'IPTV' }));
    const hard = found.find((f) => f.cls === 2);
    if (hard) return { refused: { refusal: 'secret', message: `похоже на секрет: ${hard.kind} — на доску не пишется` } };
    const c5 = found.filter((f) => f.cls === 5);
    const confirmed = ctx.notSecret ?? [];
    const bad = c5.find((f) => !confirmed.includes(f.kind));
    if (bad) return { refused: { refusal: 'secret', message: `похоже на секрет вне текста Ивана: ${bad.kind} — зови дирижёра` } };
    return { flags: [...new Set(c5.map((f) => f.kind))].flatMap((k) => ['--not-secret', k]) };
  }

  // свежая сверка по файлам: статус и владелец — из шапки, записи — из журнала (parseLog доски). null — файлы не читаются
  function fresh(cardId) {
    let c;
    try { c = board.readCard(cardId); } catch { return null; }
    if (!c || c.error || !c.header) return null;
    const lg = board.readLog(cardId, { fresh: true });
    if (lg.error) return null;
    const entries = lg.entries.filter((e) => Number.isFinite(e.ms));
    const tm = (e) => (e ? { at: new Date(e.ms).toISOString(), text: e.body } : null);
    return { status: c.header.status, owner: c.header.owner ?? '', entries,
      lastNS: tm(board.latestOf(entries.filter((e) => !SERVICE_KINDS.has(e.kind)))) };
  }

  // §1.1 п.6, §3.3 пп.8–9: последняя запись журнала без служебных (статус, владелец) новее q и не запись пульта → время (мс),
  // иначе null. q витрина берёт теми же читателями (они служебные тоже пропускают), поэтому сверка идёт по той же «последней»:
  // `status review` или `take` после вопроса новым вопросом не бывают
  function fresher(q, f) {
    return newerThanQ(q, f.lastNS);
  }

  // есть ли в журнале карточки запись с этим номером: true | false | null (журнал не прочитан)
  function hasRecord(cardId, needle) {
    const lg = board.readLog(cardId, { fresh: true });
    if (lg.error) return null;
    return lg.entries.some((e) => String(e.body ?? '').includes(needle));
  }

  // запись решения в журнал: → {} (легла) | {error: исход обработчика}; неясный исход — чтение <ID>.log.md, не show (§3.3 п.5)
  async function writeRecord(ctx, { card, md }) {
    const g = guard(ctx, [md], card.split('-')[0]);
    if (g.refused) return { error: { outcome: 'refused', ...g.refused } };
    const c = await withFile(ctx, md, (f) => call(ctx, 'log', ['log', card, 'решение', '--body-file', f, ...g.flags]));
    if (c.kind === 'ok') return {};
    if (c.kind === 'not-run' || c.kind === 'bad-call') return { error: { outcome: 'error', message: `не записано: ${mask(c.line)}`, result: { code: 'NOT_WRITTEN', line: mask(c.line) } } };
    if (c.kind !== 'unclear') return { error: { outcome: 'refused', ...refusalOf(c, mask) } };
    const has = hasRecord(card, ctx.id);
    ctx.step({ step: 'board', cmd: 'read', result: { code: has === null ? null : 0, line: has === null ? 'журнал не прочитан' : has ? 'запись найдена' : 'записи нет' } });
    if (has === null) return { error: { outcome: 'error', message: `исход записи неясен: ${mask(c.line)} — повтори, перед записью будет сверка`, result: { code: 'UNCLEAR', line: mask(c.line) } } };
    if (has) return {};
    return { error: { outcome: 'error', message: `запись не легла (${mask(c.line)}) — повтори, перед записью будет сверка`, result: { code: 'NOT_WRITTEN', line: mask(c.line) } } };
  }

  // смена статуса: → исход board (kind 'ok' — стоит); неясный исход просто повторяется (status, который уже стоит, board принимает кодом 0)
  const setStatus = (ctx, card, st, why) => call(ctx, 'status', ['status', card, st, '--why', why]);

  // новая карточка: → {outcome…} (решённый исход обработчика)
  async function create(ctx, { project, title, md }) {
    const g = guard(ctx, [title, md], project);
    if (g.refused) return { outcome: 'refused', ...g.refused };
    const c = await withFile(ctx, md, (f) => call(ctx, 'new', ['new', project, title, '--body-file', f, '--force-new', ...g.flags]));
    const made = c.kind === 'ok' ? c.line.match(/^([A-Z]{2,6}-\d+) создана(?![а-яё])/)?.[1] : null;
    if (made && made.split('-')[0] === project) return { outcome: 'ok', message: `создана ${made} · Backlog`, result: { created: made }, extra: { created: made } };
    if (c.kind === 'not-run' || c.kind === 'bad-call') return { outcome: 'error', message: `не создана: ${mask(c.line)}`, result: { code: 'NOT_CREATED', line: mask(c.line) } };
    if (c.kind !== 'unclear' && c.kind !== 'ok') return { outcome: 'refused', ...refusalOf(c, mask) };
    // неясный исход (или код 0 без узнаваемой строки): поиск карточки с этим заголовком, созданной после asked, с коммитом Board-As: ivan
    const found = await findCreated(ctx, { project, title });
    ctx.step({ step: 'board', cmd: 'read', result: { code: found === undefined ? null : 0, line: found ? `найдена ${found}` : found === undefined ? 'поиск не удался' : 'карточки нет' } });
    if (found) return { outcome: 'ok', message: `создана ${found} · Backlog`, result: { created: found }, extra: { created: found } };
    return { outcome: 'error', message: 'не знаю, создана ли — проверь доску: карточка могла создаться (повторять вслепую нельзя)', result: { code: 'UNCLEAR', line: mask(c.line ?? '') } };
  }

  // → id | null (нет) | undefined (поиск не удался)
  async function findCreated(ctx, { project, title }) {
    const since = minute(ctx.askedAt ?? now()) * 60000; // created в шапке — с точностью до минуты
    let cands;
    try {
      cands = board.readCards(project)
        .filter(({ header }) => String(header.title ?? '').trim() === title.trim() && Date.parse(header.created) >= since)
        .sort((a, b) => Number(b.id.split('-')[1]) - Number(a.id.split('-')[1]));
    } catch { return undefined; }
    if (!cands.length) return null;
    if (!trailerOf) return undefined;
    for (const c of cands) {
      let t;
      try { t = await trailerOf(`${project}/${c.id}.md`); } catch { return undefined; }
      if (/^ivan$/m.test(String(t).trim().replace(/\r/g, ''))) return c.id;
    }
    return null;
  }

  return { fresh, fresher, hasRecord, writeRecord, setStatus, create, call, guard, recordMd, withdrawMd, newCardMd };
}
