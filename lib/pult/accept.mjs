// «Принять» и «Вернуть» (ПТ3, EXT-43; спека пульта §1.1 п.4–6, §1.2, таблица 1.3, §3.1, §3.2, §3.4).
// Режим mirror: свежая сверка `plane.py show <ID> --last` → `comment <html> <ID>` → `state <ID> Done|"In Progress"`,
// всё — через одну очередь записей в Plane (queue.mjs), один plane.py за раз. Частичный исход (comment лёг, state нет)
// и неясный (comment вышел кодом ≠ 0) — явные; повтор не задваивает коммент: номер действия стоит в первом абзаце
// записи и попадает в 80 знаков show --last. Скрытие «Принять» (В7), местная отметка и её снятие — по внешнему следу
// (файлы доски, runs.log зеркала), не по ответу Plane.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { stripMarkdown } from '../text.mjs';

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const ddmmhhmm = (ms) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${hhmm(ms)}`; };
const minute = (ms) => Math.floor(ms / 60000);
const LINE_MAX = 200;

// ---------- нормализация «первых слов» (§1.1 п.6; одна функция для q.head и для show --last) ----------

const BLOCK_TAG = /<(?:br|hr|\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|pre|tr|td|th|table))\b[^>]*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entity = (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
};
// HTML (Plane) и markdown (зеркало) → простой текст: теги прочь (блочные — пробелом), сущности, разметка markdown,
// markdown-экранирование «\*», непарные маркеры (*, _, `, ~ — разрез в 60 знаков рвёт «**» пополам), U+FE0F, пробелы
export function normHead(s) {
  let t = String(s ?? '').replace(BLOCK_TAG, ' ').replace(/<[^>]*>/g, '');
  t = t.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, entity);
  // экранированный знак — не разметка: на время разбора — в символ частной зоны, потом обратно
  t = t.replace(/\\([!-/:-@[-`{-~])/g, (_, c) => String.fromCharCode(0xE100 + c.charCodeAt(0)));
  t = stripMarkdown(t).replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xE100));
  // маркеры прочь с обеих сторон одинаково: непарные (разрез рвёт «**»), экранированные и буквальные из HTML
  t = t.replace(/[*_`~]/g, '');
  return t.replace(/️/g, '').replace(/\s+/g, ' ').trim();
}

// «те же первые слова»: q.head — 60 знаков markdown, show --last — 80 знаков текста; после нормализации короткое —
// начало длинного. Разрез мог пройтись по слову и разметке — у трёх и больше слов последнее неполное не сравнивается.
export function sameHead(a, b) {
  const x = normHead(a);
  const y = normHead(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(short)) return true;
  const words = short.split(' ');
  if (words.length < 3) return false;
  return long.startsWith(words.slice(0, -1).join(' ') + ' ');
}

export const PULT_MARK = 'Слово Ивана · кнопка витрины · ';
// запись самого пульта — по началу первого абзаца (§1.2): «Слово Ивана · кнопка витрины · W-»
export const isPultRecord = (text) => normHead(text).startsWith(`${PULT_MARK}W-`);

// ---------- вывод plane.py ----------

// show <ID> --last (строка документации plane.py): «<ID> · <статус> · <название>», затем
// «последний коммент · <created_at> · <80 знаков>» | «… · (без текста)» | «комментов нет». Иное — null.
export function parseShow(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim());
  const m = lines[0]?.match(/^([A-Z]{2,6}-\d+) · (.+?) · /) ?? lines[0]?.match(/^([A-Z]{2,6}-\d+) · (.+)$/);
  if (!m || lines.length < 2) return null;
  if (lines[1].trim() === 'комментов нет') return { status: m[2].trim(), last: null };
  const c = lines[1].match(/^последний коммент · (\S+) · (.*)$/);
  if (!c || !Number.isFinite(Date.parse(c[1]))) return null;
  return { status: m[2].trim(), last: { at: c[1], text: c[2] === '(без текста)' ? '' : c[2] } };
}

