// Окно «Дорожная карта» (EXT-103 Т3; спека Vault extractor/SPEC-extractor-roadmap.md, раздел 3 «Вид», гейт Г3).
// #/roadmap — все проекты строками со счётчиками; #/roadmap/<КОД> — карта проекта: Где стоим · Ждёт Ивана · Идеи · Впереди ·
// Сделано · Снято. Только показ (Р-4 (а)): кнопок записи нет. Свой опрос ручки раз в 5 с, пока окно открыто (правку карты поток
// событий не сигналит). Разметка и стили — соседних экранов: .beacon, details.blk / .grp, .ptable, .lbl, .trc (EXT-48).
import { useMemo } from 'react';
import { pollSource, useSource } from './data.js';
import { useOpen } from './prefs.js';
import { Summary, More } from './Summary.jsx';
import { lineForIvan, mapStatus, phaseLine } from './plainData.js';
import { TraceBadge } from './Trace.jsx';
import {
  ROADMAP_POLL_MS, NO_MAP, brokenLine, cardHref, cardWord, countsParts, dateShort, ideaView, markView, offLines,
  roadmapUrl, splitIdeas, srcLine, waitView, splitQuestions, stepLine, totalLine, traceState, traceTip, TRACE_SIGN, cardTraceView,
} from './roadmapData.js';

const CardLink = ({ id }) => <a className="rm-id" href={cardHref(id)}>{id}</a>;

// след одной части («имя@хеш» или номер карточки): знак, текст, причина — подсказкой и для экранного чтеца;
// text null — только знак (у идеи «сделана»: значок следа её карточки, подпись — в подсказке)
function Trc({ t, text }) {
  const st = traceState(t);
  const tip = traceTip(t);
  return (
    <span className={`trc rm-trc t-${st}`} title={tip}>
      <span className="ts" aria-hidden="true">{st === 'wait' ? '…' : TRACE_SIGN[st]}</span>
      {text != null && <span className="mono">{text}</span>}<span className="sr">{text != null ? '. ' : 'след: '}{tip}</span>
    </span>
  );
}

function Broken({ b, what }) {
  const s = brokenLine(b, what);
  return s ? <div className="rm-warn" role="status">{s}</div> : null;
}

/* ---------- все проекты ---------- */

