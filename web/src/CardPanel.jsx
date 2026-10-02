// Карточка — панель справа ~560 px без затемнения (решение Ивана 8, макет BBE73reeyzkCGzC3rrg9sd, версия 2); поля — спека §2.6, §3.3.
// Доска под панелью кликабельна: панель живёт, пока в адресе есть номер карточки (#/project/EXT/EXT-6), и меняет содержимое.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pollSource, useSource } from './data.js';
import { ageShort, dd, dm, hm, minutes, plural } from './format.js';
import { mdToHtml } from './md.js';
import { staleText } from './Ceh.jsx';

const GIT_STALE_MS = 90_000; // git опрашивается раз в 30 с (2.8): серая строка у коммитов — после трёх пропущенных проходов

export const STATUS = {
  backlog: 'Backlog', ready: 'В очереди', 'in-progress': 'В работе', review: 'Review', done: 'Done', cancelled: 'Отменена',
};

const LINKS = [
  ['parent', 'родитель'], ['blocks', 'блокирует'], ['blockedBy', 'блокирована'], ['relates', 'связана'],
  ['blockingIt', '← блокирует её'], ['relatedFrom', '← связана'], ['blockedByIt', '← ждёт её'], ['children', 'дети'],
];
const KIND = { comment: 'коммент', commit: 'коммит', run: 'агент' };
const FILTERS = [['all', 'Всё'], ['comment', 'Комменты'], ['commit', 'Коммиты'], ['run', 'Агенты']];
const RESULT = { 'готово': 'ok', 'работает': 'part' };