// первая непустая строка (stderr при сбое — трасса Python: только её первая строка, по маске; §3.1)
export function firstLineOf(text) {
  const l = String(text ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
  return [...l].slice(0, LINE_MAX).join('');
}

// ---------- запись на карточке (§1.2, режим mirror) ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escLines = (s) => esc(s).replace(/\r?\n/g, '<br>');

export function recordHtml({ id, word, q, reason = null }) {
  const asked = q?.at ? `<p>В ответ на: запись ${ddmmhhmm(Date.parse(q.at))} «${esc(q.head ?? '')}»</p>` : '<p>В ответ на: записей не было</p>';
  return `<p><b>${PULT_MARK}${id}</b>: «${esc(word)}»</p>`
    + asked
    + (reason ? `<p>Причина: ${escLines(reason)}</p>` : '')
    + `<p>Кто решил: слово Ивана · кнопка витрины · ${id}</p>`;
}

// ---------- запуск plane.py ----------

// spawn('python', [plane.py, …args], {windowsHide, env: {…, PYTHONIOENCODING}}) — аргументы массивом (кириллица цела);
// → {code, stdout, stderr}; не запустился — code null и spawnError; дольше timeoutMs — убит, code null
export function createPlaneSpawn({ python = 'python', planePy, timeoutMs = 120000, spawn = nodeSpawn, env = process.env }) {
  return (args) => new Promise((resolve) => {
    const out = [];
    const err = [];
    let done = false;
    // timer — до end: синхронный сбой spawn зовёт end раньше таймера (мелочь 3 Голема на В10: иначе ReferenceError и 500)
    let timer = null;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ...v }); } };
    let child;
    try {
      child = spawn(python, [planePy, ...args], { windowsHide: true, env: { ...env, PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { end({ code: null, spawnError: typeof e?.code === 'string' ? e.code : 'SPAWN' }); return; }
    timer = setTimeout(() => { child.kill(); end({ code: null, timedOut: true }); }, timeoutMs);
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    child.once('error', (e) => end({ code: null, spawnError: typeof e?.code === 'string' ? e.code : 'SPAWN' }));
    child.once('close', (code) => end({ code }));
  });
}

// ---------- скрытие «Принять» (В7) ----------

// ветка карточки `<код строчными>-<N>-*` в репозиториях проекта по реестру: слита ли в main. Обёртка чтения git —
// только `branch --list <шаблон> --format=…` и `merge-base --is-ancestor` (git-read.mjs). Кэш на ttlMs: опрос «Цеха»
// не зовёт git на каждый запрос (нагрузка в покое, EXT-37); POST «Принять» сверяет заново (fresh).
// Значение: {state: 'ok' | 'not-merged' | 'unknown', branch, repo}; веток нет — ok.
export function createMergeCheck({ git, registry, ttlMs = 5 * 60000, now = Date.now }) {
  const cache = new Map(); // card → {at, value, running}
  async function compute(card) {
    if (!git) return { state: 'ok', branch: null, repo: null };
    const [code, n] = card.split('-');
    const repos = registry?.get().codes.find((c) => c.code === code)?.repos ?? [];
    const re = new RegExp(`^${code.toLowerCase()}-${n}-`);
    for (const repo of repos) {
      let out;
      try { out = await git(repo, ['branch', '--list', `${code.toLowerCase()}-${n}-*`, '--format=%(refname:short)']); }
      catch { return { state: 'unknown', branch: null, repo }; }
      for (const b of out.split(/\r?\n/).map((x) => x.trim()).filter((x) => re.test(x))) {
        try { await git(repo, ['merge-base', '--is-ancestor', b, 'main']); }
        catch (e) { return { state: e?.code === 1 ? 'not-merged' : 'unknown', branch: b, repo }; }
      }
    }
    return { state: 'ok', branch: null, repo: null };
  }
  function refresh(card) {
    const c = cache.get(card) ?? {};
    if (c.running) return c.running;
    const p = compute(card).then((value) => { cache.set(card, { at: now(), value }); return value; },
      () => { const value = { state: 'unknown', branch: null, repo: null }; cache.set(card, { at: now(), value }); return value; });
    cache.set(card, { ...c, running: p });
    return p;
  }
  return {
    // свежее значение (POST) или из кэша, если моложе ttl (GET)
    async check(card, { fresh = false } = {}) {
      const c = cache.get(card);
      if (!fresh && c?.value && now() - c.at < ttlMs) return c.value;
      return refresh(card);
    },
    // синхронно: что знаем (null — ещё не проверено); старое — перепроверка фоном
    peek(card) {
      const c = cache.get(card);
      if (!c?.value || now() - c.at >= ttlMs) refresh(card).catch(() => {});
      return c?.value ?? null;
    },
  };
}

// ветку проверять есть смысл только у карточки в Review без Б-признака: иначе «Принять» нет и без git (нагрузка, EXT-37)
export const needsGit = (c) => !!c && c.status === 'review' && c.markB !== true && !c.last?.mark;
export const B_HINT = 'Б-карточка ждёт слияния: «сливай» или «выкатывай»';
export const FORK_HINT = 'по карточке открыта развилка — сначала ответь на неё';
// можно ли «Принять» (таблица 1.3, В7): {can, why: null | 'not-review' | 'b-deal' | 'not-merged' | 'checking', hint, branch}
// Б-признак: mark_b или последняя запись — вопрос с меткой (строка (б): «развилка» / «сливай» / «выкатывай»)
export function acceptState(card, merge) {
  const no = (why, hint, branch = null) => ({ can: false, why, hint, branch });
  if (!card || card.status !== 'review') return no('not-review', 'карточка не в Review');
  if (card.markB === true || card.last?.mark) return no('b-deal', card.markB !== true && card.last?.mark === 'развилка' ? FORK_HINT : B_HINT);
  if (!merge) return { can: null, why: 'checking', hint: 'проверяю, слита ли ветка карточки', branch: null };
  if (merge.state === 'not-merged') return no('not-merged', `ветка ${merge.branch} не слита в main — ${B_HINT}`, merge.branch);
  if (merge.state === 'unknown') return no('not-merged', `не проверить, слита ли ветка карточки${merge.branch ? ` ${merge.branch}` : ''} — ${B_HINT}`, merge.branch);
  return { can: true, why: null, hint: null, branch: null };
}

// ---------- местная отметка (§3.2) ----------

// .mirror/runs.log зеркала: «<ISO> · начало · <вид> · pid N», «<ISO> · конец · <вид> · pid N · код C · …» → проходы
export function readRuns(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const runs = [];
  const open = new Map();
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^(\S+) · (начало|конец) · (.+?) · pid (\d+)(?: · код (\d+))?/);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    if (m[2] === 'начало') open.set(m[4], at);
    else { runs.push({ start: open.get(m[4]) ?? null, end: at, code: m[5] === undefined ? null : Number(m[5]), kind: m[3] }); open.delete(m[4]); }
  }
  return runs;
}

