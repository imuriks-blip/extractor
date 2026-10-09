// Зеркало доски (EXT-42, EXT-75, EXT-77; спека пульта, таблица 1.3 «Прогони зеркало», §1.1 п.3, п.7, §1.7, §4.2):
// • ход и итог в шапке (MirrorStatus) — кнопки в шапке нет (EXT-77, слово Ивана 06.10 «перенеси кнопку обновить в
//   служебное»): ход любого прохода (GET /api/mirror раз в 4 с, только пока идёт), итог и красная пометка;
// • «Обновить» (RefreshMirror) — первой строкой меню «Служебное» в шапке (EXT-87, Service.jsx): POST /api/act {action: "mirror",
//   kind: "changed"}, обычный проход, без второго щелчка;
// • «Полный проход зеркала» (FullMirror) — там же второй строкой (решение Ивана 05.10): первый щелчок — цена,
//   подтверждение раскрывается в потоке под строкой внутри меню; запуск — вторым щелчком {kind: "full", confirm}; закрыл меню —
//   подтверждение сброшено (dropConfirm).
// Состояние общее (один проход зеркала на витрину): хранится здесь, вне React; опрос, повтор после 403 и «дотянуть» держит
// MirrorStatus — он смонтирован в шапке на всех экранах (на «Расходе» — тоже, EXT-87: меню там то же), «дотянуть» у
// «Принять»/«Вернуть» работает везде.
// Пульт выключен: флага в данных нет — узнаётся по первому 503 и запоминается на запуск сервера (токен страницы новый на
// каждый запуск, флаг pult.enabled читается при старте), кнопки до перезапуска витрины не показываются.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { dm, hm } from './format.js';
import { isRefusal, phaseWord, pressPlace, pullAnswer, readMirror, refusalNote, runResult } from './mirrorData.js';
import { clear403, postAct, reloadOn403, setPuller, store, take403, token, tokenMark as mark } from './act.js';

const POLL_MS = 4000;
const OFF_KEY = 'vitrina.pultOff'; // отпечаток токена запуска сервера, на котором пульт ответил 503
const HINT = 'прогнать зеркало доски: свежие карточки из Plane (обычный проход, несколько минут)';
const FULL_HINT = 'вся доска заново из Plane; сначала покажет цену и спросит подтверждение';
const CONFIRM_MS = 5 * 60000; // подтверждение живёт 5 мин (спека пульта §1.1 п.7)

// ---------- общее состояние ----------
// phase: idle | asking (первый щелчок «полный») | pending | running | off; kind — вид последнего нажатия (changed | full);
// st — последний ответ /api/mirror; note — пометка нажатия {text, title, kind}: видна у той кнопки, чьё нажатие, — в
// «Служебном»; cf — подтверждение полного {id, c, until}; here — ход в шапке смонтирован (он держит опрос);
// svc — блок «Служебное» раскрыт; src — откуда последнее нажатие ('button' | 'pull' — «дотянуть»). Где виден исход
// нажатия («запускаю…», пометка, «пульт выключен») — у строки или в шапке — решает pressPlace (mirrorData.js): «дотянуть» —
// всегда в шапке, кнопка «Обновить» — у строки, пока блок раскрыт; показ всегда в одном месте
let S = null;
const subs = new Set();
const get = () => (S ??= {
  phase: 'idle', kind: null, src: 'button', st: null, note: null, cf: null, here: false, svc: false,
  off: (() => { const t = token(); return !!t && store.get(localStorage, OFF_KEY) === mark(t); })(),
});
const set = (p) => { S = { ...get(), ...(typeof p === 'function' ? p(get()) : p) }; subs.forEach((f) => f()); };
const sub = (f) => { subs.add(f); return () => subs.delete(f); };
const useMirror = () => useSyncExternalStore(sub, get);

