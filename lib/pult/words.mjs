// Слова-кнопки (ПТ6, EXT-67; спека пульта §1.1 пп.5–9, §1.2, таблица 1.3 строки «да», «го», «сливай», «выкатывай», «нет»,
// «Ответ треду», §2.3, §2.8, §4.3 «pult.words»): yes · go · merge · deploy · no · reply.
// Порядок (1.1): проверки по зеркалу → [Б-дело: второй щелчок] → свежая сверка `show --last` (закрытая карточка, статус,
// «новое сообщение») → запись 1.2 (`comment`, статуса нет) → дотяжка → звонок (2.3). Не легла запись — звонка нет.
// Сверка, вызов plane.py, запись с неясным исходом — общие с «Принять»/«Вернуть» (accept.mjs), звонок — ringFor routes.mjs.
// Ответ треду из строки (а) (session) — q = {uuid, at}: сверка по журналу треда; у треда без карточки записи на доске
// нет — след actions.log и звонок.
import { hhmm, newerThanQ, planeTools, priorOpen, recordHtml, writeRecord } from './accept.mjs';
import { pickThread } from './bell.mjs';

export const WORD_LABEL = { yes: 'да', go: 'го', merge: 'сливай', deploy: 'выкатывай', no: 'нет', reply: 'ответ' };
export const WORD_ACTIONS = Object.keys(WORD_LABEL);
export const CONFIRM_MS = 5 * 60000; // второй щелчок — не дольше 5 мин после шага asked (1.1 п.7)

// Б-дело (1.3, одно определение): слово «сливай»/«выкатывай»; mark_b; последняя запись — вопрос с меткой (развилка /
// выкатывай / сливай — card.last.mark); в заголовке карточки или в начале последней записи — база, auth, снос (слова
// из 1.3, граница слова слева явная — \b на кириллице не работает; стем «база» ловит «базы», «в базу»). → признак | null
const B_WORD = /(?:^|[^\p{L}\p{N}_])(?:баз(?:а|у|е|ы|ой)(?![\p{L}\p{N}_])|миграц|auth|вход|снос|удален)/iu;
export function bDeal(card, action) {
  if (action === 'merge' || action === 'deploy') return `слово «${WORD_LABEL[action]}»`;
  if (card?.markB === true) return 'mark_b';
  if (card?.last?.mark) return `последняя запись — «${card.last.mark}»`;
  const m = `${card?.title ?? ''}\n${card?.last?.bodyHead ?? ''}`.match(B_WORD);
  return m ? `признак «${m[0].replace(/^[^\p{L}\p{N}_]/u, '').toLowerCase()}»` : null;
}

// форма q слова: у карточки без session — {at, head}/{at: null}; у ответа из строки (а) (есть session) — {uuid, at}.
// Поля q нет вовсе — 400 (1.1 п.5). → true — годится
export function wordQOk(v) {
  if (!v.q) return false;
  return v.action === 'reply' && v.session ? v.q.uuid !== undefined : v.q.uuid === undefined;
}

const sameQ = (a, b, mask) => !!a && !!b && a.at === b.at && (a.uuid ?? null) === (b.uuid ?? null)
  && (a.head === undefined ? b.head === undefined : b.head !== undefined && a.head === mask(b.head));
const CLOSED = /^(done|cancel+ed)$/i;

