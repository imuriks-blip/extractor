// «Отозвать» (EXT-71, спека пульта §1.9): чистые куски — круг действий, разбор строк actions.log по отзываемому действию
// (порядок проверок 1–6), форма записи на карточке. Обработчик (шаги 1–6 порядка) — в routes.mjs: ему нужны звонок и очередь Plane.
import { OUTCOME_STEPS, lastStepLine } from './actions-log.mjs';

// Круг (Г6): действия, кладущие слово в звонок (шаг ring-queued). Прочие — not-withdrawable.
export const WITHDRAWABLE = ['yes', 'go', 'merge', 'deploy', 'no', 'reply', 'return', 'take', 'reread'];
// слово в записи отзыва и в строке «Отзывает» — то, что стоит в записи слова на карточке и в звонке (2.6)
export const WITHDRAW_WORD = { yes: 'да', go: 'го', merge: 'сливай', deploy: 'выкатывай', no: 'нет', reply: 'ответ', return: 'вернуть', take: 'в работу', reread: 'перечитай правила' };

const p2 = (n) => String(n).padStart(2, '0');
const ddmmhhmm = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Запись на карточке, режим mirror (§1.9 «Запись на карточке»). Строки «В ответ на» и приписки «Б — ждёт…» нет.
// number — номер слова (record), не обязательно номер действия; at — время слова (asked отзываемого); word — подпись слова.
export function withdrawHtml({ id, number, at, word }) {
  return `<p><b>Слово Ивана · кнопка витрины · ${id}</b>: «отозвать ${number}»</p>`
    + `<p>Отзывает: ${number} · ${ddmmhhmm(at)} · «${esc(word)}» — не исполнять; если уже исполнено — сказать Ивану в чате</p>`
    + `<p>Кто решил: слово Ивана · кнопка витрины · ${id}</p>`;
}

// Действия withdraw с withdraws == target, у которых есть asked (отказы до asked — не отзывы): [{id, ls, last}]
export function withdrawsOf(lines, target) {
  const byId = new Map();
  for (const l of lines) if (typeof l?.id === 'string') byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  const out = [];
  for (const [id, ls] of byId) {
    const asked = ls.find((l) => l.step === 'asked');
    if (asked?.action === 'withdraw' && asked.withdraws === target) out.push({ id, ls, last: lastStepLine(ls), at: asked.at });
  }
  return out;
}

// Разбор по строкам: проверки 1, 2, 4, 5, 6 §1.9 (проверку 3 — bell-off — и проверку 7 — память звонка — решает routes.mjs).
// → {refusal, message, ...} | {mode: 'full' | 'record' | 'noop', card, project, action, number, at, queued, aid, sid, ...}
//   full — шаги 1–6; record — только запись (шаг 5; прежняя запись — по show --last); noop — слово без карточки, звонок уже снят
export function planWithdraw(lines, target, { bellOn }) {
  const ls = lines.filter((l) => l?.id === target);
  if (!ls.length) return { refusal: 'no-target', message: `${target}: такого номера нет в журнале действий` };
  const asked = ls.find((l) => l.step === 'asked') ?? ls[0];
  if (!WITHDRAWABLE.includes(asked.action)) return { refusal: 'not-withdrawable', message: `«${asked.action}» отозвать нельзя: отзываются только слова, попавшие в звонок` };
  if (!bellOn) return { refusal: 'bell-off', message: 'звонок выключен (pult.bell): отзывать нечего — слова в памяти без звонка нет' };
  const queued = ls.find((l) => l.step === 'ring-queued') ?? null;
  const ws = withdrawsOf(lines, target);
  const info = { action: asked.action, card: asked.card ?? null, project: asked.project ?? null, at: asked.at, aid: target,
    queued: !!queued, sid: queued?.target?.sessionId ?? null, number: queued ? queued.word ?? queued.id : target };
  const done = ws.find((w) => w.last?.step === 'done');
  if (done) return { refusal: 'already-withdrawn', message: `уже отозвано (${done.id})`, withdrawnBy: done.id, ...info };
  const ivan = ls.find((l) => l.step === 'withdrawn' && l.reason === 'ivan');
  const restart = ls.find((l) => l.step === 'withdrawn' && l.reason === 'restart');
  // отзыв, чей asked лёг без исхода (его оборвал рестарт)
  const interrupted = ws.some((w) => !w.ls.some((l) => OUTCOME_STEPS.has(l.step)));
  if (ivan || (interrupted && restart)) {
    if (info.card) return { mode: 'record', ...info };
    if (ivan) return { mode: 'noop', ...info };
  }
  if (restart) {
    if (info.card) return { mode: 'record', ...info };
    return { refusal: 'not-queued', message: 'сброшено перезапуском — снимать нечего', ...info };
  }
  if (!queued) return { refusal: 'not-queued', message: 'слова нет в звонке (звонка не было) — отзывать нечего', ...info };
  return { mode: 'full', ...info };
}
