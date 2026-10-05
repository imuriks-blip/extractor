// Кнопки пульта в строках и панели (спека пульта: таблица 1.3, §1.1 п.3, п.7 и п.10, §1.4, §1.7, §2.8, §3.2, §4.2):
// «Принять»/«Вернуть» (EXT-43), кнопки-слова да · го · сливай · выкатывай · нет · «Ответить» и «В работу» (EXT-70).
// POST /api/act {action, intentId, card | session, q, text?, confirm?, pick?}; q — готовый из данных, как есть.
// Состояние нажатия — общее на страницу по ключу (номер карточки, у строки (а) — тред и вопрос): строка и панель одной
// карточки показывают одно и то же. Подтверждение (второй щелчок и выбор треда) раскрывается под строкой.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { canPull, clear403, postAct, pull, reloadOn403, take403 } from './act.js';
import { useNow } from './data.js';
import { dm, hm } from './format.js';

const TEXT_MAX = 500;
const CONFIRM_MS = 5 * 60_000; // второй щелчок — не дольше 5 мин после первого (1.1 п.7)
const OK_SHOWN_MS = 60_000; // свежий исход «записано» держится до прихода отметки из данных; дольше минуты — забывается
const PULT_ACTIONS = ['accept', 'return', 'yes', 'go', 'merge', 'deploy', 'no', 'reply', 'take'];

/* ---------- слова ---------- */

// подпись слова в исходах и «Моих словах»
export const WORD = { yes: 'да', go: 'го', merge: 'сливай', deploy: 'выкатывай', no: 'нет', reply: 'ответ', take: 'В работу' };
export const FLIGHT = ['положено', 'доставлено']; // слово ещё в пути: кнопки строки (а) неактивны (§1.7)
const RING_CLS = (r) => (r === 'положено' ? 'q' : r === 'доставлено' ? 'd' : r === 'прочитано' ? 'ok' : r === 'звонок выключен' || r === 'отозвано' ? 'off' : 'bad');
const RING_NOTE = { положено: ' — услышит, когда закончит ход' };

// статус звонка 2.8 — словом и цветом
export const Ring = ({ ring, note = false }) => (ring
  ? <><span className={`w2 ${RING_CLS(ring)}`}>{ring}</span>{note && RING_NOTE[ring]}</>
  : null);

