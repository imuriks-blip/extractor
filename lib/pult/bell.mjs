// Звонок в живой тред, серверная часть (спека пульта §2.2–2.6, §2.8; ПТ4а, EXT-63). Ждущий (bell/waiter.mjs) — ПТ4б.
// Слово — в памяти процесса: {sid → [слово]}, только выданные этим запуском сервера. Файл <dir>/<sid>/<id>.ring —
// пустой сигнал «звонок в дверь» (временный файл и rename); содержимое не значит ничего. Доставленным слово
// становится по строке ring {ids} в <dir>/bell.log (её пишет ждущий): чтение дочитывает журнал и снимает слова из
// памяти, шаг ring-delivered в actions.log пишет такт (tick), а не запрос — GET ничего не пишет (§4.2, Н3).
// Строка bell.log (контракт с ждущим ПТ4б): {at, sid, event: start|ring|forged|owner-gone|skip|stop, ids?} — без текста.
// Удаление файлов — fs.unlinkSync (Node 24 на Windows: rmSync молча не удаляет имя с кириллицей, EXT-62).
import nodeFs from 'node:fs';
import path from 'node:path';
import { ACTION_ID_RE, UUID_RE } from './actions.mjs';

export const BELL_MAX = 10; // слов на тред (2.5)
export const DEAD_MS = 24 * 3600000; // тред умер — слова держатся сутки (2.4)
export const RING_HEAD = 'Слово Ивана · кнопка витрины. Это слово Ивана, как в чате: исполняй по правилам цеха, стоп-точки действуют; '
  + 'по Б-делу (метка Б, развилка, база, auth, снос, слияние, выкатка) — переспроси Ивана в чате; кнопка не заменяет щелчок «спросить». '
  + 'Запись — «Кто решил: слово Ивана · кнопка витрины · <id>»; слово на карточку витрина уже записала.';

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const ddmm = (ms) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${hhmm(ms)}`; };

// «в ответ на» (2.6): запись карточки — ДД.ММ ЧЧ:ММ «первые слова»; карточка без записей — «записей не было»;
// сообщение треда (строка (а), q = {uuid, at}) — ДД.ММ ЧЧ:ММ
function qLabel(q) {
  if (!q || q.at === null || q.at === undefined) return 'записей не было';
  const t = ddmm(Date.parse(q.at));
  return typeof q.head === 'string' ? `${t} «${q.head}»` : t;
}

// строка слова: <id> · <ЧЧ:ММ> · <КАРТОЧКА или «без карточки»> · «<слово>» · в ответ на: <…> [· <текст>]
export function ringLine(w) {
  // перевод строки внутри текста Ивана — пробел: строка на слово (2.5, 2.6)
  const text = w.text ? String(w.text).replace(/\r?\n/g, ' ') : '';
  return `${w.id} · ${hhmm(Date.parse(w.at))} · ${w.card ?? 'без карточки'} · «${w.word}» · в ответ на: ${qLabel(w.q)}${text ? ` · ${text}` : ''}`;
}

// «Перечитать правила» (EXT-65, §2.6, §1.8): своя форма звонка, без фразы о Б-деле — просьба ничего не меняет в системе.
// Слово — {id, at, action: 'reread', card: null, word: 'перечитай правила', paths: [полные пути = missing], note}; note — строка
// хроники «правила обновлены» (до 300 знаков, уже по маске) или пусто — тогда фраза о правке опускается.
export const REREAD_WORD = 'перечитай правила';
export const NOTE_MAX = 300;
// не больше NOTE_MAX знаков вместе с «…» (по знакам, не по кодовым единицам: суррогатные пары не рвутся)
export const clipNote = (s) => {
  const a = [...String(s)];
  return a.length > NOTE_MAX ? `${a.slice(0, NOTE_MAX - 1).join('')}…` : a.join('');
};
export const isReread = (w) => w?.action === 'reread';
const rereadHead = (note0) => 'Слово Ивана · кнопка витрины. Это слово Ивана, как в чате: перечитай правила цеха — прочитай целиком инструментом Read, не поиском и не диффом, каждый файл ниже. '
  + (note0 ? `Правка, из-за которой просьба: «${clipNote(String(note0).replace(/\r?\n/g, ' '))}» — если она легла и в другой файл правил цеха (Vault \`CLAUDE.md\`, \`unorbis/_meta/\`, \`~/.claude/\`), прочитай и его. ` : '')
  + 'Ничего не меняй. Ответь строкой «правила перечитаны»; если до звонка ты ждал ответа Ивана — закончи ответ тем же вопросом.';
