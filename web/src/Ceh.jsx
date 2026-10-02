// Экран «Цех» — по макету AdbsFQdeExwwUBEEXPbwsf (версия 3), поля — спека §3.1.
import { useState } from 'react';
import { useOpen } from './prefs.js';
import { ageShort, dur, hm, dm, minutes, plural } from './format.js';

const STALE_MS = 60_000; // данные читателя старше минуты — серая строка 2.7 (опрос доски 5 с, журналов 1–2 с)
const REVIEW_SHOWN = 10; // «Готово, посмотри» на живой доске — десятки строк; остальное по кнопке

const STATE = {
  waiting: ['wait', 'ждёт тебя'],
  busy: ['work', 'работает'],
  idle: ['free', 'свободен'],
  stale: ['old', 'устарело'],
};
const STATE_WORD = { waiting: 'ждёт тебя', busy: 'работает', idle: 'свободен' };

// Свежесть нескольких читателей одной строкой: самое старое lastOkAt, самый ранний failingSince.
function mergeFresh(...list) {
  const by = (k) => list.map((f) => f?.[k]).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return { lastOkAt: by('lastOkAt'), failingSince: by('failingSince') };
}

// Серая строка 2.7: прежние данные остаются, у блока — «данные на ЧЧ:ММ, чтение не удаётся N мин».
// N — от failingSince читателя (сервер), если он есть; иначе — от последнего удачного чтения
// (сбой самого запроса к ручке или читатель стоит без ошибки дольше минуты).
function staleText(fresh, fetchFailing, now) {
  const { lastOkAt, failingSince } = fresh || {};
  const t = lastOkAt ? Date.parse(lastOkAt) : NaN;
  const f = failingSince ? Date.parse(failingSince) : NaN;
  if (!Number.isFinite(t)) return Number.isFinite(f) ? `данных нет, чтение не удаётся ${minutes(f, now)}` : 'чтение ещё не прошло';
  if (Number.isFinite(f)) return `данные на ${hm(lastOkAt, now)}, чтение не удаётся ${minutes(f, now)}`;
  if (!fetchFailing && now - t <= STALE_MS) return null;
  return `данные на ${hm(lastOkAt, now)}, чтение не удаётся ${minutes(t, now)}`;
}
function Stale({ text }) {
  return text ? <div className="foot" role="status">{text}</div> : null;
}

function Summary({ children }) {
  return <summary><span className="car" aria-hidden="true">›</span>{children}</summary>;
}

/* ---------- Ждёт меня ---------- */

function Group({ id, title, count, hint, children }) {
  const o = useOpen(`grp-${id}`);
  return (
    <details className="grp" open={o.open} onToggle={o.onToggle}>
      <Summary>{title} <span className="cnt num">{count}</span>{hint && <span className="hint">{hint}</span>}</Summary>
      {children}
    </details>
  );
}

function Waiting({ w, now, stale }) {
  const o = useOpen('waiting');
  const [allReview, setAllReview] = useState(false);
  const review = allReview ? w.review : w.review.slice(0, REVIEW_SHOWN);
  const empty = !w.threads.length && !w.yes.length && !w.review.length;
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Ждёт меня <span className="big num">{w.count}</span>
        {w.more > 0 && <span className="cnt">+ {w.more} посмотреть</span>}
        <span className="hint">по важности</span>
      </Summary>

      {w.threads.length > 0 && (
        <Group id="threads" title="Тред ждёт ответа" count={w.threads.length}>
          {w.threads.map((r) => (
            <div className="wrow" key={r.key}>
              <span className="src" title={r.title}><span className="k">тред</span>{r.title}
                {r.projectBy === 'cards' && r.project && <span className="by"><span className="mono">{r.project}</span> · по карточкам</span>}
              </span>
              <span>{r.overDay && <span className="tag r">ждёт больше суток</span>}{r.text}</span>
              <span className="age num">{ageShort(r.since, now)}</span>
            </div>
          ))}
        </Group>
      )}

      {w.yes.length > 0 && (
        <Group id="yes" title="Нужно твоё «да»" count={w.yes.length}>
          {w.yes.map((r) => (
            <div className="wrow" key={r.key}>
              <span className="src mono">{r.id}</span>
              <span><span className={r.mark === 'Б' ? 'tag b' : 'tag'}>{r.mark}</span>{r.title}</span>
              <span className="age num">{ageShort(r.since, now)}</span>
            </div>
          ))}
        </Group>
      )}

      {w.review.length > 0 && (
        <Group id="review" title="Готово, посмотри" count={w.review.length} hint="Review">
          {review.map((r) => (
            <div className="wrow" key={r.id}>
              <span className="src mono">{r.id}</span>
              <span>{r.title}</span>
              <span className="age num">{ageShort(r.at, now)}</span>
            </div>
          ))}
          {w.review.length > REVIEW_SHOWN && (
            <button type="button" className="more" onClick={() => setAllReview((v) => !v)}>
              {allReview ? 'Свернуть до свежих' : `Показать ещё ${w.review.length - REVIEW_SHOWN}`}
            </button>
          )}
        </Group>
      )}

      {empty && <div className="foot">Ничего не ждёт.</div>}
      <Stale text={stale} />
    </details>
  );
}