// EXT-125: проекты без карты — не строкой каждый, а одной строкой внизу; код — ссылка на окно «карты нет»
function All({ d, onOpen }) {
  const key = (code) => (e) => { if (e.key === 'Enter') onOpen(code); };
  const total = totalLine(d.total);
  const withMap = d.projects.filter((p) => p.hasMap || p.broken);
  const noMap = d.projects.filter((p) => !p.hasMap && !p.broken);
  return (
    <details className="blk" open>
      <Summary>Карты проектов <span className="cnt num">{withMap.length}</span>{total && <span className="hint">{total}</span>}</Summary>
      <div className="tw">
        <table className="ptable rm-all">
          <thead><tr><th>Проект</th><th>Где стоим</th><th>Карта</th><th className="go"></th></tr></thead>
          <tbody>
            {withMap.map((p) => {
              const parts = countsParts(p.counts);
              return (
                <tr className={p.hasMap ? 'p' : 'p rm-nomap'} key={p.code} tabIndex={0} onClick={() => onOpen(p.code)} onKeyDown={key(p.code)}
                  aria-label={`Открыть карту ${p.code}`}>
                  <td className="code">{p.code}</td>
                  <td>
                    {/* EXT-129: есть строка для Ивана — она вместо «фаза → шаг», фаза и шаг — мелко серым под ней */}
                    {p.hasMap && lineForIvan(p.where)
                      ? <span className="pj-t">
                          <span className="pj-now">{lineForIvan(p.where)}</span>
                          {phaseLine(p.where.phase, p.where.next) && <span className="pj-ph" title={phaseLine(p.where.phase, p.where.next)}>{phaseLine(p.where.phase, p.where.next)}</span>}
                        </span>
                      : p.hasMap && p.where
                      ? <span className="pn" title={[p.where.phase, p.where.next && `→ ${p.where.next}`].filter(Boolean).join(' ') || undefined}>
                          {p.where.phase ? <span className="phase">{p.where.phase}</span> : <span className="faint">фаза не указана</span>}
                          {p.where.next && <> <span className="next">→ {p.where.next}</span></>}
                        </span>
                      : null}
                    {p.broken && <span className="pfail rm-amb">{brokenLine(p.broken)}</span>}
                  </td>
                  <td className="rm-cnt">
                    {parts
                      ? parts.map((x, i) => <span key={x.k}>{i > 0 && <span className="faint"> · </span>}<span className={x.hot ? 'rm-hot' : undefined}>{x.text}</span></span>)
                      : <span className="faint">{NO_MAP}</span>}
                  </td>
                  <td className="go" aria-hidden="true">›</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {noMap.length > 0 && (
        <div className="empty pj-quiet">
          {withMap.length ? `У остальных ${noMap.length}` : `У всех ${noMap.length}`} карты пока нет:{' '}
          {noMap.map((p, i) => <span key={p.code}>{i > 0 && ', '}<a className="rm-id" href={`#/roadmap/${p.code}`}>{p.code}</a></span>)}
        </div>
      )}
      {!d.projects.length && <div className="empty">Проектов нет.</div>}
    </details>
  );
}

/* ---------- карта проекта ---------- */

function Where({ w }) {
  if (!w) return <div className="beacon" data-sec="where"><span className="faint">«Где стоим» в карте пусто</span></div>;
  const text = Array.isArray(w.text) ? w.text : [];
  // EXT-125: «Где стоим» крупно (одно крупное на экране), «Дальше», абзац карты; кто и когда правил карту — под «подробнее».
  // EXT-129: есть строка для Ивана — крупно она, фаза ниже обычным текстом строкой «Фаза»; нет — как раньше
  const b = lineForIvan(w);
  return (
    <div className="beacon brief rm-where" data-sec="where" aria-label="Где стоим">
      <span className="l">Где стоим</span>
      {b
        ? <><span className="lead">{b}</span><span className="l">Фаза</span>{w.phase ? <span>{w.phase}</span> : <span className="faint">не указана</span>}</>
        : w.phase ? <span className="lead">{w.phase}</span> : <span className="faint">фаза не указана</span>}
      <span className="l">Дальше</span>
      <span>{w.next ?? <span className="faint">—</span>}</span>
      {text.length > 0 && <><span className="l" /><div className="rm-text">{text.map((p, i) => <p key={i}>{p}</p>)}</div></>}
      {(w.updated || w.by) && <><span className="l" /><More label={`карта обновлена ${dateShort(w.updated) || '—'}`}>{w.by ? <span className="mono">{w.by}</span> : 'кто правил — не указано'}</More></>}
    </div>
  );
}

function Ask({ code, qs }) {
  const o = useOpen(`rm-ask-${code}`);
  const c = useOpen(`rm-askc-${code}`, false);
  const { open, closed } = splitQuestions(qs);
  return (
    <details className="blk" data-sec="ask" open={o.open} onToggle={o.onToggle}>
      <Summary>Ждёт Ивана <span className={open.length ? 'cnt num rm-hot' : 'cnt num'}>{open.length}</span><span className="hint hsm">вопросы без карточки · отвечать в чате треда</span></Summary>
      {open.map((q) => (
        <div className="rm-row" key={q.n}>
          <span className="rm-n mono">{q.n}</span>
          <span className="rm-t">{q.text}</span>
          <span className="rm-src">{srcLine(q)}</span>
        </div>
      ))}
      {!open.length && <div className="empty">Открытых вопросов нет.</div>}
      {closed.length > 0 && (
        <details className="grp" open={c.open} onToggle={c.onToggle}>
          <Summary>Закрытые <span className="cnt num">{closed.length}</span></Summary>
          {closed.map((q) => (
            <div className="rm-row rm-old" key={q.n}>
              <span className="rm-n mono">{q.n}</span>
              <span className="rm-t">{q.text}{q.answer && <span className="rm-ans"> → {q.answer}</span>}{q.who && <span className="faint"> · {q.who}</span>}</span>
              <span className="rm-src">{dateShort(q.date)}</span>
            </div>
          ))}
        </details>
      )}
    </details>
  );
}

function IdeaRow({ i }) {
  const v = ideaView(i);
  // след карточки идеи не сходится (или ещё не посчитан) — значок рядом со статусом; «сделана» зелёной только при зелёном следе
  const hot = v.trace !== undefined && traceState(v.trace) !== 'ok';
  const cls = hot && v.cls === 'done' ? 'idle' : v.cls;
  return (
    // EXT-125: сверху — статус словом и сама идея; номер, карточка, след и откуда — под «подробнее»
    <div className={v.cls === 'gone' ? 'rm-row rm-pl rm-old' : 'rm-row rm-pl'}>
      <span className="rm-t">
        <span className={`rm-st s-${cls}`}>{v.text}</span>
        {hot && <TraceBadge t={v.trace} />}
        <span className="rm-it">{i.text}</span>
        {i.why && <span className="faint"> — {i.why}</span>}
        <More>
          <span className="mono">{i.n}</span>
          {v.card && <> · <CardLink id={v.card} /></>}
          {v.ask && <> · <span className="mono">{v.ask}</span></>}
          {v.trace !== undefined && !hot && <> <Trc t={v.trace} text={null} /></>}
          {' · '}{srcLine(i)}
        </More>
      </span>
    </div>
  );
}

function Ideas({ code, ideas, discuss }) {
  const o = useOpen(`rm-ideas-${code}`);
  const c = useOpen(`rm-drop-${code}`, false);
  const { shown, dropped } = splitIdeas(ideas);
  return (
    <details className="blk" data-sec="ideas" open={o.open} onToggle={o.onToggle}>
      <Summary>Идеи <span className="cnt num">{shown.length}</span>{discuss > 0 && <span className="hint">в обсуждении {discuss}</span>}</Summary>
      {shown.map((i) => <IdeaRow key={i.n} i={i} />)}
      {!shown.length && <div className="empty">Идей нет.</div>}
      {dropped.length > 0 && (
        <details className="grp" open={c.open} onToggle={c.onToggle}>
          <Summary>Отброшенные <span className="cnt num">{dropped.length}</span></Summary>
          {dropped.map((i) => <IdeaRow key={i.n} i={i} />)}
        </details>
      )}
    </details>
  );
}

function PlanItem({ it }) {
  const m = markView(it);
  const step = stepLine(it);
  const w = waitView(it.wait);
  return (
    <div className={`rm-pi d${Math.min(it.depth ?? 0, 2)}${it.shownMark === '-' ? ' rm-old' : ''}`}>
      <span className={`rm-mk ${m.cls}`} title={m.word} aria-hidden="true">{m.sign}</span>
      <span className="rm-t">
        <span className="sr">{m.word}: </span>
        <span className="rm-num mono">{it.num}</span> {it.text}
        {it.card && <> <span className="faint">→</span> <CardLink id={it.card} /> <span className="faint">{cardWord(it.cardStatus)}</span></>}
        {w && <> <span className="rm-amb">ждёт {w.card ? <CardLink id={w.card} /> : <span className="rm-wt">{w.text}</span>}</span></>}
        {it.why && <span className="faint"> — {it.why}</span>}
        {(it.traces || []).map((t) => <span key={t.part}> <Trc t={t.state == null ? null : t} text={t.part} /></span>)}
        {it.cardTrace && <> <Trc t={it.cardTrace} text={it.card} /></>}
      </span>
      {step && <span className="rm-step">{step}</span>}
    </div>
  );
}

function BigCard({ c, defOpen }) {
  const o = useOpen(`rm-card-${c.id}`, defOpen);
  const plan = c.plan;
  const st = mapStatus(c.status);
  // след не сходится (или ещё не посчитан) — значок в строке карточки рядом со статусом, не только в раскрытии;
  // «сделано» зелёным — только при зелёном следе (спека карты, «След „сделано“»)
  const { traced, hot } = cardTraceView(c);
  const stCls = st.cls === 'done' && (!traced || hot) ? 'later' : st.cls;
  // EXT-125: строка карточки — заголовок и статус словом («делаем / посмотри / потом»), у плана — «шагов X из Y»;
  // раскрытие — это «подробнее»: номер, статус доски, след, маленькие и план со следами и хешами
  const head = (
    <>
      {/* EXT-129: есть строка для Ивана — она вместо заголовка; заголовок — в раскрытии, первым */}
      <span className="rm-ct">{c.exists === false ? <span className="faint">нет на доске</span> : lineForIvan(c) ?? c.title}</span>
      {c.exists !== false && <span className={`rm-st s-${stCls}`}>{st.text}</span>}
      {hot && <TraceBadge t={c.trace} />}
      {plan && <span className="rm-sum num">шагов {plan.summary?.done ?? 0} из {plan.summary?.total ?? 0}</span>}
    </>
  );
  return (
    <details className="grp rm-card" data-id={c.id} open={o.open} onToggle={o.onToggle}>
      <Summary>{head}</Summary>
      <div className="rm-meta">
        {c.exists !== false && lineForIvan(c) && <span className="dd-t">{c.title}</span>}
        <CardLink id={c.id} />
        <span className="lbl">{cardWord(c.status)}</span>
        {c.trace && !hot && <TraceBadge t={c.trace} />}
        {c.childrenSummary && <span className="rm-sum num">{c.childrenSummary.label}</span>}
        {plan && <span className="rm-sum num">план: сделано {plan.summary?.done ?? 0} из {plan.summary?.total ?? 0}</span>}
        {c.hint && <span className="faint rm-sum">{c.hint}</span>}
      </div>
      {c.children?.length > 0 && (
        <div className="rm-kids" aria-label={`Маленькие ${c.id}`}>
          {c.children.map((k) => (
            <div className={k.status === 'cancelled' || k.status === 'done' ? 'rm-kid rm-old' : 'rm-kid'} key={k.id}>
              <CardLink id={k.id} /><span className="rm-t">{k.title}</span><span className="lbl">{cardWord(k.status)}</span>
            </div>
          ))}
        </div>
      )}
      {plan && (
        <div className="rm-plan" aria-label={`План ${c.id}`}>
          <Broken b={plan.broken} what="план" />
          {plan.items.map((it) => <PlanItem key={it.num} it={it} />)}
          {!plan.items.length && <div className="lmore">План пуст.</div>}
        </div>
      )}
    </details>
  );
}

function Cards({ code, sec, title, list, defOpen, cardsOpen, hint }) {
  const o = useOpen(`rm-${sec}-${code}`, defOpen);
  return (
    <details className="blk" data-sec={sec} open={o.open} onToggle={o.onToggle}>
      <Summary>{title} <span className="cnt num">{list.length}</span>{hint && <span className="hint hsm">{hint}</span>}</Summary>
      <div className="rm-cards">
        {list.map((c) => <BigCard key={c.id} c={c} defOpen={cardsOpen} />)}
      </div>
      {!list.length && <div className="empty">Пусто.</div>}
    </details>
  );
}

function One({ d }) {
  const code = d.code;
  if (!d.hasMap && !d.map) {
    return <div className="beacon" data-sec="nomap"><span className="faint">{NO_MAP}: у проекта {code} карты на доске нет ({code}/{code}.map.md)</span></div>;
  }
  const m = d.map;
  if (!m) return <><Broken b={d.broken} /><div className="beacon"><span className="faint">карта {code} не разобрана ни разу — показывать нечего</span></div></>;
  const cards = m.cards || {};
  return (
    <div className="rm-col">
      <Broken b={d.broken} />
      <Where w={m.where} />
      <Ask code={code} qs={m.questions} />
      <Ideas code={code} ideas={m.ideas} discuss={d.counts?.ideasDiscuss ?? 0} />
      <Cards code={code} sec="ahead" title="Впереди" list={cards.ahead || []} defOpen cardsOpen={false} hint="что важнее — выше" />
      <Cards code={code} sec="done" title="Сделано" list={cards.done || []} defOpen cardsOpen={false} />
      <Cards code={code} sec="cancelled" title="Снято" list={cards.cancelled || []} defOpen={false} cardsOpen={false} />
    </div>
  );
}

export default function Roadmap({ code }) {
  const source = useMemo(() => pollSource(roadmapUrl(code), ROADMAP_POLL_MS, { pauseHidden: true }), [code]);
  const { data, failingSince, error } = useSource(source);
  if (!data) {
    return <div className="foot" role="status">
      {code && error === 'HTTP 404' ? `Проекта ${code} нет.` : failingSince ? 'Сервер витрины не отвечает — пробую снова каждые 5 с.' : 'Читаю карту…'}
    </div>;
  }
  const off = offLines(data);
  return (
    <div className="rm-col">
      {failingSince != null && <div className="foot" role="status">Сервер витрины не отвечает — показаны прежние данные.</div>}
      {off
        ? <div className="beacon rm-off" role="status"><span className="rm-amb">{off.error}</span><span className="faint">{off.hint}</span></div>
        : code ? <One d={data} /> : <All d={data} onOpen={(c) => { window.location.hash = `#/roadmap/${c}`; }} />}
    </div>
  );
}