/* ---------- состояние нажатий: ключ → {phase, action, msg, payload, ...} ---------- */
// phase: busy | confirm | ok | partial | refused | error | net (нет связи — повтор тем же ключом) | none (ручки ещё нет, 501)
const acts = new Map();
const subs = new Set();
const setAct = (key, v) => { if (v) acts.set(key, v); else acts.delete(key); subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const useAct = (key) => useSyncExternalStore(subscribe, () => acts.get(key) ?? null);

// ключ состояния: у строки (а) — тред и вопрос, у остального — карточка
export const keyOf = (p) => (p.session ? `${p.session}|${p.q?.uuid ?? ''}` : p.card);

async function send(payload, key = keyOf(payload)) {
  const base = { action: payload.action, payload, at: Date.now() };
  setAct(key, { ...base, phase: 'busy', since: Date.now() });
  let r;
  try {
    r = await postAct(payload);
  } catch {
    setAct(key, { ...base, phase: 'net', msg: 'нет связи с витриной — «повторить» пошлёт то же нажатие' });
    return;
  }
  if (r.status === 403) {
    if (reloadOn403(payload)) return;
    setAct(key, { ...base, phase: 'error', msg: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
    return;
  }
  clear403(payload.intentId);
  const b = r.body || {};
  if (r.status === 503) { setAct(key, { ...base, phase: 'refused', msg: b.message || 'пульт выключен' }); return; }
  if (r.status === 501) { setAct(key, { ...base, phase: 'none', msg: b.message || 'ещё не подключено' }); return; }
  // второй щелчок и выбор треда (§1.7): ответ ещё ничего не записал
  if (r.status === 200 && b.outcome === 'need-confirm' && b.confirm) {
    setAct(key, { ...base, phase: 'confirm', resp: b, until: Date.now() + CONFIRM_MS });
    return;
  }
  const outcome = r.status === 200 ? b.outcome : r.status === 409 || r.status === 429 ? 'refused' : 'error';
  const msg = b.message || `ошибка: HTTP ${r.status}`;
  if (outcome === 'ok') setAct(key, { ...base, phase: 'ok', id: b.id, msg });
  else if (outcome === 'partial') setAct(key, { ...base, phase: 'partial', id: b.id, msg });
  else if (outcome === 'refused') setAct(key, { ...base, phase: 'refused', msg, rid: b.id, pull: b.pull === true });
  else setAct(key, { ...base, phase: 'error', msg });
}

// новое намерение — новый ключ (§1.1 п.3); «повторить» после partial — тоже новый: сервер сам зовёт только state
const fresh = (p) => ({ ...p, intentId: crypto.randomUUID() });

// после перезагрузки на 403 — то же намерение тем же ключом (§1.1 п.3). Шлёт его кнопка той карточки, когда её строка
// или панель на экране: исход виден там, где Иван нажимал. Карточки на экране нет (за «Показать ещё», другой экран) —
// повтор ждёт её до 60 с свежести записи, потом намерение забывается без запроса (п.12 ревью Голема)
const resumed = new Set(); // ключи, уже отправленные повтором в этой загрузке страницы
function resume403(key) {
  const p = take403((x) => PULT_ACTIONS.includes(x.action) && keyOf(x) === key);
  if (!p || resumed.has(p.intentId)) return;
  resumed.add(p.intentId);
  send(p, key);
}

/* ---------- вид ---------- */

// «идёт»: сверка и запись — ~6 запросов к Plane по 1,05 с, 7–8 с на нажатие (1.1 п.10)
function Going({ since, text }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="going" role="status">{text}… <span className="num">{s} с</span> <span className="faint">· обычно 7–8 с</span></span>;
}
const goingText = (a) => (a === 'accept' ? 'записываю в Plane' : a === 'reply' ? 'пишу и зову тред' : 'записываю в Plane и зову тред');

function ReturnForm({ onSend, onCancel, label = 'Причина возврата', placeholder = 'Причина: что доделать', send: sendText = 'вернуть', qline = null, foot = null }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const ok = text.trim().length > 0;
  const submit = (e) => { e.preventDefault(); if (ok) onSend(text.trim()); };
  return (
    <form className="pret" onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      {qline && <span className="qline">{qline}</span>}
      <textarea ref={ref} rows={2} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)}
        aria-label={label} placeholder={placeholder} />
      <span className="pret-row">
        <button type="submit" className={qline ? 'pbtn pmain' : 'pbtn'} disabled={!ok}>{sendText}</button>
        <button type="button" className="pbtn" onClick={onCancel}>отмена</button>
        <span className="pcnt num" aria-live="polite">{text.length}/{TEXT_MAX}</span>
      </span>
      {foot && <span className="faint">{foot}</span>}
    </form>
  );
}

// Отметка из данных (§3.2, §1.7 «Местная отметка»): text — у «Принять»/«Вернуть» всегда («принято · Done в Plane ЧЧ:ММ ·
// зеркало ещё не видело», «частично: …»), у слов — только у красной (missing: true, «зеркало не видит запись <id>»);
// у не красной отметки слова text нет — строка строится из полей: слово, время записи, статус звонка 2.8.
// tail — приписка к красной (у частичного исхода: статус не сменился)
export function PultMark({ m, now, tail = null }) {
  if (!m) return null;
  if (m.text) {
    // missing: сервер уже кладёт в text «зеркало не видит запись <id>» — тот же текст, красным
    return <span className={m.missing ? 'pmark pbad' : 'pmark'}>{m.text}{tail}{m.ring && <> · тред: <Ring ring={m.ring} /></>}</span>;
  }
  const w = WORD[m.action];
  return (
    <span className="pmark">
      {m.action === 'reply' ? 'ответ' : `«${w ?? m.action}»`} · записано {hm(m.at, now)}
      {m.ring ? <> · тред: <Ring ring={m.ring} note /></> : ' · звонка нет'}
    </span>
  );
}

// «Принять»/«Вернуть» с state null — частичный исход: запись легла, статус не сменился (§1.7, таблица 1.3)
export const isPartialMark = (m) => !!m && (m.action === 'accept' || m.action === 'return') && m.state === null;

// отметка карточки; у частичного исхода — «повторить» (accept — сразу, return — снова с причиной), только при включённом
// пульте (can = pult.enabled: иначе ответ 503). Частичный под красной — красный текст в строке и «статус не сменился»;
// «повторить» не нужно: под красной у строки и панели снова обычные кнопки (слово Ивана 05.10, §1.7)
export function MarkLine({ card, q, mark, now, can = true }) {
  const [form, setForm] = useState(false);
  if (!mark) return null;
  if (!isPartialMark(mark)) return <PultMark m={mark} now={now} />;
  if (mark.missing) return <PultMark m={mark} now={now} tail={<span className="pamb"> · частично: статус не сменился</span>} />;
  if (!can) return <span className="pnote pamb" role="status">частично: запись есть, статус не сменился</span>;
  return (
    <>
      <span className="pnote pamb" role="status">частично: запись есть, статус не сменился —{' '}
        <button type="button" className="pbtn" disabled={!q} aria-expanded={mark.action === 'return' ? form : undefined}
          onClick={() => (mark.action === 'accept' ? send(fresh({ action: 'accept', card, q })) : setForm((v) => !v))}>повторить</button>
      </span>
      {form && <ReturnForm onSend={(t) => { setForm(false); send(fresh({ action: 'return', card, q, text: t })); }} onCancel={() => setForm(false)} />}
    </>
  );
}

// второй щелчок и выбор треда — под строкой, как форма «Вернуть» (§1.1 п.7, §1.7: confirm.what / follows / candidates)
function Confirm({ st, onGo, onCancel }) {
  const { resp, payload } = st;
  const c = resp.confirm;
  // Б-дело или только выбор треда — по полю bdeal тела ответа; в запрос confirm уходит в обоих случаях
  const b = !!resp.bdeal;
  const cands = c.candidates?.length > 0 ? c.candidates : null;
  const [pick, setPick] = useState(null);
  const w = payload.action === 'reply' ? 'ответ' : WORD[payload.action];
  const need = cands && !pick;
  const q = c.q;
  return (
    <div className={b ? 'cfm b' : 'cfm'} role="group" aria-label={b ? `Подтверждение: ${c.what}` : `Выбор треда: ${c.what}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <span className="h">{b ? 'Б-дело · второй щелчок' : 'Кому слово'}</span>{c.what}
      <dl>
        <dt>в ответ на</dt>
        <dd>{q?.at ? <>запись {dm(q.at)}{q.head ? ` «${q.head}»` : ''}</> : q?.uuid ? 'вопрос треда' : 'записей не было'}</dd>
        {b && <><dt>что дальше</dt><dd>{c.follows}</dd></>}
        {b && payload.card && <><dt>на карточке</dt><dd>запись «Слово Ивана · кнопка витрины» с припиской «Б — ждёт «да» в чате»: тред переспросит тебя в чате</dd></>}
        {payload.text && <><dt>{payload.action === 'no' ? 'причина' : 'текст'}</dt><dd>«{payload.text}»</dd></>}
        {cands && (
          <><dt>кому</dt>
            <dd className="pick">
              {cands.map((x) => (
                <label key={x.sessionId}>
                  <input type="radio" name={`pk-${resp.id}`} checked={pick === x.sessionId} onChange={() => setPick(x.sessionId)} />
                  {x.title}{(x.by === 'cards' || x.by === 'card' || x.staleMin != null) && (
                    <span className="faint"> · {[x.by === 'cards' && 'по карточкам', x.by === 'card' && 'по карточке', x.staleMin != null && `нет вестей ${x.staleMin} мин — слово дождётся`].filter(Boolean).join(' · ')}</span>
                  )}
                </label>
              ))}
            </dd></>
        )}
        {c.mirrorAt && <><dt>зеркало</dt><dd>от {dm(c.mirrorAt)}</dd></>}
      </dl>
      <span className="row">
        <button type="button" className="pbtn pmain" disabled={need} autoFocus={!cands}
          onClick={() => onGo({ confirm: resp.id, ...(pick ? { pick } : {}) })}>{b ? `${w} — подтверждаю` : `${w === 'ответ' ? 'ответ' : w} — отправить`}</button>
        <button type="button" className="pbtn" onClick={onCancel}>отмена</button>
        {need && <span className="faint">сначала выбери тред</span>}
        <span className="tmr num">действует до {hm(new Date(st.until).toISOString())}</span>
      </span>
    </div>
  );
}

// описание слов: {btns: ['merge', 'no'], more: ['yes', 'go'], main: 'merge'}; слово — действие из WORD или {action, text, label}
const NAME = { reply: 'Ответить' };
const labelOf = (w) => w.label ?? NAME[w.action] ?? WORD[w.action];
const asWord = (w) => (typeof w === 'string' ? { action: w } : w);

// card — номер (ключ состояния и поле card); thread — {session, card?, key} у строки (а): ответ ровно этому треду;
// ar — «Принять»/«Вернуть» (строки (в), панель в Review); words — {btns, more, main}; mark — отметка из данных
export default function Pult({ card, q, accept, mark, ar = true, words = null, thread = null }) {
  const key = thread ? thread.key : card;
  const st0 = useAct(key);
  const [form, setForm] = useState(null); // null | 'return' | 'reply'
  const [menu, setMenu] = useState(false);
  const retBtn = useRef(null);
  const backFocus = useRef(false);
  const menuBox = useRef(null);
  useEffect(() => { resume403(key); }, [key]);
  useEffect(() => { if (!form && backFocus.current) { backFocus.current = false; retBtn.current?.focus(); } }, [form]);
  // меню «ещё ▾» закрывается щелчком мимо (второй щелчок по кнопке — onClick ниже)
  useEffect(() => {
    if (!menu) return undefined;
    const away = (e) => { if (!menuBox.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);

  const st = st0 && st0.phase === 'ok' && Date.now() - st0.at > OK_SHOWN_MS ? null : st0;
  const phase = st?.phase;
  const busy = phase === 'busy';
  const confirming = phase === 'confirm';
  const markMine = mark && (!st || (phase === 'ok' && (!st.id || st.id === mark.id)));
  // красная «зеркало не видит запись <id>» (§1.7, слово Ивана 05.10): кнопки слов снова есть — отметка над ними
  const red = !thread && mark?.missing === true;
  const markPartial = isPartialMark(mark) && !st && !red;

  // карточка: обычная отметка из данных пришла — нажатие исполнено, кнопок нет, видна она
  if (!thread && markMine && !red) return <div className="pult"><MarkLine card={card} q={q} mark={mark} can={ar} /></div>;
  if (!thread && phase === 'ok') return <div className="pult"><span className="pmark" role="status">{st.msg}</span></div>;
  if (!q && !st && !(red && markMine)) return null;
  // строка (а): кнопки неактивны, пока слово в пути — по отметке из данных или по свежему исходу без отметки (§1.7)
  const inFlight = thread && ((markMine && FLIGHT.includes(mark.ring)) || (phase === 'ok' && !markMine));

  const base = (action) => (thread
    ? { action, session: thread.session, ...(thread.card ? { card: thread.card } : {}), q }
    : { action, card, q });
  const press = (action, text) => {
    setForm(null);
    setMenu(false);
    send(fresh({ ...base(action), ...(text != null ? { text } : {}) }), key);
  };
  const close = () => { backFocus.current = true; setForm(null); };
  const onWord = (w) => {
    setMenu(false);
    if (w.action === 'reply' && !w.text) setForm((f) => (f === 'reply' ? null : 'reply'));
    else press(w.action, w.text);
  };

  let note = null;
  if (busy) note = <Going since={st.since} text={goingText(st.action)} />;
  else if (phase === 'partial') {
    note = (
      <span className="pnote pamb" role="status">
        частично: запись есть, статус не сменился —{' '}
        <button type="button" className="pbtn" onClick={() => send(fresh(st.payload), key)}>повторить</button>
      </span>
    );
  } else if (phase === 'net') {
    note = (
      <span className="pnote pbad" role="status">
        {st.msg} <button type="button" className="pbtn" onClick={() => send(st.payload, key)}>повторить</button>
      </span>
    );
  } else if (phase === 'refused') {
    const maybe = /^может быть секретом/.test(st.msg) && st.rid && st.payload?.text !== undefined;
    note = (
      <span className="pnote" role="status">
        <span className="pamb">отказ:</span> {st.msg}
        {maybe && <> <button type="button" className="pbtn" onClick={() => send(fresh({ ...st.payload, confirm: st.rid }), key)}>это не секрет — отправить</button>
          <button type="button" className="pbtn" onClick={() => { setAct(key, null); setForm(st.payload.action === 'return' ? 'return' : 'reply'); }}>поправить текст</button></>}
        {st.pull && canPull() && !st.pullNote && <> <button type="button" className="pbtn" onClick={() => {
          const r = pull();
          if (r === 'started') setAct(key, null);
          // «Обновить» занята — отказ не стираем, говорим почему ничего не случилось (п.13 ревью Голема)
          else setAct(key, { ...st, pullNote: r === 'off' ? 'пульт выключен — дотянуть нечем' : 'обновление уже идёт — смотри «Обновить» вверху' });
        }}>дотянуть</button></>}
        {st.pullNote && <span> · {st.pullNote}</span>}
      </span>
    );
  } else if (phase === 'error') {
    note = <span className="pnote pbad" role="status">не вышло: {st.msg}</span>;
  } else if (phase === 'none') {
    note = <span className="pnote" role="status"><span className="faint">ещё нет:</span> {st.msg}</span>;
  } else if (phase === 'ok' && !markMine) {
    note = <span className="pmark" role="status">{st.msg}</span>;
  }

  const canAccept = accept?.can === true;
  // can null — слитость ветки ещё не посчитана проходом читателя git (EXT-57): кнопки нет, серое «проверяю…» из hint сервера
  const hint = ar && (accept?.can === false || (accept && accept.can === null)) && (accept.hint || 'проверяю, слита ли ветка карточки');
  // partial и «нет связи» — действие уже начато: вместо кнопок одно «повторить»
  const arShown = ar && q && phase !== 'partial' && phase !== 'net' && !markPartial;
  const wordBtns = (words?.btns ?? []).map(asWord);
  const moreWords = (words?.more ?? []).map(asWord);
  const wordsShown = words && q && phase !== 'partial' && phase !== 'net' && !markPartial;
  const off = busy || confirming || inFlight;
  const wordBtn = (w) => (
    <button key={w.action + (w.text ?? '')} type="button" className={words.main === w.action && !w.text ? 'pbtn pmain' : 'pbtn'} disabled={off && !(w.action === 'reply' && form === 'reply')}
      aria-expanded={w.action === 'reply' && !w.text ? form === 'reply' : confirming && st.action === w.action ? true : undefined}
      title={w.action === 'take' ? 'ручки «В работу» ещё нет' : undefined}
      onClick={() => onWord(w)}>{labelOf(w)}</button>
  );
  const nothing = !arShown && !wordsShown && !hint && !note && !markMine;
  if (nothing) return null;

  return (
    <div className="pult">
      {red && markMine && !busy && !confirming && <span className="pml"><MarkLine card={card} q={q} mark={mark} can={ar} /></span>}
      {(arShown || wordsShown) && (
        <span className="pbtns">
          {arShown && accept && canAccept && <button type="button" className="pbtn pmain" disabled={busy || confirming || !!form} onClick={() => press('accept')}>Принять</button>}
          {arShown && <button ref={retBtn} type="button" className="pbtn" disabled={busy || confirming} aria-expanded={form === 'return'}
            onClick={() => (form === 'return' ? close() : (setMenu(false), setForm('return')))}>Вернуть</button>}
          {wordsShown && wordBtns.map((w) => (
            <span key={w.action + (w.text ?? '')} className="pbw">{wordBtn(w)}{w.action === 'take' && <span className="todo">ещё нет</span>}</span>
          ))}
          {wordsShown && moreWords.length > 0 && (
            // меню — поверх содержимого под кнопками, по правому краю ряда кнопок (как «Отложить до …»): строку «След» не двигает
            <span className="pmw" ref={menuBox}>
              <button type="button" className="pbtn" disabled={off} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((v) => !v)}>ещё ▾</button>
              {menu && (
                <span className="menu pmenu" role="menu" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } }}>
                  {moreWords.map((w) => <button key={w.action} type="button" role="menuitem" onClick={() => onWord(w)}>{labelOf(w)}{w.action === 'reply' ? '…' : ''}</button>)}
                </span>
              )}
            </span>
          )}
        </span>
      )}
      {q && hint && !note && <span className="phint">{hint}</span>}
      {note}
      {thread && markMine && !busy && !confirming && <span className="pmark"><PultMark m={mark} /></span>}
      {confirming && <Confirm st={st} onCancel={() => setAct(key, null)} onGo={(extra) => send(fresh({ ...st.payload, ...extra }), key)} />}
      {form === 'return' && !busy && (
        <ReturnForm onSend={(t) => press('return', t)} onCancel={close} />
      )}
      {form === 'reply' && !busy && (
        <ReturnForm label="Ответ" placeholder="Ответ" send="отправить"
          qline={thread
            ? `в ответ на: вопрос треда${thread.card ? ` · запись ляжет на ${thread.card}` : ' · тред без карточки — на доску не ляжет, след в «Моих словах»'}`
            : `в ответ на: ${q?.at ? `${hm(q.at)} «${q.head ?? ''}»` : 'записей не было'}`}
          foot="Свободный ответ не заменяет «да» на слияние, выкатку, базу — тред переспросит в чате."
          onSend={(t) => press('reply', t)} onCancel={close} />
      )}
    </div>
  );
}

export { send, fresh, setAct, useAct };
