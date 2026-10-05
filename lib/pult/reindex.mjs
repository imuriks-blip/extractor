// «Пересобрать индекс» (спека пульта, таблица 1.3; ПТ8, EXT-75): индекс смещений журналов data/vitrina/index/ — пересчитываемое
// (спека витрины §1.3). Пересбор делает читатель журналов (journal-reader.mjs → rebuild): читает всё заново черновым читателем,
// живой всё это время держит прежние смещения (витрина читается как читалась), по готовности — подмена в памяти и запись
// файла индекса (временный + rename). Здесь — только действие: одно нажатие запускает пересбор и сразу отвечает «запущено»,
// ход «N из M журналов» и время конца — в данных страницы (/api/mirror → reindex). Второе нажатие во время пересбора — отказ
// reindex-running («уже идёт», не ошибка). Память — в этом запуске витрины: рестарт посреди пересбора его обрывает, индекс
// остаётся прежним (подмена — одним присвоением в конце), нажатие после рестарта запускает заново.
const fail = (code) => Object.assign(new Error(code), { code });
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

// rebuild({onProgress}) → Promise; onEnd(err|null, {id}) — по концу (строка error в actions.log при сбое)
export function createReindexer({ rebuild, now = Date.now, onEnd = () => {} }) {
  let run = null; // {at, id, done, total}
  let last = { lastAt: null, lastMs: null, lastFiles: null, lastError: null };

  const state = () => ({
    running: !!run,
    startedAt: run ? new Date(run.at).toISOString() : null,
    done: run ? run.done : null,
    total: run ? run.total : null,
    ...last,
  });

  // проверка и запоминание — синхронно, до первого await (два нажатия разом — один пересбор)
  async function act({ id = null }) {
    if (run) {
      const n = run.total === null ? '' : `, ${run.done} из ${run.total} журналов`;
      return { outcome: 'refused', refusal: 'reindex-running', message: `индекс уже пересобирается (с ${hhmm(run.at)}${n})` };
    }
    if (typeof rebuild !== 'function') throw fail('NO_REBUILD');
    const cur = { at: now(), id, done: 0, total: null };
    run = cur;
    let p;
    try {
      p = Promise.resolve(rebuild({ onProgress: (done, total) => { cur.done = done; cur.total = total; } }));
    } catch (e) {
      run = null;
      throw e;
    }
    p.then((r) => {
      last = { lastAt: new Date(now()).toISOString(), lastMs: now() - cur.at, lastFiles: Number.isFinite(r?.files) ? r.files : cur.total, lastError: null };
      run = null;
      onEnd(null, { id });
    }, (e) => {
      last = { ...last, lastError: typeof e?.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'ERR' };
      run = null;
      onEnd(e, { id });
    });
    return { outcome: 'ok', message: 'пересбор индекса запущен' };
  }

  return { state, act };
}