let intent = null; // ключ намерения без ответа (сбой сети) — повтор нажатием с тем же ключом
let offTimer = null;
let cfTimer = null;
// подтверждение живёт 5 мин; просрочено — закрывается само
function setCf(cf) {
  clearTimeout(cfTimer);
  if (cf) cfTimer = setTimeout(() => set({ cf: null }), Math.max(0, cf.until - Date.now()));
  set({ cf });
}

// закрыли меню «Служебное» — ждущее подтверждение полного прохода сбрасывается (спека витрины §2.11)
export function dropConfirm() { if (get().cf) setCf(null); }

async function check() {
  try {
    const m = await readMirror();
    set((s) => ({ st: m, phase: s.phase === 'pending' || s.phase === 'asking' || s.phase === 'off' ? s.phase : m.running ? 'running' : 'idle' }));
    return m;
  } catch { return null; }
}

// payload: {action:'mirror', intentId, kind[, confirm]}; повтор прерванного намерения — тем же payload.
// src — откуда нажатие ('button' | 'pull'); в payload не идёт — серверу оно не нужно
async function send(payload, src = 'button') {
  intent = payload;
  const kind = payload.kind;
  const first = kind === 'full' && !payload.confirm;
  const keepCf = payload.confirm ? get().cf : null; // окно «как было»: при сбое сети второго щелчка оно возвращается
  set({ phase: first ? 'asking' : 'pending', kind, src, note: null });
  if (payload.confirm) setCf(null); // второй щелчок ушёл — подтверждение снято
  const fail = (text, title) => set({ phase: 'idle', note: { text, title, kind } });
  let r;
  try {
    r = await postAct(payload);
  } catch {
    if (keepCf) setCf(keepCf);
    fail('нет связи', 'витрина не ответила — нажми ещё раз, повтор того же нажатия');
    return;
  }
  const body = r.body;
  intent = null;
  if (r.status === 403) {
    // §4.2: токен на запуск сервера — одна перезагрузка страницы, второй 403 подряд — отказ
    if (reloadOn403(payload)) return;
    fail('пульт отказал, перезапусти витрину', 'ответ 403 дважды подряд');
    return;
  }
  clear403(payload.intentId);
  if (r.status === 503) {
    store.set(localStorage, OFF_KEY, mark(token()));
    set({ phase: 'off' });
    clearTimeout(offTimer);
    offTimer = setTimeout(() => set({ off: true }), 6000);
    return;
  }
  if (r.status === 200 && body?.outcome === 'need-confirm' && body.confirm) {
    // первый щелчок «полный»: цена из confirm.follows; запускать — только вторым щелчком (§1.1 п.7)
    setCf({ id: body.id, c: body.confirm, until: Date.now() + CONFIRM_MS });
    set({ phase: 'idle' });
    return;
  }
  setCf(null);
  if (body?.outcome === 'refused' && !isRefusal(body, 'mirror-running')) {
    // у полного отказ подтверждения (чужое, потраченное, просроченное) — нажать заново; прочие отказы — причина в подсказке
    const n = refusalNote(kind, body);
    fail(n.text, n.title);
    return;
  }
  if ((r.status >= 200 && r.status < 300) || (r.status === 409 && body?.outcome === 'refused')) {
    set({ phase: 'running' }); // «уже идёт» — не ошибка: показываем ход того прохода
    check();
    return;
  }
  fail('ошибка', body?.message || `ошибка: HTTP ${r.status}`);
}

// kind: 'changed' | 'full'; confirm — id первого щелчка «полный». Прерванное сбоем сети нажатие повторяется тем же ключом
function press(kind = 'changed', confirm, src = 'button') {
  const prev = intent;
  const same = prev && prev.kind === kind && prev.confirm === confirm;
  return send(same ? prev : { action: 'mirror', intentId: crypto.randomUUID(), kind, ...(confirm ? { confirm } : {}) }, src);
}

