// «Отложить до …» (EXT-47; спека пульта: таблица 1.3, §1.4, §1.1 п.3, §4.2): личная отметка Ивана на строке «Ждёт меня».
// POST /api/act {action: defer, intentId, rowKey, until} и {action: undefer, intentId, rowKey}; второго щелчка нет (А).
// Состояние нажатия — общее на страницу по ключу строки (rowKey): кнопка и строка исхода читают одно и то же.
// После ответа поток событий сам пришлёт changed — строка уйдёт в «Отложено» (или вернётся) при перечитывании.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { dm } from './format.js';
import { Summary } from './Ceh.jsx';
import { useOpen } from './prefs.js';

// пункты меню — спека (решено автором): местное время машины
export const UNTIL = [['1h', 'на 1 ч'], ['tomorrow9', 'завтра 9:00'], ['3days9', 'через 3 дня 9:00'], ['monday9', 'в понедельник 9:00']];
const OK_SHOWN_MS = 8000; // подтверждение «отложено до …» держится, пока строка уходит при перечитывании

/* ---------- состояние: rowKey → {phase, action, msg, payload} ---------- */
// phase: busy | ok | refused | error | net (нет связи — повтор тем же ключом намерения)
const acts = new Map();
const subs = new Set();
const timers = new Map();
const setAct = (key, v) => {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (v) acts.set(key, v); else acts.delete(key);
  if (v?.phase === 'ok') timers.set(key, setTimeout(() => { if (acts.get(key) === v) setAct(key, null); }, OK_SHOWN_MS));
  subs.forEach((f) => f());
};
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const useAct = (key) => useSyncExternalStore(subscribe, () => acts.get(key) ?? null);

async function send(payload) {
  const key = payload.rowKey;
  const { action } = payload;
  setAct(key, { phase: 'busy', action, payload });
  let r;
  try {
    r = await postAct(payload);
  } catch {
    setAct(key, { phase: 'net', action, payload, msg: 'нет связи с витриной — «повторить» пошлёт то же нажатие' });
    return;
  }
  if (r.status === 403) {
    if (reloadOn403(payload)) return;
    setAct(key, { phase: 'error', action, msg: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
    return;
  }
  clear403(payload.intentId);
  const b = r.body || {};
  const msg = b.message || (r.status === 503 ? 'пульт выключен' : `ошибка: HTTP ${r.status}`);
  const outcome = r.status === 200 ? b.outcome : r.status === 503 || r.status === 409 || r.status === 429 ? 'refused' : 'error';
  if (outcome === 'ok') setAct(key, { phase: 'ok', action, msg });
  else if (outcome === 'refused') setAct(key, { phase: 'refused', action, msg });
  else setAct(key, { phase: 'error', action, msg });
}

const fresh = (p) => ({ ...p, intentId: crypto.randomUUID() }); // новое намерение — новый ключ (§1.1 п.3)

// после перезагрузки на 403 — то же намерение тем же ключом; шлёт его кнопка той строки, когда она на экране (как Pult.jsx)
const resumed = new Set();
function resume403(action, rowKey) {
  const p = take403((x) => x.action === action && x.rowKey === rowKey);
  if (!p || resumed.has(p.intentId)) return;
  resumed.add(p.intentId);
  send(p);
}

/* ---------- кнопка «Отложить» и меню сроков ---------- */

export function DeferBtn({ rowKey }) {
  const st = useAct(rowKey);
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const first = useRef(0); // какой пункт получит фокус при открытии: 0 или последний (стрелка вверх)
  useEffect(() => { resume403('defer', rowKey); }, [rowKey]);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelectorAll('[role="menuitem"]')[first.current]?.focus();
    const out = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [open]);

  const busy = st?.phase === 'busy' && st.action === 'defer';
  const show = (at) => { first.current = at; setOpen(true); };
  const close = () => { setOpen(false); btn.current?.focus(); };
  const pick = (until) => { setOpen(false); btn.current?.focus(); send(fresh({ action: 'defer', rowKey, until })); };

  const onBtnKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); show(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); show(UNTIL.length - 1); }
  };
  const onMenuKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <span className="dfr">
      <button ref={btn} type="button" className="pbtn" disabled={busy} aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show(0))} onKeyDown={onBtnKey}>Отложить</button>
      {open && (
        <span className="dmenu" role="menu" aria-label="Отложить до" ref={menu} onKeyDown={onMenuKey}>
          {UNTIL.map(([v, label]) => (
            <button key={v} type="button" role="menuitem" tabIndex={-1} onClick={() => pick(v)}>{label}</button>
          ))}
        </span>
      )}
    </span>
  );
}

// исход нажатия строкой ниже: action — какое нажатие показывает это место (defer — строка «Ждёт меня», undefer — «Отложено»)
export function DeferNote({ rowKey, action = 'defer' }) {
  const st = useAct(rowKey);
  if (!st || st.action !== action) return null;
  const busyWord = action === 'defer' ? 'откладываю…' : 'возвращаю…';
  if (st.phase === 'busy') return <span className="dnote" role="status">{busyWord}</span>;
  if (st.phase === 'ok') return <span className="dnote" role="status">{st.msg}</span>;
  if (st.phase === 'refused') return <span className="dnote" role="status"><span className="pamb">отказ:</span> {st.msg}</span>;
  if (st.phase === 'net') {
    return (
      <span className="dnote pbad" role="status">
        {st.msg} <button type="button" className="pbtn" onClick={() => send(st.payload)}>повторить</button>
      </span>
    );
  }
  return <span className="dnote pbad" role="status">не вышло: {st.msg}</span>;
}

/* ---------- «Отложено: N» внизу «Ждёт меня» ---------- */

function DeferredRow({ d }) {
  const st = useAct(d.key);
  useEffect(() => { resume403('undefer', d.key); }, [d.key]);
  const busy = st?.phase === 'busy' && st.action === 'undefer';
  const thread = d.group === 'thread';
  return (
    <div className="wrow dl">
      <span className="src">{thread ? <span className="k">тред</span> : <span className="mono">{d.card}</span>}</span>
      <span className="tt">{d.label}{(thread || !d.card) && d.project && <span className="faint"> · <span className="mono">{d.project}</span></span>}</span>
      <span className="until num">до {dm(d.until)}</span>
      <button type="button" className="pbtn" disabled={busy} onClick={() => send(fresh({ action: 'undefer', rowKey: d.key }))}>вернуть сейчас</button>
      <DeferNote rowKey={d.key} action="undefer" />
    </div>
  );
}

export function Deferred({ list }) {
  const o = useOpen('grp-deferred', false);
  if (!list?.length) return null;
  return (
    <details className="grp dfd" open={o.open} onToggle={o.onToggle}>
      <Summary>Отложено <span className="cnt num">{list.length}</span></Summary>
      {list.map((d) => <DeferredRow key={d.key} d={d} />)}
    </details>
  );
}
