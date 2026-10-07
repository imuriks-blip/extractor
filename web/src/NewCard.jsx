// «Новая карточка» (EXT-81, ПТ9; спека пульта §1.3, §1.4, §1.6, §1.7): кнопка и форма — на «Цехе» (проект выбирается) и в окне
// проекта (проект подставлен). POST /api/act {action:'new-card', intentId, project, title, text?, confirm?}.
// Вид — как «Вернуть» (.pret) и второй щелчок (.cfm) из Pult.jsx. Черновик и исход живут на уровне модуля по ключу места:
// пересборка данных страницы форму не сбрасывает. Данные и разбор ответа — newCardData.js.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { useNow } from './data.js';
import { dm, hm } from './format.js';
import { Going } from './Pult.jsx';
import {
  NET_UNCLEAR_MESSAGE, TEXT_MAX, TITLE_MAX, UNCLEAR_ACTIONS, buildPayload, canNewCardIn, canRetryNet, canSubmit, classifyReply, clip,
  closeAction, copyText, len, projectChoices,
} from './newCardData.js';

const CONFIRM_MS = 5 * 60_000; // второй щелчок — не дольше 5 мин после первого (как у слов)
const OK_SHOWN_MS = 60_000; // «создана …» держится минуту
const EMPTY = { open: false, phase: 'form', project: '', title: '', text: '', note: null };

/* ---------- состояние по ключу места ('ceh' | 'p:<КОД>') ---------- */
// phase: form | busy | confirm | unclear | net | ok; note — {cls, text, rid?, fix?} над кнопками формы
const stores = new Map();
const subs = new Set();
const get = (key) => stores.get(key) ?? EMPTY;
const patch = (key, p) => { stores.set(key, { ...get(key), ...p }); subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const useStore = (key) => useSyncExternalStore(subscribe, () => get(key));
const reset = (key) => { stores.set(key, EMPTY); subs.forEach((f) => f()); };
const fresh = () => crypto.randomUUID();
// закрытие формы: из «нет связи» — в «исход неясен» (запрос мог дойти), не молча; во время запроса — нельзя
const closeForm = (key) => {
  const a = closeAction(get(key).phase);
  if (a === 'unclear') patch(key, { open: true, phase: 'unclear', note: { cls: 'pbad', text: NET_UNCLEAR_MESSAGE } });
  else if (a === 'reset') reset(key); // из «исход неясен» — как «закрыть»: поля очищаются, иначе кнопка вернула бы форму с прежним вводом (Важно Голема, круг 2)
  else if (a === 'close') patch(key, { open: false, phase: 'form', note: null });
};

const FORBIDDEN = 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)';

async function send(key, payload) {
  // sentAt — первая отправка этого намерения: окно «повторить» (9 мин) считается от неё, а не от последнего повтора
  const prev = get(key);
  const sentAt = prev.payload?.intentId === payload.intentId && prev.sentAt ? prev.sentAt : Date.now();
  patch(key, { phase: 'busy', payload, since: Date.now(), sentAt, note: null });
  let r;
  try {
    r = await postAct(payload);
  } catch {
    patch(key, { phase: 'net' }); // повтор — тем же intentId
    return;
  }
  if (r.status === 403) {
    if (reloadOn403(payload)) return;
    patch(key, { phase: 'form', note: { cls: 'pbad', text: FORBIDDEN } });
    return;
  }
  clear403(payload.intentId);
  const v = classifyReply(r.status, r.body);
  switch (v.kind) {
    case 'created':
      stores.set(key, { ...EMPTY, phase: 'ok', created: v.created, msg: v.message, okAt: Date.now() });
      subs.forEach((f) => f());
      return;
    case 'confirm': patch(key, { phase: 'confirm', resp: v, until: Date.now() + CONFIRM_MS }); return;
    case 'unclear': patch(key, { phase: 'unclear', note: { cls: 'pbad', text: v.message } }); return;
    case 'secret': patch(key, { phase: 'form', note: { cls: 'pamb', text: v.message, fix: true } }); return;
    case 'secret-maybe': patch(key, { phase: 'form', note: { cls: 'pamb', text: v.message, rid: v.rid, fix: true } }); return;
    case 'not-created': patch(key, { phase: 'form', note: { cls: 'pbad', text: v.message } }); return;
    case 'retype': patch(key, { phase: 'form', note: { cls: 'pamb', text: v.message } }); return;
    default: patch(key, { phase: 'form', note: { cls: v.kind === 'error' ? 'pbad' : 'pamb', text: v.message } });
  }
}

