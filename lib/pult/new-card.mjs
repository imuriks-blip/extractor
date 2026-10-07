// «Новая карточка / мысль» (ПТ9, EXT-81; спека пульта §1.1 пп.3, 4, 7, 8, §1.3, §1.6): действие new-card.
// Порядок: проект без «новой карточки» (RADAR) → отказ → поиск похожих (функция доски similar, не копия) → без confirm и
// с похожими — need-confirm (ничего не записано) → со вторым щелчком — сверка как у Б-слов (words.mjs) → создание:
// файл card-<id>.json, `plane.py create <КОД> <файл>`, файл удаляется после вызова.
// Исход создания не сверяется повтором: карточки ещё нет, номер неизвестен. Неясный исход — явный, автоповтора нет.
import fs from 'node:fs';
import path from 'node:path';
import { escLines, firstLineOf } from './accept.mjs';
import { CONFIRM_MS } from './words.mjs';

export const NO_NEW_CARD = { RADAR: 'в RADAR карточка рождается с вердиктом — заводит дирижёр' };
export const SIMILAR_MAX = 5;
const CREATED = /^создана ([A-Z]{2,6}-\d+) · \S+/m;
// первая строка отказа plane.py, после которого карточка точно не создана (ответ доски получен и это отказ; нет статуса/проекта/доступа)
const NOT_CREATED = /^(?:Доска ответила [1-4]\d\d|Нет статуса|Нет проекта|нет )/;
export const UNCLEAR_MESSAGE = 'исход неясен — проверь доску: карточка могла создаться (повторять вслепую нельзя)';

// похожие заголовки: карточки проекта по файлам зеркала в порядке readdir (`${id}.md`), первые SIMILAR_MAX
export function similarCards({ board, similar, project, title }) {
  return board.cardsList()
    .filter((c) => c.code === project && typeof c.title === 'string' && similar(title, c.title))
    .sort((a, b) => { const x = `${a.id}.md`; const y = `${b.id}.md`; return x < y ? -1 : x > y ? 1 : 0; })
    .slice(0, SIMILAR_MAX);
}

export const newCardHtml = ({ id, text }) => (text ? `<p>${escLines(text)}</p>` : '')
  + `<p>Кто решил: слово Ивана · кнопка витрины · ${id}</p>`;

// board — читатель доски; similar(a, b) — функция доски; mask/maskP — маска; readLines — actions.log; tmpDir — папка временных файлов
export function createNewCardHandler({ board, readLines, mask = (t) => t, maskP = (t) => mask(t), now = Date.now, similar, tmpDir, fs: fsx = fs }) {
  return async function newCard(ctx) {
    const { id, project, title, text, plane, step, confirm } = ctx;
    const maskIn = (t) => maskP(t, project); // одна маска с asked (routes)
    const refused = (refusal, message) => ({ outcome: 'refused', refusal, message });
    if (Object.hasOwn(NO_NEW_CARD, project)) return refused('no-new-card', NO_NEW_CARD[project]);

    if (!confirm) {
      const found = similarCards({ board, similar, project, title });
      if (found.length) {
        const list = found.map((c) => ({ id: c.id, title: maskIn(c.title) }));
        return { outcome: 'need-confirm', message: `похожие: ${list.map((c) => `${c.id} · ${c.title}`).join('\n')}`,
          confirm: { what: `Новая карточка · ${project}: ${maskIn(title)}`, follows: 'создастся карточка в Backlog', mirrorAt: board.mirrorStatus?.()?.lastOkAt ?? null, similar: list } };
      }
    } else {
      const lines = readLines();
      const asked = lines.find((l) => l?.id === confirm && l.step === 'asked');
      const waited = lines.some((l) => l?.id === confirm && l.step === 'need-confirm');
      if (!asked || !waited || asked.action !== 'new-card' || (asked.project ?? null) !== project
        || (asked.title ?? null) !== maskIn(title) || (asked.text ?? null) !== (text === null ? null : maskIn(text))) return refused('bad-confirm', 'подтверждение не от этого нажатия — нажми заново');
      const askedAt = Date.parse(asked.at);
      if (!Number.isFinite(askedAt) || now() - askedAt > CONFIRM_MS) return refused('confirm-expired', 'подтверждение просрочено (не дольше 5 минут) — нажми заново');
      // потрачено: другое нажатие с этим confirm прошло сверку (шаг confirmed) — оно создаёт или уже создало; параллельное второе не должно
      // успеть между сверкой и шагом plane (там await), поэтому считается шаг confirmed, а не только plane/create и исход
      const spent = lines.some((l) => l?.step === 'confirmed' && l.confirm === confirm && l.id !== id);
      if (spent) return refused('bad-confirm', 'это подтверждение уже использовано — нажми заново');
      step({ step: 'confirmed', confirm });
    }

    const file = path.join(tmpDir, `card-${id}.json`);
    let r;
    try {
      fsx.mkdirSync(tmpDir, { recursive: true });
      fsx.writeFileSync(file, JSON.stringify({ name: title, description_html: newCardHtml({ id, text }), state: 'Backlog' }));
    } catch (e) {
      remove(fsx, file);
      return { outcome: 'error', message: `не создана: временный файл не записался (${typeof e?.code === 'string' ? e.code : 'ERR'})`, result: { code: 'NOT_CREATED' } };
    }
    const t0 = Date.now();
    try {
      r = await plane.push(['create', project, file]);
    } catch (e) {
      // очередь без plane.py (не подключён) — ничего не запускалось; прочий сбой исполнителя — исход неясен
      if (e?.code === 'NOT_CONNECTED') return { outcome: 'error', message: 'не создана: plane.py не подключён', result: { code: 'NOT_CREATED' } };
      return { outcome: 'error', message: UNCLEAR_MESSAGE, result: { code: 'UNCLEAR' } };
    } finally {
      remove(fsx, file);
    }
    const ms = Date.now() - t0;
    const raw = firstLineOf(r.code === 0 ? r.stdout : (r.stderr || r.stdout)) || (r.timedOut ? 'таймаут' : r.spawnError ?? '');
    const line = mask(raw);
    step({ step: 'plane', cmd: 'create', result: { code: r.code, line, ms } });
    if (r.code === 0) {
      const m = String(r.stdout ?? '').match(CREATED);
      if (m && m[1].split('-')[0] === project) return { outcome: 'ok', message: `создана ${m[1]} · Backlog`, result: { created: m[1] }, extra: { created: m[1] } };
    } else if (r.code === 1 && NOT_CREATED.test(raw)) {
      return { outcome: 'error', message: `не создана: ${line}`, result: { code: 'NOT_CREATED', line } };
    }
    return { outcome: 'error', message: UNCLEAR_MESSAGE, result: { code: 'UNCLEAR', line } };
  };
}

function remove(fsx, file) {
  try { fsx.unlinkSync(file); } catch { /* ENOENT — файла нет; прочее — не меняет исход */ }
}