/* ---------- Проекты ---------- */

const noPhase = (p) => (p.inRegistry === false ? 'проект не описан в реестре' : 'фаза не указана в карточке проекта');
const phaseTip = (p) => [p.phase?.full ?? noPhase(p), p.next && `→ ${p.next.full}`].filter(Boolean).join('\n');

const n0 = (v) => <td className={v ? 'n num' : 'n num z'}>{v ?? 0}</td>;

function Projects({ projects, now, stale, onOpen }) {
  const o = useOpen('projects');
  const key = (code) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(code); } };
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>Проекты <span className="cnt num">{projects.length}</span><span className="hint">порядок постоянный · строка открывает окно проекта</span></Summary>
      <div className="tw">
        <table className="ptable">
          <thead><tr><th>Проект</th><th>Фаза · следующий шаг</th><th className="n">в работе</th><th className="n">очередь</th><th className="n">Review</th><th className="n hidesm">активность</th><th className="go"></th></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr className="p" key={p.code} tabIndex={0} onClick={() => onOpen(p.code)} onKeyDown={key(p.code)} aria-label={`Открыть окно проекта ${p.code}`}>
                <td className="code">{p.code}</td>
                <td>
                  {/* не выше двух строк с «…»; целиком — во всплывающей подсказке (слово Ивана 02.10) */}
                  <span className="pn" title={phaseTip(p)}>
                    {p.phase
                      ? <span className="phase">{p.phase.short}</span>
                      : <span className="faint">{noPhase(p)}</span>}
                    {(p.phase || p.next) && <> <span className="next">→ {p.next?.short ?? '—'}</span></>}
                  </span>
                  {p.phaseFailingSince && (
                    <span className="pfail">данные на {hm(p.phaseReadAt, now)}, чтение не удаётся {minutes(Date.parse(p.phaseFailingSince), now)}</span>
                  )}
                </td>
                {n0(p.inProgress)}{n0(p.ready)}{n0(p.review)}
                <td className="n num muted hidesm">{p.activityAt ? ageShort(p.activityAt, now) : '—'}</td>
                <td className="go" aria-hidden="true">›</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Stale text={stale} />
    </details>
  );
}

/* ---------- Кто работает ---------- */

function Gauge({ turns, max, target }) {
  if (!max) return <span />;
  const w = Math.min(100, (turns / max) * 100);
  const over = target != null && turns > target;
  return (
    <span className={over ? 'gauge over' : 'gauge'} aria-hidden="true">
      <i style={{ width: `${w}%` }} />
      {target != null && <b style={{ left: `${Math.min(100, (target / max) * 100)}%` }} />}
    </span>
  );
}

function Sub({ s }) {
  const tip = s.target != null ? `ходы ${s.turns} из ${s.maxTurns ?? '?'}, ориентир ${s.target}` : `ходы ${s.turns} из ${s.maxTurns ?? '?'}, ориентира нет`;
  return (
    <div className="sub" title={tip}>
      <span className="who">{s.who || s.agent}</span>
      <span className="what" title={s.description}>{s.description}</span>
      <Gauge turns={s.turns} max={s.maxTurns} target={s.target} />
      <span className="tt mono num">{s.turns}/{s.maxTurns ?? '?'}</span>
    </div>
  );
}

function Done({ done }) {
  if (done === null || done === undefined) return 'неизвестно';
  if (!done.length) return 'коммитов нет';
  return done.map((c, i) => <span key={c.hash}>{i > 0 && '; '}<span className="mono">{c.hash}</span>{c.subject}</span>);
}

