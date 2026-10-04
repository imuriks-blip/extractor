// «Ждёт меня» (спека витрины 2.4) и красные пометки под тредом (2.3; такт В4). Чистые функции над выжимками
// читателей (доска, журналы, реестр процессов) — без чтения диска; тексты наружу — через маску в app.mjs (6.2).
import { resolveRef, pathKey } from './journal-parse.mjs';
import { WHO, WHO_DATIVE, buildThreads, projectOf } from './threads.mjs';
import { stripMarkdown, cutChars } from './text.mjs';

const MIN = 60000;
const DAY = 24 * 60 * MIN;
// В-4 (решение Ивана 01.10): (б) и висящие ▶ — моложе 14 дней; Review — все
export const LIMIT_DAYS = 14;
const Q_MAX = 160;

const ms = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const iso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : null);
const fin = (...xs) => xs.filter(Number.isFinite);
// последний текст агента и «осталось» блока обрыва (2.3): разметка снимается, потом одна обрезка по символам, с «…»
const LAST_TEXT_MAX = 200;
const plainOrNull = (s) => (typeof s === 'string' ? cutChars(stripMarkdown(s), LAST_TEXT_MAX) : null);

// (б), правило (2) 2.4: маркер в последней записи журнала — без учёта регистра; запись-решение (есть «Кто решил»
// или «слово Ивана», тоже без учёта регистра) — не вопрос. Метка — первое сработавшее в порядке спеки.
const YES_WORDS = [['развилк', 'развилка'], ['выкатывай', 'выкатывай'], ['сливай', 'сливай']];
const DECISION = ['кто решил', 'слово ивана'];
export function yesMark(body) {
  const t = String(body ?? '').toLowerCase();
  if (DECISION.some((w) => t.includes(w))) return null;
  for (const [w, label] of YES_WORDS) if (t.includes(w)) return label;
  return null;
}

// Один тред на сессию (как buildThreads): копии с тем же sessionId — больше строк.
function bySession(sessions) {
  const m = new Map();
  for (const s of sessions ?? []) { const p = m.get(s.sessionId); if (!p || (s.lines ?? 0) > (p.lines ?? 0)) m.set(s.sessionId, s); }
  return m;
}

// (а) Тред ждёт ответа: живые треды в состоянии «ждёт тебя» (2.1). Текст — абзац (Б) или вопрос AskUserQuestion,
// ключ уведомления — sessionId + uuid этого сообщения (4.1); ожидание разрешения — без текста, от statusUpdatedAt,
// ключ — sessionId + statusUpdatedAt; незнакомое waitingFor («?») — так же, без текста. Старые сверху.
// uuid — сообщения из журнала, по которому сработало правило (null — хвост не дочитан): вопрос без него в тосты не идёт.
export function waitingThreads({ threads = [], sessions = [], now = Date.now(), thresholds = {} }) {
  const sess = bySession(sessions);
  const overMs = (thresholds.waitingOverDayHours ?? 24) * 60 * MIN;
  const rows = [];
  for (const t of threads) {
    if (t.state !== 'waiting') continue;
    const th = sess.get(t.sessionId)?.thread ?? {};
    const kind = t.waitingKind ?? 'question';
    // EXT-37: th.ask — последний AskUserQuestion сессии, в том числе давно отвеченный; текст и ключ от него — только
    // при открытом вопросе (askOpen). Иначе («input needed» на плане или ином вопросе, или вопрос ещё не дописан
    // в журнал) — строка без текста, ключ sessionId|statusUpdatedAt, askMissing: тост — после 3 циклов подряд
    // без открытого вопроса (notify.mjs, createAskGate)
    const askMissing = kind === 'askUserQuestion' && th.askOpen !== true;
    const src = kind === 'askUserQuestion' ? (askMissing ? null : th.ask) : kind === 'question' ? th.q : null;
    let text = null;
    let since = t.statusUpdatedAt ?? null;
    let key = `${t.sessionId}|${t.statusUpdatedAt ?? ''}`;
    if (kind === 'permission') text = 'ждёт разрешения на команду';
    else if (src) {
      // разметка снимается до обрезки (В6); маска — потом, в app.mjs
      const plain = typeof src.text === 'string' ? stripMarkdown(src.text) : '';
      text = plain ? `Трурль: ${cutChars(plain, Q_MAX)}` : null;
      since = src.at ?? since;
      key = `${t.sessionId}|${src.uuid ?? src.at ?? ''}`;
    }
    // keyTemp (EXT-47, В3): вопрос без uuid сообщения — хвост журнала не дочитан, ключ временный (statusUpdatedAt или
    // src.at) и сменится на sessionId|uuid; такую строку не откладывают (вид прячет кнопку, defer — отказ key-temp).
    // Разрешение и незнакомое ожидание ключуются statusUpdatedAt всегда — ключ у них не временный.
    const keyTemp = (kind === 'question' || kind === 'askUserQuestion') && !src?.uuid;
    rows.push({ sessionId: t.sessionId, title: t.title ?? null, project: t.project ?? null, projectBy: t.projectBy ?? null, kind, text, since, overDay: Number.isFinite(ms(since)) && ms(now) - ms(since) >= overMs, key, uuid: src?.uuid ?? null, ...(askMissing ? { askMissing: true } : {}), ...(keyTemp ? { keyTemp: true } : {}) });
  }
  return rows.sort((a, b) => (ms(a.since) || Infinity) - (ms(b.since) || Infinity));
}

