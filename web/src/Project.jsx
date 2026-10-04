// Окно проекта — по макету BBE73reeyzkCGzC3rrg9sd (версия 2), поля — спека §3.2: маячок полосой, доска слева,
// «Ждёт меня по <КОД>» и «Кто работает по <КОД>» справа; карточка — панелью (CardPanel.jsx).
import { useState } from 'react';
import { useOpen } from './prefs.js';
import { ageShort, hm, minutes, plural } from './format.js';
import { Mark, Stale, Thread, mergeFresh, staleText, useShowMore } from './Ceh.jsx';
import { Summary } from './Summary.jsx';
import CardPanel from './CardPanel.jsx';
import { PultMark } from './Pult.jsx';
import { TraceBadge } from './Trace.jsx';
import { DeferBtn, DeferNote, Deferred } from './Defer.jsx';

const GIT_STALE_MS = 90_000; // git опрашивается раз в 30 с (2.8)
const DONE_SHOWN = 5; // 2.5: в Done видны 5 последних, остальные — поиском
const COLS = [['inProgress', 'В работе'], ['ready', 'В очереди'], ['review', 'Review']];

/* ---------- маячок ---------- */

// Одноимённые папки (несколько рабочих копий «wt») различаем родительской папкой; полный путь — в подсказке.
function repoLabels(repos) {
  const n = {};
  repos.forEach((r) => { n[r.name] = (n[r.name] || 0) + 1; });
  return repos.map((r) => {
    if (n[r.name] < 2) return r.name;
    const parts = String(r.path || '').split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? `${parts[parts.length - 2]}/${r.name}` : r.name;
  });
}

function Repo({ r, label }) {
  let dot = 'off', state;
  if (r.error) state = <span>статус не читается</span>;
  else if (r.missing) state = <span>папки нет</span>;
  else if (r.dirty == null) state = <span>не прочитано</span>;
  else if (r.dirty === 0) { dot = 'ok'; state = <span className="muted">чисто</span>; }
  else { dot = 'dirty'; state = <span className="amb">{plural(r.dirty, ['изменение не закоммичено', 'изменения не закоммичены', 'изменений не закоммичены'])}</span>; }
  const tip = [r.path, r.error && `ошибка чтения: ${r.error}`].filter(Boolean).join('\n');
  return (
    <span className={dot === 'off' ? 'repo off' : 'repo'} title={tip}>
      <span className="l">{label}</span><span className={`dot ${dot}`} />
      {r.branch && <><span className="mono">{r.branch}</span> </>}{state}
    </span>
  );
}

function Beacon({ b, failing, now }) {
  const labels = repoLabels(b.repos || []);
  const gitStale = b.repos?.length ? staleText({ lastOkAt: b.readAt, failingSince: b.failingSince }, failing, now, GIT_STALE_MS) : null;
  return (
    <div className="beacon">
      {b.described === false
        ? <span className="faint">{b.message || 'проект не описан в реестре'}</span>
        : <>
            {/* не выше двух строк с «…»; целиком — во всплывающей подсказке (слово Ивана 02.10, как на «Цехе») */}
            <span className="cl2" title={b.phase || undefined}><span className="l">фаза</span>{b.phase ? <span className="phase">{b.phase}</span> : <span className="faint">фаза не указана в карточке проекта</span>}</span>
            <span className="cl2" title={b.next || undefined}><span className="l">следующий шаг</span>{b.next ?? <span className="faint">—</span>}</span>
          </>}
      {(b.repos || []).map((r, i) => <Repo key={r.path || r.name} r={r} label={labels[i]} />)}
      {b.phaseFailingSince && (
        <span className="bstale">фаза и шаг: данные на {hm(b.phaseReadAt, now)}, чтение не удаётся {minutes(Date.parse(b.phaseFailingSince), now)}</span>
      )}
      {gitStale && <span className="bstale">репозитории: {gitStale}</span>}
    </div>
  );
}

/* ---------- доска ---------- */

function CardBtn({ c, sel, onOpen, now }) {
  const last = c.lastLog ? `${c.lastLog.author ? `${c.lastLog.author}: ` : ''}${c.lastLog.text}` : null;
  return (
    <button type="button" className="card" data-id={c.id} aria-current={sel === c.id ? 'true' : undefined} onClick={() => onOpen(c.id)}>
      <span className="c1">
        <span className="id">{c.id}</span>
        {c.markB && <span className="lbl b" title="метка Б: нужно твоё «да»">Б</span>}
        {c.label && <span className="lbl">{c.label}</span>}
        <span className="age num">{ageShort(c.at, now)}</span>
      </span>
      <span className="t">{c.title}</span>
      {c.agentWorking && <span className="who">{c.agentWorking} работает</span>}
      <span className="lc" title={last || undefined}>{last ?? '—'}</span>
    </button>
  );
}