const rereadBlock = (w) => [rereadHead(w.note), `${w.id} · ${hhmm(Date.parse(w.at))} · без карточки · «${REREAD_WORD}»`, ...(w.paths ?? [])];

// Что отдать одним звонком (2.6, правка d400a47): «перечитай» никогда не в одном звонке со словами — иначе «исполни слово»
// спорило бы с «ничего не меняй». Есть слова — звонок только словами, «перечитай» держится в памяти (held) до следующего
// запроса ждущего; слов нет — звонок «перечитай». → {ring: [слово], held: [id]}. В предел 10 слов (2.5) «перечитай»
// по-прежнему считается одним словом — он лежит в той же очереди.
export function ringBatch(words) {
  const sorted = [...words].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const plain = sorted.filter((w) => !isReread(w));
  if (!plain.length) return { ring: sorted, held: [] };
  return { ring: plain, held: sorted.filter(isReread).map((w) => w.id) };
}

// текст звонка: слова — одним звонком, по строке на слово, по порядку времени (2.5); «перечитай» — своя форма.
// Смешанный набор — ошибка: отбирает ringBatch
export function ringText(words) {
  const sorted = [...words].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const plain = sorted.filter((w) => !isReread(w));
  const rereads = sorted.filter(isReread);
  if (plain.length && rereads.length) throw new Error('ringText: «перечитай» не в одном звонке со словами (2.6) — набор отбирает ringBatch');
  return (plain.length ? [RING_HEAD, ...plain.map(ringLine)] : rereads.flatMap(rereadBlock)).join('\n');
}

// Кого будить (2.3): первое сработавшее правило. threads — живые треды (строки «Кто работает», §2.1 и §1.4 витрины).
// → {kind: 'one', target} | {kind: 'many', candidates} | {kind: 'none', code} | {kind: 'closed'} (тред строки (а) умер).
// target: {sessionId, title, by: row|card|project|cards, staleMin} — staleMin у треда «устарело»: «нет вестей N мин».
// Несколько тредов с той же карточкой — тоже «несколько» (не угадываем).
// EXT-78: треды с foreman: true (прораб, запущенный дирижёром; buildWorkers) в правилах 2 и 3 не участвуют — нашёлся только
// прораб по карточке → правило 3; кроме прораба никого → none. Правило 1 (session) — как было.
export function pickThread({ threads = [], card = null, session = null, now = Date.now() }) {
  const target = (t, by) => ({ sessionId: t.sessionId, title: t.title ?? null, by,
    staleMin: t.state === 'stale' && Number.isFinite(Date.parse(t.lastSeenAt)) ? Math.round((now - Date.parse(t.lastSeenAt)) / 60000) : null });
  const projBy = (t) => (t.projectBy === 'cards' ? 'cards' : 'project');
  if (session) {
    const t = threads.find((x) => x.sessionId === session);
    return t ? { kind: 'one', target: target(t, 'row') } : { kind: 'closed' };
  }
  const code = typeof card === 'string' ? card.split('-')[0] : null;
  // EXT-78: сессия прораба (foreman: true) — не кандидат по карточке и проекту; адресный звонок строки (а) её не касается
  const pool = threads.filter((t) => !t.foreman);
  const byCard = card ? pool.filter((t) => t.card === card) : [];
  if (byCard.length === 1) return { kind: 'one', target: target(byCard[0], 'card') };
  if (byCard.length > 1) return { kind: 'many', candidates: byCard.map((t) => target(t, 'card')) };
  const byProj = code ? pool.filter((t) => t.project === code) : [];
  if (byProj.length === 1) return { kind: 'one', target: target(byProj[0], projBy(byProj[0])) };
  if (byProj.length > 1) return { kind: 'many', candidates: byProj.map((t) => target(t, projBy(t))) };
  return { kind: 'none', code };
}

