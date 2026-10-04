// Кнопка «?» в шапке и окно «Как читать витрину» (§2.9, EXT-52). Текст — help.js, здесь только вид.
// Окно — общее со словарём (dialog.js): Escape с перехватом на window, щелчок мимо, фокус назад на «?».
import { Fragment, useCallback, useRef, useState } from 'react';
import { useDialog } from './dialog.js';
import { HELP, HELP_TITLE } from './help.js';
import { Summary } from './Summary.jsx';

// **жирное** → <b>; прочее — текстом как есть
function Rich({ text }) {
  return text.split('**').map((s, i) => (i % 2 ? <b key={i}>{s}</b> : <Fragment key={i}>{s}</Fragment>));
}

export default function Help() {
  const { btn, dlg, close, dialogProps } = useDialog();
  const closeBtn = useRef(null);
  // номер открытия — ключ разделов: каждое открытие начинается с раскрытого первого (мелочь Голема)
  const [n, setN] = useState(0);

  const open = useCallback(() => {
    const d = dlg.current;
    if (!d || d.open) return;
    setN((x) => x + 1);
    d.showModal();
    d.querySelector('.hlp-b')?.scrollTo(0, 0);
    closeBtn.current?.focus({ preventScroll: true });
  }, [dlg]);

  return (
    <>
      <button ref={btn} type="button" className="hbtn" aria-label={HELP_TITLE} title={HELP_TITLE} aria-haspopup="dialog" onClick={open}>?</button>
      <dialog {...dialogProps} className="hlp" aria-labelledby="hlp-title">
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
