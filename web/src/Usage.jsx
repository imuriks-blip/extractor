// Экран «Расход» (EXT-84, ПТ12; спека пульта §6): объём из журналов по дням, проектам, агентам и тредам, предупреждение
// «за 5 ч выше обычного», остаток — строкой из уже виденного события. Кнопки «Замерить» нет (слово Ивана 07.10).
// Данные — GET /api/usage, опрос раз в 30 с (usageSource). Разметка и стили — как у соседних экранов (.blk, .ptable, .seg, .alarm).
import { useState } from 'react';
import { usageSource, useSource } from './data.js';
import { PARTS, breakdownRows, dayBars, exact, fmtTokens, noUsage, remainingLine, shares, windowNote, dayLabel } from './usageData.js';

const PCLS = { in: 'p-in', out: 'p-out', cacheRead: 'p-cr', cacheWrite: 'p-cw' };

function Bar({ row, thin }) {
  const s = shares(row);
  if (!(row?.total > 0)) return <span className={`ubar${thin ? ' thin' : ''}`} aria-hidden="true" />;
  return (
    <span className={`ubar${thin ? ' thin' : ''}`} aria-hidden="true">
      {s.filter((p) => p.frac > 0).map((p) => <i key={p.k} className={PCLS[p.k]} style={{ flexGrow: p.frac }} />)}
    </span>
  );
}

