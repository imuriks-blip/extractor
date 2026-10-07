// Блоки «Цеха» вокруг кнопок-слов (EXT-70; спека пульта §1.4 «Цех», §1.5, §1.7, §2.8, §4.3):
// «Мои слова за 24 ч» — GET /api/actions, это и аудит, красная пометка «не из браузера» (source.ok);
// «Рабочие копии» — GET /api/worktrees и «Прибери отслужившие» (ручки исполнения ещё нет — ответ 501 словами «ещё нет»).
import { useState } from 'react';
import { clear403, postAct, reloadOn403 } from './act.js';
import { streamSource, useSource } from './data.js';
import { hm, plural } from './format.js';
import { useOpen } from './prefs.js';
import { Ring, WORD } from './Pult.jsx';
import { RETURN_HINT, canWithdraw, outcomeText, withdrawResult, withdrawRowView, wordRingView } from './pultData.js';
import { Summary } from './Summary.jsx';

const actionsSource = streamSource('/api/actions');
const worktreesSource = streamSource('/api/worktrees');

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
        {r.status === 'done' && !isW && lc?.phase !== 'ok' && (rv ? (rv.cls === 'ring' ? <> · тред: <Ring ring={r.ring} /></> : <> · тред: <span className={clsOf[rv.cls]}>{rv.text}</span></>) : r.action === 'reply' && !r.card ? ' · в журнале треда' : '')}
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

// «Прибери отслужившие рабочие копии» (таблица 1.3, §1.5): список кандидатов с причиной годности, всегда второй щелчок.
// Выбор копий в запрос пока не входит («выбор копий для cleanup добавит ПТ8б») — кнопка просит убрать все годные.
export function Worktrees() {
  const o = useOpen('worktrees', false);
  const { data } = useSource(worktreesSource);
  const [ph, setPh] = useState('idle'); // idle | confirm | busy | done
  const [msg, setMsg] = useState(null);
  const list = Array.isArray(data) ? data : [];
  const ok = list.filter((x) => x.eligible);
  const name = (p) => String(p).split(/[\\/]/).filter(Boolean).pop();
  const go = async () => {
    setPh('busy');
    const payload = { action: 'cleanup', intentId: crypto.randomUUID() };
    let r;
    try { r = await postAct(payload); } catch { setMsg({ cls: 'pbad', text: 'нет связи с витриной' }); setPh('done'); return; }
    if (r.status === 403) {
      if (reloadOn403(payload)) return;
      setMsg({ cls: 'pbad', text: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
    } else {
      clear403(payload.intentId);
      const b = r.body || {};
      setMsg(r.status === 501
        ? { cls: 'muted', text: <><span className="faint">ещё нет:</span> {b.message || 'уборка ещё не подключена'}</> }
        : { cls: b.outcome === 'ok' ? 'pmark' : 'pamb', text: b.message || `ошибка: HTTP ${r.status}` });
    }
    setPh('done');
  };
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>Рабочие копии <span className="cnt num">{list.length}</span>{list.length > 0 && <span className="hint">годны к уборке: {ok.length}</span>}</Summary>
      {list.map((x) => (
        <div className={x.eligible ? 'wt' : 'wt no'} key={x.path}>
          <span className="p" title={x.path}>{name(x.path)} · {x.branch}</span>
          <span className="r">{x.reason}{x.ignored?.length > 0 && ` · ${x.ignored.join(', ')}`}</span>
        </div>
      ))}
      {!list.length && <div className="foot">{data ? 'Рабочих копий нет.' : 'Читаю список…'}</div>}
      {ok.length > 0 && (
        <div className="wtb">
          {ph === 'confirm' ? (
            <span className="cfm"><span className="h">Убрать {plural(ok.length, ['копию', 'копии', 'копий'])}?</span>{ok.map((x) => name(x.path)).join(', ')}. Ветки не удаляются.
              <span className="row"><button type="button" className="pbtn pmain" onClick={go}>убрать {ok.length}</button><button type="button" className="pbtn" onClick={() => setPh('idle')}>отмена</button></span>
            </span>
          ) : (
            <>
              <button type="button" className="pbtn" disabled={ph === 'busy'} onClick={() => { setMsg(null); setPh('confirm'); }}>убрать годные: {ok.length}</button>
              {ph === 'busy' ? <span className="going" role="status">убираю…</span> : msg ? <span className={msg.cls} role="status">{msg.text}</span> : <span className="faint">ветки остаются; вернуть — git worktree add</span>}
            </>
          )}
        </div>
      )}
    </details>
  );
}
