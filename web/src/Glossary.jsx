// Кнопка «Словарь» в шапке и окно «Словарь цеха» (§2.10, EXT-61). Источник — GET /api/glossary (сервер читает
// unorbis/Словарь.md); окно только читает. Запрос — при каждом открытии (сервер держит кэш по времени изменения
// файла, повтор дешёвый): термин, дописанный Демоном, виден без перезагрузки; пока ответ идёт — прежний удачный.
// Окно — общее с памяткой (dialog.js).
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useDialog } from './dialog.js';
import { plural } from './format.js';

const TITLE = 'Словарь цеха';
const COLS = [['term', 'термин'], ['ru', 'по-русски'], ['meaning', 'что это у нас'], ['example', 'пример']];

let cache = null; // последний удачный ответ — показ, пока идёт новый запрос

// `код` → моноширинно; прочее — текстом как есть
function Ticks({ text }) {
  return String(text ?? '').split('`').map((s, i) => (i % 2 ? <code key={i} className="mono">{s}</code> : <Fragment key={i}>{s}</Fragment>));
}

// без регистра, ё = е, обратные кавычки не мешают поиску
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/`/g, '');

export default function Glossary() {
  const { btn, dlg, close, dialogProps } = useDialog();
  const input = useRef(null);
  const [data, setData] = useState(cache);
  const [fail, setFail] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setFail(null);
    try {
      const r = await fetch('/api/glossary', { cache: 'no-store' });
      if (!r.ok) throw new Error(`ответ ${r.status}`);
      const j = await r.json();
      if (!j.error) cache = j;
      setData(j);
    } catch (e) {
      setFail(e?.message || 'нет ответа');
    }
  }, []);

  const open = useCallback(() => {
    const d = dlg.current;
    if (!d || d.open) return;
    d.showModal();
    d.querySelector('.hlp-b')?.scrollTo(0, 0);
    // фокус в поиск; прежний запрос выделен — новый ввод его заменит
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    load();
  }, [dlg, load]);

  const sections = data?.sections ?? [];
  const total = sections.reduce((a, s) => a + (s.rows?.length ?? 0), 0);
  const query = norm(q.trim());
  const shown = useMemo(() => (query
    ? sections.map((s) => ({ ...s, rows: (s.rows ?? []).filter((r) => COLS.some(([k]) => norm(r[k]).includes(query))) }))
      .filter((s) => s.rows.length)
    : sections), [sections, query]);

  const error = fail ?? data?.error;
  let body;
  if (error) body = <p className="gls-m">словарь не читается: {error}</p>;
  else if (!data) body = <p className="gls-m">читаю словарь…</p>;
  else if (!shown.length) body = <p className="gls-m">{query ? 'нет таких терминов' : 'словарь пуст'}</p>;
  else body = shown.map((s) => (
    <section key={s.title} className="gls-s">
      <h3>{s.title}{query && <span className="cnt num">{s.rows.length}</span>}</h3>
      <table className="gls-t">
        <thead><tr>{COLS.map(([k, h]) => <th key={k} className={`g-${k}`}>{h}</th>)}</tr></thead>
        <tbody>
          {s.rows.map((r, i) => (
            <tr key={`${r.term}-${i}`}>
              {COLS.map(([k]) => <td key={k} className={`g-${k}`}><Ticks text={r[k]} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  ));

  return (
    <>
      <button ref={btn} type="button" className="hbtn" title={TITLE} aria-haspopup="dialog" onClick={open}>Словарь</button>
      <dialog {...dialogProps} className="hlp gls" aria-labelledby="gls-title">
        <div className="hlp-in">
          <div className="hlp-h">
            <h2 id="gls-title">{TITLE}{total > 0 && <span className="muted"> · {plural(total, ['термин', 'термина', 'терминов'])}</span>}</h2>
            <button type="button" className="close" aria-label="Закрыть" onClick={close}>×</button>
          </div>
          <div className="gls-f">
            <input ref={input} className="gls-q" type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Найти: термин, перевод, смысл, пример" aria-label="Найти в словаре" />
          </div>
          <div className="hlp-b">{body}</div>
        </div>
      </dialog>
    </>
  );
}
