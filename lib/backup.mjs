// Суточная копия журнала действий пульта data/vitrina/actions.log (EXT-50). Журнал — первичный факт без другой копии:
// раз в сутки снимается снимок, пишется во временный файл в backup.dir, тот читается заново и сверяется со снимком
// (SHA-256, число строк, id последней JSON-строки); сошлось — переименование в actions-ГГГГ-ММ-ДД.log (местная дата),
// не сошлось — временный файл уходит в ….<метка времени>.bad, файл дня остаётся прежним, в server.log — «backup error …».
// Здоровье журнала — отдельно: строки не JSON считаются; есть — lastError и stale, но верная копия всё равно ложится.
// Часы и fs подменяются (тесты): now() → Date | число, fs — объект с методами node:fs.
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

export const BACKUP_KEEP = 14;
// имя копии — единственная маска, по которой что-то удаляется
export const COPY_NAME = /^actions-(\d{4})-(\d{2})-(\d{2})\.log$/;
const DAY_MS = 24 * 3600000;
const STALE_MS = 48 * 3600000;

const p2 = (n) => String(n).padStart(2, '0');
// местная дата ГГГГ-ММ-ДД
export const localDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const copyName = (d) => `actions-${localDay(d)}.log`;
// метка времени для ….bad: местные ЧЧММСС-мсс (дата уже в имени файла дня)
const badStamp = (d) => `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Разбор содержимого журнала или копии: число строк, id последней JSON-строки и строки, которые не JSON (пустая тоже),
// — их номера (с 1) в badLines, первая в badLine; ok — битых нет. Битая строка разбор не прерывает.
// Текст без завершающего перевода строки — последняя строка неполная и тоже считается.
export function inspectLog(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (text === '') return { ok: true, lines: 0, lastId: null, badLine: null, badLines: [] };
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  let lastId = null;
  const badLines = [];
  for (let i = 0; i < rows.length; i++) {
    let j;
    try { j = JSON.parse(rows[i]); } catch { badLines.push(i + 1); continue; }
    lastId = j && typeof j === 'object' && typeof j.id === 'string' ? j.id : null;
  }
  return { ok: badLines.length === 0, lines: rows.length, lastId, badLine: badLines[0] ?? null, badLines };
}

// Снимок: прочитанные байты до последнего полного перевода строки; хвост (журнал дописывается во время копии) уйдёт
// в следующую копию.
export function snapshotOf(buf) {
  const cut = buf.lastIndexOf(0x0a);
  return cut < 0 ? buf.subarray(0, 0) : buf.subarray(0, cut + 1);
}

export function createBackup({ file, dir, keep = BACKUP_KEEP, now = () => new Date(), fs = nodeFs, log = { write() {} } }) {
  const keepN = Number.isInteger(keep) && keep >= 1 ? keep : BACKUP_KEEP;
  const clock = () => { const t = now(); return t instanceof Date ? t : new Date(t); };
  const st = { lastOkAt: null, lastFile: null, lastError: null, count: 0 };
  let day = null; // местные сутки последнего решения (старт или прогон): следующий прогон — на первом тике нового дня
  let failed = false; // последняя попытка неудачна
  let sick = false; // последняя удачная копия сняла журнал с битыми строками

  // файлы-копии по маске (только файлы, не папки), по возрастанию имени — оно же возрастание даты
  function copies() {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return names.filter((e) => e.isFile() && COPY_NAME.test(e.name)).map((e) => e.name).sort();
  }
  function recount() { st.count = copies().length; }

  function fail(code, fields = {}) {
    failed = true;
    st.lastError = code;
    log.write('backup', { error: code, ...fields });
  }

  // Одна копия. Возврат: { status: 'ok' | 'none' | 'error', file?, lines?, lastId?, code? }. Не бросает.
  function run() {
    const t = clock();
    day = localDay(t);
    let live;
    try { live = fs.readFileSync(file); } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'none' }; // журнала нет — копии нет, не ошибка
      fail(String(e?.code ?? 'READ'));
      return { status: 'error', code: st.lastError };
    }
    const snap = snapshotOf(live);
    if (snap.length === 0) return { status: 'none' }; // пуст (или ни одной полной строки) — копии нет, не ошибка
    const want = { sha: sha256(snap), ...inspectLog(snap) };
    const name = copyName(t);
    const dest = path.join(dir, name);
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, snap);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* временного файла нет */ }
      fail(String(e?.code ?? 'WRITE'), { file: name });
      return { status: 'error', code: st.lastError };
    }
    // проверка восстановления — до того, как копия станет файлом дня: временный файл читается заново
    let code = null;
    try {
      const back = fs.readFileSync(tmp);
      const got = inspectLog(back);
      if (sha256(back) !== want.sha) code = 'sha-mismatch';
      else if (got.lines !== want.lines) code = 'lines-mismatch';
      else if (got.lastId !== want.lastId) code = 'last-id-mismatch';
    } catch (e) { code = String(e?.code ?? 'VERIFY-READ'); }
    if (code) {
      // файл дня не тронут; .bad — с меткой времени: несколько неудач за сутки друг друга не затирают
      let bad = `${dest}.${badStamp(t)}.bad`;
      for (let k = 2; fs.existsSync(bad); k++) bad = `${dest}.${badStamp(t)}-${k}.bad`;
      try { fs.renameSync(tmp, bad); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* не убрался */ } }
      fail(code, { file: name });
      recount();
      return { status: 'error', code };
    }
    try {
      fs.renameSync(tmp, dest); // проверено — повтор в те же сутки заменяет файл дня
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* временного файла нет */ }
      fail(String(e?.code ?? 'RENAME'), { file: name });
      return { status: 'error', code: st.lastError };
    }
    failed = false;
    // здоровье журнала — отдельно от верности копии: битые строки — красное, но верная копия легла
    sick = want.badLines.length > 0;
    st.lastError = sick ? `в журнале ${want.badLines.length} битых строк (первая — строка ${want.badLine})` : null;
    st.lastOkAt = t.toISOString();
    st.lastFile = name;
    // ротация: keep последних файлов по маске, ничего другого не трогается (.bad, .tmp, чужие имена — мимо)
    const all = copies();
    for (const old of all.slice(0, Math.max(0, all.length - keepN))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* не удалился — останется до следующей ротации */ }
    }
    recount();
    log.write('backup', { file: name, lines: want.lines, last: want.lastId ?? '-', kept: st.count, ...(sick ? { badLines: want.badLines.length, firstBad: want.badLine } : {}) });
    return { status: 'ok', file: name, lines: want.lines, lastId: want.lastId };
  }

  return {
    // старт: последняя удачная копия — новейший файл по маске (он есть, только если прошёл проверку: плохие уходят в .bad);
    // нет её или она старше 24 ч — копия сейчас
    start() {
      const t = clock();
      const all = copies();
      st.count = all.length;
      const newest = all[all.length - 1];
      let age = null;
      if (newest) {
        try {
          const m = fs.statSync(path.join(dir, newest)).mtimeMs;
          st.lastOkAt = new Date(m).toISOString();
          st.lastFile = newest;
          age = t.getTime() - m;
        } catch { /* копия исчезла между списком и stat — как будто её нет */ }
      }
      day = localDay(t);
      if (age === null || age > DAY_MS) return run();
      return { status: 'skipped' };
    },
    // цикл уведомлений: первый тик после местной полуночи (и после сна через полночь)
    tick() {
      const t = clock();
      if (day === null || localDay(t) === day) return null;
      return run();
    },
    run,
    state: () => ({ lastOkAt: st.lastOkAt, lastFile: st.lastFile, lastError: st.lastError, count: st.count }),
    // для freshness /api/ceh: stale — удачной копии нет больше 48 ч, последняя попытка неудачна или в журнале битые строки
    freshness() {
      const t = clock().getTime();
      const old = st.lastOkAt !== null && t - Date.parse(st.lastOkAt) > STALE_MS;
      return { lastOkAt: st.lastOkAt, stale: failed || sick || old };
    },
  };
}

// заглушка: витрина собрана без копии (тесты ручек)
export const NO_BACKUP = {
  state: () => ({ lastOkAt: null, lastFile: null, lastError: null, count: 0 }),
  freshness: () => ({ lastOkAt: null, stale: false }),
};
