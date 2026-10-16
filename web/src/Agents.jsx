// Кнопка «Агенты» в шапке и окно «Агенты цеха» (EXT-116, Р4; развилки А-1 (а), А-2 (а), А-4 (а)). Источник — GET /api/agents
// (сервер читает реестр ролей цеха в Vault и сверяет тормоз и модель с определениями агентов); окно только показывает:
// сверку не повторяет, реестр не правит. Запрос — при каждом открытии, как у словаря; пока ответ идёт — прежний.
// Окно — общее со словарём и памяткой (dialog.js); слова и пометки — agentsData.js.
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useDialog } from './dialog.js';
import { useNow } from './data.js';
import {
  COLS, MISSING, NOTHING, PROPOSAL_NOTE, DRIFT_HINT, TITLE,
  driftLine, errorLines, fieldMark, headLine, legendHead, roleTags, rolesTitle, searchRoles, searchSummary, sectionKind,
} from './agentsData.js';

let cache = null; // последний ответ с ролями — показ, пока идёт новый запрос

// `код` → моноширинно, **жирное** → жирным, *курсив* → курсивом; прочее — текстом
function Rich({ text }) {
  return String(text ?? '').split('`').map((s, i) => (i % 2
    ? <code key={i} className="mono">{s}</code>
    : <Fragment key={i}>{s.split('**').map((b, j) => (j % 2
      ? <b key={j}>{b}</b>
      : <Fragment key={j}>{b.split(/(?<![*\w])\*(?=\S)([^*]+?)\*(?![*\w])/).map((e, k) => (k % 2 ? <em key={k}>{e}</em> : e))}</Fragment>))}</Fragment>));
}

function Field({ role, k }) {
  const v = role.fields?.[k];
  const m = k === 'model' || k === 'brake' ? fieldMark(role, k) : null;
  if (m?.kind === 'drift') return <span className="ags-dr" title={m.title}>{m.text}</span>;
  return (
    <>
      {v == null ? <span className="faint">—</span> : <Rich text={v} />}
      {m && <span className="ags-un" title={m.title}> · {m.text}</span>}
    </>
  );
}

function Sections({ role, hits, all, onAll }) {
  const idx = hits && !all ? hits : role.sections.map((_, i) => i);
  const rest = role.sections.length - idx.length;
  return (
    <div className="ags-x">
      {role.status === 'proposal' && <p className="ags-note">{PROPOSAL_NOTE}</p>}
      {role.drift?.length > 0 && <p className="ags-note">Жёлтое: {DRIFT_HINT}.</p>}
      {role.problems?.length > 0 && <p className="ags-note">Разобрано не всё: {role.problems.join('; ')}.</p>}
      <dl className="ags-d">
        {idx.map((i) => {
          const s = role.sections[i];
          const kind = sectionKind(s.text);
          return (
            <Fragment key={s.title}>
              <dt>{s.title}</dt>
              <dd className={kind === 'none' ? 'faint' : kind === 'missing' ? 'ags-gray' : undefined}>{kind === 'missing' ? MISSING : <Rich text={s.text} />}</dd>
            </Fragment>
          );
        })}
      </dl>
      {rest > 0 && <button type="button" className="ags-more" onClick={onAll}>ещё {rest} без совпадения</button>}
    </div>
  );
}

function SummaryBlock({ items, forceOpen }) {
  if (!items.length) return null;
  return (
    <details className="ags-sum" open={forceOpen || undefined} key={forceOpen ? 'q' : 'n'}>
      <summary><span className="car" aria-hidden="true">›</span>Сводка<span className="cnt num">{items.length}</span></summary>
      {items.map((s) => (
        <section key={s.title} className="ags-ss">
          <h3>{s.title}</h3>
          {s.text && s.text.split('\n').map((p, i) => <p key={i}><Rich text={p} /></p>)}
          {s.head && (
            <div className="ags-sw"><table className="ags-st">
              <thead><tr>{s.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{(s.rows ?? []).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Rich text={c} /></td>)}</tr>)}</tbody>
            </table></div>
          )}
        </section>
      ))}
    </details>
  );
}