function Mark({ m, now }) {
  const who = m.who || m.agent;
  switch (m.kind) {
    case 'partial':
      return (
        <div className="alarm">
          <span className="h">Обрыв · PARTIAL</span>{who}{m.card && `, ${m.card}`} — закончил в {hm(m.endedAt, now)}
          {m.waitingWord && <span className="st wait fr">ждёт твоего слова</span>}
          <dl>
            <dt>сделано</dt><dd><Done done={m.done} />{m.lastText && <span className="quote">{m.lastText}</span>}</dd>
            <dt>осталось</dt><dd>{m.left || 'агент не указал'}</dd>
            <dt>причина</dt><dd>{m.reason || `тормоз ${m.turnLimit} ходов; продолжить можно`}</dd>
          </dl>
        </div>
      );
    case 'takt':
      return (
        <div className={m.level === 'red' ? 'alarm' : 'alarm warn'}>
          <span className="h">Такт без ответа</span>{m.card && <span className="mono">{m.card}</span>}▶ выдан {m.whoDative || who} {dur(m.issuedAt, now)} назад, ⏸ нет
        </div>
      );
    case 'subagentWrite':
      return (
        <div className="alarm">
          <span className="h">Запись субагента в доску</span>{who}{m.card && `, ${m.card}`} — {hm(m.at, now)}
          {m.line && <span className="quote">{m.line}</span>}
        </div>
      );
    case 'oldRules':
      return <div className="alarm"><span className="h">Старые правила</span>тред открыт до «правила обновлены» {dm(m.rulesUpdatedAt)}</div>;
    default:
      return <div className="alarm"><span className="h">{m.kind}</span></div>;
  }
}

function Thread({ t, now }) {
  const [cls, word] = STATE[t.state] || ['free', t.state];
  const showCode = t.project && !(t.title || '').startsWith(t.project);
  return (
    <div className="thr">
      <div className="th1">
        <span className="tname">
          {showCode && <span className="mono">{t.project}</span>}{t.title || 'без названия'}
          {t.project && t.projectBy === 'cards' && <span className="by-in"> · по карточкам</span>}
          {!t.project && <span className="faint"> · проект не определён</span>}
        </span>
        <span className={`st ${cls}`}>{word}</span>
      </div>
      <div className="th2">
        {t.state === 'stale'
          ? <span>нет вестей {dur(t.lastSeenAt, now)} · последнее наблюдение {hm(t.lastSeenAt, now)}: «{STATE_WORD[t.lastState] || t.lastState || '?'}»</span>
          : <>
              {t.card ? <span className="mono">{t.card}</span> : <span className="faint">без карточки</span>}
              <span className="num">{t.sinceKind === 'card' ? 'идёт' : 'открыт'} {dur(t.since, now)}</span>
            </>}
      </div>
      {t.subagents.map((s, i) => <Sub key={`${s.agent}-${i}`} s={s} />)}
      {t.marks.map((m, i) => <Mark key={`${m.kind}-${i}`} m={m} now={now} />)}
    </div>
  );
}

function Workers({ w, now, stale }) {
  const o = useOpen('workers');
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Кто работает <span className="cnt num">{plural(w.threads.length, ['тред', 'треда', 'тредов'])} · {plural(w.subagentsCount, ['субагент', 'субагента', 'субагентов'])}</span>
        {w.marksCount > 0 && <span className="hint red">{plural(w.marksCount, ['пометка', 'пометки', 'пометок'])}</span>}
      </Summary>
      {w.threads.map((t) => <Thread key={t.sessionId} t={t} now={now} />)}
      {!w.threads.length && <div className="foot">Живых тредов нет.</div>}
      <div className="legend"><span><span className="gauge"><i style={{ width: '40%' }} /><b style={{ left: '55%' }} /></span> ходы до тормоза агента, риска — ориентир из ТЗ</span></div>
      <Stale text={stale} />
      <div className="foot">Только живые треды на этом компьютере. Облачные сессии не видны.</div>
    </details>
  );
}

/* ---------- экран ---------- */

export default function Ceh({ data, failing, now, onOpenProject }) {
  const f = data.freshness || {};
  return (
    <div className="grid">
      <div className="col">
        <Waiting w={data.waiting} now={now} stale={staleText(mergeFresh(f.board, f.journals), failing, now)} />
        <Projects projects={data.projects} now={now} stale={staleText(f.board, failing, now)} onOpen={onOpenProject} />
      </div>
      <div className="col">
        <Workers w={data.workers} now={now} stale={staleText(f.journals, failing, now)} />
      </div>
    </div>
  );
}
