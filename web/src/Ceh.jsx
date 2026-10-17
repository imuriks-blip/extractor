// Экран «Цех» — по макету AdbsFQdeExwwUBEEXPbwsf (версия 3), поля — спека §3.1.
// Свежесть, свёртка блока, тред и пометки отсюда же берёт окно проекта (Project.jsx) — одни компоненты на два экрана.
import { useState } from 'react';
import { useOpen, useStored } from './prefs.js';
import { REVIEW_FILTER_KEY, isReviewFilter, nextFilter, reviewView } from './reviewData.js';
import { ageShort, dur, hm, dm, minutes, plural, DESKTOP_HINT, waitsInDesktop, stepChips, compactLine, foremanLabel, canReplyRow, replyWords } from './format.js';
import Pult, { MarkLine, PultMark } from './Pult.jsx';
import { TraceBadge } from './Trace.jsx';
import { DeferBtn, DeferNote, Deferred } from './Defer.jsx';
import { Summary, More } from './Summary.jsx';
import Reread from './Reread.jsx';
import { FILTER_WORD, briefMe, briefNow, markWord, projectCounts, reviewSubView, splitProjects, threadDoing, traceWord, workersView } from './plainData.js';
import { MyWords, Worktrees } from './Words.jsx';
import NewCard from './NewCard.jsx';

const STALE_MS = 60_000; // данные читателя старше минуты — серая строка 2.7 (опрос доски 5 с, журналов 1–2 с)
const REVIEW_SHOWN = 10; // «Готово, посмотри» на живой доске — десятки строк; остальное по кнопке

const STATE = {
  waiting: ['wait', 'ждёт тебя'],
  busy: ['work', 'работает'],
  idle: ['free', 'свободен'],
  stale: ['old', 'устарело'],
};
const STATE_WORD = { waiting: 'ждёт тебя', busy: 'работает', idle: 'свободен' };

// Кнопки окна «следующий шаг» под вопросом (EXT-107 Р1): серые чипы без нажатия. buttons (EXT-110, «Цех» при кнопках ответа):
// ответы с send уже кнопки пульта — серыми остаются действия приложения и ответы без send; без параметра — все (окно проекта)
export function StepChips({ actions, buttons = false }) {
  const chips = stepChips(actions, { buttons });
  if (!chips.length) return null;
  return <span className="mline">{chips.map((c, i) => <span key={i} className="tag" title={c.title}>{c.text}</span>)}</span>;
}

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

// плашка следа словами (EXT-125): «цех проверил» / «проверь сам» / «нет отчёта» / «не отправлено»; знак и подпись сервера — под «подробнее»
function Plain({ t }) {
  const w = traceWord(t);
  return w ? <span className={`pst s-${w.cls}`}>{w.text}</span> : null;
}

// сводка над «Цехом» (EXT-125): «Сейчас» — треды и тревога; «Ждёт меня» — решения и что посмотреть. «Дальше» — после INFRA-113
function Brief({ data }) {
  const b = briefNow(data.workers?.threads);
  return (
    <div className="beacon brief" aria-label="Сводка">
      <span className="l">Сейчас</span>
      <span>{b.line}{b.alarm && <span className="brief-alarm"> {b.alarm}</span>}</span>
      <span className="l">Ждёт меня</span>
      <span className="lead">{briefMe(data.waiting)}</span>
    </div>
  );
}

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

// Отвечено с витрины, ждёт зеркала (§3.2): строки (б)/(в) с обычной местной отметкой — серым, свёрнуто, вне крупного числа.
// Красная «зеркало не видит запись» сюда не попадает — строка в своей группе с кнопками (§1.7, слово Ивана 05.10);
// счётчик красных в заголовке — на случай старых данных. can — пульт включён: «повторить» у частичного исхода
function Answered({ rows, now, can }) {
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
          <span>{r.title}<span className="mline"><MarkLine card={r.id} q={r.q ?? null} mark={r.pultMark} now={now} can={can} /></span></span>
          <span className="age num">{ageShort(r.pultMark?.at ?? r.at ?? r.since, now)}</span>
        </div>
      ))}
    </details>
  );
}

// слова строк: метка строки (б) → главное слово; «нет» — рядом (§1.4 (б), решение Ивана 05.10)
const MAIN_WORD = { сливай: 'merge', выкатывай: 'deploy', Б: 'yes', развилка: 'reply' };

