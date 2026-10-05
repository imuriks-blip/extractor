// «Перечитать правила» (EXT-65; спека пульта §1.8, §2.8, спека витрины §2.3 «Не перечитаны»): строка и кнопка внутри
// блока «Старые правила» под тредом — «Цех» и окно проекта. POST /api/act ровно {action: 'reread', intentId, session};
// путей страница не шлёт — сервер берёт missing у пометки сам. Кнопки нет при выключенном звонке (/api/health → bell.on).
// Статус просьбы — из GET /api/actions?session=: последний reread этого треда со звонком (поле ring, §2.8).
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { hm } from './format.js';

const POLL_MS = 5000;
const FRESH_MS = 10 * 60_000; // «доставлено» моложе 10 минут, а Read в журнале ещё не виден — кнопка неактивна (§1.8)
const HEALTH_TTL_MS = 20_000;

// флаг звонка — один запрос на все блоки страницы; сбой чтения = «выключен» (кнопки нет, строка остаётся)
let health = { at: 0, p: null };
const bellOn = () => {
  if (!health.p || Date.now() - health.at > HEALTH_TTL_MS) {
    health = {
      at: Date.now(),
      p: fetch('/api/health', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.bell?.on === true).catch(() => false),
    };
  }
  return health.p;
};

async function lastReread(session) {
  const r = await fetch(`/api/actions?session=${encodeURIComponent(session)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const rows = await r.json();
  // ответ — от новых к старым; отказы (без звонка) ring не имеют и «просьбой в пути» не считаются
  return (Array.isArray(rows) ? rows : []).find((x) => x.action === 'reread' && x.ring) ?? null;
}

const inFlight = (row, now) => !!row && (row.ring === 'положено' || (row.ring === 'доставлено' && now - Date.parse(row.at) < FRESH_MS));
const sad = (ring) => /^(не доставлено|сброшено)/.test(ring);

function useReread(session, now) {
  const [on, setOn] = useState(false);
  const [row, setRow] = useState(null);
  const [act, setAct] = useState(null); // {phase: busy|refused|error|net, msg, payload}
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const [b, r] = await Promise.all([bellOn(), lastReread(session).catch(() => undefined)]);
    if (!alive.current) return;
    setOn(b);
    if (r !== undefined) setRow(r);
  }, [session]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh]);

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
    refresh();
  }, [refresh]);

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
