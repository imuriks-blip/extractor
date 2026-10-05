// Кнопка «Обновить» в шапке (EXT-42; спека пульта, таблица 1.3 «Прогони зеркало», §1.1 п.3, §1.7, §4.2):
// POST /api/act {action: "mirror", kind: "changed"} — обычный проход зеркала; ход — GET /api/mirror раз в 4 с, только пока
// идёт. Итог — подпись «доска: зеркало Plane от …» обновится сама (она из /api/ceh); сбой прохода — красная пометка.
// Пульт выключен: флага в данных нет — узнаётся по первому 503 и запоминается на запуск сервера (токен страницы новый на
// каждый запуск, флаг pult.enabled читается при старте), кнопка до перезапуска витрины не показывается.
import { useCallback, useEffect, useRef, useState } from 'react';
import { dm, hm } from './format.js';
import { isRefusal, phaseWord, readMirror, runResult } from './mirrorData.js';
import { clear403, postAct, reloadOn403, setPuller, store, take403, token, tokenMark as mark } from './act.js';

const POLL_MS = 4000;
const OFF_KEY = 'vitrina.pultOff'; // отпечаток токена запуска сервера, на котором пульт ответил 503
const HINT = 'прогнать зеркало доски: свежие карточки из Plane (обычный проход, несколько минут)';
const FULL_HINT = 'полный проход зеркала: вся доска заново, спросит подтверждение с ценой';
const CONFIRM_MS = 5 * 60000; // подтверждение живёт 5 мин (спека пульта §1.1 п.7)

