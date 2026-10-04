// Общее у окон шапки — памятки «?» (§2.9, EXT-52) и словаря (§2.10, EXT-61). Окно — <dialog> showModal: фокус заперт
// внутри, страница под ним не кликается. Закрывается крестиком, Escape и щелчком мимо (по подложке — сам <dialog>,
// содержимое занимает его целиком); фокус возвращается на кнопку, которая окно открыла.
import { useCallback, useEffect, useMemo, useRef } from 'react';

export function useDialog() {
  const btn = useRef(null);
  const dlg = useRef(null);
  // щелчок мимо — только если и нажатие было на подложке: выделение текста, отпущенное на подложке, окно не закрывает
  const downOnBackdrop = useRef(false);

  const close = useCallback(() => { dlg.current?.close(); }, []);
  // Escape при открытом окне перехватывается на window в фазе захвата — раньше слушателя панели карточки на
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

  // tabIndex -1: щелчок по тексту оставляет фокус в окне, и Escape приходит сюда, а не на document
  // (там его слушает панель карточки — закрылась бы заодно; Важно Голема)
  const dialogProps = useMemo(() => ({
    ref: dlg,
    tabIndex: -1,
    // любое закрытие (крестик, Escape, мимо) — фокус на кнопку, без прокрутки страницы
    onClose: () => { btn.current?.focus({ preventScroll: true }); },
    onMouseDown: (e) => { downOnBackdrop.current = e.target === dlg.current; },
    onClick: (e) => { if (e.target === dlg.current && downOnBackdrop.current) close(); downOnBackdrop.current = false; },
    // Escape закрываем сами и дальше не пускаем: иначе тот же Escape закроет и панель карточки под окном
    onKeyDown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } },
  }), [close]);

  return { btn, dlg, close, dialogProps };
}