const WORD_DONE = { accept: 'принято', return: 'возвращено' };
const MARK_DAYS = 7;
// отметки по actions.log: удачные «Принять»/«Вернуть» последних 7 дней, у которых нет mirror-seen и запись <record>
// которых зеркало ещё не принесло в файлы доски. Проход, начавшийся и кончившийся после шага plane (код 0), а записи
// нет → красная «зеркало не видит запись <id>». → Map card → {id, action, at, state, text, missing}
// Проход, который обязан был принести запись: обычный или полный (не dry), либо свой --card — начался в пределах
// OWN_CARD_MS после нашего запуска (launches: card → [время запуска]; у runs.log нет номера карточки). assets, links,
// чужой --card — не в счёт (Важно 2 Голема на ПТ3).
export const OWN_CARD_MS = 2 * 60000;
const BOARD_PASS = /^(changed|full)$/;
export function localMarks({ lines, readLog, runs = [], now = Date.now(), launches = new Map() }) {
  const seen = new Set(lines.filter((l) => l?.step === 'mirror-seen').map((l) => l.id));
  const out = new Map();
  for (const l of lines) {
    if (l?.step !== 'done' || !WORD_DONE[l.action] || l.result?.outcome !== 'ok' || !l.result?.record || seen.has(l.id)) continue;
    const at = Date.parse(l.result.planeAt ?? l.at);
    if (!Number.isFinite(at) || now - at > MARK_DAYS * 86400000) continue;
    const record = l.result.record;
    const entries = readLog(l.card)?.entries ?? [];
    if (entries.some((e) => String(e.body ?? '').includes(record))) continue;
    const own = (r) => r.kind === 'card' && (launches.get(l.card) ?? []).some((t) => r.start >= t - 1000 && r.start <= t + OWN_CARD_MS);
    const missing = runs.some((r) => r.code === 0 && r.start !== null && r.start > at && r.end > at && (BOARD_PASS.test(r.kind) || own(r)));
    const state = l.result.state ?? (l.action === 'accept' ? 'Done' : 'In Progress');
    out.set(l.card, { id: record, action: l.action, at: new Date(at).toISOString(), state, missing,
      text: missing ? `зеркало не видит запись ${record}` : `${WORD_DONE[l.action]} · ${state} в Plane ${hhmm(at)} · зеркало ещё не видело` });
  }
  return out;
}