// «Ждёт меня» целиком: (а) — готовые строки waitingThreads; (б) и (в) — по доске. Карточка — один раз, (б) важнее (в).
export function buildWaiting({ threads = [], board, now = Date.now(), limitDays = LIMIT_DAYS }) {
  const nowMs = ms(now);
  const yes = [];
  const review = [];
  const cards = board.cardsList ? board.cardsList() : [];
  for (const c of cards) {
    if (c.status === 'done' || c.status === 'cancelled') continue;
    const lastMs = ms(c.last?.at);
    let mark = null;
    let since = NaN;
    if (c.markB === true) { mark = 'Б'; since = Math.max(...fin(ms(c.updated), lastMs), -Infinity); }
    else if (c.last?.mark) { mark = c.last.mark; since = lastMs; }
    if (!mark || !Number.isFinite(since) || nowMs - since >= limitDays * DAY) continue;
    yes.push({ id: c.id, project: c.code, mark, title: c.title ?? '', since: iso(since), status: c.status, key: `${c.id}|${c.last?.key ?? ''}` });
  }
  const inYes = new Set(yes.map((r) => r.id));
  for (const c of cards) {
    if (c.status !== 'review' || inYes.has(c.id)) continue;
    const at = Math.max(...fin(ms(c.updated), ms(c.last?.at)), -Infinity);
    // key — как у (б): номер|заголовок последней записи (EXT-47: ключ отметки «Отложить», новая запись — новый key)
    review.push({ id: c.id, project: c.code, title: c.title ?? '', at: iso(at), key: `${c.id}|${c.last?.key ?? ''}` });
  }
  const fresh = (k) => (a, b) => (ms(b[k]) || 0) - (ms(a[k]) || 0);
  yes.sort(fresh('since'));
  review.sort(fresh('at'));
  return { threads, yes, review, count: threads.length + yes.length, more: review.length };
}

// ---------- красные пометки (2.3) ----------

// маркеры такта — с двоеточием и без (1.4), вариационный селектор U+FE0F не в счёт
const norm = (s) => String(s ?? '').replace(/️/g, '').trim();
const TAKT_ON = /^▶\s*выдан/;
const TAKT_OFF = /^⏸\s*получен/;
// «▶ выдан: <субагент> · <ветка> · <что>» (§1.4 спеки доски) — субагент: слово до первого « · »
const agentOfLine = (line) => line.replace(TAKT_ON, '').replace(/^\s*:?\s*/, '').split(' · ')[0].trim() || null;

