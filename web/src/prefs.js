// Удобства одного зрителя в localStorage: тема и свёрнутые блоки. Хранилища может не быть — всё в try/catch.
import { useCallback, useState } from 'react';

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, v) { try { localStorage.setItem(key, v); } catch { /* приватное окно — без памяти */ } }

const THEMES = ['auto', 'light', 'dark'];

export function useTheme() {
  const [theme, setState] = useState(() => { const t = read('ceh-theme'); return THEMES.includes(t) ? t : 'auto'; });
  const setTheme = useCallback((t) => {
    const root = document.documentElement;
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    write('ceh-theme', t);
    setState(t);
  }, []);
  return [theme, setTheme];
}

// Выбор зрителя, который помнится между заходами (фильтр «Готово, посмотри», EXT-79); чужое значение в хранилище — dflt.
export function useStored(key, dflt, valid) {
  const [v, setState] = useState(() => { const s = read(key); return s !== null && valid(s) ? s : dflt; });
  const set = useCallback((x) => { write(key, x); setState(x); }, [key]);
  return [v, set];
}

// Открыт ли блок <details>; по умолчанию — как в макете (открыт).
export function useOpen(key, dflt = true) {
  const [open, setState] = useState(() => { const v = read(`ceh-open:${key}`); return v === null ? dflt : v === '1'; });
  const onToggle = useCallback((e) => {
    const v = e.currentTarget.open;
    write(`ceh-open:${key}`, v ? '1' : '0');
    setState(v);
  }, [key]);
  return { open, onToggle };
}