// ---------- обработчики ----------

// незавершённое прежнее нажатие того же действия по той же карточке: его коммент лёг (partial / оборвано после comment)
// или исход comment неясен. → {id, record, known} | null; record — номер на карточке, known — коммент лёг точно.
// Подставляется в новое нажатие только после сверки: последний коммент в Plane несёт record (createAcceptHandlers).
export function priorOpen(lines, card, action, currentId) {
  const ids = [];
  for (const l of lines) if (l?.card === card && l.action === action && l.id !== currentId && !ids.includes(l.id)) ids.push(l.id);
  for (const id of ids.reverse()) {
    const ls = lines.filter((l) => l.id === id);
    const comment = ls.filter((l) => l.step === 'plane' && l.cmd === 'comment');
    if (!comment.length) continue; // отказ до записи — не в счёт, смотрим раньше
    const last = ls.at(-1);
    if (last.step === 'done' || (last.step === 'error' && last.result?.code === 'NOT_WRITTEN')) return null;
    if (last.step === 'partial') return { id, record: last.result?.record ?? id, known: true };
    if (comment.some((l) => l.result?.code === 0)) return { id, record: id, known: true };
    return { id, record: id, known: false };
  }
  return null;
}

const STATE = { accept: 'Done', return: 'In Progress' };
const WORD = { accept: 'принято', return: 'вернуть' };

