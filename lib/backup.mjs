// Суточная копия журнала действий пульта data/vitrina/actions.log (EXT-50). Журнал — первичный факт без другой копии:
// раз в сутки снимается снимок, пишется во временный файл в backup.dir, тот читается заново и сверяется со снимком
// (SHA-256, число строк, id последней JSON-строки); сошлось — переименование в actions-ГГГГ-ММ-ДД.log (местная дата)
// и эталон рядом — actions-ГГГГ-ММ-ДД.log.sha256; не сошлось — временный файл уходит в ….<метка времени>.bad, файл дня
// остаётся прежним, в server.log — «backup error …», повтор — не раньше чем через час.
// Журнал только дописывается: снимок, который короче последней удачной копии или расходится с ней в начале, всё равно
// ложится файлом дня, но ротация в этот раз не идёт и копия красная.
// Здоровье журнала — отдельный сигнал journalBad {count, first}: битые строки копию не портят и stale не делают.
// Часы и fs подменяются (тесты): now() → Date | число, fs — объект с методами node:fs.
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

export const BACKUP_KEEP = 14;
// имя копии и её эталона — единственные маски, по которым что-то удаляется
export const COPY_NAME = /^actions-(\d{4})-(\d{2})-(\d{2})\.log$/;
export const SHA_SUFFIX = '.sha256';
const HOUR_MS = 3600000;
const STALE_MS = 48 * HOUR_MS;

