// Проверка следа рядом с «Принять» (EXT-48; спека пульта §1.4а). Только показывает — «Принять» не прячет и не блокирует.
// trace: undefined — поля нет (строки (б), карточка не в Review) — ничего; null — ещё не посчитано, «проверяю след…»;
// {state, label, hint, reasons[]} — подпись и причины готовые от сервера. Состояние — знаком и словом, не только цветом.
import { plural } from './format.js';

// число не отрывается от соседних слов при переносе: «ещё 1 запись», «· ещё 1» — неразрывными пробелами
const NB = String.fromCharCode(160);
const glue = (s) => String(s ?? '').replace(/ (\d+)(?=\s|$)/g, NB + '$1').replace(/(?<=\s|^)(\d+) /g, '$1' + NB);

const SIGN = { ok: '✓', warn: '!', bad: '✕', none: '–' };
const LEVEL = { bad: ['✕', 'ошибка'], warn: ['!', 'предупреждение'], info: ['·', 'к сведению'] };

// значок строки (в): подпись label, hint — подсказкой и для экранного чтеца
export function TraceBadge({ t, bare = false }) {
  // bare — в панели: «сверено: …» там отдельной строкой, подсказка не нужна
  if (t === undefined) return null;
  if (t === null) return <span className="trc t-wait"><span className="ts" aria-hidden="true">…</span><span>проверяю след</span></span>;
  const st = SIGN[t.state] ? t.state : 'none';
  // В2 Голема: после контракта есть записи — серым при любом state (зелёное стоит по старому контракту); в панели это причина info
  const later = !bare && t.laterRecords > 0
    ? (t.reasons?.find((r) => r.code === 'later')?.text ?? `после контракта — ещё ${plural(t.laterRecords, ['запись', 'записи', 'записей'])}`)
    : null;
  return (
    <span className={`trc t-${st}`} title={(!bare && t.hint) || undefined}>
      <span className="ts" aria-hidden="true">{SIGN[st]}</span>
      <span>{glue(t.label)}{!bare && t.hint && <span className="sr">. {t.hint}</span>}{later && <span className="tlt"> · {glue(later)}</span>}</span>
    </span>
  );
}

// блок «След» в панели карточки: итог, полный список причин, «сверено: …»; info (в т.ч. «после контракта — ещё N») — серым
export function TraceBlock({ t }) {
  if (t === undefined) return null;
  const list = t?.reasons ?? [];
  return (
    <div className="trb">
      <div className="trh"><span className="trk">След</span><TraceBadge t={t} bare /></div>
      {list.length > 0 && (
        <ul className="trl">
          {list.map((r, i) => {
            const [sign, word] = LEVEL[r.level] ?? LEVEL.info;
            return (
              <li key={`${r.code}-${i}`} className={`tr-${LEVEL[r.level] ? r.level : 'info'}`}>
                <span className="ts" aria-hidden="true">{sign}</span><span><span className="sr">{word}: </span>{r.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {t?.hint && <div className="trs">{t.hint}</div>}
    </div>
  );
}