// board — читатель доски; merge — createMergeCheck; mirror — {pull(card) → 'launched'|'queued'|'no-index'|…, statusAt()};
// readLines — actions.log; mask(text) — маска; now — часы
export function createAcceptHandlers({ board, merge, mirror, readLines, mask = (t) => t, now = Date.now }) {
  async function act(ctx) {
    const { id, action, card: cardId, q, plane, step } = ctx;
    const target = STATE[action];
    const refused = (refusal, message, extra = {}) => ({ outcome: 'refused', refusal, message, ...extra });
    const card = board.card(cardId);
    if (!card) return refused('no-card', `${cardId}: карточки нет в файлах доски`);
    if (card.status !== 'review') return refused('not-review', `${cardId}: по зеркалу не в Review (${card.status})`, { pull: true });
    if (action === 'accept') {
      const st = acceptState(card, needsGit(card) ? await merge.check(cardId, { fresh: true }) : null);
      if (!st.can) return refused(st.why === 'b-deal' ? 'b-deal' : 'not-merged', `«Принять» нет: ${st.hint}`);
    }
    const prior = priorOpen(readLines(), cardId, action, id);
    const call = async (args) => {
      const t0 = Date.now();
      const r = await plane.push(args);
      return { ...r, ms: Date.now() - t0 };
    };
    const lineOf = (r) => mask(firstLineOf(r.code === 0 ? r.stdout : (r.stderr || r.stdout)) || (r.timedOut ? 'таймаут' : r.spawnError ?? ''));
    const freshRead = async (why) => {
      const r = await call(['show', cardId, '--last']);
      const sh = r.code === 0 ? parseShow(r.stdout) : null;
      step({ step: 'fresh', ...(why ? { why } : {}), fresh: sh ? { status: sh.status, last: sh.last ? { at: sh.last.at, text: mask(sh.last.text) } : null } : null,
        result: { code: r.code, ms: r.ms, ...(sh ? {} : { line: lineOf(r) }) } });
      return { r, sh };
    };

    // свежая сверка (§1.1 п.6)
    const f = await freshRead(null);
    if (!f.sh) return { outcome: 'error', message: `свежая сверка не удалась: ${lineOf(f.r)}`, result: { code: 'FRESH', line: lineOf(f.r) } };
    const mirrorAt = board.mirrorStatus?.()?.lastOkAt ?? null;
    if (f.sh.status !== 'Review') {
      return refused('stale-status', `в Plane сейчас ${f.sh.status}; зеркало от ${mirrorAt ? ddmmhhmm(Date.parse(mirrorAt)) : '—'} — дотянуть?`, { pull: true });
    }
    const last = f.sh.last;
    // прежний номер (partial, оборвано рестартом после comment, неясный исход) — только если последний коммент в Plane
    // по свежей сверке несёт именно его. Иначе на карточке с тех пор было что-то ещё (тред вернул и спросил снова) —
    // новая запись с новым номером: старая отвечала на прежний вопрос (Критично 1 Голема на ПТ3)
    let record = prior && last?.text.includes(prior.record) ? prior.record : null;
    if (last && !isPultRecord(last.text)) {
      const lm = Date.parse(last.at);
      const fresher = q?.at == null || minute(lm) > minute(Date.parse(q.at)) || (minute(lm) === minute(Date.parse(q.at)) && !sameHead(q.head, last.text));
      if (fresher) return refused('new-question', `на карточке новое сообщение от ${hhmm(lm)} — посмотри и ответь заново`, { pull: true });
    }

    // запись (§1.2) — если прежнее нажатие её уже не положило
    if (!record) {
      const html = recordHtml({ id, word: WORD[action], q, reason: action === 'return' ? ctx.text : null });
      const c = await call(['comment', html, cardId]);
      step({ step: 'plane', cmd: 'comment', result: { code: c.code, line: lineOf(c), ms: c.ms } });
      if (c.code !== 0) {
        // неясный исход: коммент мог лечь — сверка show --last по номеру действия
        const v = await freshRead('unclear');
        if (!v.sh) return { outcome: 'error', message: `исход записи неясен: ${lineOf(c)} — повтори, перед записью будет сверка`, result: { code: 'UNCLEAR', line: lineOf(c) } };
        // последний коммент — не наш: запись, скорее всего, не легла, но мог лечь и чужой коммент поверх — Иван смотрит сам
        if (!v.sh.last?.text.includes(id)) return { outcome: 'error', message: `не найдено в последнем комменте — проверь карточку (${lineOf(c)})`, result: { code: 'NOT_WRITTEN', line: lineOf(c) } };
      }
      record = id;
    }

    // статус: успех — код 0 и «подтверждён»; код 0 и «НЕ совпал» — не успех; код ≠ 0 — первая строка stderr по маске
    const s = await call(['state', cardId, target]);
    const okState = s.code === 0 && /подтверждён/.test(s.stdout);
    step({ step: 'plane', cmd: 'state', result: { code: s.code, line: lineOf(s), ms: s.ms } });
    if (!okState) return { outcome: 'partial', message: `частично: запись есть, статус не сменился — повторить (${lineOf(s)})`, result: { record, line: lineOf(s) } };
    const planeAt = now();
    const pull = mirror ? await mirror.pull(cardId) : 'off';
    const message = action === 'accept'
      ? `принято · Done в Plane ${hhmm(planeAt)} · зеркало: ждёт`
      : `возвращено · In Progress в Plane ${hhmm(planeAt)} · тред увидит при открытии (звонок — после ПТ4)`;
    return { outcome: 'ok', message, result: { record, state: target, planeAt: new Date(planeAt).toISOString(), pull } };
  }
  return { accept: act, return: act };
}

