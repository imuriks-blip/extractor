// Кнопка «?» в шапке и окно «Как читать витрину» (§2.9, EXT-52). Текст — help.js, здесь только вид.
// Окно — <dialog> showModal: фокус заперт внутри, страница под ним не кликается. Закрывается крестиком, Escape
// и щелчком мимо (по подложке — сам <dialog>, содержимое занимает его целиком); фокус возвращается на «?».
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { HELP, HELP_TITLE } from './help.js';
import { Summary } from './Summary.jsx';

// **жирное** → <b>; прочее — текстом как есть
function Rich({ text }) {
  return text.split('**').map((s, i) => (i % 2 ? <b key={i}>{s}</b> : <Fragment key={i}>{s}</Fragment>));
}

export default function Help() {
  const btn = useRef(null);
  const dlg = useRef(null);
  const closeBtn = useRef(null);
  // номер открытия — ключ разделов: каждое открытие начинается с раскрытого первого (мелочь Голема)
  const [n, setN] = useState(0);
  // щелчок мимо — только если и нажатие было на подложке: выделение текста, отпущенное на подложке, окно не закрывает
  const downOnBackdrop = useRef(false);

  const open = useCallback(() => {
    const d = dlg.current;
    if (!d || d.open) return;
    setN((x) => x + 1);
    d.showModal();
    d.querySelector('.hlp-b')?.scrollTo(0, 0);
    closeBtn.current?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => { dlg.current?.close(); }, []);
  // Escape при открытой памятке перехватывается на window в фазе захвата — раньше слушателя панели карточки на
  // document (CardPanel): иначе тот же Escape закрывал и панель (проверено дирижёром в браузере, Важно Голема)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !dlg.current?.open) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dlg.current.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // любое закрытие (крестик, Escape, мимо) — фокус на «?», без прокрутки страницы
  const onClose = useCallback(() => { btn.current?.focus({ preventScroll: true }); }, []);

  return (
    <>
      <button ref={btn} type="button" className="hbtn" aria-label={HELP_TITLE} title={HELP_TITLE} aria-haspopup="dialog" onClick={open}>?</button>
      {/* tabIndex -1: щелчок по тексту оставляет фокус в окне, и Escape приходит сюда, а не на document
          (там его слушает панель карточки — закрылась бы заодно; Важно Голема) */}
      <dialog ref={dlg} className="hlp" aria-labelledby="hlp-title" onClose={onClose} tabIndex={-1}
        onMouseDown={(e) => { downOnBackdrop.current = e.target === dlg.current; }}
        onClick={(e) => { if (e.target === dlg.current && downOnBackdrop.current) close(); downOnBackdrop.current = false; }}
        // Escape закрываем сами и дальше не пускаем: иначе тот же Escape закроет и панель карточки под окном
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
        <div className="hlp-in" key={n}>
          <div className="hlp-h">
            <h2 id="hlp-title">{HELP_TITLE}</h2>
            <button ref={closeBtn} type="button" className="close" aria-label="Закрыть" onClick={close}>×</button>
          </div>
          <div className="hlp-b">
            {HELP.map((s, i) => (
              <details key={s.title} className="hlp-s" open={i === 0}>
                <Summary>{s.title}</Summary>
                {s.lead && <p><Rich text={s.lead} /></p>}
                {s.items && <ul>{s.items.map((t) => <li key={t}><Rich text={t} /></li>)}</ul>}
              </details>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