// подгруппа проекта в «Готово, посмотри» (EXT-79): раскрыта по умолчанию, свёртка помнится (ceh-open:grp-review-<КОД>);
// в заголовке — код, сколько под фильтром («из M» — когда фильтр убрал часть), сводка следа ✕ / ! / ✓ и давность самой свежей;
// больше 10 — «Показать ещё» внутри подгруппы
// EXT-125: сводка следа — словами (FILTER_WORD); все строки с одной плашкой — подгруппа свёрнута одной строкой «все — <плашка>»
// (свой ключ памяти: прежняя отметка «раскрыто» её не держит)
const SUB_SIGNS = ['bad', 'warn', 'ok'];
function ReviewSub({ g, now, row }) {
  const { uniform } = reviewSubView(g.rows);
  const o = useOpen(uniform ? `grp-review-1-${g.code}` : `grp-review-${g.code}`, !uniform);
  const [shown, more] = useShowMore(g.rows);
  return (
    <details className="sg" open={o.open} onToggle={o.onToggle}>
      <Summary>
        <span className="code">{g.code}</span><span className="cnt num">{g.rows.length}</span>
        {g.rows.length !== g.total && <span className="of num">из {g.total}</span>}
        <span className="sgt num">
          {uniform
            ? <span className="sg-all">все — {uniform}</span>
            : SUB_SIGNS.filter((k) => g.counts[k] > 0).map((k) => (
              <span key={k} className={`s-${k}`}>{FILTER_WORD[k]} {g.counts[k]}</span>
            ))}
        </span>
        <span className="age num">{ageShort(g.at, now)}</span>
      </Summary>
      {shown.map(row)}
      {more}
    </details>
  );
}