export default function Agents() {
  const { btn, dlg, close, dialogProps } = useDialog();
  const input = useRef(null);
  const [data, setData] = useState(cache);
  const [fail, setFail] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set()); // раскрытые роли (по строке файла); под поиском роль раскрыта сама, щелчок — все разделы или только с совпадением
  const [legendOpen, setLegendOpen] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    setFail(null);
    try {
      const r = await fetch('/api/agents', { cache: 'no-store' });
      if (!r.ok) throw new Error(`ответ ${r.status}`);
      const j = await r.json();
      if (j.roles?.length) cache = j;
      setData(j);
    } catch (e) {
      setFail(e?.message || 'нет ответа');
    }
  }, []);

  const show = useCallback(() => {
    const d = dlg.current;
    if (!d || d.open) return;
    d.showModal();
    d.querySelector('.hlp-b')?.scrollTo(0, 0);
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    load();
  }, [dlg, load]);

  const toggle = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // щелчок по строке раскрывает; выделение текста мышью — не щелчок
  const onRow = (key) => { if (!window.getSelection()?.toString()) toggle(key); };

  const roles = data?.roles ?? [];
  const searching = q.trim() !== '';
  const shown = useMemo(() => searchRoles(roles, q), [roles, q]);
  const summary = useMemo(() => searchSummary(data?.summary, q), [data, q]);
  const head = headLine(data);
  const drift = data && roles.length ? driftLine(data) : null;
  const legend = legendHead(data?.legend);
  const err = errorLines(data, now);

  let body;
  if (fail && !roles.length) body = <p className="gls-m">реестр не читается: {fail}</p>;
  else if (!data) body = <p className="gls-m">читаю реестр…</p>;
  else if (!roles.length) body = null; // ошибка — строкой над списком; ролей нет — только она
  else if (!shown.length && !summary.length) body = <p className="gls-m">{NOTHING}</p>;
  else body = (
    <>
      {shown.length > 0 && (
        <table className="ags-t">
          <thead><tr><th className="a-name">роль</th>{COLS.map(([k, h]) => <th key={k} className={`a-${k}`}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map(({ role, hits }) => {
              const key = role.line ?? role.name;
              const expanded = hits ? true : open.has(key);
              const tags = roleTags(role);
              return (
                <Fragment key={key}>
                  <tr className={`ags-r${role.status === 'proposal' ? ' prop' : ''}${expanded ? ' on' : ''}`} onClick={() => onRow(key)}>
                    <td className="a-name">
                      <button type="button" className="ags-n" aria-expanded={expanded}>
                        <span className="car" aria-hidden="true">›</span>{role.name}
                      </button>
                      {tags.map((t) => <span key={t.kind} className={`tag ags-tg ${t.kind}`} title={t.title}>{t.text}</span>)}
                    </td>
                    {COLS.map(([k, h]) => <td key={k} className={`a-${k}`} data-k={h}><Field role={role} k={k} /></td>)}
                  </tr>
                  {expanded && (
                    <tr className="ags-xr"><td colSpan={COLS.length + 1}>
                      <Sections role={role} hits={hits} all={open.has(key)} onAll={() => toggle(key)} />
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <SummaryBlock items={summary} forceOpen={searching} />
    </>
  );

  return (
    <>
      <button ref={btn} type="button" className="hbtn" title={TITLE} aria-haspopup="dialog" onClick={show}>Агенты</button>
      <dialog {...dialogProps} className="hlp gls ags" aria-labelledby="ags-title">
        <div className="hlp-in">
          <div className="hlp-h">
            <h2 id="ags-title">{TITLE}{roles.length > 0 && <span className="muted"> · {rolesTitle(roles.length)}</span>}</h2>
            <button type="button" className="close" aria-label="Закрыть" onClick={close}>×</button>
          </div>
          <div className="gls-f">
            {(head || drift) && (
              <p className="ags-m">
                {head}{head && drift && <span className="sep"> · </span>}
                {drift && <span className={drift.warn ? 'ags-warn' : 'ags-gray'}>{drift.text}</span>}
              </p>
            )}
            {err && <p className="ags-m ags-err">{err.error}</p>}
            {err?.stale && <p className="ags-m ags-gray">{err.stale}</p>}
            {fail && roles.length > 0 && <p className="ags-m ags-gray">не удалось обновить: {fail} · показан прежний ответ</p>}
            {data?.problems?.length > 0 && <p className="ags-m ags-gray">{data.problems.join(' · ')}</p>}
            {legend && (
              <button type="button" className="ags-lg" aria-expanded={legendOpen} onClick={() => setLegendOpen((x) => !x)}>
                <Rich text={legend.head} />
                {legend.rest && (legendOpen
                  ? <> {legend.rest.split('\n').map((p, i) => <Fragment key={i}>{i > 0 && <br />}<Rich text={p} /></Fragment>)}</>
                  : <span className="ags-lgm"> …</span>)}
              </button>
            )}
            <input ref={input} className="gls-q" type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Найти: кто, что пишет, что запрещено" aria-label="Найти в реестре ролей" />
          </div>
          <div className="hlp-b">{body}</div>
        </div>
      </dialog>
    </>
  );
}