const p2 = (n) => String(n).padStart(2, '0');
// местная дата ГГГГ-ММ-ДД
export const localDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const copyName = (d) => `actions-${localDay(d)}.log`;
// метка времени для ….bad: местные ЧЧММСС-мсс (дата уже в имени файла дня)
const badStamp = (d) => `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// строка эталона — как у sha256sum: «<hex>  <имя>»
export const shaLine = (hex, name) => `${hex}  ${name}\n`;
// hex из файла эталона или null
export const parseShaLine = (text) => /^([0-9a-f]{64})\b/.exec(String(text).trim())?.[1] ?? null;

// Разбор содержимого журнала или копии: число строк, id последней JSON-строки и строки, которые не JSON, — их номера
// (с 1) в badLines, первая в badLine; ok — битых нет. Пустая строка — не битая (читатель пульта её пропускает).
// Битая строка разбор не прерывает. Текст без завершающего перевода строки — последняя строка неполная и тоже считается.
export function inspectLog(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (text === '') return { ok: true, lines: 0, lastId: null, badLine: null, badLines: [] };
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  let lastId = null;
  const badLines = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === '') continue;
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

// свободное имя: base, иначе base с суффиксом -2, -3… перед расширением ext (ext — хвост base, может быть '')
export function freeName(base, ext = '', exists = nodeFs.existsSync) {
  if (!exists(base)) return base;
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let k = 2; ; k++) { const n = `${stem}-${k}${ext}`; if (!exists(n)) return n; }
}

export function createBackup({ file, dir, keep = BACKUP_KEEP, now = () => new Date(), fs = nodeFs, log = { write() {} } }) {
  const keepN = Number.isInteger(keep) && keep >= 1 ? keep : BACKUP_KEEP;
  const clock = () => { const t = now(); return t instanceof Date ? t : new Date(t); };
  const st = { lastOkAt: null, lastFile: null, lastError: null, count: 0 };
  let day = null; // местные сутки последнего решения (старт или прогон): следующий прогон — на первом тике нового дня
  let failed = false; // последняя попытка неудачна
  let lastTry = null; // время последней попытки (мс): после неудачи повтор — не раньше чем через час
  let shrunk = false; // последний снимок короче последней удачной копии или расходится с ней в начале
  let journalBad = null; // битые строки журнала {count, first} | null — отдельный сигнал, не stale

  // файлы-копии по маске (только файлы, не папки), по возрастанию имени — оно же возрастание даты
  function copies() {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return names.filter((e) => e.isFile() && COPY_NAME.test(e.name)).map((e) => e.name).sort();
  }
  function recount() { st.count = copies().length; }
  const health = (h) => (h.ok ? null : { count: h.badLines.length, first: h.badLine });

  function fail(code, fields = {}) {
    failed = true;
    st.lastError = code;
    log.write('backup', { error: code, ...fields });
  }

  // Журнал только дописывается: снимок не короче последней удачной копии и начинается с неё. Возврат — имя копии,
  // с которой не сошлось, или null (сошлось, копии нет, не читается).
  function shrankAgainst(snap) {
    const all = copies();
    const prev = all[all.length - 1];
    if (!prev) return null;
    let old;
    try { old = fs.readFileSync(path.join(dir, prev)); } catch { return null; }
    if (snap.length < old.length || sha256(snap.subarray(0, old.length)) !== sha256(old)) return prev;
    return null;
  }

  // Одна копия. Возврат: { status: 'ok' | 'none' | 'error', file?, lines?, lastId?, code? }. Не бросает.
  function run() {
    const t = clock();
    day = localDay(t);
    lastTry = t.getTime();
    let live;
    try { live = fs.readFileSync(file); } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'none' }; // журнала нет — копии нет, не ошибка
      fail(String(e?.code ?? 'READ'));
      return { status: 'error', code: st.lastError };
    }
    const snap = snapshotOf(live);
    if (snap.length === 0) return { status: 'none' }; // пуст (или ни одной полной строки) — копии нет, не ошибка
    const want = { sha: sha256(snap), ...inspectLog(snap) };
    journalBad = health(want);
    const shrankFrom = shrankAgainst(snap);
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
      const bad = freeName(`${dest}.${badStamp(t)}.bad`, '.bad', (p) => fs.existsSync(p));
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
    // эталон рядом — после удачной проверки, тоже временным файлом и переименованием
    const shaTmp = `${dest}${SHA_SUFFIX}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(shaTmp, shaLine(want.sha, name));
      fs.renameSync(shaTmp, `${dest}${SHA_SUFFIX}`);
    } catch (e) {
      try { fs.rmSync(shaTmp, { force: true }); } catch { /* временного файла нет */ }
      fail(String(e?.code ?? 'SHA-WRITE'), { file: `${name}${SHA_SUFFIX}` });
      recount();
      return { status: 'error', code: st.lastError };
    }
    failed = false;
    shrunk = shrankFrom !== null;
    st.lastError = shrunk ? `журнал стал короче или изменился в начале — последняя удачная копия ${shrankFrom}` : null;
    st.lastOkAt = t.toISOString();
    st.lastFile = name;
    // ротация: keep последних файлов по маске, каждый — вместе со своим эталоном; ничего другого не трогается
    // (.bad, .tmp, чужие имена — мимо). Журнал стал короче — в этот раз ротации нет: старые копии — единственная полная
    if (!shrunk) {
      const all = copies();
      for (const old of all.slice(0, Math.max(0, all.length - keepN))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { continue; /* не удалился — останется до следующей ротации */ }
        try { fs.rmSync(path.join(dir, `${old}${SHA_SUFFIX}`), { force: true }); } catch { /* эталон останется сиротой */ }
      }
    }
    recount();
    log.write('backup', { file: name, lines: want.lines, last: want.lastId ?? '-', kept: st.count, ...(journalBad ? { badLines: journalBad.count, firstBad: journalBad.first } : {}), ...(shrunk ? { shrunk: shrankFrom } : {}) });
    return { status: 'ok', file: name, lines: want.lines, lastId: want.lastId };
  }

  return {
    // старт: последняя удачная копия — новейший файл по маске (он есть, только если прошёл проверку: плохие уходят в .bad);
    // файла сегодняшнего дня нет — копия сейчас
    start() {
      const t = clock();
      const all = copies();
      st.count = all.length;
      const newest = all[all.length - 1];
      if (newest) {
        try {
          st.lastOkAt = new Date(fs.statSync(path.join(dir, newest)).mtimeMs).toISOString();
          st.lastFile = newest;
        } catch { /* копия исчезла между списком и stat — как будто её нет */ }
      }
      day = localDay(t);
      if (!all.includes(copyName(t))) return run();
      // копия дня есть — не снимается, но здоровье журнала проверяется: сигнал о битых строках держится через перезапуск
      try { journalBad = health(inspectLog(snapshotOf(fs.readFileSync(file)))); } catch { /* журнала нет или не читается — скажет следующая копия */ }
      return { status: 'skipped' };
    },
    // цикл уведомлений: первый тик после местной полуночи (и после сна через полночь); после неудачи — раз в час
    tick() {
      const t = clock();
      if (day === null) return null;
      if (localDay(t) !== day) return run();
      if (failed && lastTry !== null && t.getTime() - lastTry >= HOUR_MS) return run();
      return null;
    },
    run,
    state: () => ({ lastOkAt: st.lastOkAt, lastFile: st.lastFile, lastError: st.lastError, count: st.count, journalBad }),
    // для freshness /api/ceh: stale — удачной копии нет больше 48 ч, последняя попытка неудачна или журнал стал короче;
    // битые строки — отдельно, journalBad
    freshness() {
      const t = clock().getTime();
      const old = st.lastOkAt !== null && t - Date.parse(st.lastOkAt) > STALE_MS;
      return { lastOkAt: st.lastOkAt, stale: failed || shrunk || old, journalBad };
    },
  };
}

// заглушка: витрина собрана без копии (тесты ручек)
export const NO_BACKUP = {
  state: () => ({ lastOkAt: null, lastFile: null, lastError: null, count: 0, journalBad: null }),
  freshness: () => ({ lastOkAt: null, stale: false, journalBad: null }),
};