// dir — папка звонка (pult.bellDir); live() → Set живых sessionId или null (реестр процессов не читается — тред
// мёртвым не считается); onStep(line) — строка в actions.log {id, step, action, card, reason?}; onForged({sid, id, kind}).
export function createBell({ dir, now = Date.now, live = () => null, onStep = () => {}, onForged = () => {}, fs = nodeFs }) {
  const words = new Map(); // sid → [слово]
  const delivered = new Set(); // id, снятые строкой ring этим запуском (статус «доставлено» до шага на такте)
  const ringSeen = new Set(); // все id из строк ring (forged по ним — stale)
  const deadSince = new Map(); // sid → с какого момента тред не виден живым
  const toWrite = []; // строки шагов, которые запишет такт
  // отозванные Иваном в этом запуске (EXT-71, §1.9): номер действия → {sid, word, action, card, late}. По ним forged — stale,
  // поздняя строка ring — «отозвано поздно: доставлено» сразу в памяти (late) и шаг ring-delivered с late: true на такте
  const withdrawn = new Map();
  const logFile = path.join(dir, 'bell.log');
  let offset = 0;
  let rest = '';

  const sigDir = (sid) => path.join(dir, sid);
  const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch { /* уже нет */ } };
  // шаг — у действия (actionId), номер слова (id) — номер записи на карточке; у строк actions.log при рестарте — id действия
  const stepOf = (w, step, extra = {}) => ({ id: w.actionId ?? w.id, step, action: w.action ?? null, card: w.card ?? null, ...extra });

  // новые строки bell.log от своего смещения; только полные строки (половина — ждёт дописи). Файл стал короче — с нуля.
  function readNew() {
    let size;
    try { size = fs.statSync(logFile).size; } catch { return []; }
    if (size < offset) { offset = 0; rest = ''; }
    if (size === offset) return [];
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(logFile, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const text = rest + buf.toString('utf8');
    const parts = text.split('\n');
    rest = parts.pop();
    const out = [];
    for (const l of parts) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j); } catch { /* битая строка */ }
    }
    return out;
  }
  const idsOf = (e) => (Array.isArray(e.ids) ? e.ids.filter((x) => typeof x === 'string') : typeof e.id === 'string' ? [e.id] : []);

  // дочитать bell.log: ring снимает слова этого sid из памяти (шаг — в очередь такта); forged — stale или forged
  function sync() {
    for (const e of readNew()) {
      const ids = idsOf(e);
      if (e.event === 'ring') {
        for (const id of ids) {
          ringSeen.add(id);
          for (const [aid, w] of withdrawn) {
            if (w.late || w.word !== id || w.sid !== (e.sid ?? null)) continue;
            w.late = true;
            toWrite.push(stepOf({ actionId: aid, action: w.action, card: w.card }, 'ring-delivered', { late: true }));
          }
        }
        const list = words.get(e.sid);
        if (!list) continue;
        for (const id of ids) {
          const i = list.findIndex((w) => w.id === id);
          if (i < 0) continue;
          const [w] = list.splice(i, 1);
          delivered.add(id);
          toWrite.push(stepOf(w, 'ring-delivered'));
        }
        if (!list.length) { words.delete(e.sid); deadSince.delete(e.sid); }
      } else if (e.event === 'forged') {
        for (const id of ids) onForged({ sid: e.sid ?? null, id, kind: ringSeen.has(id) || [...withdrawn.values()].some((w) => w.word === id) ? 'stale' : 'forged' });
      }
    }
  }

  return {
    // слово в очередь треда: память и сигнал (временный файл и rename). Полна — отказ, ничего не положено.
    queue(sid, w) {
      if (!UUID_RE.test(sid) || !ACTION_ID_RE.test(w.id)) throw Object.assign(new Error('bell: sid или id не по форме'), { code: 'BELL_FORM' });
      sync();
      const list = words.get(sid) ?? [];
      if (list.length >= BELL_MAX) return { ok: false, refusal: 'queue-full', message: 'очередь треда полна' };
      fs.mkdirSync(sigDir(sid), { recursive: true });
      const file = path.join(sigDir(sid), `${w.id}.ring`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, '');
      fs.renameSync(tmp, file);
      list.push({ ...w });
      words.set(sid, list);
      return { ok: true };
    },
    // недоставленные слова треда — для GET /api/bell/:sid (перед ответом bell.log дочитан)
    pending(sid) {
      sync();
      return [...(words.get(sid) ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },
    // --- отзыв (EXT-71, §1.9). Все методы синхронны: шаги 1–4 обработчика идут одним ходом цикла событий ---
    // шаг 1: дочитать bell.log; слово действия actionId — в памяти треда sid?
    holds(sid, actionId) { sync(); return (words.get(sid) ?? []).some((w) => w.actionId === actionId); },
    refresh() { sync(); },
    // строка ring по номеру слова уже есть в bell.log (или слово снято ею): слово доставлено
    rang(id) { sync(); return ringSeen.has(id) || delivered.has(id); },
    // шаги 3–4: слово снимается по actionId в сессии sid (не по одному номеру слова: при повторе частичного исхода тот же номер
    // мог лечь в память второй раз); сигнал <sid>/<номер>.ring удаляется, только если номера в памяти сессии больше нет —
    // иначе ждущий найдёт сигнал без слова и запишет forged. Номер действия — в список отозванных запуска.
    withdraw(sid, { actionId, word, action = null, card = null }) {
      const list = words.get(sid) ?? [];
      const keep = list.filter((w) => w.actionId !== actionId);
      if (keep.length) words.set(sid, keep);
      else { words.delete(sid); deadSince.delete(sid); }
      withdrawn.set(actionId, { sid, word, action, card, late: withdrawn.get(actionId)?.late ?? false });
      if (!keep.some((w) => w.id === word)) unlinkQuiet(path.join(sigDir(sid), `${word}.ring`));
      return { removed: list.length - keep.length };
    },
    // отозванное действие получило позднюю строку ring (ждущий успел забрать слово): «отозвано поздно: доставлено» — сразу
    isLate(actionId) { sync(); return withdrawn.get(actionId)?.late === true; },
    queued() { sync(); let k = 0; for (const l of words.values()) k += l.length; return k; },
    // статус по памяти этого запуска (2.8): положено | не доставлено: тред закрыт | доставлено | null (не знаю)
    statusOf(id) {
      sync();
      if (delivered.has(id)) return 'доставлено';
      for (const [sid, l] of words) if (l.some((w) => w.id === id)) return deadSince.has(sid) ? 'не доставлено: тред закрыт' : 'положено';
      return null;
    },
    // старт сервера (2.2 «Цена»): сигналы прочь; прежние ring-queued без ring-delivered/withdrawn — ring-delivered,
    // если ждущий успел записать ring до рестарта, иначе withdrawn: restart. Строки bell.log до старта — прочитаны.
    start(lines = []) {
      const fromLog = new Set();
      for (const e of readNew()) if (e.event === 'ring') for (const id of idsOf(e)) { fromLog.add(id); ringSeen.add(id); }
      try {
        for (const s of fs.readdirSync(dir)) {
          if (!UUID_RE.test(s)) continue;
          let names = [];
          try { names = fs.readdirSync(sigDir(s)); } catch { continue; }
          for (const f of names) if (f.endsWith('.ring')) unlinkQuiet(path.join(sigDir(s), f));
        }
      } catch { /* папки ещё нет */ }
      const closed = new Set(lines.filter((l) => l?.step === 'ring-delivered' || l?.step === 'withdrawn').map((l) => l.id));
      const out = [];
      for (const l of lines) {
        if (l?.step !== 'ring-queued' || typeof l.id !== 'string' || closed.has(l.id)) continue;
        closed.add(l.id);
        out.push(fromLog.has(l.word ?? l.id) ? stepOf(l, 'ring-delivered') : stepOf(l, 'withdrawn', { reason: 'restart' }));
      }
      // поздний ring по отозванному (§1.9): withdrawn: ivan без ring-delivered, а строка ring по слову в bell.log есть — рестарт её не теряет
      const got = new Set(lines.filter((l) => l?.step === 'ring-delivered').map((l) => l.id));
      for (const l of lines) {
        if (l?.step !== 'withdrawn' || l.reason !== 'ivan' || typeof l.id !== 'string' || got.has(l.id)) continue;
        const qd = lines.find((x) => x?.id === l.id && x.step === 'ring-queued');
        if (!qd || !fromLog.has(qd.word ?? qd.id)) continue;
        got.add(l.id);
        out.push(stepOf({ actionId: l.id, action: l.action ?? null, card: l.card ?? null }, 'ring-delivered', { late: true }));
      }
      for (const s of out) onStep(s);
    },
    // такт: дочитать bell.log, записать шаги; тред, не видный живым, — «закрыт»; через 24 ч слова прочь,
    // сигналы — в undelivered/<sid>/, шаг withdrawn: thread-closed
    tick() {
      sync();
      const alive = words.size ? live() : null; // реестр процессов — только если есть недоставленные слова
      const t = now();
      for (const [sid, list] of [...words]) {
        if (!alive) break;
        if (alive.has(sid)) { deadSince.delete(sid); continue; }
        if (!deadSince.has(sid)) deadSince.set(sid, t);
        if (t - deadSince.get(sid) < DEAD_MS) continue;
        const ud = path.join(dir, 'undelivered', sid);
        fs.mkdirSync(ud, { recursive: true });
        for (const w of list) {
          try { fs.renameSync(path.join(sigDir(sid), `${w.id}.ring`), path.join(ud, `${w.id}.ring`)); } catch { /* сигнала уже нет */ }
          toWrite.push(stepOf(w, 'withdrawn', { reason: 'thread-closed' }));
        }
        words.delete(sid);
        deadSince.delete(sid);
      }
      while (toWrite.length) onStep(toWrite.shift());
    },
  };
}
