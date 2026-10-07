// Блоки «Цеха» вокруг кнопок-слов (EXT-70; спека пульта §1.4 «Цех», §1.5, §1.7, §2.8, §4.3):
// «Мои слова за 24 ч» — GET /api/actions, это и аудит, красная пометка «не из браузера» (source.ok);
// «Рабочие копии» — GET /api/worktrees и «Прибери отслужившие» (EXT-83: второй щелчок сервера).
import { Fragment, useEffect, useRef, useState } from 'react';
import { clear403, postAct, reloadOn403 } from './act.js';
import { streamSource, useSource } from './data.js';
import { dm, hm } from './format.js';
import { useOpen } from './prefs.js';
import { Ring, WORD } from './Pult.jsx';
import { RETURN_HINT, canWithdraw, outcomeText, withdrawResult, withdrawRowView, wordRingView } from './pultData.js';
import { Summary } from './Summary.jsx';
import { WT_CONFIRM_MS, WT_URL, finalAnswer, firstAnswer, wtCounts, wtRows } from './worktreesData.js';

const actionsSource = streamSource('/api/actions');

const SERVICE = new Set(['mirror', 'defer', 'undefer', 'reindex', 'ping', 'cleanup']); // не слова: Обновить, Отложить и прочее служебное
const LABEL = { ...WORD, accept: 'принять', return: 'вернуть', reread: 'перечитать правила', 'new-card': 'новая карточка', withdraw: 'отозвать' };
const SHOWN = 6;

// «Отозвать» (EXT-71, спека пульта §1.9): один щелчок, подтверждения нет; во время запроса — «идёт», кнопка неактивна.
// Исход держится у строки слова, пока опрос не принёс withdrawnBy (тогда строка говорит сама).
function WithdrawBtn({ r, local, setLocal }) {
  const busy = local?.phase === 'busy';
  const press = async () => {
    const payload = { action: 'withdraw', intentId: crypto.randomUUID(), target: r.id };
    setLocal(r.id, { phase: 'busy' });
    let res;
    try { res = await postAct(payload); } catch { setLocal(r.id, { phase: 'error', text: 'нет связи с витриной' }); return; }
    if (res.status === 403) {
      if (reloadOn403(payload)) return;
      setLocal(r.id, { phase: 'error', text: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
      return;
    }
    clear403(payload.intentId);
    setLocal(r.id, withdrawResult(res.status, res.body));
  };
  return (
    <>
      {' '}<button type="button" className="pbtn" disabled={busy} onClick={press}>Отозвать</button>
      {busy && <> <span className="going" role="status">идёт…</span></>}
    </>
  );
}

function Row({ r, now, rows, pult, local, setLocal }) {
  const isW = r.action === 'withdraw';
  const wv = isW ? withdrawRowView(r, rows) : null;
  const word = isW ? <b>{wv.label}</b> : r.action === 'reply' ? <b>ответ</b> : <b>«{LABEL[r.action] ?? r.action}»</b>;
  const out = isW ? wv.text : outcomeText(r);
  const bad = isW ? (wv.cls === 'bad' ? 'pbad' : wv.cls === 'amb' ? 'pamb' : null) : r.status === 'refused' ? 'pamb' : r.status === 'error' ? 'pbad' : null;
  const rv = !isW && r.status === 'done' ? wordRingView(r) : null;
  // исход нажатия, пока опрос не принёс withdrawnBy (после — говорит сама строка)
  const lc = local && !r.withdrawnBy ? local : null;
  const clsOf = { off: 'w2 off', bad: 'pbad', amb: 'pamb' };
  return (
    <div className="mw">
      <span className="tm num">{hm(r.at, now)}</span>
      <span className="wd">
        {word}{r.card && <span className="id">{r.card}</span>}
        {r.text && <> <span className="muted">«{r.text}»</span></>}
        {r.source && r.source.ok === false && <> <span className="tag r" title={`процесс-источник: ${r.source.image ?? 'неизвестен'}; нажато не из браузера`}>не из браузера</span></>}
      </span>
      <span className="sub">
        {bad ? <span className={bad}>{out}</span> : out}
        {r.status === 'done' && !isW && lc?.phase !== 'ok' && (rv ? (rv.cls === 'ring' ? <> · тред: <Ring ring={r.ring} /></> : <> · {rv.text.startsWith('отозвано') ? '' : 'тред: '}<span className={clsOf[rv.cls]}>{rv.text}</span></>) : r.action === 'reply' && !r.card ? ' · в журнале треда' : '')}
        {!isW && lc?.phase !== 'ok' && canWithdraw(r, pult) && <WithdrawBtn r={r} local={lc} setLocal={setLocal} />}
        {lc?.phase === 'ok' && <> · <span className={lc.late ? 'pbad' : 'pmark'} role="status">{lc.late ? lc.text : `отозвано${lc.by ? ` · ${lc.by}` : ''}${r.action === 'return' ? ` · ${RETURN_HINT}` : ''}`}</span></>}
        {lc?.phase === 'partial' && <> · <span className="pamb" role="status">{lc.text}</span></>}
        {lc?.phase === 'refused' && <> · <span className="pnote" role="status"><span className="pamb">отказ:</span> {lc.text}</span></>}
        {lc?.phase === 'error' && <> · <span className="pbad" role="status">не вышло: {lc.text}</span></>}
      </span>
    </div>
  );
}

export function MyWords({ now, pult }) {
  const o = useOpen('mywords');
  const { data } = useSource(actionsSource);
  const [all, setAll] = useState(false);
  const [svc, setSvc] = useState(false);
  const [local, setLocalAll] = useState({}); // номер слова → исход нажатия «Отозвать» (EXT-71)
  const setLocal = (id, v) => setLocalAll((m) => ({ ...m, [id]: v }));
  const rows = Array.isArray(data) ? data : [];
  const words = rows.filter((r) => !SERVICE.has(r.action));
  const service = rows.length - words.length;
  const foreign = rows.filter((r) => r.source && r.source.ok === false).length;
  const list = (svc ? rows : words);
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle} aria-label="Мои слова за 24 ч">
      <Summary>
        Мои слова за 24 ч <span className="cnt num">{words.length}</span>
        {foreign > 0 && <span className="hint red">не из браузера: {foreign}</span>}
      </Summary>
      {shown.map((r) => <Row key={r.id} r={r} now={now} rows={rows} pult={pult} local={local[r.id]} setLocal={setLocal} />)}
      {!list.length && <div className="foot">{data ? 'За сутки слов не было.' : 'Читаю журнал нажатий…'}</div>}
      {list.length > SHOWN && (
        <button type="button" className="more flat" onClick={() => setAll((v) => !v)}>{all ? 'Свернуть' : `Показать ещё ${list.length - SHOWN}`}</button>
      )}
      <div className="foot">Это и аудит: каждое нажатие с витрины.
        {service > 0 && <> Ещё {service} служебных (Обновить, Отложить) — <button type="button" className="lnk" onClick={() => setSvc((v) => !v)}>{svc ? 'скрыть' : 'показать'}</button></>}
      </div>
    </details>
  );
}

