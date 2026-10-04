// Экран «Цех» — по макету AdbsFQdeExwwUBEEXPbwsf (версия 3), поля — спека §3.1.
// Свежесть, свёртка блока, тред и пометки отсюда же берёт окно проекта (Project.jsx) — одни компоненты на два экрана.
import { useState } from 'react';
import { useOpen } from './prefs.js';
import { ageShort, dur, hm, dm, minutes, plural } from './format.js';
import Pult, { PultMark } from './Pult.jsx';
import { TraceBadge } from './Trace.jsx';
import { DeferBtn, DeferNote, Deferred } from './Defer.jsx';
import { Summary } from './Summary.jsx';

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
export function mergeFresh(...list) {
  const by = (k) => list.map((f) => f?.[k]).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return { lastOkAt: by('lastOkAt'), failingSince: by('failingSince') };
}

// Серая строка 2.7: прежние данные остаются, у блока — «данные на ЧЧ:ММ, чтение не удаётся N мин».
// N — от failingSince читателя (сервер), если он есть; иначе — от последнего удачного чтения
// (сбой самого запроса к ручке или читатель стоит без ошибки дольше минуты).
export function staleText(fresh, fetchFailing, now, staleMs = STALE_MS) {
  const { lastOkAt, failingSince } = fresh || {};
  const t = lastOkAt ? Date.parse(lastOkAt) : NaN;
  const f = failingSince ? Date.parse(failingSince) : NaN;
  if (!Number.isFinite(t)) return Number.isFinite(f) ? `данных нет, чтение не удаётся ${minutes(f, now)}` : 'чтение ещё не прошло';
  if (Number.isFinite(f)) return `данные на ${hm(lastOkAt, now)}, чтение не удаётся ${minutes(f, now)}`;
  if (!fetchFailing && now - t <= staleMs) return null;
  return `данные на ${hm(lastOkAt, now)}, чтение не удаётся ${minutes(t, now)}`;
}
export function Stale({ text }) {
  return text ? <div className="foot" role="status">{text}</div> : null;
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

// «Готово, посмотри» (в): первые n свежих, остальное — кнопкой (слово Ивана 02.10). Им же пользуется окно проекта.
export function useShowMore(list, n = REVIEW_SHOWN, className = 'more') {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, n);
  const button = list.length > n
    ? (
      <button type="button" className={className} onClick={() => setAll((v) => !v)}>
        {all ? 'Свернуть до свежих' : `Показать ещё ${list.length - n}`}
      </button>
    )
    : null;
  return [shown, button];
}

// Отвечено с витрины, ждёт зеркала (§3.2): строки (б)/(в) с местной отметкой — серым, свёрнуто, вне крупного числа
function Answered({ rows, now }) {
  const o = useOpen('grp-answered', false);
  if (!rows.length) return null;
  const missing = rows.filter((r) => r.pultMark?.missing).length;
  return (
    <details className="grp ans" open={o.open} onToggle={o.onToggle}>
      <Summary>Отвечено, ждёт зеркала <span className="cnt num">{rows.length}</span>
        {missing > 0 && <span className="hint red">зеркало не видит {missing}</span>}
      </Summary>
      {rows.map((r) => (
        <div className="wrow" key={`a-${r.id}`}>
          <span className="src mono">{r.id}</span>
          <span>{r.title}<PultMark m={r.pultMark} /></span>
          <span className="age num">{ageShort(r.pultMark?.at ?? r.at ?? r.since, now)}</span>
        </div>
      ))}
    </details>
  );
}

