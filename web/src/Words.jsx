// Блоки «Цеха» вокруг кнопок-слов (EXT-70; спека пульта §1.4 «Цех», §1.5, §1.7, §2.8, §4.3):
// «Мои слова за 24 ч» — GET /api/actions, это и аудит, красная пометка «не из браузера» (source.ok);
// «Рабочие копии» — GET /api/worktrees и «Прибери отслужившие» (ручки исполнения ещё нет — ответ 501 словами «ещё нет»).
import { useState } from 'react';
import { clear403, postAct, reloadOn403 } from './act.js';
import { streamSource, useSource } from './data.js';
import { hm, plural } from './format.js';
import { useOpen } from './prefs.js';
import { Ring, WORD } from './Pult.jsx';
import { Summary } from './Summary.jsx';

const actionsSource = streamSource('/api/actions');
const worktreesSource = streamSource('/api/worktrees');

const SERVICE = new Set(['mirror', 'defer', 'undefer', 'reindex', 'ping', 'cleanup']); // не слова: Обновить, Отложить и прочее служебное
const LABEL = { ...WORD, accept: 'принять', return: 'вернуть', reread: 'перечитать правила', 'new-card': 'новая карточка' };
const SHOWN = 6;

const OUTCOME = {
  done: 'записано',
  partial: 'частично: запись есть, статус не сменился',
  refused: 'отказ',
  error: 'не записано',
  asked: 'идёт или оборвано',
  'need-confirm': 'ждёт второго щелчка',
};

function Row({ r, now }) {
  const word = r.action === 'reply' ? <b>ответ</b> : <b>«{LABEL[r.action] ?? r.action}»</b>;
  const out = OUTCOME[r.status] ?? r.status ?? '—';
  const bad = r.status === 'refused' ? 'pamb' : r.status === 'error' ? 'pbad' : null;
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
        {r.status === 'done' && (r.ring ? <> · тред: <Ring ring={r.ring} /></> : r.action === 'reply' && !r.card ? ' · в журнале треда' : '')}
      </span>
    </div>
  );
}

export function MyWords({ now }) {
  const o = useOpen('mywords');
  const { data } = useSource(actionsSource);
  const [all, setAll] = useState(false);
  const [svc, setSvc] = useState(false);
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
      {shown.map((r) => <Row key={r.id} r={r} now={now} />)}
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
