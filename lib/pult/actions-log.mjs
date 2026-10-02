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
export function actionRows(lines) {
  const byId = new Map();
  for (const l of lines) {
    if (typeof l?.id !== 'string') continue;
    const r = byId.get(l.id) ?? { first: l, asked: null, last: l };
    if (l.step === 'asked' && !r.asked) r.asked = l;
    r.last = l;
    byId.set(l.id, r);
  }
  return [...byId.values()].map(({ first, asked, last }) => {
    const a = asked ?? first;
    const proc = a.client?.proc;
    return {
      id: a.id, at: a.at ?? null, action: a.action ?? null, card: a.card ?? null, project: a.project ?? null,
      text: a.text ?? null, status: last.step ?? null,
      // отметка процесса-источника — ПТ1б; до неё null
      source: proc ? { image: proc.image ?? null, ok: proc.ok === true } : null,
      session: a.session ?? null,
    };
  });
}
