// «Отложить до …» (EXT-47, спека пульта §1.3, §1.7 defer/undefer): личная отметка Ивана на строке «Ждёт меня».
// Не слово по карточке — в Plane ничего не пишется; след — actions.log (routes.mjs) и отметка в data/vitrina/defer.json
// (временный файл и переименование). Ключ отметки — `key` строки (спека витрины 1.6): у (а) — sessionId|uuid вопроса,
// у (б) и (в) — номер|заголовок последней записи журнала. Новый вопрос — новый key, старая отметка строку не прячет.
// Отметка действует, пока until в будущем; снимает её sweep — цикл уведомлений (start.mjs): срок прошёл и строка
// на месте — тост «вернулось: …»; строки нет (ответ, закрытие) — молча.
import nodeFs from 'node:fs';
import path from 'node:path';
import { localIso } from './actions-log.mjs';

// сроки меню (решено автором спеки): местное время машины; произвольная дата не принимается
export const UNTIL = ['1h', 'tomorrow9', '3days9', 'monday9'];

// срок → мс по местному календарю (setDate/setHours — переход на летнее время учтён); незнакомое — null.
// monday9 — понедельник следующей недели: в понедельник это +7 дней, не сегодняшние 9:00.
export function untilOf(choice, nowMs) {
  const d = new Date(nowMs);
  const at9 = (days) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 9, 0, 0, 0); return x.getTime(); };
  if (choice === '1h') return nowMs + 3600000;
  if (choice === 'tomorrow9') return at9(1);
  if (choice === '3days9') return at9(3);
  if (choice === 'monday9') { const wd = d.getDay(); return at9(((8 - wd) % 7) || 7); }
  return null;
}

// пункты меню (спека пульта §1.3) с готовым временем на момент ответа — вид показывает дату серым
const UNTIL_LABEL = { '1h': 'на 1 ч', tomorrow9: 'завтра 9:00', '3days9': 'через 3 дня 9:00', monday9: 'в понедельник 9:00' };
export const deferOptions = (nowMs) => UNTIL.map((until) => ({ until, label: UNTIL_LABEL[until], at: localIso(new Date(untilOf(until, nowMs))) }));

// подпись срока для message: «ДД.ММ ЧЧ:ММ» местным временем
const p2 = (n) => String(n).padStart(2, '0');
export const untilLabel = (ms) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

// строки «Ждёт меня» по группам: что за строка — подпись, карточка, проект
const GROUPS = [['threads', 'thread'], ['yes', 'yes'], ['review', 'review']];
const labelOf = (group, r) => (group === 'thread' ? (r.title || 'Тред') : (r.title || r.id || ''));
export function findRow(waiting, key) {
  for (const [list, group] of GROUPS) {
    const r = (waiting?.[list] ?? []).find((x) => x.key === key);
    if (r) return { group, row: r };
  }
  const d = (waiting?.deferred ?? []).find((x) => x.key === key);
  return d ? { group: d.group, row: d } : null;
}

// Строка исчезла (ответ, закрытие) — отметка снимается молча, но только когда строки нет MISS_PASSES циклов sweep подряд
// и каждый цикл видел новый удачный проход читателя её группы (журналы — (а), доска — (б)/(в)): неудачный проход или тот
// же проход ещё раз счёт не двигают, строка вернулась — счёт сначала (вердикт Голема на EXT-47, В3).
export const MISS_PASSES = 3;
const CARD_KEY = /^[A-Z]{2,6}-\d+\|/;
const readerOf = (key, m) => ((m.group ?? (CARD_KEY.test(key) ? 'yes' : 'thread')) === 'thread' ? 'thread' : 'board');