// «Прибери отслужившие рабочие копии» (таблица 1.3, §1.5, §1.7; EXT-83): список кандидатов с причиной годности и второй щелчок
// сервера. Первый POST cleanup (без confirm) ничего не убирает: возвращает окно подтверждения со списком; убирает только второй
// POST с confirm = id первого, и только то, что было в списке первого. Окно живёт 5 мин, как у «Полного прохода зеркала».
// project — код проекта (окно проекта: свои репозитории) или не задан («Цех»: все).
const wtSources = new Map();
const wtSource = (project) => { const k = project || '*'; if (!wtSources.has(k)) wtSources.set(k, streamSource(WT_URL(project))); return wtSources.get(k); };

export function Worktrees({ project }) {
  const o = useOpen('worktrees', false);
  const source = wtSource(project);
  const { data } = useSource(source);
  const [ph, setPh] = useState('idle'); // idle | asking | confirm | busy
  const [cf, setCf] = useState(null); // {id, what, follows, mirrorAt, candidates, until}
  const [msg, setMsg] = useState(null); // {cls, text}
  const intent = useRef(null); // намерение без ответа (сбой сети) — повтор нажатием с тем же ключом
  const btn = useRef(null);
  const again = useRef(null);
  useEffect(() => () => clearTimeout(again.current), []);
  const rows = wtRows(data);
  const { total, ok } = wtCounts(data);
  // просроченное подтверждение закрывается само
  useEffect(() => {
    if (!cf) return undefined;
    const t = setTimeout(() => { setCf(null); setPh('idle'); setMsg({ cls: 'pamb', text: 'подтверждение просрочено — нажми заново' }); }, Math.max(0, cf.until - Date.now()));
    return () => clearTimeout(t);
  }, [cf]);
  const closeCf = () => { setCf(null); setPh('idle'); btn.current?.focus(); };

  const send = async (confirm) => {
    const prev = intent.current;
    const payload = prev && prev.confirm === confirm ? prev : { action: 'cleanup', intentId: crypto.randomUUID(), ...(confirm ? { confirm } : {}), ...(project ? { project } : {}) };
    intent.current = payload;
    setMsg(null);
    setPh(confirm ? 'busy' : 'asking');
    const keep = cf;
    if (confirm) setCf(null); // второй щелчок ушёл — окно снято
    let r;
    try { r = await postAct(payload); } catch {
      if (confirm) { setCf(keep); setPh('confirm'); } else setPh('idle');
      setMsg({ cls: 'pbad', text: 'нет связи с витриной — нажми ещё раз (повтор того же нажатия)' });
      return;
    }
    if (r.status === 403) {
      if (reloadOn403(payload)) return;
      intent.current = null; setPh('idle');
      setMsg({ cls: 'pbad', text: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
      return;
    }
    clear403(payload.intentId);
    intent.current = null;
    if (!confirm) {
      const a = firstAnswer(r.status, r.body);
      if (a.kind === 'confirm') { setCf({ ...a, until: Date.now() + WT_CONFIRM_MS }); setPh('confirm'); return; }
      setPh('idle'); setMsg({ cls: a.cls, text: a.text });
      return;
    }
    const a = finalAnswer(r.status, r.body);
    setPh('idle'); setMsg({ cls: a.cls, text: a.text });
    // убранные строки пропадают: перечитать сейчас и ещё раз через 3 с — git-наблюдатель сервера шлёт «changed» посреди уборки, и ручка
    // может ответить снимком до удаления (общее идущее вычисление на ключ); второе чтение снимает этот хвост
    source.reload();
    clearTimeout(again.current);
    again.current = setTimeout(() => source.reload(), 3000);
  };

  return (
    <details className="blk" open={o.open} onToggle={o.onToggle} aria-label="Рабочие копии">
      <Summary>Рабочие копии <span className="cnt num">{total}</span>{total > 0 && <span className="hint">годны к уборке: {ok}</span>}</Summary>
      {rows.map((x) => (
        <div className={`wt${x.eligible ? '' : ' no'}${x.manual ? ' man' : ''}`} key={x.key}>
          <span className="p" title={x.path}>{x.name}{x.branch && <span className="muted"> · {x.branch}</span>}{x.card && <span className="id">{x.card}</span>}{x.badge && <span className={`tag ${x.eligible ? 'g' : 'b'}`}>{x.badge}</span>}</span>
          <span className="r">{x.reason}{x.ignored.length > 0 && ` · ${x.ignored.join(', ')}`}</span>
        </div>
      ))}
      {!rows.length && <div className="foot">{data ? 'Рабочих копий нет.' : 'Читаю список…'}</div>}
      {ok > 0 && (
        <div className="wtb">
          <button type="button" className="pbtn" ref={btn} disabled={ph === 'asking' || ph === 'busy'} aria-expanded={!!cf} onClick={() => (cf ? closeCf() : send())}>{ph === 'asking' ? 'спрашиваю…' : `убрать годные: ${ok}`}</button>
          {ph === 'busy' ? <span className="going" role="status">убираю…</span> : msg ? <span className={msg.cls} role="status">{msg.text}</span> : !cf && <span className="faint">ветки остаются; вернуть — git worktree add</span>}
          {cf && (
            <div className="cfm" role="group" aria-label={`Подтверждение: ${cf.what}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCf(); } }}>
              <span className="h">{cf.what}</span>{cf.follows}
              {!/остаются/.test(cf.follows) && ' Ветки остаются.'}
              {cf.mirrorAt && <span className="faint"> Зеркало от {dm(cf.mirrorAt)}.</span>}
              <dl>{cf.candidates.map((c) => <Fragment key={c.path}><dt className="mono" title={c.path}>{c.name}</dt><dd>{c.branch}{c.card && <span className="id">{c.card}</span>}</dd></Fragment>)}</dl>
              <span className="row">
                {/* фокус — на «отмена»: автоповтор Enter на «убрать годные» не нажимает уборку */}
                <button type="button" className="pbtn pmain" onClick={() => send(cf.id)}>убрать {cf.candidates.length}</button>
                <button type="button" className="pbtn" autoFocus onClick={closeCf}>отмена</button>
                <span className="tmr num">действует до {hm(new Date(cf.until).toISOString())}</span>
              </span>
            </div>
          )}
        </div>
      )}
      {ok === 0 && msg && <div className="wtb"><span className={msg.cls} role="status">{msg.text}</span></div>}
    </details>
  );
}