// label — подпись зеркала из /api/ceh: сменилась (проход закончился или начат Планировщиком) — ход перечитывается
export default function MirrorButton({ label }) {
  const [off, setOff] = useState(() => { const t = token(); return !!t && store.get(localStorage, OFF_KEY) === mark(t); });
  const offTimer = useRef(null);
  useEffect(() => () => clearTimeout(offTimer.current), []);
  const [phase, setPhase] = useState('idle'); // idle | asking (первый щелчок «полный») | pending | running | off
  const [st, setSt] = useState(null); // последний ответ /api/mirror
  const [note, setNote] = useState(null); // красная пометка {text, title}
  const [cf, setCf] = useState(null); // второй щелчок «полный»: {id, c: confirm из ответа, until}
  const intent = useRef(null); // ключ намерения без ответа (сбой сети) — повтор нажатием с тем же ключом
  const resent = useRef(false);
  const fullBtn = useRef(null);
  const cfRef = useRef(null); // окно подтверждения «как было»: при сбое сети второго щелчка оно возвращается (повтор тем же ключом)
  cfRef.current = cf;

  const check = useCallback(async () => {
    try {
      const m = await readMirror();
      setSt(m);
      setPhase((p) => (p === 'pending' || p === 'asking' || p === 'off' ? p : m.running ? 'running' : 'idle'));
      return m;
    } catch { return null; }
  }, []);

  useEffect(() => { if (!off) check(); }, [off, label, check]);

  // опрос — только пока идёт
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [phase, check]);

  // подтверждение живёт 5 мин; просрочено — окно закрывается само
  useEffect(() => {
    if (!cf) return undefined;
    const t = setTimeout(() => setCf(null), Math.max(0, cf.until - Date.now()));
    return () => clearTimeout(t);
  }, [cf]);

  // payload: {action:'mirror', intentId, kind[, confirm]}; reuse — прерванное намерение целиком (повтор тем же ключом)
  const send = useCallback(async (payload) => {
    intent.current = payload;
    const first = payload.kind === 'full' && !payload.confirm;
    setPhase(first ? 'asking' : 'pending');
    setNote(null);
    const keepCf = payload.confirm ? cfRef.current : null;
    if (payload.confirm) setCf(null); // второй щелчок ушёл — окно подтверждения снято
    let r;
    try {
      r = await postAct(payload);
    } catch {
      setPhase('idle');
      if (keepCf) setCf(keepCf);
      setNote({ text: 'нет связи', title: 'витрина не ответила — нажми ещё раз, повтор того же нажатия' });
      return;
    }
    const body = r.body;
    intent.current = null;
    if (r.status === 403) {
      // §4.2: токен на запуск сервера — одна перезагрузка страницы, второй 403 подряд — отказ
      if (reloadOn403(payload)) return;
      setPhase('idle');
      setNote({ text: 'пульт отказал, перезапусти витрину', title: 'ответ 403 дважды подряд' });
      return;
    }
    clear403(payload.intentId);
    if (r.status === 503) {
      store.set(localStorage, OFF_KEY, mark(token()));
      setPhase('off');
      offTimer.current = setTimeout(() => setOff(true), 6000);
      return;
    }
    if (r.status === 200 && body?.outcome === 'need-confirm' && body.confirm) {
      // первый щелчок «полный»: цена из confirm.follows; запускать — только вторым щелчком (§1.1 п.7)
      setCf({ id: body.id, c: body.confirm, until: Date.now() + CONFIRM_MS });
      setPhase('idle');
      return;
    }
    setCf(null);
    if (body?.outcome === 'refused' && !isRefusal(body, 'mirror-running')) {
      // подтверждение чужое, потраченное или просроченное — просто нажать «полный» заново
      setPhase('idle');
      setNote({ text: 'нажми «полный» ещё раз', title: body.message || 'подтверждение не годится' });
      return;
    }
    if ((r.status >= 200 && r.status < 300) || (r.status === 409 && body?.outcome === 'refused')) {
      setPhase('running'); // «уже идёт» — не ошибка: показываем ход того прохода
      check();
      return;
    }
    setPhase('idle');
    setNote({ text: 'ошибка', title: body?.message || `ошибка: HTTP ${r.status}` });
  }, [check]);

  // kind: 'changed' | 'full'; confirm — id первого щелчка «полный». Прерванное сбоем сети нажатие повторяется тем же ключом
  const press = useCallback((kind = 'changed', confirm) => {
    const prev = intent.current;
    const same = prev && prev.kind === kind && prev.confirm === confirm;
    return send(same ? prev : { action: 'mirror', intentId: crypto.randomUUID(), kind, ...(confirm ? { confirm } : {}) });
  }, [send]);

  // после перезагрузки на 403 — то же намерение тем же ключом и в том же виде (§1.1 п.3); «Принять»/«Вернуть» — не наше
  useEffect(() => {
    if (resent.current || off) return;
    resent.current = true;
    const prev = take403((p) => p.action === 'mirror');
    if (prev) send(prev);
  }, [off, send]);

  // «дотянуть» у «Принять»/«Вернуть» (таблица 1.3) — эта же кнопка; пока она видна и свободна
  const pressRef = useRef(press);
  pressRef.current = press;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => (off ? undefined : setPuller(() => {
    if (phaseRef.current === 'idle') { pressRef.current(); return 'started'; }
    return phaseRef.current === 'off' ? 'off' : 'busy';
  })), [off]);

  if (off) return null;
  if (phase === 'off') return <span className="mbtn-off faint" role="status">пульт выключен</span>;

  const running = phase === 'running';
  const nums = running && Number.isFinite(st?.cardsDone) && Number.isFinite(st?.cardsTotal);
  const text = phase === 'pending' ? 'запускаю…' : running ? 'идёт…' : 'Обновить';
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
  const err = note ?? (!running && phase !== 'pending' && res?.red ? res
    : !running && phase !== 'pending' && st?.lastError ? { text: 'ошибка', title: `последний проход зеркала: ${st.lastError}` } : null);
  const quiet = !running && !err && res && !res.red ? res : null; // зелёный итог — серым, не красным
  const closeCf = () => { setCf(null); fullBtn.current?.focus(); };
  return (
    <span className="mbtn">
      <button type="button" className={running ? 'num' : undefined} disabled={phase !== 'idle'} title={runTitle} onClick={() => press()}>{text}</button>
      {!running && phase !== 'pending' && (
        <button type="button" ref={fullBtn} disabled={phase !== 'idle'} aria-expanded={!!cf} title={FULL_HINT}
          onClick={() => (cf ? closeCf() : press('full'))}>{phase === 'asking' ? 'спрашиваю…' : 'полный'}</button>
      )}
      {running && <span className="mrun" role="status">{st?.kind === 'full' ? 'полный проход идёт' : 'зеркало идёт'}{prog.length > 0 && <> · <span className="num">{prog.join(' · ')}</span></>}</span>}
      {quiet && <span className="mrun mres num" role="status" title={quiet.title}>{quiet.text}</span>}
      <span className="mbtn-note" role="status" title={err?.title}>{err?.text}</span>
      {cf && (
        <div className="cfm mcfm" role="group" aria-label={`Подтверждение: ${cf.c.what}`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCf(); } }}>
          <span className="h">{cf.c.what}</span>{cf.c.follows}
          {cf.c.mirrorAt && <span className="faint"> Сейчас зеркало от {dm(cf.c.mirrorAt)}.</span>}
          <span className="row">
            <button type="button" className="pbtn pmain" autoFocus onClick={() => press('full', cf.id)}>запустить полный</button>
            <button type="button" className="pbtn" onClick={closeCf}>отмена</button>
            <span className="tmr num">действует до {hm(new Date(cf.until).toISOString())}</span>
          </span>
        </div>
      )}
    </span>
  );
}
