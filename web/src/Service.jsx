// «Служебное» на «Цехе» (EXT-75, ПТ8; спека пульта §1.3 «Пересобрать индекс», §1.4): кнопка пересбора индекса читателя
// журналов. POST /api/act {action: "reindex"} — без второго щелчка (пересчитываемое, уровень А); ход и время — из
// GET /api/mirror → reindex {running, done, total, lastAt, lastMs, lastFiles, lastError}. «Уже идёт» (409) — не ошибка.
// Строки блока: «Обновить» (Mirror.jsx, RefreshMirror; из шапки — EXT-77, слово Ивана 06.10), «Полный проход зеркала»
// (FullMirror; из шапки — решение Ивана 05.10) — две кнопки зеркала подряд, — затем «Пересобрать индекс».
import { useCallback, useEffect, useRef, useState } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { FullMirror, RefreshMirror } from './Mirror.jsx';
import { isRefusal, readMirror, reindexLine } from './mirrorData.js';
import { useOpen } from './prefs.js';
import { Summary } from './Summary.jsx';

const POLL_MS = 3000;

export function Service() {
  const o = useOpen('service', false);
  const [ri, setRi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {cls, text}: итог нажатия — отказ словами; пропадает, как только пришли данные
  const resent = useRef(false);

  const check = useCallback(async () => {
    try { const m = await readMirror(); setRi(m.reindex ?? null); return m.reindex ?? null; } catch { return null; }
  }, []);
  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    if (!ri?.running) return undefined;
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [ri?.running, check]);

  const go = useCallback(async (payload) => {
    setBusy(true);
    setMsg(null);
    let r;
    try { r = await postAct(payload); } catch { setMsg({ cls: 'pbad', text: 'нет связи с витриной' }); setBusy(false); return; }
    if (r.status === 403) {
      if (reloadOn403(payload)) return;
      setMsg({ cls: 'pbad', text: 'пульт отказал, перезапусти витрину (ответ 403 дважды подряд)' });
    } else {
      clear403(payload.intentId);
      const b = r.body || {};
      if (r.status === 409 && isRefusal(b, 'reindex-running')) setMsg({ cls: 'muted', text: 'уже идёт' });
      else if (r.status === 501) setMsg({ cls: 'muted', text: 'ещё не подключено' });
      else if (r.status < 200 || r.status >= 300) setMsg({ cls: 'pbad', text: b.message || `ошибка: HTTP ${r.status}` });
      await check();
    }
    setBusy(false);
  }, [check]);

  // после перезагрузки на 403 — то же намерение тем же ключом
  useEffect(() => {
    if (resent.current) return;
    resent.current = true;
    const prev = take403((p) => p.action === 'reindex');
    if (prev) go(prev);
  }, [go]);

  const line = reindexLine(ri);
  const running = !!ri?.running;
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle} aria-label="Служебное">
      <Summary>Служебное{running && !o.open && <span className="hint going" role="status">{line.text}</span>}</Summary>
      <RefreshMirror shown={o.open} />
      <FullMirror />
      <div className="wtb">
        <button type="button" className="pbtn" disabled={busy || running} title="Заново прочитать журналы тредов и пересобрать индекс; витрина всё это время показывает прежние данные"
          onClick={() => go({ action: 'reindex', intentId: crypto.randomUUID() })}>{running ? 'идёт…' : 'Пересобрать индекс'}</button>
        <span className={msg && !running ? msg.cls : line.cls} role="status">{msg && !running ? msg.text : line.text}</span>
      </div>
    </details>
  );
}
