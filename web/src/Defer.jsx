// «Отложить до …» (EXT-47; спека пульта: таблица 1.3, §1.4, §1.1 п.3, §4.2): личная отметка Ивана на строке «Ждёт меня».
// POST /api/act {action: defer, intentId, rowKey, until} и {action: undefer, intentId, rowKey}; второго щелчка нет (А).
// Пункты меню — deferOptions сервера [{until, label, at}]: until шлётся как есть, at — серой датой (в браузере не считаем).
// Состояние нажатия — общее на страницу по ключу строки (rowKey): кнопка и строка исхода читают одно и то же.
// После ответа поток событий сам пришлёт changed — строка уйдёт в «Отложено» (или вернётся) при перечитывании.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { clear403, postAct, reloadOn403, store, take403, token, tokenMark } from './act.js';
import { dd, dm, hm } from './format.js';
import { Summary } from './Summary.jsx';
import { useOpen } from './prefs.js';

const OK_SHOWN_MS = 8000; // подтверждение «отложено до …» держится, пока строка уходит при перечитывании
// пульт выключен: тот же признак, что у «Обновить» (Mirror.jsx) — отпечаток токена запуска, на котором пришёл 503
const OFF_KEY = 'vitrina.pultOff';
const pultOff = () => { const t = token(); return !!t && store.get(localStorage, OFF_KEY) === tokenMark(t); };

/* ---------- состояние: rowKey → {phase, action, msg, payload} ---------- */
// phase: busy | ok | refused | error | net (нет связи — повтор тем же ключом намерения)
const acts = new Map();
const subs = new Set();
const timers = new Map();
let off = pultOff();
// удачно отложено — фокус на заголовок «Отложено», как только блок есть (М10); scroll — нажато с клавиатуры
let focusAfter = null;
let focusTick = 0;
const ping = () => subs.forEach((f) => f());
const setAct = (key, v) => {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (v) acts.set(key, v); else acts.delete(key);
  if (v?.phase === 'ok') timers.set(key, setTimeout(() => { if (acts.get(key) === v) setAct(key, null); }, OK_SHOWN_MS));
  ping();
};
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const useAct = (key) => useSyncExternalStore(subscribe, () => acts.get(key) ?? null);
const useOff = () => useSyncExternalStore(subscribe, () => off);
const useFocusTick = () => useSyncExternalStore(subscribe, () => focusTick);

async function send(payload, opts = {}) {
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
  if (r.status === 503) { // пульт выключен: запоминаем на запуск сервера — кнопки «Отложить» больше не показываются
    store.set(localStorage, OFF_KEY, tokenMark(token()));
    off = true;
  }
  const msg = b.message || (r.status === 503 ? 'пульт выключен' : `ошибка: HTTP ${r.status}`);
  const outcome = r.status === 200 ? b.outcome : r.status === 503 || r.status === 409 || r.status === 429 ? 'refused' : 'error';
  if (outcome === 'ok') {
    if (action === 'defer') { focusAfter = { scroll: opts.keyboard === true }; focusTick++; }
    setAct(key, { phase: 'ok', action, msg });
  } else if (outcome === 'refused') setAct(key, { phase: 'refused', action, msg });
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

// серая подпись пункта из at сервера: у «на 1 ч» — время возврата («12:54», через полночь — «05.10 00:30»),
// у пунктов «… 9:00» — только дата («07.10»): время уже в подписи
const whenOf = (o) => (o.until === '1h' ? hm(o.at) : dd(o.at));

// options — deferOptions сервера; name — что за строка, для экранного чтеца («Отложить: EXT-23»)
export function DeferBtn({ rowKey, options, name }) {
  const st = useAct(rowKey);
  const isOff = useOff();
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const first = useRef(0); // какой пункт получит фокус при открытии: 0 или последний (стрелка вверх)
  const id = useId();
  useEffect(() => { resume403('defer', rowKey); }, [rowKey]);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelectorAll('[role="menuitem"]')[first.current]?.focus();
    const out = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [open]);

  if (isOff || !options?.length) return null;
  const busy = st?.phase === 'busy' && st.action === 'defer';
  const show = (at) => { first.current = at; setOpen(true); };
  const close = () => { setOpen(false); btn.current?.focus(); };
  // e.detail === 0 — пункт нажат с клавиатуры (Enter/Пробел), не мышью
  const pick = (until, e) => { setOpen(false); btn.current?.focus(); send(fresh({ action: 'defer', rowKey, until }), { keyboard: e.detail === 0 }); };

  const onBtnKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); show(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); show(options.length - 1); }
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
        aria-controls={open ? id : undefined} aria-label={name ? `Отложить: ${name}` : undefined}
        onClick={() => (open ? setOpen(false) : show(0))} onKeyDown={onBtnKey}>Отложить</button>
      {open && (
        <span className="dmenu" id={id} role="menu" aria-label="Отложить до" ref={menu} onKeyDown={onMenuKey}>
          {options.map((o) => (
            <button key={o.until} type="button" role="menuitem" tabIndex={-1} onClick={(e) => pick(o.until, e)}>
              {o.label}{o.at && <span className="dwhen num"> · {whenOf(o)}</span>}
            </button>
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
  // message сервера при сбое записи отметки уже начинается с «не вышло:» — не удваиваем
  return <span className="dnote pbad" role="status">{/^не вышло/.test(st.msg) ? st.msg : `не вышло: ${st.msg}`}</span>;
}

/* ---------- «Отложено N» внизу «Ждёт меня» (на «Цехе» и в окне проекта) ---------- */

function DeferredRow({ d, flat }) {
  const st = useAct(d.key);
  useEffect(() => { resume403('undefer', d.key); }, [d.key]);
  const busy = st?.phase === 'busy' && st.action === 'undefer';
  const thread = d.group === 'thread';
  return (
    <div className={flat ? 'wrow dl flat' : 'wrow dl'}>
      <span className="src">{thread ? <span className="k">тред</span> : <span className="mono">{d.card}</span>}</span>
      <span className="tt">{d.label}{!flat && (thread || !d.card) && d.project && <span className="faint"> · <span className="mono">{d.project}</span></span>}</span>
      <span className="until num">до {dm(d.until)}</span>
      <button type="button" className="pbtn" disabled={busy} aria-label={`Вернуть сейчас: ${thread ? `тред ${d.label}` : d.card}`}
        onClick={() => send(fresh({ action: 'undefer', rowKey: d.key }))}>вернуть сейчас</button>
      <DeferNote rowKey={d.key} action="undefer" />
    </div>
  );
}

// flat — окно проекта: плоские строки панели, «до …» под подписью
export function Deferred({ list, flat = false }) {
  const o = useOpen(flat ? 'pgrp-deferred' : 'grp-deferred', false);
  const head = useRef(null);
  const tick = useFocusTick();
  const n = list?.length ?? 0;
  useEffect(() => {
    if (!n || !focusAfter || !head.current) return;
    const { scroll } = focusAfter;
    focusAfter = null;
    head.current.focus({ preventScroll: !scroll });
  }, [n, tick]);
  if (!n) return null;
  return (
    <details className={flat ? 'grp dfd flat' : 'grp dfd'} open={o.open} onToggle={o.onToggle}>
      <Summary ref={head}>Отложено <span className="cnt num">{n}</span></Summary>
      {list.map((d) => <DeferredRow key={d.key} d={d} flat={flat} />)}
    </details>
  );
}