// procs — записи реестра процессов (live, sessionId, startedAt); rulesAt — момент «правила обновлены» (или null);
// commitsOf({key, code, since, until}) — коммиты проекта за заход ([] — нет, null — неизвестно); titleOf(sessionId) —
// название закрытого треда; liveOf(sessionId) — живая сессия того же десктопного треда, если sessionId — её прежняя
// (priorCliSessionIds); reread — набор файлов «правила перечитаны» (абсолютные пути, EXT-54). Возврат: пометки живых
// тредов по sessionId, строки «тред закрыт» (В-6 (б)), свежесть правил, время «правила перечитаны» по sessionId.
export function buildMarks({ procs = [], sessions = [], board, mirrorIndex = null, now = Date.now(), thresholds = {}, rulesAt = null, reread = [], commitsOf = null, titleOf = null, liveOf = null, limitDays = LIMIT_DAYS }) {
  const nowMs = ms(now);
  const limitMs = limitDays * DAY;
  const live = new Map();
  for (const p of procs) if (p.live && p.sessionId) live.set(p.sessionId, p);
  const sess = bySession(sessions);
  const out = {};
  const closed = new Map();
  // живой тред, под которым показывать пометку сессии: она сама или живое продолжение того же десктопного треда
  // (вердикт Голема на В4, Важно 3: прежняя сессия живого треда — не «тред закрыт»)
  const home = (sid) => (live.has(sid) ? sid : (liveOf && live.has(liveOf(sid)) ? liveOf(sid) : null));
  const titleOfSid = (sid) => titleOf?.(sid) ?? sess.get(sid)?.thread?.customTitle ?? null;
  // проект строки «тред закрыт»: по карточке, иначе по названию треда (мелочь 1); пометки двух проектов — две строки
  const add = (sid, mark, project) => {
    const h = home(sid);
    if (h) { (out[h] ??= []).push(mark); return; }
    const title = titleOfSid(sid);
    const proj = project ?? (board.hasCode && title ? projectOf(title, null, board, []).code : null);
    const k = `${sid}|${proj}`;
    if (!closed.has(k)) closed.set(k, { sessionId: sid, title, project: proj, closed: true, marks: [] });
    closed.get(k).marks.push(mark);
  };
  const isOpen = (id) => { const c = board.card?.(id); return c && c.status !== 'done' && c.status !== 'cancelled' ? c : null; };

  // Обрыв · PARTIAL: последний обрыв запуска. Один обрыв (agentId + время) лежит и в копиях сессии — показывается раз
  // (у живого треда, если он есть), снят любым сообщением Ивана после обрыва в любой сессии, где он лежит (В-3 (а))
  const breaks = new Map();
  for (const s of sess.values()) {
    const last = new Map();
    for (const p of s.partials ?? []) if (!last.has(p.agentId) || ms(p.at) >= ms(last.get(p.agentId).at)) last.set(p.agentId, p);
    for (const p of last.values()) {
      const k = `${p.agentId}|${ms(p.at)}`;
      if (!breaks.has(k)) breaks.set(k, { p, holders: [] });
      breaks.get(k).holders.push(s);
    }
  }
  for (const { p, holders } of breaks.values()) {
    // тред — десктопный, не одна сессия (В-3 «в этом треде»): слово Ивана в сессии с обрывом или в живой сессии
    // того же десктопного треда (круг 2 Голема на В4)
    const ivanAfter = (h) => [h, sess.get(home(h.sessionId))].some((x) => ms(x?.ivan?.lastAt) > ms(p.at));
    if (holders.some(ivanAfter)) continue;
    const s = holders.find((h) => live.has(h.sessionId)) ?? holders.find((h) => home(h.sessionId)) ?? holders[0];
    {
      const run = holders.map((h) => (h.runs ?? []).find((r) => r.agentId === p.agentId)).find(Boolean) ?? null;
      const card = (run?.cards ?? []).find((id) => board.hasCard(id)) ?? null;
      const starts = (run?.starts ?? []).map(ms).filter((t) => Number.isFinite(t) && t <= ms(p.at));
      const since = starts.length ? Math.max(...starts) : NaN;
      const code = card ? card.split('-')[0] : null;
      const done = commitsOf ? commitsOf({ key: `${s.sessionId}|${p.agentId}|${p.at}`, code, since: iso(since), until: p.at }) : null;
      add(s.sessionId, {
        kind: 'partial', agent: run?.agentType ?? null, who: WHO[run?.agentType] ?? run?.agentType ?? null, card, endedAt: p.at, turnLimit: p.limit,
        // последний текст и «осталось» — без разметки (В6); 200 знаков обрезает разбор журнала (journal-parse)
        done: done ?? null, lastText: plainOrNull(run?.lastText), left: plainOrNull(run?.left),
        reason: `тормоз ${p.limit} ходов; продолжить можно`, canContinue: true, waitingWord: true,
      }, code);
    }
  }

  // Такт без ответа (В-16 (а)): по каждой карточке — последний успешный вызов «▶ выдан» против последнего «⏸ получен»
  // во всех журналах тредов; жёлтый с taktYellowMin, красный с taktRedMin; ▶ старше 14 дней — нет (В-4)
  const per = new Map();
  for (const s of sess.values()) for (const w of s.boardWrites ?? []) {
    const line = norm(w.firstLine);
    const kind = TAKT_ON.test(line) ? 'on' : TAKT_OFF.test(line) ? 'off' : null;
    const t = ms(w.at);
    if (!kind || !Number.isFinite(t)) continue;
    for (const id of (w.refs ?? []).map((r) => resolveRef(r, mirrorIndex)).filter((x) => x && board.hasCard(x))) {
      const e = per.get(id) ?? {};
      // одна запись в копиях сессии (равное время) — у живой сессии
      if (!e[kind] || t > e[kind].t || (t === e[kind].t && live.has(s.sessionId))) e[kind] = { t, sid: s.sessionId, line };
      per.set(id, e);
    }
  }
  const yellow = (thresholds.taktYellowMin ?? 60) * MIN;
  const red = (thresholds.taktRedMin ?? 180) * MIN;
  for (const [id, e] of per) {
    if (!e.on || (e.off && e.off.t >= e.on.t)) continue;
    const age = nowMs - e.on.t;
    const c = isOpen(id);
    if (!c || age < yellow || age >= limitMs) continue;
    // EXT-56: закрывает и запись ⏸ в журнале карточки доски новее ▶ (pauseAt читателя доски); нет или не прочиталась —
    // правило по журналу тредов, как было
    if (ms(c.pauseAt) >= e.on.t) continue;
    const agent = agentOfLine(e.on.line);
    add(e.on.sid, { kind: 'takt', level: age >= red ? 'red' : 'yellow', card: id, agent, who: WHO[agent] ?? agent, whoDative: WHO_DATIVE[agent] ?? agent, issuedAt: iso(e.on.t) }, c.code);
  }

  // Запись субагента в доску (В-15 (а)): успешный вызов записи в журнале субагента — под живым тредом, в том числе
  // из прежних сессий продолженного треда (home, решение дирижёра 02.10), моложе 14 дней; каждая запись — своя
  // пометка: карточка и первая строка тела до 160 знаков (§2.3; наружу — маской треда). Копия той же записи — раз.
  const seenWrites = new Set();
  for (const s of sess.values()) {
    const h = home(s.sessionId);
    if (!h) continue;
    for (const r of s.runs ?? []) for (const w of r.boardWrites ?? []) {
      if (!(nowMs - ms(w.at) < limitMs)) continue;
      const k = `${h}|${r.agentId}|${w.at}`;
      if (seenWrites.has(k)) continue;
      seenWrites.add(k);
      const card = (w.refs ?? []).map((x) => resolveRef(x, mirrorIndex)).find((x) => x && board.hasCard(x)) ?? null;
      add(s.sessionId, { kind: 'subagentWrite', agent: r.agentType ?? null, who: WHO[r.agentType] ?? r.agentType ?? null, card, at: w.at, line: typeof w.firstLine === 'string' ? cutChars(stripMarkdown(w.firstLine), Q_MAX) : null });
    }
  }

  // Старые правила: тред открыт (startedAt реестра процессов) раньше момента «правила обновлены».
  // Правила перечитаны (EXT-54): тред после момента сам прочитал каждый файл набора reread (Read в журнале его сессии,
  // результат без ошибки) — пометки нет, вместо неё серая строка с самым поздним из чтений (не пометка: ни в счётчик,
  // ни в «Ждёт меня», ни в тост). Набор пуст — прежнее поведение.
  const rulesFresh = {};
  const rulesReread = {};
  const rMs = ms(rulesAt);
  const keys = [...new Set(reread.map(pathKey))];
  for (const [sid, p] of live) {
    if (!Number.isFinite(rMs) || !Number.isFinite(ms(p.startedAt))) { rulesFresh[sid] = null; continue; }
    rulesFresh[sid] = ms(p.startedAt) >= rMs;
    if (rulesFresh[sid]) continue;
    const reads = keys.map((k) => sess.get(sid)?.reread?.[k]);
    if (keys.length && reads.every((t) => ms(t) > rMs)) { rulesReread[sid] = reads.reduce((a, t) => (ms(t) > ms(a) ? t : a)); continue; }
    add(sid, { kind: 'oldRules', rulesUpdatedAt: rulesAt });
  }

  return { bySession: out, closed: [...closed.values()], rulesFresh, rulesReread };
}