// ---------- ход и итог в шапке ----------
// label — подпись зеркала из /api/ceh: сменилась (проход закончился или начат Планировщиком) — ход перечитывается
export default function MirrorStatus({ label }) {
  const s = useMirror();
  const resent = useRef(false);

  useEffect(() => { set({ here: true }); return () => set({ here: false }); }, []);
  useEffect(() => { if (!s.off) check(); }, [s.off, label]);

  // опрос — только пока идёт
  useEffect(() => {
    if (s.phase !== 'running') return undefined;
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [s.phase]);

  // после перезагрузки на 403 — то же намерение тем же ключом и в том же виде (§1.1 п.3); «Принять»/«Вернуть» — не наше
  useEffect(() => {
    if (resent.current || s.off) return;
    resent.current = true;
    const prev = take403((p) => p.action === 'mirror');
    if (prev) send(prev);
  }, [s.off]);

  // «дотянуть» у «Принять»/«Вернуть» (таблица 1.3) — то же нажатие, что «Обновить»; пока пульт не выключен и проход свободен
  // исход такого нажатия — всегда в шапке (src 'pull', pressPlace)
  useEffect(() => (s.off ? undefined : setPuller(() => {
    const r = pullAnswer(get().phase);
    if (r === 'started') press('changed', undefined, 'pull');
    return r;
  })), [s.off]);

  if (s.off) return null;
  const inHeader = pressPlace(s) === 'header';
  if (s.phase === 'off') return inHeader ? <span className="mbtn-off faint" role="status">пульт выключен</span> : null;

  const { phase, st } = s;
  const running = phase === 'running';
  const nums = running && Number.isFinite(st?.cardsDone) && Number.isFinite(st?.cardsTotal);
  // ход зеркала (таблица 1.3): фаза, N из M, запросов, темп, с какого времени — из GET /api/mirror
  const prog = running ? [
    st?.phase && (nums ? `${phaseWord(st.phase)} ${st.cardsDone} из ${st.cardsTotal}` : phaseWord(st.phase)),
    Number.isFinite(st?.requests) && `${st.requests} запросов`,
    Number.isFinite(st?.rpm) && `${st.rpm}/мин`,
    st?.startedAt && `с ${hm(st.startedAt)}`,
  ].filter(Boolean) : [];
  const runTitle = running
    ? ['зеркало идёт', st?.kind, st?.phase && `фаза ${st.phase}`, Number.isFinite(st?.requests) && `запросов ${st.requests}`, Number.isFinite(st?.rpm) && `${st.rpm}/мин`].filter(Boolean).join(' · ')
    : HINT;
  const res = !running && phase === 'idle' ? runResult(st) : null;
  // исход нажатия — здесь или у строки в «Служебном», не в обоих местах (pressPlace)
  const note = inHeader && s.note?.kind !== 'full' ? s.note : null;
  const starting = phase === 'pending' && s.kind !== 'full' && inHeader;
  const err = note ?? (!running && phase !== 'pending' && res?.red ? res
    : !running && phase !== 'pending' && st?.lastError ? { text: 'ошибка', title: `последний проход зеркала: ${st.lastError}` } : null);
  const quiet = !running && !err && res && !res.red ? res : null; // зелёный итог — серым, не красным
  if (!running && !starting && !quiet && !err) return null;
  return (
    <span className="mst">
      {starting && <span className="mrun" role="status">зеркало: запускаю…</span>}
      {running && <span className="mrun" role="status" title={runTitle}>{st?.kind === 'full' ? 'полный проход идёт' : 'зеркало идёт'}{prog.length > 0 && <> · <span className="num">{prog.join(' · ')}</span></>}</span>}
      {quiet && <span className="mrun mres num" role="status" title={quiet.title}>{quiet.text}</span>}
      {err && <span className="mbtn-note" role="status" title={err.title}>{err.text}</span>}
    </span>
  );
}

// ---------- «Обновить» в «Служебном» ----------
// первая строка блока: кнопка обычного прохода и рядом — что с ним; ход — в шапке, здесь только «идёт — ход вверху».
// shown — блок «Служебное» раскрыт: пока строка видна, пометки нажатия — здесь, а не в шапке
export function RefreshMirror({ shown }) {
  const s = useMirror();
  useEffect(() => { set({ svc: shown }); return () => set({ svc: false }); }, [shown]);
  if (!s.here || s.off) return null;
  const { phase, st } = s;
  const running = phase === 'running';
  const inRow = pressPlace(s) === 'row' && s.kind !== 'full'; // исход нажатия «Обновить» — здесь, а не в шапке
  const note = inRow && s.note && s.note.kind !== 'full' ? s.note : null;
  const text = phase === 'pending' && s.kind !== 'full' ? 'запускаю…' : running ? 'идёт…' : 'Обновить';
  const line = phase === 'off' ? (inRow ? { cls: 'faint', text: 'пульт выключен' } : null)
    : running && st?.kind !== 'full' ? { cls: 'going', text: 'зеркало идёт — ход вверху' }
    : note ? { cls: 'pbad', text: note.text, title: note.title }
    : !running && phase !== 'pending' ? { cls: 'faint', text: 'свежее из Plane, несколько минут' } : null;
  return (
    <div className="wtb">
      <button type="button" className="pbtn" disabled={phase !== 'idle'} title={running ? 'зеркало уже идёт — ход в шапке' : HINT} onClick={() => press()}>{text}</button>
      {line && <span className={line.cls} role="status" title={line.title}>{line.text}</span>}
    </div>
  );
}

// ---------- «Полный проход зеркала» в «Служебном» ----------
// строка блока: кнопка и рядом — когда был последний полный (lastFullOk) или пометка нажатия; подтверждение — под строкой,
// в потоке (сдвигает содержимое ниже, ничего не накрывает); ход прохода — в шапке, здесь только «идёт — ход вверху»
export function FullMirror() {
  const s = useMirror();
  const btn = useRef(null);
  if (!s.here || s.off || s.phase === 'off') return null;
  const { phase, st, cf } = s;
  const running = phase === 'running';
  const note = s.note?.kind === 'full' ? s.note : null;
  const closeCf = () => { setCf(null); btn.current?.focus(); };
  // идёт обычный — строка «идёт» у «Обновить», здесь только недоступная кнопка
  const line = running ? (st?.kind === 'full' ? { cls: 'going', text: 'полный проход идёт — ход вверху' } : null)
    : phase === 'pending' && s.kind === 'full' ? { cls: 'going', text: 'запускаю…' }
    : note ? { cls: 'pbad', text: note.text, title: note.title }
    : st?.lastFullOk ? { cls: 'muted', text: `последний полный — ${dm(st.lastFullOk)}` }
    : st ? { cls: 'faint', text: 'полного прохода ещё не было' } : null;
  return (
    <div className="wtb">
      <button type="button" className="pbtn" ref={btn} disabled={phase !== 'idle'} aria-expanded={!!cf} title={running ? 'зеркало уже идёт — ход в шапке' : FULL_HINT}
        onClick={() => (cf ? closeCf() : press('full'))}>{phase === 'asking' ? 'спрашиваю…' : 'Полный проход зеркала'}</button>
      {line && <span className={line.cls} role="status" title={line.title}>{line.text}</span>}
      {cf && (
        <div className="cfm" role="group" aria-label={`Подтверждение: ${cf.c.what}`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCf(); } }}>
          <span className="h">{cf.c.what}</span>{cf.c.follows}
          {cf.c.mirrorAt && <span className="faint"> Сейчас зеркало от {dm(cf.c.mirrorAt)}.</span>}
          <span className="row">
            {/* фокус после раскрытия — на «отмена»: автоповтор Enter на «Полный проход зеркала» не нажимает запуск */}
            <button type="button" className="pbtn pmain" onClick={() => press('full', cf.id)}>запустить полный</button>
            <button type="button" className="pbtn" autoFocus onClick={closeCf}>отмена</button>
            <span className="tmr num">действует до {hm(new Date(cf.until).toISOString())}</span>
          </span>
        </div>
      )}
    </div>
  );
}