function Tile({ title, date, row }) {
  const s = shares(row);
  return (
    <section className="blk utile" aria-label={title}>
      <h2 className="uh"><span>{title}</span><span className="muted mono">{date}</span></h2>
      <div className="ubig"><span className="big num" title={`${exact(row?.total)} токенов`}>{fmtTokens(row?.total)}</span><span className="muted"> токенов</span></div>
      <Bar row={row} />
      <dl className="u4">
        {s.map((p) => (
          <div key={p.k}>
            <dt><i className={`sw ${PCLS[p.k]}`} />{p.short}</dt>
            <dd className="num" title={`${exact(p.value)} токенов`}>{fmtTokens(p.value)}<span className="muted"> · {p.pct} %</span></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Days({ days }) {
  const bars = dayBars(days);
  return (
    <section className="blk" aria-label="По дням">
      <h2 className="uh"><span>По дням</span><span className="muted">высота — объём за день</span></h2>
      <div className="udays">
        {bars.map((b) => (
          <div key={b.date} className={`ud${b.today ? ' today' : ''}`} title={`${b.label}: ${exact(b.total)} токенов`}>
            <span className="num uv">{b.total > 0 ? fmtTokens(b.total) : '0'}</span>
            <span className="ucol"><span className="ustack" style={{ height: `${Math.max(b.total > 0 ? 3 : 0, Math.round(b.h * 100))}%` }}>
              {b.parts.filter((p) => p.frac > 0).map((p) => <i key={p.k} className={PCLS[p.k]} style={{ flexGrow: p.frac }} />)}
            </span></span>
            <span className="ul mono">{b.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const Legend = () => (
  <span className="uleg">{PARTS.map((p) => <span key={p.k}><i className={`sw ${PCLS[p.k]}`} />{p.label}</span>)}</span>
);

function Cells({ row }) {
  return (
    <>
      {PARTS.map((p) => <td key={p.k} className="n num u4c" title={`${exact(row[p.k])} токенов`}>{fmtTokens(row[p.k])}</td>)}
      <td className="n num ut" title={`${exact(row.total)} токенов`}>{fmtTokens(row.total)}</td>
    </>
  );
}

// строка с названием; на узком экране четыре числа — второй строкой под названием (.u4m), колонки скрыты
function Table({ rows, head }) {
  if (!rows.length) return <div className="empty">Нет расхода в этом окне.</div>;
  return (
    <div className="tw">
      <table className="ptable utable">
        <thead><tr><th>{head}</th>{PARTS.map((p) => <th key={p.k} className="n u4c">{p.short}</th>)}<th className="n">сумма</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="uname">
                {r.tag && <span className="code">{r.tag}</span>}{r.tag ? ' ' : ''}<span title={r.name}>{r.name}</span>
                <span className="u4m muted num">{PARTS.map((p) => `${p.short} ${fmtTokens(r.row[p.k])}`).join(' · ')}</span>
              </td>
              <Cells row={r.row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breakdowns({ d }) {
  const [scope, setScope] = useState('today');
  const kinds = [['byProject', 'По проектам', 'проект'], ['byAgent', 'По агентам', 'агент'], ['byThread', 'По тредам', 'тред']];
  return (
    <>
      <div className="utool">
        <span className="seg" role="group" aria-label="Окно разреза">
          <button type="button" aria-pressed={scope === 'today'} onClick={() => setScope('today')}>Сегодня</button>
          <button type="button" aria-pressed={scope === 'week'} onClick={() => setScope('week')}>7 дней</button>
        </span>
        <Legend />
      </div>
      {kinds.map(([kind, title, head]) => {
        const rows = breakdownRows(d, kind, scope);
        return (
          <section key={kind} className="blk" aria-label={title}>
            <h2 className="uh"><span>{title}</span><span className="muted num">{rows.length}</span></h2>
            <Table rows={rows} head={head} />
          </section>
        );
      })}
    </>
  );
}

function Top5({ rows }) {
  const list = (Array.isArray(rows) ? rows : []).map((r, i) => ({ key: `${i}:${r.sessionId}`, name: r.title ?? '', tag: r.project ?? null, row: r }));
  return (
    <section className="blk" aria-label="Топ-5 тредов за 5 ч">
      <h2 className="uh"><span>Топ-5 тредов за 5 ч</span></h2>
      <Table rows={list} head="тред" />
    </section>
  );
}

function WindowNote({ w }) {
  const n = windowNote(w);
  if (n.kind === 'none') return null;
  if (n.kind === 'warn') {
    return <div className="ubn warn" role="alert" title={n.title}><b className="h">{n.head}</b>{n.text}</div>;
  }
  return <div className={`ubn ${n.kind}`} role="status" title={n.title}>{n.text}</div>;
}

function Remaining({ d }) {
  const r = remainingLine(d);
  return (
    <div className={`urem${r.has ? '' : ' none'}`} role="status">
      {r.has && <><span className="muted">Остаток</span>{' '}</>}<span className="num">{r.text}</span>
      {r.expired && <span className="pamb"> · {r.expired}</span>}
      {r.note && <span className="faint"> · {r.note}</span>}
    </div>
  );
}

export default function Usage() {
  const { data, failingSince, error } = useSource(usageSource);
  if (!data) {
    return <div className="foot" role="status">{failingSince ? 'Сервер витрины не отвечает — пробую снова каждые 30 с.' : 'Читаю данные…'}{failingSince && error ? ` (${error})` : ''}</div>;
  }
  const empty = noUsage(data);
  return (
    <div className="ucol1">
      {failingSince != null && <div className="foot" role="status">Сервер витрины не отвечает — показаны прежние данные.</div>}
      <WindowNote w={data.window5h} />
      <Remaining d={data} />
      {empty ? (
        <div className="blk"><div className="empty">За 7 дней расхода не видно: в журналах тредов нет сообщений с подсчётом токенов.</div></div>
      ) : (
        <>
          <div className="ugrid">
            <Tile title="Сегодня" date={dayLabel(data.today?.date)} row={data.today} />
            <Tile title="7 дней" date={`${dayLabel(data.week?.from)}–${dayLabel(data.week?.to)}`} row={data.week} />
          </div>
          <Days days={data.days} />
          <Breakdowns d={data} />
          <Top5 rows={data.top5h} />
          {data.unplaced > 0 && <div className="foot">Не поставлено в день (нет времени или ключа), за всё время с пересборки индекса: {data.unplaced} строк.</div>}
        </>
      )}
    </div>
  );
}