// file — data/vitrina/defer.json; null (тесты без каталога) — только в памяти. Файл: {marks: {<key>: {until, at, id, group}}}
// (until и at — местное время с поясом). Битый или пустой файл — как пустой: строки просто видны.
// Память меняется только после удачной записи файла (М5): сбой — исключение наружу, отметки как были.
export function createDeferStore({ file = null, now = Date.now, fs = nodeFs, onError = () => {} } = {}) {
  let marks = new Map();
  const misses = new Map(); // key → {n, lastAt}: циклы без строки при удачных проходах читателя
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, m] of Object.entries(j?.marks ?? {})) {
        const until = Date.parse(m?.until);
        if (Number.isFinite(until)) marks.set(k, { until, at: m.at ?? null, id: m.id ?? null, group: m.group ?? null });
      }
    } catch { /* нет файла или битый — пусто */ }
  }
  // записать next и только потом сделать его памятью
  const commit = (next) => {
    if (file) {
      const out = { marks: Object.fromEntries([...next].map(([k, m]) => [k, { until: localIso(new Date(m.until)), at: m.at, id: m.id, group: m.group }])) };
      const tmp = `${file}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
      fs.renameSync(tmp, file);
    }
    marks = next;
  };
  const activeKey = (k) => { const m = marks.get(k); return m && m.until > now() ? m : null; };

  return {
    // запись — исключение наружу: без файла отметка не переживёт рестарт, действие — «не вышло» (routes.mjs)
    set(key, until, id, group = null) {
      const next = new Map(marks);
      next.set(key, { until, at: localIso(new Date(now())), id, group });
      commit(next);
      misses.delete(key);
    },
    remove(key) {
      if (!marks.has(key)) return false;
      const next = new Map(marks);
      next.delete(key);
      commit(next);
      misses.delete(key);
      return true;
    },
    has: (key) => marks.has(key),
    // waiting без строк с действующей отметкой + deferred[] — {key, group, label, card, project, until}; count/more
    // пересчитывает app.mjs (у него правило «отвечено, ждёт зеркала»)
    apply(waiting) {
      const deferred = [];
      const out = { ...waiting };
      for (const [list, group] of GROUPS) {
        out[list] = (waiting[list] ?? []).filter((r) => {
          const m = r.key ? activeKey(r.key) : null;
          if (!m) return true;
          deferred.push({ key: r.key, group, label: labelOf(group, r), card: group === 'thread' ? null : (r.id ?? null), project: r.project ?? null,
            until: localIso(new Date(m.until)) });
          return false;
        });
      }
      out.deferred = deferred.sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
      return out;
    },
    // цикл уведомлений: waiting — уже после apply (видимые строки и deferred); health — {thread, board}: состояние
    // читателей {lastOkAt, failingSince}. Отметка строки из deferred — живёт; строка видна и срок прошёл — отметка снята,
    // строка тоста «вернулось: …» (ключ — на эту отметку, один раз); строки нет — правило MISS_PASSES (молча).
    // Запись не удалась — память как была, тостов нет (повтор на следующем цикле), код — в onError.
    sweep(waiting, health = {}) {
      if (marks.size === 0) return [];
      const deferredKeys = new Set((waiting?.deferred ?? []).map((d) => d.key));
      const back = [];
      const next = new Map(marks);
      const nextMisses = new Map(misses);
      for (const [key, m] of marks) {
        if (deferredKeys.has(key)) { nextMisses.delete(key); continue; }
        const found = findRow(waiting, key);
        if (!found) {
          const h = health?.[readerOf(key, m)];
          if (!h || h.failingSince || !h.lastOkAt) continue; // проход не удался или его не было — счёт стоит
          const prev = nextMisses.get(key) ?? { n: 0, lastAt: null };
          if (prev.lastAt === h.lastOkAt) continue; // тот же проход — не новый
          const n = prev.n + 1;
          if (n < MISS_PASSES) { nextMisses.set(key, { n, lastAt: h.lastOkAt }); continue; }
          next.delete(key);
          nextMisses.delete(key);
          continue;
        }
        nextMisses.delete(key);
        if (m.until > now()) continue; // отметили между сборкой и циклом — до следующего цикла
        next.delete(key);
        const { group, row } = found;
        const card = group === 'thread' ? null : (row.id ?? null);
        const label = labelOf(group, row);
        const what = card ? `${card} · ${label}` : label;
        const body = group === 'thread' ? (row.text ?? '') : group === 'yes' ? [row.mark, 'нужно твоё «да»'].filter(Boolean).join(' · ') : 'готово, посмотри';
        // force — «вернулось» не глушится тихим циклом старта и пробуждения (В1)
        back.push({ key: `defer|${key}|${m.until}`, title: `вернулось: ${what}`, body, force: true });
      }
      misses.clear();
      for (const [k, v] of nextMisses) misses.set(k, v);
      if (next.size !== marks.size) {
        try { commit(next); } catch (e) { onError(e); return []; }
      }
      return back;
    },
  };
}
