// «Перечитать правила» (EXT-65; спека пульта §1.8, §2.8, спека витрины §2.3 «Не перечитаны»): строка и кнопка внутри
// блока «Старые правила» под тредом — «Цех» и окно проекта. POST /api/act ровно {action: 'reread', intentId, session};
// путей страница не шлёт — сервер берёт missing у пометки сам. Кнопки нет при выключенном пульте или звонке (/api/health → pult.enabled, bell.on).
// Статус просьбы — из общего опроса GET /api/actions (rereadFeed.js, один на страницу): последний reread этого треда со звонком (поле ring, §2.8).
import { Fragment, useCallback, useEffect, useState } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { hm } from './format.js';
import { inFlight, lastFor, refreshNow, subscribe } from './rereadFeed.js';

const sad = (ring) => /^(не доставлено|сброшено)/.test(ring);

function useReread(session, now) {
  const [feed, setFeed] = useState({ on: false, rows: [] });
  const [act, setAct] = useState(null); // {phase: busy|refused|error|net, msg, payload}
  useEffect(() => subscribe(setFeed), []);
  const on = feed.on;
  const row = lastFor(feed.rows, session);

  const send = useCallback(async (payload) => {
    setAct({ phase: 'busy', payload });
    let r;
    try {
      r = await postAct(payload);
    } catch {
      setAct({ phase: 'net', payload, msg: 'нет связи с витриной — «повторить» пошлёт то же нажатие' });
      return;
    }
    if (r.status === 403) {
      if (reloadOn403(payload)) return;
      setAct({ phase: 'error', msg: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
      return;
    }
    clear403(payload.intentId);
    const b = r.body || {};
    const outcome = r.status === 200 ? b.outcome : r.status === 409 || r.status === 429 || r.status === 503 ? 'refused' : 'error';
    const msg = b.message || `ошибка: HTTP ${r.status}`;
    if (outcome === 'ok') setAct(null); // дальше — статус из журнала действий
    else setAct({ phase: outcome === 'refused' ? 'refused' : 'error', msg });
    refreshNow();
  }, []);

  // после перезагрузки на 403 — то же намерение тем же ключом (§1.1 п.3 пульта)
  useEffect(() => {
    const p = take403((x) => x.action === 'reread' && x.session === session);
    if (p) send(p);
  }, [session, send]);

  const press = () => send({ action: 'reread', intentId: crypto.randomUUID(), session });
  return { on, row, act, press, retry: () => act?.payload && send(act.payload), blocked: inFlight(row, now) };
}

// missing — [{path, short}] у пометки oldRules; пусто или поля нет (набор выключен) — компонент не зовётся
export default function Reread({ session, missing, now }) {
  const { on, row, act, press, retry, blocked } = useReread(session, now);
  const busy = act?.phase === 'busy';
  return (
    <div className="rr">
      <span>не перечитаны:{' '}
        {missing.map((f, i) => (
          <Fragment key={f.path}>{i > 0 && ', '}<span className="mono" title={f.path}>{f.short || f.path}</span></Fragment>
        ))}
      </span>
      {on && (
        <span className="rr-a">
          <button type="button" className="pbtn" disabled={busy || blocked} onClick={press}>Перечитать правила</button>
          {row && <span className={sad(row.ring) ? 'pamb' : 'muted'} role="status">просьба {hm(row.at, now)} · {row.ring}</span>}
          {busy && <span className="muted" role="status">прошу…</span>}
          {act?.phase === 'refused' && <span className="pnote" role="status"><span className="pamb">отказ:</span> {act.msg}</span>}
          {act?.phase === 'error' && <span className="pnote pbad" role="status">не вышло: {act.msg}</span>}
          {act?.phase === 'net' && <span className="pnote pbad" role="status">{act.msg} <button type="button" className="pbtn" onClick={retry}>повторить</button></span>}
        </span>
      )}
    </div>
  );
}