function Waiting({ w, now, stale, pult, threads, order }) {
  const o = useOpen('waiting');
  const pultOn = pult?.enabled === true; // «Принять»/«Вернуть» строк (в) — по pult.enabled, как в панели (иначе 503)
  const wordsOn = pultOn && pult?.words === true;
  // красная отметка у строки без кнопок пульта (слова выключены) — строкой под заголовком
  const redLine = (r) => r.pultMark?.missing === true && <span className="mline"><PultMark m={r.pultMark} now={now} /></span>;
  const cardOf = new Map((threads || []).map((t) => [t.sessionId, t.card]));
  const yes = w.yes.filter((r) => !r.answered);
  const open = w.review.filter((r) => !r.answered);
  const answered = [...w.yes, ...w.review].filter((r) => r.answered);
  const [review, moreReview] = useShowMore(open);
  const [filter, setFilter] = useStored(REVIEW_FILTER_KEY, 'all', isReviewFilter);
  const rv = reviewView(open, order, filter);
  // EXT-125: сверху — заголовок и плашка следа словами; номер карточки и след целиком — под «подробнее»
  const reviewRow = (r) => (
    <div className="wrow pr np" key={r.id}>
      <span className="tt">{r.title}<Plain t={r.trace} />
        <More><span className="mono">{r.id}</span><TraceBadge t={r.trace} /></More></span>
      <span className="age num">{ageShort(r.at, now)}</span>
      <Pult card={r.id} q={r.q ?? null} accept={r.accept} mark={r.pultMark} ar={pultOn} />
      {r.key && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={r.id} /><DeferNote rowKey={r.key} /></>}
    </div>
  );
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
          {w.threads.map((r) => {
            // ответ треду из строки (а): вид question или nextStep с номером сообщения (EXT-110); «го <ID>» — при поле card строки
            // и только у question (§1.7, EXT-70; Д-1); у nextStep — кнопки-ответы окна и «Ответить» (replyWords, дубли по send сняты).
            // card у ответа — карточка треда из «Кто работает» или ничего, не поле card строки
            const tc = cardOf.get(r.sessionId) || undefined;
            const canReply = canReplyRow(r, { wordsOn, bell: pult.bell, tc });
            const defer = r.key && !r.keyTemp && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={`тред ${r.title || ''}`.trim()} /><DeferNote rowKey={r.key} /></>;
            if (canReply) {
              return (
                <div className={r.kind === 'nextStep' ? 'wrow pr stack win' : 'wrow pr stack'} key={r.key}>
                  <span className="src" title={r.title}><span className="k">тред</span>{r.title}
                    {r.projectBy === 'cards' && r.project && <span className="by"><span className="mono">{r.project}</span> · по карточкам</span>}
                  </span>
                  <span className="tt" title={r.recap || undefined}>{r.overDay && <span className="tag r">ждёт больше суток</span>}{r.text}
                    {r.kind === 'nextStep' && <StepChips actions={r.actions} buttons />}</span>
                  <span className="age num">{ageShort(r.since, now)}</span>
                  <Pult card={null} q={{ uuid: r.uuid, at: r.since }} ar={false} mark={r.pultMark}
                    thread={{ session: r.sessionId, card: tc, key: `${r.sessionId}|${r.uuid}`, window: r.kind === 'nextStep' }}
                    words={{ btns: replyWords(r) }} />
                  {defer}
                </div>
              );
            }
            return (
            <div className="wrow df" key={r.key}>
              <span className="src" title={r.title}><span className="k">тред</span>{r.title}
                {r.projectBy === 'cards' && r.project && <span className="by"><span className="mono">{r.project}</span> · по карточкам</span>}
              </span>
              <span className="tt" title={r.recap || undefined}>{r.overDay && <span className="tag r">ждёт больше суток</span>}{r.text}
                {r.kind === 'nextStep' && <StepChips actions={r.actions} />}
                {waitsInDesktop(r) && <span className="mline muted">{DESKTOP_HINT}</span>}</span>
              <span className="age num">{ageShort(r.since, now)}</span>
              {defer}
            </div>
            );
          })}
        </Group>
      )}

      {yes.length > 0 && (
        <Group id="yes" title="Нужно твоё «да»" count={yes.length}>
          {yes.map((r) => (wordsOn && r.q ? (
            <div className="wrow pr np" key={r.key}>
              <span className="tt"><span className={r.mark === 'Б' ? 'tag b' : 'tag'}>{markWord(r.mark)}</span>{r.title}
                <More><span className="mono">{r.id}</span> · метка {r.mark}</More></span>
              <span className="age num">{ageShort(r.since, now)}</span>
              <Pult card={r.id} q={r.q} ar={false} mark={r.pultMark} words={{ btns: [MAIN_WORD[r.mark] ?? 'yes', 'no'], main: MAIN_WORD[r.mark] ?? 'yes' }} />
              {r.key && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={r.id} /><DeferNote rowKey={r.key} /></>}
            </div>
          ) : (
            <div className="wrow df np" key={r.key}>
              <span className="tt"><span className={r.mark === 'Б' ? 'tag b' : 'tag'}>{markWord(r.mark)}</span>{r.title}{redLine(r)}
                <More><span className="mono">{r.id}</span> · метка {r.mark}</More></span>
              <span className="age num">{ageShort(r.since, now)}</span>
              {r.key && <><DeferBtn rowKey={r.key} options={w.deferOptions} name={r.id} /><DeferNote rowKey={r.key} /></>}
            </div>
          )))}
        </Group>
      )}

      {open.length > 0 && (
        <Group id="review" title="Готово, посмотри" count={rv.head} hint="принять или вернуть">
          {rv.grouped && (
            <div className="rf">
              <div className="filt" role="group" aria-label="Фильтр по следу">
                <button type="button" aria-pressed={rv.filter === 'all'} onClick={() => setFilter('all')}>все</button>
                {rv.chips.map((c) => (
                  <button type="button" key={c.val} aria-pressed={c.on} onClick={() => setFilter(nextFilter(filter, c.val))}>
                    <span className={`s-${c.val}`} aria-hidden="true">{c.sign}</span> {FILTER_WORD[c.val] ?? c.word}<span className="n num">{c.n}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {rv.grouped
            ? rv.groups.map((g) => <ReviewSub key={g.code} g={g} now={now} row={reviewRow} />)
            : <>{review.map(reviewRow)}{moreReview}</>}
          {rv.empty && <div className="foot">Под выбранный след карточек нет.</div>}
        </Group>
      )}

      <Answered rows={answered} now={now} can={pultOn} />
      <Deferred list={w.deferred} />
      {empty && <div className="foot">Ничего не ждёт.</div>}
      <Stale text={stale} />
    </details>
  );
}

/* ---------- Проекты ---------- */

const noPhase = (p) => (p.inRegistry === false ? 'проект не описан в реестре' : 'фаза не указана в карточке проекта');
const phaseTip = (p) => [p.phase?.full ?? noPhase(p), p.next && `→ ${p.next.full}`].filter(Boolean).join('\n');


// EXT-125, проекты строками (слово Ивана): код, ниже «сейчас» (фаза) и «Дальше:» (следующий шаг) — из тех же полей;
// справа давность и счётчики словами. Без фазы и шага — одной строкой «Ещё N — тихо, описания пока нет: …», код открывает окно.
function Projects({ projects, now, stale, onOpen, pult }) {
  const o = useOpen('projects');
  const key = (code) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(code); } };
  const { described, quiet } = splitProjects(projects);
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>Проекты <span className="cnt num">{projects.length}</span><span className="hint">строка открывает окно проекта</span></Summary>
      {described.map((p) => (
        <div className="pj" key={p.code} role="button" tabIndex={0} onClick={() => onOpen(p.code)} onKeyDown={key(p.code)} aria-label={`Открыть окно проекта ${p.code}`}>
          <span className="code">{p.code}</span>
          {/* не выше двух строк с «…»; целиком — во всплывающей подсказке (слово Ивана 02.10) */}
          <span className="pj-t" title={phaseTip(p)}>
            {p.phase ? <span className="pj-now">{p.phase.short}</span> : <span className="pj-now faint">{noPhase(p)}</span>}
            {p.next && <span className="pj-next"><span className="pj-k">Дальше:</span> {p.next.short}</span>}
            {p.phaseFailingSince && (
              <span className="pfail">данные на {hm(p.phaseReadAt, now)}, чтение не удаётся {minutes(Date.parse(p.phaseFailingSince), now)}</span>
            )}
          </span>
          <span className="pj-a num">
            <span>{p.activityAt ? ageShort(p.activityAt, now) : '—'}</span>
            {projectCounts(p).length > 0 && <span>{projectCounts(p).join(' · ')}</span>}
          </span>
        </div>
      ))}
      {quiet.length > 0 && (
        <div className="empty pj-quiet">
          {described.length ? 'Ещё' : 'Все'} {quiet.length} — тихо, описания пока нет:{' '}
          {quiet.map((p, i) => (
            <span key={p.code}>{i > 0 && ', '}<button type="button" className="unfold" title={noPhase(p)} onClick={() => onOpen(p.code)}>{p.code}</button></span>
          ))}
        </div>
      )}
      <NewCard projects={projects} pult={pult} />
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

export function Mark({ m, now, sid }) {
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
      // EXT-65: missing — файлы набора, которых тред после момента не прочитал; поля нет — набор выключен, строки нет.
      // Закрытый тред (sid не передан) просить некому — строка без кнопки.
      return (
        <div className="alarm">
          <span className="h">Старые правила</span>тред открыт до «правила обновлены» {dm(m.rulesUpdatedAt)}
          {m.missing?.length > 0 && (sid
            ? <Reread session={sid} missing={m.missing} now={now} />
            : <div className="rr">не перечитаны: {m.missing.map((f) => f.short || f.path).join(', ')}</div>)}
        </div>
      );
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
// EXT-107 Р2: рядом — событие «тред сжат» (compactLine): свежее — обычным цветом, позже — бледное «сжат N раз»
function Memory({ m, now }) {
  if (!m) return null;
  const c = compactLine(m, now);
  const k = Math.round(m.tokens / 1000);
  const size = m.pct == null ? `память ${k > 0 ? k : 'меньше 1'} тыс.` : `память ${m.pct} %`;
  return (
    <div className="th2">
      {m.warn
        ? <span className="mem-warn">{size} — пора сделать снимок и открыть новый тред</span>
        : <span>{size}</span>}
      {c && <span className={c.faint ? 'faint' : undefined}>{c.text}</span>}
    </div>
  );
}

// inner (EXT-125) — тред целиком под «подробнее» строки «Цеха»: без своей шапки и рамки; кнопку «Перечитать правила» там
// не рисуем (она уже в строке замечания) — «Старые правила» показывают только список файлов
export function Thread({ t, now, inner = false }) {
  const [cls, word] = STATE[t.state] || ['free', t.state];
  const showCode = t.project && !(t.title || '').startsWith(t.project);
  return (
    <div className={inner ? 'thr thr-in' : 'thr'}>
      {!inner && <div className="th1">
        <span className="tname">
          {showCode && <span className="mono">{t.project}</span>}{t.title || 'без названия'}
          {t.project && t.projectBy === 'cards' && <span className="by-in"> · по карточкам</span>}
          {!t.project && <span className="faint"> · проект не определён</span>}
          {/* EXT-107 Р4: тред прораба — окна нет, ему отвечает дирижёр */}
          {foremanLabel(t) && <span className="faint"> · {foremanLabel(t)}</span>}
        </span>
        <span className={`st ${cls}`}>{word}</span>
      </div>}
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
      <Memory m={t.memory} now={now} />
      {t.subagents.map((s, i) => <Sub key={`${s.agent}-${i}`} s={s} />)}
      {t.marks.map((m, i) => <Mark key={`${m.kind}-${i}`} m={m} now={now} sid={inner ? undefined : t.sessionId} />)}
    </div>
  );
}

const GaugeLegend = () => (
  <div className="legend"><span><span className="gauge"><i style={{ width: '40%' }} /><b style={{ left: '55%' }} /></span> ходы до тормоза агента, риска — ориентир из ТЗ</span></div>
);

// EXT-125: тред одной строкой по-людски — чем занят или его замечания (кнопка «Перечитать правила» рядом); прежний вид треда
// целиком (карточка, память, помощники, пометки) — под «подробнее»
function PlainThread({ t, remarks, now }) {
  const [cls, word] = STATE[t.state] || ['free', t.state];
  const oldRules = t.marks.find((m) => m.kind === 'oldRules');
  const doing = !remarks.length || t.subagents.length > 0;
  return (
    <div className="thr">
      <div className="th1">
        <span className="tname">{t.title || 'без названия'}{!t.project && <span className="faint"> · проект не определён</span>}</span>
        <span className={`st ${cls}`}>{word}</span>
      </div>
      {doing && <div className="pl">{threadDoing(t)}</div>}
      {remarks.map((r) => (
        <div key={r.kind} className={`pl pl-${r.level}`}>
          <span>{r.text}</span>
          {r.reread && oldRules && <Reread session={t.sessionId} missing={oldRules.missing} now={now} bare />}
        </div>
      ))}
      <More>
        <Thread t={t} now={now} inner />
        {t.subagents.length > 0 && <GaugeLegend />}
      </More>
    </div>
  );
}

// треды без замечаний — одной строкой с раскрытием (свободные; «нет вестей» — своей строкой)
function Quiet({ id, title, list, now }) {
  const o = useOpen(`workers-${id}`, false);
  return (
    <details className="grp wq" open={o.open} onToggle={o.onToggle}>
      <Summary>{title}: <span className="wq-n">{list.map((t) => t.title || 'без названия').join(', ')}</span></Summary>
      {list.map((t) => <Thread key={t.sessionId} t={t} now={now} />)}
    </details>
  );
}

function Workers({ w, now, stale }) {
  const o = useOpen('workers');
  const v = workersView(w.threads);
  const busy = w.threads.filter((t) => t.state === 'busy').length;
  return (
    <details className="blk" open={o.open} onToggle={o.onToggle}>
      <Summary>
        Кто работает <span className="cnt num">{busy} из {w.threads.length}</span>
        {v.withRemarks > 0 && <span className="hint red">{plural(v.withRemarks, ['тред с замечанием', 'треда с замечаниями', 'тредов с замечаниями'])}</span>}
      </Summary>
      {v.shown.map((r) => <PlainThread key={r.t.sessionId} t={r.t} remarks={r.remarks} now={now} />)}
      {v.idle.length > 0 && <Quiet id="idle" title={v.shown.length ? 'Свободны, замечаний нет' : 'Все свободны, замечаний нет'} list={v.idle} now={now} />}
      {v.stale.length > 0 && <Quiet id="stale" title="Нет вестей" list={v.stale} now={now} />}
      {!w.threads.length && <div className="foot">Живых тредов нет.</div>}
      <Stale text={stale} />
      <div className="foot">Только живые треды на этом компьютере. Облачные сессии не видны.</div>
    </details>
  );
}

/* ---------- экран ---------- */

export default function Ceh({ data, failing, now, onOpenProject }) {
  const f = data.freshness || {};
  return (
    <>
    <Brief data={data} />
    <div className="grid">
      {/* wcol — колонка «Ждёт меня»: строки смотрят на её ширину (EXT-80, styles.css) */}
      <div className="col wcol">
        <Waiting w={data.waiting} now={now} pult={data.pult} threads={data.workers?.threads} order={(data.projects ?? []).map((p) => p.code)} stale={staleText(mergeFresh(f.board, f.journals), failing, now)} />
        <Projects projects={data.projects} pult={data.pult} now={now} stale={staleText(f.board, failing, now)} onOpen={onOpenProject} />
      </div>
      <div className="col">
        <Workers w={data.workers} now={now} stale={staleText(f.journals, failing, now)} />
        {data.pult?.enabled === true && <MyWords now={now} pult={data.pult} />}
        {data.pult?.enabled === true && <Worktrees />}
      </div>
    </div>
    </>
  );
}
