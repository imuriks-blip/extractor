// Меню «Служебное» в шапке (EXT-87, спека витрины §2.11; спека пульта §1.3 «Меню «Служебное» в шапке»; слово Ивана 09.10).
// Кнопка — рядом со «Словарём» и «?» на всех экранах; пункты: «Обновить», «Полный проход зеркала» (второй щелчок — внутри
// меню), «Пересобрать индекс» (EXT-75), «Замерить остаток» (measure.js). У каждого — серая подпись о прошлом исходе или ходе.
// Меню раскрывается под кнопкой, ничего не затемняет; закрывается щелчком мимо, Escape (только меню; панель карточки под ним не
// закрывается) и повторным щелчком; закрытие сбрасывает ждущее подтверждение полного прохода (dropConfirm).
// Строки «Обновить» и «Полный проход зеркала» — из Mirror.jsx (общее состояние зеркала; ход и итог — в шапке, MirrorStatus).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clear403, postAct, reloadOn403, take403 } from './act.js';
import { measure, loadUsage, useMeasure } from './measure.js';
import { FullMirror, RefreshMirror, dropConfirm } from './Mirror.jsx';
import { isRefusal, readMirror, reindexLine } from './mirrorData.js';
import { measureMenuLine } from './usageData.js';

const POLL_MS = 3000;

export function ServiceMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const [ri, setRi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {cls, text}: итог нажатия «Пересобрать индекс» — отказ словами; пропадает, как только пришли данные
  const resent = useRef(false);
  const m = useMeasure();
  // меню шире кнопки: у правого края окна — выравнивается по правому краю кнопки, иначе (кнопка перенеслась влево) — по левому
  const [alignLeft, setAlignLeft] = useState(false);
  useLayoutEffect(() => {
    if (open && btn.current) setAlignLeft(btn.current.getBoundingClientRect().right - 440 >= 0 ? false : true);
  }, [open]);

  const check = useCallback(async () => {
    try { const x = await readMirror(); setRi(x.reindex ?? null); return x.reindex ?? null; } catch { return null; }
  }, []);
  const running = !!ri?.running;

  const close = useCallback((toButton) => {
    setOpen(false);
    dropConfirm(); // закрыл меню — ждущее подтверждение полного сбрасывается
    if (toButton) btn.current?.focus({ preventScroll: true });
  }, []);

  // открыто: свежее состояние пересбора и замера; идут — опрос
  useEffect(() => { if (open) { check(); loadUsage(); } }, [open, check]);
  const measuring = m.busy || m.u?.measuring === true;
  useEffect(() => {
    if (!open || !(running || measuring)) return undefined;
    const t = setInterval(() => { if (running) check(); if (measuring) loadUsage(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, running, measuring, check]);
  // идущий пересбор видно и при закрытом меню (кнопка подсвечена), поэтому состояние читается раз при монтировании
  useEffect(() => { check(); }, [check]);

  // закрытие: щелчок мимо и Escape. Escape ловится на window в фазе захвата — раньше слушателя панели карточки на document
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!wrap.current?.contains(e.target)) close(false); };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open, close]);
  // уход с экрана при открытом меню (смена маршрута) — подтверждение не остаётся
  useEffect(() => () => dropConfirm(), []);

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

  // после перезагрузки на 403 — то же намерение тем же ключом (меню смонтировано всегда, кнопка в шапке)
  useEffect(() => {
    if (resent.current) return;
    resent.current = true;
    const prev = take403((p) => p.action === 'reindex' || p.action === 'measure');
    if (prev?.action === 'reindex') go(prev);
    else if (prev?.action === 'measure') measure(prev);
  }, [go]);

  const line = reindexLine(ri);
  const mLine = m.busy || m.u?.measuring ? { cls: 'going', text: 'замеряю… до минуты' } : m.note ?? (m.u ? measureMenuLine(m.u) : { cls: 'faint', text: 'читаю состояние…' });
  return (
    <span className="smw" ref={wrap}>
      <button ref={btn} type="button" className={`hbtn${open ? ' on' : ''}${running || measuring ? ' going' : ''}`} aria-haspopup="true" aria-expanded={open}
        title="Обновить зеркало доски, пересобрать индекс, замерить остаток" onClick={() => (open ? close(true) : setOpen(true))}>Служебное</button>
      {open && (
        <div className={`smenu${alignLeft ? ' left' : ''}`} role="group" aria-label="Служебное">
          <RefreshMirror shown={open} />
          <FullMirror />
          <div className="wtb">
            <button type="button" className="pbtn" disabled={busy || running} title="Заново прочитать журналы тредов и пересобрать индекс; витрина всё это время показывает прежние данные"
              onClick={() => go({ action: 'reindex', intentId: crypto.randomUUID() })}>{running ? 'идёт…' : 'Пересобрать индекс'}</button>
            <span className={msg && !running ? msg.cls : line.cls} role="status">{msg && !running ? msg.text : line.text}</span>
          </div>
          <div className="wtb">
            <button type="button" className="pbtn" disabled={measuring} title="Одна короткая сессия Claude: узнать, сколько осталось в 5-часовом и недельном окне (до минуты)"
              onClick={() => measure()}>{measuring ? 'замеряю…' : 'Замерить остаток'}</button>
            <span className={mLine.cls} role="status">{mLine.text}</span>
          </div>
        </div>
      )}
    </span>
  );
}