// «Кто работает» с пометками и строки (а) «Ждёт меня» — одним сбором на запрос (start.mjs, тест образцов).
// o — параметры buildThreads и buildMarks; thresholds — config.json → thresholds (2.8).
export function buildWorkers(o) {
  const th = o.thresholds ?? {};
  // прежние сессии живого десктопного треда (priorCliSessionIds записи десктопного индекса) → живая сессия
  const prior = new Map();
  for (const p of o.procs ?? []) {
    if (!p.live || !p.sessionId || !p.hostSessionId || !o.desktop) continue;
    for (const id of o.desktop(p.hostSessionId)?.priorCliSessionIds ?? []) if (id !== p.sessionId) prior.set(id, p.sessionId);
  }
  const mk = buildMarks({ procs: o.procs, sessions: o.sessions, board: o.board, mirrorIndex: o.mirrorIndex, now: o.now, thresholds: th, rulesAt: o.rulesAt ?? null, reread: o.reread ?? [], commitsOf: o.commitsOf ?? null, titleOf: o.titleOf ?? null, liveOf: (sid) => prior.get(sid) ?? null });
  const w = buildThreads({ procs: o.procs, desktop: o.desktop, sessions: o.sessions, board: o.board, mirrorIndex: o.mirrorIndex, maxTurns: o.maxTurns, now: o.now, staleMin: th.staleMin ?? 15, marks: mk.bySession, slept: o.slept ?? null });
  // «правила перечитаны» (EXT-54) — поле треда (серая строка «Цеха» и окна проекта), не пометка; у треда без
  // проекта — нет, как и «Старых правил» (buildThreads)
  const threads = w.threads.map((t) => ({ ...t, rulesReread: t.project ? mk.rulesReread[t.sessionId] ?? null : null }));
  return { ...w, threads, closed: mk.closed, rulesFresh: mk.rulesFresh, waiting: waitingThreads({ threads, sessions: o.sessions, now: o.now, thresholds: th }) };
}