// board — читатель доски; readLines — actions.log; mask(text) — маска; mirror — {pull(card)}; ring(ctx) — звонок routes.mjs;
// bellOn() — включён ли звонок (pult.bell); threadsNow() — живые треды; sessionsNow() — выжимки журналов (thread.q — последний вопрос треда)
export function createWordHandlers({ board, readLines, mask = (t) => t, now = Date.now, mirror = null, ring, bellOn = () => false, threadsNow = () => [], sessionsNow = () => [] }) {
  async function act(ctx) {
    const { id, action, card: cardId, session, q, text, plane, step, confirm } = ctx;
    const word = WORD_LABEL[action];
    const refused = (refusal, message, extra = {}) => ({ outcome: 'refused', refusal, message, ...extra });
    const card = cardId ? board.card(cardId) : null;
    if (cardId) {
      if (!card) return refused('no-card', `${cardId}: карточки нет в файлах доски`);
      if (card.status === 'done' || card.status === 'cancelled') return refused('closed', `${cardId}: карточка закрыта (${card.status}) — слово не пишется`);
      // «сливай»/«выкатывай» — у карточки в Review (таблица 1.3, колонка «Где»)
      if ((action === 'merge' || action === 'deploy') && card.status !== 'review') return refused('not-review', `${cardId}: по зеркалу не в Review (${card.status})`, { pull: true });
    }
    // строка (а): ровно этот тред (2.3 п.1); жив ли он и не задал ли новый вопрос — по его журналу (1.1 п.6, третий пункт)
    if (session) {
      if (!threadsNow().some((t) => t.sessionId === session)) return refused('thread-closed', 'тред закрыт — слово не доставлено');
      if (!cardId && !bellOn()) return refused('bell-off', 'звонок выключен (pult.bell): ответ треду без карточки некуда записать — на доске его не будет');
      const sess = sessionsNow().filter((s) => s.sessionId === session).sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))[0];
      const cur = sess?.thread?.q;
      if (!cur?.uuid || cur.uuid !== q.uuid) return refused('new-question', 'тред задал новый вопрос — посмотри и ответь заново');
    }

    // Б-дело (1.3, 1.1 п.7): без второго щелчка — ничего во внешнем мире (ни Plane, ни звонка). Свободный ответ строки (а)
    // согласием на Б-дело не считается никогда (К2) — у него Б не бывает.
    // признак Б есть и у ответа строки (а) — на нём приписка «Б — ждёт «да» в чате» (1.2); второй щелчок — только без session
    const bAny = bDeal(card, action);
    const bd = session ? null : bAny;
    if (bd) {
      if (!confirm) {
        const code = cardId.split('-')[0];
        const pk = pickThread({ threads: threadsNow(), card: cardId, now: now() });
        return { outcome: 'need-confirm', bdeal: bd, message: `Б-дело (${bd}): нужен второй щелчок — потом запись на карточке и звонок`,
          confirm: { what: `«${word}» по ${cardId}, проект ${code}`,
            follows: action === 'merge' ? 'слить = выкатить на Railway там, где проект катится из main сам; выкатку держит щелчок «спросить» на push'
              : action === 'deploy' ? `выкатка в прод проекта ${code}` : 'Б-дело: запись пульта не согласие — тред переспросит «да» в чате',
            q, mirrorAt: board.mirrorStatus?.()?.lastOkAt ?? null,
            ...(pk.kind === 'many' ? { candidates: pk.candidates.map((c) => ({ sessionId: c.sessionId, title: c.title, by: c.by })) } : {}) } };
      }
      const lines = readLines();
      const asked = lines.find((l) => l?.id === confirm && l.step === 'asked');
      const waited = lines.some((l) => l?.id === confirm && l.step === 'need-confirm');
      if (!asked || !waited || asked.action !== action || (asked.card ?? null) !== cardId || (asked.session ?? null) !== (session ?? null)
        || !sameQ(asked.q, q, mask) || (asked.text ?? null) !== (text === null ? null : mask(text))) return refused('bad-confirm', 'подтверждение не от этого нажатия — нажми заново');
      const askedAt = Date.parse(asked.at);
      if (!Number.isFinite(askedAt) || now() - askedAt > CONFIRM_MS) return refused('confirm-expired', 'подтверждение просрочено (не дольше 5 минут) — нажми заново');
      const spent = lines.some((l) => l?.step === 'confirmed' && l.confirm === confirm && l.id !== id
        && lines.some((p) => p?.id === l.id && p.step === 'plane' && p.cmd === 'comment'));
      if (spent) return refused('bad-confirm', 'это подтверждение уже использовано — нажми заново');
      step({ step: 'confirmed', confirm, bdeal: bd });
    }

    let record = id;
    const ringWord = { word, text: action === 'no' || action === 'reply' ? text || undefined : undefined };
    if (cardId) {
      const prior = priorOpen(readLines(), cardId, action, id);
      const { call, lineOf, freshRead } = planeTools({ plane, step, mask, cardId });
      const f = await freshRead(null);
      if (!f.sh) return { outcome: 'error', message: `свежая сверка не удалась: ${lineOf(f.r)}`, result: { code: 'FRESH', line: lineOf(f.r) } };
      const mirrorAt = board.mirrorStatus?.()?.lastOkAt ?? null;
      if (CLOSED.test(f.sh.status)) return refused('closed', `в Plane карточка закрыта (${f.sh.status}) — слово не пишется`, { pull: true });
      if ((action === 'merge' || action === 'deploy') && f.sh.status !== 'Review') {
        return refused('stale-status', `в Plane сейчас ${f.sh.status}; зеркало от ${mirrorAt ? hhmm(Date.parse(mirrorAt)) : '—'} — дотянуть?`, { pull: true });
      }
      const last = f.sh.last;
      // прежний номер — только если последний коммент в Plane несёт именно его (как у «Принять», Критично 1 Голема на ПТ3)
      const had = prior && last?.text.includes(prior.record) ? prior.record : null;
      // «новое сообщение» — по карточке; у ответа из строки (а) q — сообщение треда, не запись карточки: там сверка по журналу
      if (!session) {
        const fresher = newerThanQ(q, last);
        if (fresher !== null) return refused('new-question', `на карточке новое сообщение от ${hhmm(fresher)} — посмотри и ответь заново`, { pull: true });
      }
      if (had) record = had;
      else {
        const html = recordHtml({ id, word, q, reason: action === 'no' ? text : null, answer: action === 'reply' ? text : null, bNote: !!bAny });
        const w = await writeRecord({ call, lineOf, freshRead, cardId, id, html, step });
        if (w.error) return w.error;
      }
    }

    const planeAt = now();
    const pull = cardId && mirror ? await mirror.pull(cardId) : null;
    const rg = ring({ id, record, action, card: cardId, session, pick: ctx.pick, q, ...ringWord, step });
    const result = { record, ...(cardId ? { planeAt: new Date(planeAt).toISOString(), ...(pull ? { pull } : {}) } : {}), ...(bd ? { bdeal: bd } : {}), ...(rg.result ? { ring: rg.result } : {}) };
    if (!cardId) {
      // без карточки записи нет: если и звонок не лёг — слово пропало, это не «ok»
      if (rg.result?.state !== 'queued') return { outcome: 'error', message: `ответ не доставлен: ${rg.message}`, result: { code: 'NOT_RUNG', ...(rg.result ? { ring: rg.result } : {}) } };
      return { outcome: 'ok', message: `ответ треду · записи на доске нет (тред без карточки) · ${rg.message}`, result };
    }
    return { outcome: 'ok', message: `записано в Plane ${hhmm(planeAt)} · ${rg.message}`, result };
  }
  return Object.fromEntries(WORD_ACTIONS.map((a) => [a, act]));
}