function ListGroup({ id, title, items, shown, hint, sel, onOpen, now }) {
  const o = useOpen(`pgrp-${id}`, false);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const hits = query ? items.filter((c) => `${c.id} ${c.title}`.toLowerCase().includes(query)) : items;
  const list = !query && shown ? hits.slice(0, shown) : hits;
  const rest = hits.length - list.length;
  return (
    <details className="grp" open={o.open} onToggle={o.onToggle}>
      <Summary>{title} <span className="cnt num">{items.length}</span>{hint && <span className="hint">{hint}</span>}</Summary>
      {items.length > 0 && (
        <input className="srch" type="search" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} placeholder={`Найти в ${title}`} aria-label={`Найти в ${title}`} />
      )}
      {list.map((c) => (
        <button type="button" key={c.id} className="lrow" data-id={c.id} aria-current={sel === c.id ? 'true' : undefined} onClick={() => onOpen(c.id)}>
          <span className="id">{c.id}</span>
          <span className="tt">{c.title}</span>
          {c.cancelled ? <span className="lb lbl">отменена</span> : c.label ? <span className="lb lbl">{c.label}</span> : <span className="lb" />}
          <span className="age num">{ageShort(c.at, now)}</span>
        </button>
      ))}
      {!items.length && <div className="lmore">Пусто.</div>}
      {query && !hits.length && items.length > 0 && <div className="lmore">Не нашлось.</div>}
      {rest > 0 && <div className="lmore">ещё {rest} — найдутся поиском</div>}
    </details>
  );
}

function Board({ code, b, sel, onOpen, now, stale }) {
  const o = useOpen('pboard');
  const cnt = b.counts || {};
  return (
    <details className="blk pboard" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Доска {code} <span className="cnt num">{plural(cnt.live ?? 0, ['живая', 'живые', 'живых'])} · {cnt.backlog ?? 0} в Backlog · {cnt.done ?? 0} Done</span>
        <span className="hint hsm">клик по карточке открывает её справа</span>
      </Summary>
      <div className="cols">
        {COLS.map(([k, name]) => (
          <section key={k} aria-label={name}>
            <h3>{name} <span className="n num">{b[k]?.length ?? 0}</span></h3>
            {(b[k] || []).map((c) => <CardBtn key={c.id} c={c} sel={sel} onOpen={onOpen} now={now} />)}
            {!b[k]?.length && <span className="faint cempty">пусто</span>}
          </section>
        ))}
      </div>
      <ListGroup id="backlog" title="Backlog" items={b.backlog || []} sel={sel} onOpen={onOpen} now={now} />
      <ListGroup id="done" title="Done" items={b.done || []} shown={DONE_SHOWN} hint="последние сверху" sel={sel} onOpen={onOpen} now={now} />
      <Stale text={stale} />
    </details>
  );
}

/* ---------- ждёт меня по проекту: плоский список (2.4) ---------- */

const ageOf = (r, now) => ageShort(r.group === 'review' ? r.at : r.since, now);

// «Отложить» (EXT-47) — у строки с key, кроме «отвечено, ждёт зеркала»: строка-кнопка карточки и «Отложить» рядом,
// не вложенно; давность и «Отложить» — одной колонкой справа (давность над кнопкой), чтобы текст не сжимался
function WRow(props) {
  const { r, now, options } = props;
  if (!r.key || r.keyTemp || r.answered) return <WRowBody {...props} />;
  return (
    <div className="pwr">
      <WRowBody {...props} noAge />
      <span className="age num">{ageOf(r, now)}</span>
      <DeferBtn rowKey={r.key} options={options} name={r.group === 'thread' ? `тред ${r.title || ''}`.trim() : r.id} />
      <DeferNote rowKey={r.key} />
    </div>
  );
}

function WRowBody({ r, now, sel, onOpen, noAge = false }) {
  const age = noAge ? null : <span className="age num">{ageOf(r, now)}</span>;
  if (r.group === 'thread') {
    return (
      <div className="prow" title={r.title}>
        <span className="src"><span className="k">тред</span></span>
        <span>
          {r.overDay && <span className="tag r">ждёт больше суток</span>}{r.text}
          {r.projectBy === 'cards' && <span className="faint"> · по карточкам</span>}
        </span>
        {age}
      </div>
    );
  }
  const yes = r.group === 'yes';
  return (
    <button type="button" className={r.answered ? 'prow ans' : 'prow'} aria-current={sel === r.id ? 'true' : undefined} onClick={() => onOpen(r.id)}>
      <span className="src">{r.id}</span>
      <span>{yes ? <span className={r.mark === 'Б' ? 'tag b' : 'tag'}>{r.mark}</span> : <span className="tag">Review</span>}{r.title}
        {!yes && !r.answered && <TraceBadge t={r.trace} />}
        {r.answered && <PultMark m={r.pultMark} />}</span>
      {age}
    </button>
  );
}