// дотяжка --card (§3.2): запуск — тем же mirror-hidden.js, что у «Обновить», отсоединённо и скрыто; журнал — свой
// (mirror-card.log: mirror-hidden.js опустошает свой --log при старте, журнал «Обновить» не трётся).
// Проход идёт → карточка в очередь; после строки «конец» в runs.log новее постановки — --card один раз.
// «launched» — только после события spawn. Время запусков — в памяти (свой --card для красной пометки, localMarks).
// После рестарта (restore): запуски — из строк done с pull «launched» (время шага); очередь — строки done с pull
// «queued» последнего часа, если после них в runs.log не начинался ни один --card. Запуск из очереди, сделанный
// до рестарта, в actions.log не пишется (шагов §3.4 для него нет): такой --card после рестарта своим не считается —
// красная от него не загорится (ошибка в безопасную сторону).
export function createCardPull({ boardRoot, mirrorDir, running, logFile, spawn = nodeSpawn, execPath = process.execPath, wscript, now = Date.now }) {
  const pending = new Map(); // card → время постановки
  const launches = new Map(); // card → [время запуска]
  const remember = (card, t) => launches.set(card, [...(launches.get(card) ?? []), t].slice(-5));
  const launch = async (card) => {
    const hidden = path.join(boardRoot, 'tools', 'mirror-hidden.js');
    if (!fs.existsSync(hidden)) return 'no-launcher';
    const t = now();
    try {
      const child = spawn(wscript, ['//B', '//Nologo', '//E:JScript', hidden, execPath, '--card', card, '--root', boardRoot, '--log', logFile],
        { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref?.();
    } catch (e) { return `error:${typeof e?.code === 'string' ? e.code : 'SPAWN'}`; }
    remember(card, t);
    return 'launched';
  };
  const runsFile = () => path.join(mirrorDir, 'runs.log');
  return {
    async pull(card) {
      if (!boardRoot || !mirrorDir || !logFile) return 'off';
      if (!fs.existsSync(path.join(mirrorDir, 'index.json'))) return 'no-index';
      if (running()) { pending.set(card, now()); return 'queued'; }
      return launch(card);
    },
    async tick() {
      if (!pending.size || running()) return [];
      const ends = readRuns(runsFile()).map((r) => r.end);
      const out = [];
      for (const [card, at] of [...pending]) {
        if (!ends.some((e) => e > at)) continue;
        pending.delete(card);
        out.push([card, await launch(card)]);
      }
      return out;
    },
    restore(lines) {
      if (!mirrorDir) return;
      const cardStarts = readRuns(runsFile()).filter((r) => r.kind === 'card' && r.start !== null).map((r) => r.start);
      for (const l of lines) {
        if (l?.step !== 'done' || !['accept', 'return'].includes(l.action) || l.result?.outcome !== 'ok') continue;
        const t = Date.parse(l.result.planeAt ?? l.at);
        if (!Number.isFinite(t) || now() - t > 3600000) continue;
        if (l.result.pull === 'launched') remember(l.card, t);
        else if (l.result.pull === 'queued' && !cardStarts.some((s) => s > t)) pending.set(l.card, t);
        else if (l.result.pull === 'queued') pending.delete(l.card);
      }
    },
    launches: () => launches,
    pending: () => [...pending.keys()],
  };
}