// после перезагрузки на 403 — то же намерение тем же ключом (§1.1 п.3); один раз на намерение в этой загрузке страницы
const resumed = new Set();
function resume403(key, fixed) {
  const p = take403((x) => x.action === 'new-card' && (!fixed || x.project === fixed));
  if (!p || resumed.has(p.intentId)) return;
  resumed.add(p.intentId);
  patch(key, { open: true, project: p.project, title: p.title, text: p.text ?? '' });
  send(key, p);
}

async function copy(key) {
  const s = get(key);
  let ok = false;
  try { await navigator.clipboard.writeText(copyText(s)); ok = true; } catch { /* буфера нет — выделить вручную */ }
  patch(key, { copied: ok ? 'скопировано' : 'не вышло — выдели текст и скопируй вручную' });
}

/* ---------- вид ---------- */

function Count({ n, max }) {
  return <span className="pcnt num">{n}/{max}</span>;
}

function Form({ k, st, fixed, choices }) {
  const ref = useRef(null);
  const textRef = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const busy = st.phase === 'busy';
  const net = st.phase === 'net';
  const lock = busy || net;
  const ok = canSubmit({ ...st, project: fixed ?? st.project }) && !lock;
  // кнопка, на которой стоял фокус, на время запроса неактивна — фокус не теряем: после ответа он возвращается в форму
  useEffect(() => { if (!lock && document.activeElement === document.body) ref.current?.focus(); }, [lock]);
  const edit = (p) => patch(k, { ...p, ...(st.note?.rid || st.note?.fix ? { note: null } : {}) }); // правка отменяет «это не секрет»
  const close = () => closeForm(k);
  const submit = (e) => { e.preventDefault(); if (ok) send(k, buildPayload({ ...st, project: fixed ?? st.project }, fresh())); };
  const n = st.note;
  const fixText = () => { patch(k, { note: null }); textRef.current?.focus(); };
  return (
    <form className="pret nc" aria-label="Новая карточка" onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <span className="qline">{fixed ? <>в <b className="mono">{fixed}</b> · создастся в Backlog</> : 'создастся в Backlog выбранного проекта'}</span>
      {!fixed && (
        <select value={st.project} disabled={lock} aria-label="Проект" aria-required="true" onChange={(e) => edit({ project: e.target.value })}>
          <option value="">проект…</option>
          {choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <span className="ncf">
        <input ref={ref} type="text" value={st.title} disabled={lock} aria-label="Заголовок" aria-required="true"
          placeholder="Заголовок" onChange={(e) => edit({ title: clip(e.target.value, TITLE_MAX) })} />
        <Count n={len(st.title)} max={TITLE_MAX} />
      </span>
      <textarea ref={textRef} rows={3} value={st.text} disabled={lock} aria-label="Текст (необязательно)"
        placeholder="Текст — необязательно" onChange={(e) => edit({ text: clip(e.target.value, TEXT_MAX) })} />
      {busy && <Going since={st.since} text="создаю карточку" />}
      {net && (
        <span className="pnote pbad" role="status">нет связи с витриной: запрос мог дойти и создать карточку. «Повторить» пошлёт то же нажатие (до 9 минут), «отмена» — проверить доску самому{' '}
          <button type="button" className="pbtn" onClick={() => (canRetryNet(st.sentAt, Date.now()) ? send(k, st.payload) : closeForm(k))}>повторить</button></span>
      )}
      {n && !lock && (
        <span className={`pnote ${n.cls}`} role="status">
          {n.text.split('\n').map((l, i) => <span key={i}>{i > 0 && <br />}{l}</span>)}
          {n.rid && <> <button type="button" className="pbtn" onClick={() => send(k, buildPayload({ ...st, project: fixed ?? st.project }, fresh(), n.rid))}>это не секрет — отправить</button></>}
          {n.fix && <> <button type="button" className="pbtn" onClick={fixText}>поправить текст</button></>}
        </span>
      )}
      <span className="pret-row">
        <button type="submit" className="pbtn pmain" disabled={!ok}>создать</button>
        <button type="button" className="pbtn" disabled={busy} onClick={close}>отмена</button>
        {!fixed && !st.project && <span className="faint">сначала выбери проект</span>}
      </span>
    </form>
  );
}

// похожие заголовки — второй щелчок (.cfm как у слов): «всё равно создать» — тот же ввод + confirm, новый intentId
function Similar({ k, st, fixed }) {
  const c = st.resp;
  const project = fixed ?? st.project;
  return (
    <div className="cfm" role="group" aria-label={`Подтверждение: ${c.what}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); patch(k, { open: false, phase: 'form' }); } }}>
      <span className="h">Похожие карточки</span>{c.what}
      <dl>
        <dt>похожие</dt>
        <dd>{c.similar.map((x) => <span className="sim" key={x.id}><span className="mono">{x.id}</span> · {x.title}</span>)}</dd>
        {c.follows && <><dt>что дальше</dt><dd>{c.follows}</dd></>}
        {c.mirrorAt && <><dt>зеркало</dt><dd>от {dm(c.mirrorAt)}</dd></>}
      </dl>
      <span className="row">
        <button type="button" className="pbtn pmain" autoFocus
          onClick={() => send(k, buildPayload({ ...st, project }, fresh(), c.id))}>всё равно создать</button>
        <button type="button" className="pbtn" onClick={() => patch(k, { phase: 'form' })}>поправить</button>
        <button type="button" className="pbtn" onClick={() => patch(k, { open: false, phase: 'form' })}>отмена</button>
        <span className="tmr num">действует до {hm(new Date(st.until).toISOString())}</span>
      </span>
    </div>
  );
}

// исход неясен: карточка могла создаться — никакого «создать» тем же вводом; текст виден, его можно скопировать
function Unclear({ k, st, fixed }) {
  return (
    <div className="cfm nc-un" role="group" aria-label="Исход неясен"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); reset(k); } }}>
      <span className="pnote pbad" role="status">{st.note?.text}</span>
      <dl>
        <dt>проект</dt><dd className="mono">{fixed ?? st.project}</dd>
        <dt>заголовок</dt><dd>{st.title}</dd>
        {st.text.trim() && <><dt>текст</dt><dd className="ncx">{st.text}</dd></>}
      </dl>
      <span className="row">
        {UNCLEAR_ACTIONS.retry && st.payload && <button type="button" className="pbtn" onClick={() => send(k, st.payload)}>повторить</button>}
        {UNCLEAR_ACTIONS.copy && <button type="button" className="pbtn" autoFocus onClick={() => copy(k)}>скопировать текст</button>}
        <button type="button" className="pbtn" onClick={() => reset(k)}>закрыть</button>
        {st.copied && <span className="faint" role="status">{st.copied}</span>}
      </span>
    </div>
  );
}

// fixed — код проекта в окне проекта; без него (на «Цехе») проект выбирается из projects
export default function NewCard({ fixed = null, projects = [], pult }) {
  const k = fixed ? `p:${fixed}` : 'ceh';
  const st = useStore(k);
  const now = useNow(5000);
  // «создана …» — свой таймер на 60 с, не зависит от перерисовок страницы
  useEffect(() => {
    if (st.phase !== 'ok') return undefined;
    const t = setTimeout(() => { if (get(k).phase === 'ok') reset(k); }, OK_SHOWN_MS);
    return () => clearTimeout(t);
  }, [k, st.phase, st.okAt]);
  // «нет связи» старше 9 минут — повтор тем же ключом больше нельзя: исход неясен
  const netOld = st.phase === 'net' && !canRetryNet(st.sentAt, Math.max(now, Date.now()));
  useEffect(() => { if (netOld) patch(k, { phase: 'unclear', note: { cls: 'pbad', text: NET_UNCLEAR_MESSAGE } }); }, [k, netOld]);
  useEffect(() => { resume403(k, fixed); }, [k, fixed]);
  if (!canNewCardIn(pult, fixed)) return null;
  const okShown = st.phase === 'ok';
  const busy = st.phase === 'busy';
  const toggle = () => (st.open ? closeForm(k) : patch(k, { open: true, ...(st.phase === 'ok' ? { phase: 'form' } : {}) }));
  return (
    <div className="wtb nc-bar">
      <span className="ncb">
        <button type="button" className="pbtn" aria-expanded={st.open} disabled={busy} onClick={toggle}>Новая карточка</button>
        {okShown && !st.open && (
          <span className="pmark" role="status">{st.created ? <>создана <span className="mono">{st.created}</span> · Backlog</> : st.msg}</span>
        )}
      </span>
      {st.open && (st.phase === 'confirm'
        ? <Similar k={k} st={st} fixed={fixed} />
        : st.phase === 'unclear'
          ? <Unclear k={k} st={st} fixed={fixed} />
          : <Form k={k} st={st} fixed={fixed} choices={projectChoices(projects)} />)}
    </div>
  );
}