// «Сделано» блока обрыва (2.3): коммиты репозиториев проекта (реестр → board_codes → repos) за время захода —
// `git log --all --since --until` через обёртку git-read. Запрос — фоном; до ответа — null («неизвестно»),
// ответ кэшируется по ключу обрыва (окно в прошлом не меняется); ошибка git — тоже, с отсрочкой повтора retryMs
// (вердикт Голема на В4); у проекта нет репозиториев — null («неизвестно»), а не [] («коммитов нет»).
export function createCommitsCache({ git, reposOf, retryMs = 5 * 60000, now = () => Date.now() }) {
  const cache = new Map();
  const failedAt = new Map();
  const running = new Set();
  async function load({ key, code, since, until }) {
    running.add(key);
    try {
      const out = [];
      for (const repo of reposOf(code)) {
        const text = await git(repo, ['log', '--all', `--since=${since}`, `--until=${until}`, '--format=%h%x09%s']);
        for (const line of text.split(/\r?\n/)) {
          const i = line.indexOf('\t');
          if (i > 0 && !out.some((c) => c.hash === line.slice(0, i))) out.push({ hash: line.slice(0, i), subject: line.slice(i + 1) });
        }
      }
      cache.set(key, out);
      failedAt.delete(key);
    } catch { failedAt.set(key, now()); } finally { running.delete(key); }
  }
  return {
    get(q) {
      if (!q.code || !q.since || !q.until || reposOf(q.code).length === 0) return null;
      if (cache.has(q.key)) return cache.get(q.key);
      if (failedAt.has(q.key) && now() - failedAt.get(q.key) < retryMs) return null;
      if (!running.has(q.key)) load(q);
      return null;
    },
    // для тестов и первого прохода: дождаться всех начатых запросов
    async settle() { while (running.size) await new Promise((r) => setTimeout(r, 10)); },
  };
}
