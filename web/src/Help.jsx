// Кнопка «?» в шапке и окно «Как читать витрину» (§2.9, EXT-52). Текст — help.js, здесь только вид.
// Окно — <dialog> showModal: фокус заперт внутри, страница под ним не кликается. Закрывается крестиком, Escape
// и щелчком мимо (по подложке — сам <dialog>, содержимое занимает его целиком); фокус возвращается на «?».
import { Fragment, useCallback, useRef } from 'react';
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

  const open = useCallback(() => {
    const d = dlg.current;
    if (!d || d.open) return;
    d.showModal();
    d.querySelector('.hlp-b')?.scrollTo(0, 0);
    closeBtn.current?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => { dlg.current?.close(); }, []);
  // любое закрытие (крестик, Escape, мимо) — фокус на «?», без прокрутки страницы
  const onClose = useCallback(() => { btn.current?.focus({ preventScroll: true }); }, []);

  return (
    <>
      <button ref={btn} type="button" className="hbtn" aria-label={HELP_TITLE} title={HELP_TITLE} aria-haspopup="dialog" onClick={open}>?</button>
      <dialog ref={dlg} className="hlp" aria-labelledby="hlp-title" onClose={onClose}
        onClick={(e) => { if (e.target === dlg.current) close(); }}
        // Escape закрываем сами и дальше не пускаем: иначе тот же Escape закроет и панель карточки под окном
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
        <div className="hlp-in">
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