function PWaiting({ code, rows, cnt, deferred, options, now, stale, sel, onOpen }) {
  const o = useOpen('pwaiting');
  const threadWaits = rows.some((r) => r.group === 'thread');
  // (а) и (б) — целиком; (в) Review — 10 свежих и «Показать ещё N», как на «Цехе»
  // отвечено с витрины, ждёт зеркала (§3.2) — серым в конце, вне числа
  const answered = rows.filter((r) => r.answered);
  const [review, moreReview] = useShowMore(rows.filter((r) => r.group === 'review' && !r.answered), undefined, 'more flat');
  const shown = [...rows.filter((r) => r.group !== 'review' && !r.answered), ...review];
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Ждёт меня по {code} <span className="cnt num">{cnt?.count ?? 0}</span>
        {cnt?.more > 0 && <span className="hint">+ {cnt.more} посмотреть</span>}
      </Summary>
      {!threadWaits && <div className="empty">Тред {code} не ждёт ответа</div>}
      {shown.map((r) => <WRow key={r.key || `${r.group}-${r.id}`} r={r} now={now} sel={sel} onOpen={onOpen} options={options} />)}
      {moreReview}
      {answered.length > 0 && <div className="empty">Отвечено, ждёт зеркала · {answered.length}</div>}
      {answered.map((r) => <WRow key={`a-${r.group}-${r.id}`} r={r} now={now} sel={sel} onOpen={onOpen} />)}
      <Deferred list={deferred} flat />
      <Stale text={stale} />
    </details>
  );
}

/* ---------- кто работает по проекту ---------- */

const isRed = (m) => m.kind !== 'takt' || m.level === 'red'; // как marksCount «Цеха»: только красные

function PWorkers({ code, w, now, stale }) {
  const o = useOpen('pworkers');
  const threads = w.threads || [], closed = w.closed || [];
  const subs = threads.reduce((n, t) => n + (t.subagents?.length || 0), 0);
  const marks = [...threads, ...closed].reduce((n, t) => n + (t.marks || []).filter(isRed).length, 0);
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Кто работает по {code} <span className="cnt num">{plural(threads.length, ['тред', 'треда', 'тредов'])} · {plural(subs, ['субагент', 'субагента', 'субагентов'])}</span>
        {marks > 0 && <span className="hint red">{plural(marks, ['пометка', 'пометки', 'пометок'])}</span>}
      </Summary>
      {threads.map((t) => <Thread key={t.sessionId} t={t} now={now} />)}
      {/* В-6 (б): закрытый тред с обрывом или тактом без ответа — строкой «тред закрыт» */}
      {closed.map((t) => (
        <div className="thr" key={t.sessionId}>
          <div className="th1"><span className="tname">{t.title || 'без названия'}</span><span className="st old">тред закрыт</span></div>
          {(t.marks || []).map((m, i) => <Mark key={`${m.kind}-${i}`} m={m} now={now} />)}
        </div>
      ))}
      {!threads.length && !closed.length && <div className="empty">Живых тредов по {code} нет.</div>}
      <Stale text={stale} />
    </details>
  );
}

/* ---------- экран ---------- */

export default function Project({ code, data, failing, now, cardId, onOpenCard, onCloseCard }) {
  const f = data.freshness || {};
  return (
    <>
      <Beacon b={data.beacon || {}} failing={failing} now={now} />
      <div className="pgrid">
        <div className="col">
          <Board code={code} b={data.board || {}} sel={cardId} onOpen={onOpenCard} now={now} stale={staleText(f.board, failing, now)} />
        </div>
        <div className="col">
          <PWaiting code={code} rows={data.waiting || []} cnt={data.waitingCount} deferred={data.deferred} options={data.deferOptions} now={now} sel={cardId} onOpen={onOpenCard}
            stale={staleText(mergeFresh(f.board, f.journals), failing, now)} />
          <PWorkers code={code} w={data.workers || {}} now={now} stale={staleText(f.journals, failing, now)} />
        </div>
      </div>
      {cardId && <CardPanel id={cardId} now={now} onOpen={onOpenCard} onClose={onCloseCard} />}
    </>
  );
}