// Единственное место, где HTML вставляется готовым: только результат mdToHtml (markdown-it без HTML + DOMPurify).
function Md({ text, className }) {
  const html = useMemo(() => mdToHtml(text), [text]);
  return <div className={`md ${className || ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Links({ links, onOpen }) {
  const rows = LINKS.flatMap(([k, name]) => {
    const v = links?.[k];
    const list = v == null ? [] : Array.isArray(v) ? v : [v];
    return list.map((x, i) => ({ key: `${k}-${x.id}`, name: i === 0 ? name : '', x }));
  });
  if (!rows.length) return null;
  return (
    <div>
      <h4>Связи</h4>
      <div className="links">
        {rows.map((r) => (
          <div className="lk" key={r.key}>
            <span className="k">{r.name}</span>
            <button type="button" onClick={() => onOpen(r.x.id)}>
              <span className="id">{r.x.id}</span><span>{r.x.title || '—'}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Длинный коммент (у дирижёра бывают экранами) — свёрнут до нескольких строк, раскрывается по кнопке.
function Comment({ e }) {
  const ref = useRef(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { const el = ref.current; if (el && !open) setLong(el.scrollHeight > el.clientHeight + 2); }, [e.body, open]);
  return (
    <>
      {e.author && <span className="by">{e.author}</span>}
      <div ref={ref} className={open ? 'cm' : 'cm clamp'}><Md text={e.body} /></div>
      {(long || open) && <button type="button" className="unfold" onClick={() => setOpen((v) => !v)}>{open ? 'свернуть' : 'целиком'}</button>}
    </>
  );
}

function runLine(e) {
  return [
    `${plural(e.turnsTotal ?? 0, ['ход', 'хода', 'ходов'])} всего`,
    `заходов ${e.entries ?? '?'}`,
    `тормоз ${e.maxTurns ?? '?'}`,
    e.target != null ? `ориентир ${e.target}` : 'ориентира нет',
  ].join(', ');
}

function Ev({ e }) {
  let body;
  if (e.kind === 'commit') {
    body = <><span className="mono hash">{e.hash}</span> {e.subject}<span className="sm">{e.repo} · {e.branch || 'ветка не определена'}</span></>;
  } else if (e.kind === 'run') {
    const cls = RESULT[e.result] ?? (String(e.result).includes('PARTIAL') ? 'bad' : '');
    body = <><span className="by">{e.who || e.agent}</span>{e.description}<span className="sm">{runLine(e)} · <span className={cls}>{e.result || 'итог неизвестен'}</span></span></>;
  } else {
    body = <Comment e={e} />;
  }
  return (
    <div className="ev" data-t={e.kind}>
      <span className="tm num">{dm(e.at)}</span>
      <span className="ty" title={e.kind === 'comment' && e.logKind ? `запись журнала: ${e.logKind}` : undefined}>{KIND[e.kind] || e.kind}</span>
      <span className="bd">{body}</span>
    </div>
  );
}

function Feed({ data, filter, setFilter, now }) {
  const feed = data.feed || [];
  const counts = data.feedCounts || {};
  const shown = filter === 'all' ? feed : feed.filter((e) => e.kind === filter);
  const git = data.feedGit || {};
  const gitNote = git.readAt == null
    ? (git.failingSince ? `коммиты не читаются ${minutes(Date.parse(git.failingSince), now)}` : 'коммиты ещё читаются')
    : staleText({ lastOkAt: git.readAt, failingSince: git.failingSince }, false, now, GIT_STALE_MS);
  return (
    <div>
      <h4>Лента · новые сверху</h4>
      <div className="filt" role="group" aria-label="Фильтр ленты">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <span className="num muted">{k === 'all' ? feed.length : counts[k] ?? 0}</span>
          </button>
        ))}
      </div>
      {gitNote && (filter === 'all' || filter === 'commit') && <div className="note">{git.readAt == null ? gitNote : `коммиты: ${gitNote}`}</div>}
      {data.logError && filter !== 'commit' && filter !== 'run' && (
        <div className="note">журнал карточки не читается — комменты прежние</div>
      )}
      <div className="feed">
        {shown.map((e, i) => <Ev key={`${e.kind}-${e.at}-${e.hash || i}`} e={e} />)}
        {!shown.length && <div className="note">{feed.length ? 'Записей этого вида нет.' : 'Записей в ленте нет.'}</div>}
      </div>
    </div>
  );
}

function CardView({ id, now, onOpen, onClose, closeRef, filter, setFilter }) {
  const src = useMemo(() => pollSource(`/api/card/${encodeURIComponent(id)}`, 5000), [id]);
  const { data, failingSince, okAt, error } = useSource(src);
  const h = data?.header;
  const project = data?.project ?? id.split('-')[0]; // поле project ручки (5baefc7); префикс — пока ответа нет
  const stale = data && failingSince ? staleText({ lastOkAt: new Date(okAt).toISOString() }, true, now) : null;

  let body;
  if (!data) {
    body = <div className="note" role="status">
      {error === 'HTTP 404' ? `Карточки ${id} нет на доске.` : failingSince ? 'Сервер витрины не отвечает — пробую снова каждые 5 с.' : 'Читаю карточку…'}
    </div>;
  } else {
    body = <>
      {data.error && <div className="note">Шапка карточки не читается ({data.error}) — показываю, что прочиталось.</div>}
      <div className="desc">
        <h4>Описание</h4>
        {data.body?.trim() ? <Md text={data.body} /> : <div className="note">Описания нет.</div>}
      </div>
      <Links links={data.links} onOpen={onOpen} />
      <Feed data={data} filter={filter} setFilter={setFilter} now={now} />
    </>;
  }

  return (
    <>
      <div className="ph">
        <div className="ph1">
          <span className="id">{id}</span>
          {h?.status && <span className="stat">{STATUS[h.status] ?? h.status}</span>}
          {h?.mark_b && <span className="lbl b">Б</span>}
          {(h?.labels || []).map((l) => <span className="lbl" key={l}>{l}</span>)}
          <button ref={closeRef} type="button" className="close" aria-label="Закрыть карточку" title="Закрыть (Esc)" onClick={onClose}>×</button>
        </div>
        <h2 id="p-title">{h?.title ?? (data ? 'Карточка не читается' : id)}</h2>
        {h && (
          <div className="meta">
            {h.created && <span>создана {dd(h.created)}</span>}
            {h.updated && <span title={hm(h.updated, now)}>обновлена {ageShort(h.updated, now)} назад</span>}
            <span>проект {project}</span>
          </div>
        )}
        {stale && <div className="note">{stale}</div>}
      </div>
      <div className="pb">{body}</div>
    </>
  );
}

export default function CardPanel({ id, now, onOpen, onClose }) {
  const closeRef = useRef(null);
  // панель — под строкой шапки (слово Ивана 02.10): тема и свежесть всегда видны; высоту шапки меряем — на узком экране она в несколько строк
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const el = document.querySelector('.top');
    if (!el) return undefined;
    const set = () => setTop(el.offsetTop + el.offsetHeight);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [filter, setFilter] = useState('all'); // фильтр ленты живёт, пока панель открыта, и переживает смену карточки
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const on = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <aside className="panel" aria-labelledby="p-title" style={{ top }}>
      <CardView key={id} id={id} now={now} onOpen={onOpen} onClose={onClose} closeRef={closeRef} filter={filter} setFilter={setFilter} />
    </aside>
  );
}
