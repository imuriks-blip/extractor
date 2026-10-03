// «Принять» и «Вернуть» (EXT-43; спека пульта: таблица 1.3, §1.1 п.3 и п.10, §1.4, §3.2, §4.2): в строке (в)
// «Готово, посмотри» и в панели карточки в Review. POST /api/act {action, intentId, card, q, text?}; q — готовый из данных.
// Состояние нажатия — общее на страницу по номеру карточки: строка и панель одной карточки показывают одно и то же.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { canPull, clear403, postAct, pull, reloadOn403, take403 } from './act.js';

const TEXT_MAX = 500;

/* ---------- состояние нажатий: card → {phase, action, msg, payload, intentId} ---------- */
// phase: busy | ok | partial | refused | error | net (нет связи — повтор тем же ключом)
const acts = new Map();
const subs = new Set();
const setAct = (card, v) => { if (v) acts.set(card, v); else acts.delete(card); subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const useAct = (card) => useSyncExternalStore(subscribe, () => acts.get(card) ?? null);

async function send(payload) {
  const { card } = payload;
  setAct(card, { phase: 'busy', action: payload.action, payload });
  let r;
  try {
    r = await postAct(payload);
  } catch {
    setAct(card, { phase: 'net', action: payload.action, payload, msg: 'нет связи с витриной — «повторить» пошлёт то же нажатие' });
    return;
  }
  if (r.status === 403) {
    if (reloadOn403(payload)) return;
    setAct(card, { phase: 'error', action: payload.action, msg: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
    return;
  }
  clear403();
  const b = r.body || {};
  if (r.status === 503) { setAct(card, { phase: 'refused', action: payload.action, msg: b.message || 'пульт выключен' }); return; }
  const outcome = r.status === 200 ? b.outcome : r.status === 409 || r.status === 429 ? 'refused' : 'error';
  const msg = b.message || `ошибка: HTTP ${r.status}`;
  if (outcome === 'ok') setAct(card, { phase: 'ok', action: payload.action, msg });
  else if (outcome === 'partial') setAct(card, { phase: 'partial', action: payload.action, msg, payload });
  else if (outcome === 'refused') setAct(card, { phase: 'refused', action: payload.action, msg, pull: b.pull === true });
  else setAct(card, { phase: 'error', action: payload.action, msg });
}

// новое намерение — новый ключ (§1.1 п.3); «повторить» после partial — тоже новый: сервер сам зовёт только state
const fresh = (p) => ({ ...p, intentId: crypto.randomUUID() });

// после перезагрузки на 403 — то же намерение тем же ключом; один раз на загрузку страницы
let resumed = false;
function resume403() {
  if (resumed) return;
  resumed = true;
  const p = take403((x) => x.action === 'accept' || x.action === 'return');
  if (p?.card) send(p);
}

/* ---------- вид ---------- */

function ReturnForm({ onSend, onCancel }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const ok = text.trim().length > 0;
  const submit = (e) => { e.preventDefault(); if (ok) onSend(text.trim()); };
  return (
    <form className="pret" onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <textarea ref={ref} rows={2} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)}
        aria-label="Причина возврата" placeholder="Причина: что доделать" />
      <span className="pret-row">
        <button type="submit" className="pbtn" disabled={!ok}>вернуть</button>
        <button type="button" className="pbtn" onClick={onCancel}>отмена</button>
        <span className="pcnt num" aria-live="polite">{text.length}/{TEXT_MAX}</span>
      </span>
    </form>
  );
}

// Отметка §3.2 из данных: «принято · Done в Plane ЧЧ:ММ · зеркало ещё не видело»; missing — красная
export function PultMark({ m }) {
  if (!m) return null;
  return (
    <span className="pmark">
      {m.text}
      {m.missing && <span className="pbad"> · зеркало не видит запись <span className="mono">{m.id}</span></span>}
    </span>
  );
}

// card, q (null — кнопок нет), accept {can, why, hint}, mark — местная отметка из данных (есть — кнопок нет, видна она)
export default function Pult({ card, q, accept, mark }) {
  const st = useAct(card);
  const [form, setForm] = useState(false);
  const retBtn = useRef(null);
  const backFocus = useRef(false);
  useEffect(resume403, []);
  useEffect(() => { if (!form && backFocus.current) { backFocus.current = false; retBtn.current?.focus(); } }, [form]);

  const phase = st?.phase;
  const busy = phase === 'busy';
  // отметка из данных пришла — нажатие исполнено; свежий исход (ok/partial/…) — до неё
  if (mark && (!st || phase === 'ok')) return <div className="pult"><PultMark m={mark} /></div>;
  if (!q && !st) return null;
  if (phase === 'ok') return <div className="pult"><span className="pmark" role="status">{st.msg}</span></div>;

  const press = (action, text) => {
    setForm(false);
    send(fresh({ action, card, q, ...(text != null ? { text } : {}) }));
  };
  const close = () => { backFocus.current = true; setForm(false); };

  let note = null;
  if (busy) note = <span className="pnote" role="status">записываю в Plane…</span>;
  else if (phase === 'partial') {
    note = (
      <span className="pnote pamb" role="status">
        частично: запись есть, статус не сменился —{' '}
        <button type="button" className="pbtn" onClick={() => send(fresh(st.payload))}>повторить</button>
      </span>
    );
  } else if (phase === 'net') {
    note = (
      <span className="pnote pbad" role="status">
        {st.msg} <button type="button" className="pbtn" onClick={() => send(st.payload)}>повторить</button>
      </span>
    );
  } else if (phase === 'refused') {
    note = (
      <span className="pnote" role="status">
        <span className="pamb">отказ:</span> {st.msg}
        {st.pull && canPull() && <> <button type="button" className="pbtn" onClick={() => { pull(); setAct(card, null); }}>дотянуть</button></>}
      </span>
    );
  } else if (phase === 'error') {
    note = <span className="pnote pbad" role="status">не вышло: {st.msg}</span>;
  }

  const canAccept = accept?.can === true;
  const hint = accept?.can === false && accept.hint;
  return (
    <div className="pult">
      {/* partial и «нет связи» — действие уже начато: вместо кнопок одно «повторить» */}
      {q && phase !== 'partial' && phase !== 'net' && (
        <span className="pbtns">
          {canAccept && <button type="button" className="pbtn pmain" disabled={busy || form} onClick={() => press('accept')}>Принять</button>}
          <button ref={retBtn} type="button" className="pbtn" disabled={busy} aria-expanded={form}
            onClick={() => (form ? close() : setForm(true))}>Вернуть</button>
        </span>
      )}
      {q && hint && !note && <span className="phint">{hint}</span>}
      {note}
      {form && !busy && <ReturnForm onSend={(t) => press('return', t)} onCancel={close} />}
    </div>
  );
}