function Waiting({ w, now, stale }) {
  const o = useOpen('waiting');
  const yes = w.yes.filter((r) => !r.answered);
  const open = w.review.filter((r) => !r.answered);
  const answered = [...w.yes, ...w.review].filter((r) => r.answered);
  const [review, moreReview] = useShowMore(open);
  const empty = !w.threads.length && !yes.length && !open.length;
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
            <div className="wrow df" key={r.key}>
              <span className="src" title={r.title}><span className="k">тред</span>{r.title}
                {r.projectBy === 'cards' && r.project && <span className="by"><span className="mono">{r.project}</span> · по карточкам</span>}
              </span>
              <span className="tt">{r.overDay && <span className="tag r">ждёт больше суток</span>}{r.text}</span>
              <span className="age num">{ageShort(r.since, now)}</span>
              {r.key && !r.keyTemp && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={`тред ${r.title || ''}`.trim()} /><DeferNote rowKey={r.key} /></>}
            </div>
          ))}
        </Group>
      )}

      {yes.length > 0 && (
        <Group id="yes" title="Нужно твоё «да»" count={yes.length}>
          {yes.map((r) => (
            <div className="wrow df" key={r.key}>
              <span className="src mono">{r.id}</span>
              <span className="tt"><span className={r.mark === 'Б' ? 'tag b' : 'tag'}>{r.mark}</span>{r.title}</span>
              <span className="age num">{ageShort(r.since, now)}</span>
              {r.key && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={r.id} /><DeferNote rowKey={r.key} /></>}
            </div>
          ))}
        </Group>
      )}

      {open.length > 0 && (
        <Group id="review" title="Готово, посмотри" count={open.length} hint="Review">
          {review.map((r) => (
            <div className="wrow pr" key={r.id}>
              <span className="src mono">{r.id}</span>
              <span className="tt">{r.title}<TraceBadge t={r.trace} /></span>
              <span className="age num">{ageShort(r.at, now)}</span>
              <Pult card={r.id} q={r.q ?? null} accept={r.accept} mark={r.pultMark} />
              {r.key && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={r.id} /><DeferNote rowKey={r.key} /></>}
            </div>
          ))}
          {moreReview}
        </Group>
      )}

      <Answered rows={answered} now={now} />
      <Deferred list={w.deferred} />
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

export function Mark({ m, now }) {
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
    case 'collision': {
      // EXT-60 (§2.3): жёлтая; путь — short, полный — подсказкой; время — правка другого треда (otherAt)
      const files = m.files || [];
      const other = <>правит и {m.other?.title || 'без названия'}{m.other?.closed && <span className="muted"> (тред закрыт)</span>}</>;
      const path = (f) => <span className="mono" title={f.path}>{f.short || f.path}</span>;
      if (files.length === 1) {
        return <div className="alarm warn"><span className="h">Общий файл</span>{path(files[0])}{other} · {hm(files[0].otherAt, now)}</div>;
      }
      return (
        <div className="alarm warn">
          <span className="h">Общий файл</span>{other}
          <ul className="files">
            {files.map((f) => <li key={f.path}>{path(f)}<span className="muted">{hm(f.otherAt, now)}</span></li>)}
            {m.more > 0 && <li className="muted">и ещё {m.more}</li>}
          </ul>
        </div>
      );
    }
    default:
      return <div className="alarm"><span className="h">{m.kind}</span></div>;
  }
}

// EXT-49: память треда — «память N %» серым; с порога — жёлтым «пора сделать снимок…»; окна модели нет — «N тыс.»
const timesWord = (n) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'раза' : 'раз');
function Memory({ m }) {
  if (!m) return null;
  const k = Math.round(m.tokens / 1000);
  const size = m.pct == null ? `память ${k > 0 ? k : 'меньше 1'} тыс.` : `память ${m.pct} %`;
  return (
    <div className="th2">
      {m.warn
        ? <span className="mem-warn">{size} — пора сделать снимок и открыть новый тред</span>
        : <span>{size}</span>}
      {m.compactions > 0 && <span className="faint">сжат {m.compactions} {timesWord(m.compactions)}</span>}
    </div>
  );
}

export function Thread({ t, now }) {
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
              {/* окно проекта (3.2): rulesFresh приходит только из /api/project; «Старые правила» — пометкой oldRules ниже */}
              {t.rulesFresh === true && <span>правила свежие</span>}
              {/* EXT-54: тред до «правила обновлены», но сам перечитал правила после — серая строка вместо пометки */}
              {t.rulesReread && <span className="faint">правила перечитаны {dm(t.rulesReread)}</span>}
            </>}
      </div>
      <Memory m={t.memory} />
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
