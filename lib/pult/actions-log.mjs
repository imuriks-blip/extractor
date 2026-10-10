// Журнал действий data/vitrina/actions.log (спека пульта §3.4): JSONL, только дописывается, строка на шаг.
// Первичный факт витрины: не обрезается, не пересчитывается. Не пишется никогда: токен страницы, ключи, вывод
// plane.py целиком, тексты тредов. Номер действия — W-<ГГММДД>-<ЧЧММСС>-<4 hex> по местному времени.
import crypto from 'node:crypto';
import fs from 'node:fs';

const p2 = (n) => String(n).padStart(2, '0');

// местное время с поясом: 2026-10-02T19:52:46+03:00
export function localIso(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

export function actionId(d) {
  return `W-${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function createActionsLog(file) {
  return {
    // строка шага; сбой записи — исключение: без строки asked действие не идёт (§1.1 п.8)
    append(line) {
      if (!file) throw Object.assign(new Error('actions.log не задан'), { code: 'NO_LOG' });
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
    },
    // все строки; битые пропускаются (файл дописывается, половина строки при обрыве — не повод падать)
    read() {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
      const out = [];
      for (const l of text.split('\n')) {
        if (!l) continue;
        try { out.push(JSON.parse(l)); } catch { /* битая строка */ }
      }
      return out;
    },
  };
}

// «Мои слова» (§1.7): строка на действие — время и поля шага asked (или первого шага), статус — последний шаг
// ring(lines действия) — статус слова звонка (2.8, ПТ4а) или null
// исход действия (вердикт Голема на ПТ4а, Важно 1): последняя из строк done / partial / refused / error; хвостовые шаги
// (ring-*, withdrawn, mirror-seen, mirror-missing) исход не меняют. Исхода ещё нет — последняя нехвостовая строка.
export const OUTCOME_STEPS = new Set(['done', 'partial', 'refused', 'error']);
export const TAIL_STEPS = new Set(['ring-queued', 'ring-delivered', 'withdrawn', 'mirror-seen', 'mirror-missing']);
export function outcomeLine(ls) {
  for (let i = ls.length - 1; i >= 0; i--) if (OUTCOME_STEPS.has(ls[i]?.step)) return ls[i];
  return null;
}
export function lastStepLine(ls) {
  return outcomeLine(ls) ?? [...ls].reverse().find((l) => !TAIL_STEPS.has(l?.step)) ?? ls.at(-1);
}

export function actionRows(lines, ring = () => null) {
  const byId = new Map();
  for (const l of lines) {
    if (typeof l?.id !== 'string') continue;
    const r = byId.get(l.id) ?? { first: l, asked: null, last: l, all: [] };
    if (l.step === 'asked' && !r.asked) r.asked = l;
    r.last = l;
    r.all.push(l);
    byId.set(l.id, r);
  }
  // EXT-71 (§1.9): номер отзываемого действия → номер отзыва, закончившегося done; номер слова в звонке (word ?? id шага ring-queued)
  const doneBy = new Map();
  const wordOf = new Map();
  for (const r of byId.values()) {
    const a = r.asked ?? r.first;
    if (a.action === 'withdraw' && typeof a.withdraws === 'string' && lastStepLine(r.all).step === 'done') doneBy.set(a.withdraws, a.id);
    const q = r.all.find((l) => l.step === 'ring-queued');
    if (q) wordOf.set(a.id, q.word ?? q.id);
  }
  return [...byId.values()].map(({ first, asked, last, all }) => {
    const a = asked ?? first;
    const proc = a.client?.proc;
    return {
      id: a.id, at: a.at ?? null, action: a.action ?? null, card: a.card ?? null, project: a.project ?? null,
      text: a.text ?? null, status: lastStepLine(all).step ?? null,
      // отметка процесса-источника — ПТ1б; до неё null
      source: proc ? { image: proc.image ?? null, ok: proc.ok === true, ...(proc.launcherGone === true ? { launcherGone: true } : {}) } : null,
      session: a.session ?? null,
      // звонок (2.8): положено · доставлено · прочитано · сброшено перезапуском · не доставлено: тред закрыт ·
      // звонок выключен (pult.bell = false, §4.3); у действия без звонка — null
      ring: ring(all),
      // время доставки звонка (шаг ring-delivered; EXT-65, §1.8: окно кнопки «Перечитать правила» считается от него); нет шага — null
      ringAt: all.find((l) => l.step === 'ring-delivered')?.at ?? null,
      // признак Б-дела шага need-confirm, как в actions.log (EXT-70): страница отличает «ждёт второго щелчка» от «ждёт выбора
      // треда»; шага нет или он без Б-дела — null
      bdeal: all.findLast((l) => l.step === 'need-confirm')?.bdeal ?? null,
      // отзыв (EXT-71, §1.9): у слова — номер отзыва, закончившегося done (отзыв без done — слово «отозвано», но withdrawnBy нет);
      // у строки withdraw — номер отзываемого действия и номер слова в звонке
      ...(doneBy.has(a.id) ? { withdrawnBy: doneBy.get(a.id) } : {}),
      ...(a.action === 'withdraw' ? { withdraws: a.withdraws ?? null, word: wordOf.get(a.withdraws) ?? null } : {}),
    };
  });
}
