// Уведомления Windows (спека 4.1) и пробуждение (5): что показывать, что уже показано, когда молчать.
// Сам тост — lib/toast.mjs. Строки берутся из уже замаскированного «Ждёт меня» (app.mjs, маска 6.2).
import nodeFs from 'node:fs';
import path from 'node:path';

// (а) «<название треда> ждёт ответа» · текст строки; (б) «<номер>: нужно твоё «да»» · метка · заголовок. (в) — без тостов.
// Вопрос (question / askUserQuestion) без uuid сообщения из журнала — хвост ещё не дочитан, ключ временный
// (sessionId + statusUpdatedAt) и через опрос сменится на sessionId + uuid: такой строке тост не даём, иначе их два
// (вердикт Голема на В8). Ожидание разрешения ключуется по statusUpdatedAt всегда — идёт как есть.
const NEEDS_MESSAGE = new Set(['question', 'askUserQuestion']);
export const TOASTS_PER_CYCLE = 3;
// EXT-37: строка «ждёт ответа» без открытого вопроса (askMissing, waiting.mjs) — тостом, только когда ворота
// createAskGate её подтвердили (confirmed); тихий цикл (silent) запоминает и её, чтобы после старта не было лавины.
// EXT-47: back — строки «вернулось: …» (отметка «Отложить» снята по сроку, defer.mjs sweep); отложенные (а) и (б) идут
// с quiet — ключ запоминается без показа: строку, отложенную раньше первого тоста, в срок встретит одно «вернулось»,
// а не ещё и «ждёт ответа».
export function toastRows(waiting, { confirmed = null, silent = false, back = [] } = {}) {
  const pass = (r) => (r.askMissing ? silent || !!confirmed?.has(r.key) : !NEEDS_MESSAGE.has(r.kind) || r.uuid);
  const a = (waiting?.threads ?? []).filter(pass).map((r) => ({ key: r.key, title: `${r.title || 'Тред'} ждёт ответа`, body: r.text ?? '' }));
  const b = (waiting?.yes ?? []).map((r) => ({ key: r.key, title: `${r.id}: нужно твоё «да»`, body: [r.mark, r.title].filter(Boolean).join(' · ') }));
  const quiet = (waiting?.deferred ?? []).filter((d) => d.group === 'thread' || d.group === 'yes').map((d) => ({ key: d.key, quiet: true }));
  return [...a, ...b, ...back, ...quiet].filter((r) => r.key);
}

// Ворота строки без открытого вопроса (EXT-37): ключ sessionId|statusUpdatedAt подтверждается, когда строка с ним
// стоит need циклов подряд (вопрос мог просто ещё не дописаться в журнал — тогда на следующем цикле у строки ключ
// вопроса, и тост один). see(waiting) — один цикл: счёт по строкам askMissing; строка пропала — счёт сброшен.
export function createAskGate({ need = 3 } = {}) {
  let counts = new Map();
  return {
    see(waiting) {
      const next = new Map();
      for (const r of waiting?.threads ?? []) if (r.askMissing && r.key) next.set(r.key, (counts.get(r.key) ?? 0) + 1);
      counts = next;
      return new Set([...counts].filter(([, n]) => n >= need).map(([k]) => k));
    },
  };
}

// notified.json: { keys: { <ключ>: <когда впервые увиден> } } — ключ, показанный (или увиденный тихим циклом), второй
// раз не показывается ни после рестарта, ни после сна. Запись — временный файл + rename (5). Битый файл — как пустой:
// первый цикл после старта тихий, лавины не будет. Больше TOASTS_PER_CYCLE свежих строк за цикл (проход зеркала по
// многим (б)) — первые три тостами, четвёртым «и ещё N — смотри витрину» (решение дирижёра); ключи пишутся все.
// onError(e, 'save' | 'show') — запись notified.json и показ тоста различаются в server.log.
export function createNotifier({ file, show, fs = nodeFs, now = () => Date.now(), onError = () => {} }) {
  let keys = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.keys === 'object' && j.keys) keys = j.keys;
  } catch { /* нет файла или битый — пустой набор */ }

  const save = () => {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ keys }, null, 1));
    fs.renameSync(tmp, file);
  };

  return {
    // silent — только запомнить ключи (первый цикл после старта и после пробуждения); возвращает число показанных
    cycle(rows, { silent = false } = {}) {
      const fresh = rows.filter((r) => r.key && !Object.hasOwn(keys, r.key));
      if (fresh.length === 0) return 0;
      const at = new Date(now()).toISOString();
      for (const r of fresh) keys[r.key] = at;
      try { save(); } catch (e) { onError(e, 'save'); }
      // quiet (отложенная строка, EXT-47) — только запомнить
      const loud = fresh.filter((r) => !r.quiet);
      if (silent || loud.length === 0) return 0;
      const over = loud.length - TOASTS_PER_CYCLE;
      const out = over > 0
        ? [...loud.slice(0, TOASTS_PER_CYCLE), { key: null, title: 'Экстрактор', body: `и ещё ${over} — смотри витрину` }]
        : loud;
      for (const r of out) { try { show(r); } catch (e) { onError(e, 'show'); } }
      return out.length;
    },
  };
}

// Пробуждение (5): скачок стенных часов между двумя тиками больше jumpMs (90 с = 3 × самый длинный опрос).
// Отрезки сна помнятся: «устарело» считает тишину без проспанного (slept).
export function createWake({ now = () => Date.now(), jumpMs = 90000 }) {
  let last = null;
  const sleeps = [];
  return {
    tick() {
      const t = now();
      const prev = last;
      last = t;
      if (prev == null || t - prev <= jumpMs) return null;
      sleeps.push({ from: prev, to: t });
      if (sleeps.length > 100) sleeps.shift();
      return { from: prev, to: t };
    },
    // сколько из отрезка [a, b] машина спала
    slept(a, b) {
      let s = 0;
      for (const z of sleeps) s += Math.max(0, Math.min(b, z.to) - Math.max(a, z.from));
      return s;
    },
  };
}

// Цикл уведомлений: до конца первого прохода читателей — молчит; первый цикл — тихий; на пробуждении — один полный
// цикл чтения (readAll), затем тихий цикл; тосты — со следующего. Часы смотрятся на каждом тике, даже когда цикл занят.
export function createNotifyLoop({ notifier, rows, readAll, wake }) {
  let ready = false;
  let busy = false;
  let woke = false;
  return {
    async start(firstPass) {
      await firstPass;
      notifier.cycle(rows({ silent: true }), { silent: true });
      ready = true;
    },
    async tick() {
      if (wake.tick()) woke = true;
      if (busy) return;
      busy = true;
      try {
        if (woke) {
          woke = false;
          const was = ready;
          ready = false;
          await readAll();
          // start() мог закончиться, пока шло чтение (пробуждение до конца первого прохода): он поставил ready —
          // его не терять, иначе тосты молчат до рестарта (вердикт Голема на В8)
          const nowReady = was || ready;
          if (nowReady) notifier.cycle(rows({ silent: true }), { silent: true });
          ready = nowReady;
          return;
        }
        if (ready) notifier.cycle(rows());
      } finally { busy = false; }
    },
  };
}
