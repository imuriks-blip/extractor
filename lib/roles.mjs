// Реестр ролей цеха (спека витрины, «EXT-116 — окно «агенты»», Р1–Р3): Vault unorbis/_meta/Реестр ролей цеха.md
// (ведёт тред INFRA) → роли окна «агенты». Витрина файл только читает; на диск ничего не пишет (§1.3).
// Разбор: шапка YAML мимо; форма (`## Форма раздела роли`) сверяется с копией кода — не совпала — ошибка всего файла;
// роль — каждый `## <Имя>` после формы до `## Сводные таблицы`: строка полей (5 частей через « · ») и 14 разделов
// `**<Имя>.**`; сводка — подразделы `### …` (таблица и/или абзацы); legend — абзац «Как читать «держит»» вводной цитаты.
// Тексты реестра в ошибку не кладутся (она уходит ещё и в /api/health → lastError): незнакомое — номером.
// Кэш — по времени изменения и размеру (как словарь); при ошибке после удачи — последний удачный разбор с error и
// failingSince (§2.7). Сверка с определениями (Р2) — на каждый вызов: у определений свой кэш по mtime.
// Граница слова в регулярках — явная (кириллица, без \b).
import nodeFs from 'node:fs';

export const SOURCE = 'unorbis/_meta/Реестр ролей цеха.md';
// контракт окна: копия формы реестра 2de0aff (ключи строки полей и 14 разделов в порядке формы)
export const FORM_FIELDS = ['лейбл', 'подпись на доске', 'статус', 'модель', 'тормоз'];
export const FORM_SECTIONS = ['Кто', 'Где живёт', 'Кто ставит задачу и кому отчёт', 'Функции', 'Берёт / не берёт', 'Пишет', 'Читает',
  'Инструменты', 'Запрещено — слово', 'Запрещено — механика', 'Стоп-точки', 'Ориентир и тормоз', 'Форма отчёта', 'Источник правды'];
const FORM_HEAD = 'Форма раздела роли';
const SUMMARY_HEAD = 'Сводные таблицы';
const LEGEND = '> **Как читать «держит».**';
const SECTIONS_AFTER = 'Затем разделы в этом порядке:';
// ключ части строки полей — первое слово ключа формы → поле ответа
const FIELD_OF = { лейбл: 'label', подпись: 'sign', статус: 'status', модель: 'model', тормоз: 'brake' };
const FIRST = FORM_FIELDS.map((k) => k.split(' ')[0]);
const NAME = /^[a-z0-9-]+$/; // правило имени — как agent-defs.mjs
const MODEL_OF = { наследует: 'inherit', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku' };
const SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const H2 = /^##[ \t]+(?!#)(.+?)[ \t]*$/;
const H3 = /^###[ \t]+(?!#)(.+?)[ \t]*$/;
const SECTION = /^\*\*([^*]+?)\.\*\*(?:[ \t]+|$)(.*)$/;
const PART_SEP = ' · ';

// ячейки строки таблицы — как в словаре (glossary.mjs): «\|» — знак внутри ячейки
function cells(line) {
  const parts = line.split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}
const unbold = (s) => s.replace(/\*\*/g, '');
const bolds = (s) => [...s.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1].trim());

class ParseError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// форма против копии кода: различия словами из копии, лишнее — номером среди жирных слов своей группы
function formDiff(got, want, { missing, extra, order }) {
  const out = [];
  for (const w of want) if (!got.includes(w)) out.push(missing(w));
  got.forEach((g, i) => { if (!want.includes(g)) out.push(extra(i + 1)); });
  if (!out.length && got.some((g, i) => g !== want[i])) out.push(order);
  return out;
}

function parseForm(lines, at) {
  // абзац под заголовком: строки до пустой или до следующего заголовка
  let i = at + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const start = i;
  const para = [];
  for (; i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#'); i++) para.push(lines[i]);
  const text = para.join(' ');
  const line = start + 1;
  const k = text.indexOf('Затем');
  const s = text.indexOf(SECTIONS_AFTER);
  if (k === -1 || s === -1 || s < k) throw new ParseError(`форма раздела роли изменилась: нет слов «${SECTIONS_AFTER}» (строка ${line})`, `FORM:${line}`);
  const fields = bolds(text.slice(0, k)).map((f) => f.split(/\s+/)[0]);
  const sections = bolds(text.slice(s + SECTIONS_AFTER.length));
  const diffs = [
    ...formDiff(fields, FIRST, { missing: (w) => `нет ключа «${FORM_FIELDS[FIRST.indexOf(w)]}»`, extra: (n) => `лишний ключ №${n}`, order: 'порядок ключей строки полей не тот' }),
    ...formDiff(sections, FORM_SECTIONS, { missing: (w) => `нет «${w}»`, extra: (n) => `лишний раздел №${n}`, order: 'порядок разделов не тот' }),
  ];
  if (diffs.length) {
    const counts = sections.length !== FORM_SECTIONS.length ? `: в форме разделов ${sections.length}, ожидается ${FORM_SECTIONS.length}`
      : fields.length !== FIRST.length ? `: в форме ключей ${fields.length}, ожидается ${FIRST.length}` : '';
    throw new ParseError(`форма раздела роли изменилась: ${diffs.join('; ')} (строка ${line}${counts})`, `FORM:${line}`);
  }
}

function parseRole(name, line, body) {
  // body — [{text, line}] строк роли до следующего «## »; строки «---» мимо
  const problems = [];
  const rows = body.filter((r) => r.text.trim() !== '---');
  const first = rows.findIndex((r) => r.text.trim() !== '');
  const fields = { label: null, sign: null, status: null, model: null, brake: null };
  let hasFields = false;
  let from = 0;
  if (first !== -1 && !SECTION.test(rows[first].text.trim())) {
    hasFields = true;
    from = first + 1;
    const fl = rows[first];
    const parts = fl.text.trim().split(PART_SEP);
    if (parts.length !== 5) problems.push(`в строке полей частей ${parts.length}, ожидается 5 (строка ${fl.line})`);
    parts.forEach((p, i) => {
      const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(p.trim());
      const key = m?.[1] ?? '';
      const f = FIELD_OF[key];
      if (!f) { problems.push(`незнакомый ключ №${i + 1} строки полей (строка ${fl.line})`); return; }
      if (fields[f] !== null) { problems.push(`повторный ключ «${FORM_FIELDS[FIRST.indexOf(key)]}» строки полей (строка ${fl.line})`); return; }
      fields[f] = (m[2] ?? '').trim();
    });
  } else {
    problems.push('нет строки полей');
  }
  const lab = fields.label === null ? null : /`([^`]*)`/.exec(fields.label)?.[1] ?? null;
  let label = null;
  if (lab !== null) {
    if (NAME.test(lab)) label = lab;
    else problems.push('лейбл не по правилу имени [a-z0-9-]');
  }
  const st = fields.status === null ? '' : unbold(fields.status).trim();
  const status = /^действует(?![\p{L}\p{N}])/u.test(st) ? 'active' : /^предложение(?![\p{L}\p{N}])/u.test(st) ? 'proposal' : 'unknown';
  if (status === 'unknown' && hasFields) problems.push('статус не распознан');
  const tm = fields.brake === null ? null : /^(\d+) ход/.exec(unbold(fields.brake).trim());
  const turns = tm ? Number(tm[1]) : null;

  // разделы: строка «**Имя.** …» открывает раздел; текст — до следующего раздела или конца роли
  const found = []; // {title, line, n, lines[]}
  let cur = null;
  let n = 0;
  for (const r of rows.slice(from)) {
    const m = SECTION.exec(r.text.trim());
    if (m) { n++; cur = { title: m[1].trim(), line: r.line, n, lines: [m[2]] }; found.push(cur); continue; }
    if (cur) cur.lines.push(r.text);
  }
  const text = {};
  let maxIdx = -1;
  let maxTitle = null;
  for (const s of found) {
    const idx = FORM_SECTIONS.indexOf(s.title);
    if (idx === -1) { problems.push(`лишний раздел №${s.n} (строка ${s.line})`); continue; }
    if (s.title in text) { problems.push(`повторный раздел «${s.title}» (строка ${s.line})`); continue; }
    if (idx < maxIdx) problems.push(`порядок не тот: «${s.title}» после «${maxTitle}» (строка ${s.line})`);
    else { maxIdx = idx; maxTitle = s.title; }
    const t = s.lines.join('\n').trim();
    text[s.title] = t;
    if (t === '') problems.push(`пустой раздел «${s.title}» (строка ${s.line})`);
  }
  for (const t of FORM_SECTIONS) if (!(t in text)) problems.push(`нет раздела «${t}»`);
  const sections = FORM_SECTIONS.map((t) => ({ title: t, text: t in text ? text[t] : null }));
  return { name, line, label, status, fields, turns, sections, problems };
}

function parseSummary(body, problems) {
  // body — [{text, line}] после «## Сводные таблицы» до следующего «## » (или конца)
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const item = { title: cur.title };
    if (cur.text.length || !cur.table) item.text = cur.text.join('\n');
    if (cur.table) { item.head = cur.table.head; item.rows = cur.table.rows; }
    if (cur.tables > 1) problems.push(`в подразделе «${cur.title}» таблиц больше одной`);
    out.push(item);
  };
  let inTable = false;
  for (const r of body) {
    const line = r.text.trim();
    const h = H3.exec(line);
    if (h) { flush(); cur = { title: h[1], text: [], table: null, tables: 0 }; inTable = false; continue; }
    if (!cur) continue;
    if (line.startsWith('|')) {
      if (!inTable) { inTable = true; cur.tables++; if (cur.tables === 1) cur.table = { head: cells(line), rows: [] }; continue; }
      if (SEP.test(line) || cur.tables > 1) continue;
      cur.table.rows.push(cells(line));
      continue;
    }
    inTable = false;
    if (line !== '' && line !== '---') cur.text.push(line);
  }
  flush();
  return out;
}

function parseLegend(lines) {
  const i = lines.findIndex((l) => l.startsWith(LEGEND));
  if (i === -1) return null;
  const out = [];
  for (let k = i; k < lines.length; k++) {
    const l = lines[k];
    if (!l.startsWith('>') || l.trim() === '>') break;
    out.push(l.replace(/^>[ \t]?/, ''));
  }
  return out.join('\n');
}

// разбор текста реестра: {roles, summary, legend, problems}; ошибка всего файла — ParseError {message, code}
export function parseRoles(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    i = end === -1 ? lines.length : end + 1;
  }
  const h2 = [];
  for (let k = i; k < lines.length; k++) { const m = H2.exec(lines[k]); if (m) h2.push({ title: m[1], at: k }); }
  const form = h2.find((h) => h.title === FORM_HEAD);
  if (!form) {
    const ln = h2.length ? h2[0].at + 1 : lines.length;
    throw new ParseError(`нет раздела «${FORM_HEAD}» (строка ${ln} — ${h2.length ? 'первый раздел файла' : 'конец файла'})`, `NO_FORM:${ln}`);
  }
  parseForm(lines, form.at);
  const problems = [];
  const after = h2.filter((h) => h.at > form.at);
  const sumIdx = after.findIndex((h) => h.title === SUMMARY_HEAD);
  const roleHeads = sumIdx === -1 ? after : after.slice(0, sumIdx);
  const block = (from, to) => lines.slice(from + 1, to).map((t, k) => ({ text: t, line: from + 2 + k }));
  const endOf = (h) => { const nx = h2.find((x) => x.at > h.at); return nx ? nx.at : lines.length; };
  const roles = roleHeads.map((h) => parseRole(h.title, h.at + 1, block(h.at, endOf(h))));
  if (!roles.length) throw new ParseError(`после формы нет ни одной роли «## …» (строка ${form.at + 1})`, `NO_ROLES:${form.at + 1}`);
  let summary = [];
  if (sumIdx === -1) problems.push(`нет раздела «${SUMMARY_HEAD}» — сводка не показана`);
  else {
    const s = after[sumIdx];
    summary = parseSummary(block(s.at, endOf(s)), problems);
    for (const h of after.slice(sumIdx + 1)) problems.push(`раздел после сводных таблиц не показан (строка ${h.at + 1})`);
  }
  return { roles, summary, legend: parseLegend(lines.slice(i)), problems };
}

// сверка роли с определением (Р2): check {brake, model} и drift[] — только у роли с def: true
export function checkRole(role, fact) {
  if (fact?.def !== true) return { check: null, drift: [] };
  const drift = [];
  let brake;
  const reg = role.turns;
  const def = fact.maxTurns;
  if (reg === null && def === null) brake = 'unchecked';
  else if (reg !== null && def !== null && reg === def) brake = 'ok';
  else {
    brake = 'drift';
    drift.push({ field: 'brake', registry: reg !== null ? String(reg) : (role.fields.brake ?? 'нет'), fact: def !== null ? String(def) : 'maxTurns нет' });
  }
  const regText = role.fields.model === null ? '' : unbold(role.fields.model).trim();
  const word = MODEL_OF[regText.toLowerCase().split(/\s+/)[0]];
  let model;
  if (!word || fact.model === null) model = 'unchecked';
  else if (word === String(fact.model).toLowerCase()) model = 'ok';
  else { model = 'drift'; drift.push({ field: 'model', registry: regText, fact: fact.model }); }
  return { check: { brake, model }, drift };
}

const iso = (ms) => new Date(ms).toISOString();

// file() — полный путь к реестру или null (Vault не задан); defs(name) — факт определения (agent-defs read) или null;
// fs — подмена в тестах; now — часы (тесты)
export function createRoles({ file, defs = () => null, fs = nodeFs, now = Date.now }) {
  let cache = null; // {path, mtimeMs, size, parsed | error, code} — удачный разбор или ошибка разбора этого же файла
  let good = null; // последний удачный разбор процесса: {parsed, mtimeMs}
  const st = { lastOkAt: null, errors: 0, lastError: null, failingSince: null, failKey: null, roles: 0, problems: 0, defUnread: 0 };

  const ok = () => { st.lastOkAt = iso(now()); st.failingSince = null; st.failKey = null; };
  const fail = (key, code) => {
    if (st.failKey !== key) { st.errors++; st.failKey = key; }
    st.lastError = code;
    if (!st.failingSince) st.failingSince = iso(now());
  };

  function check() {
    // → {error: string|null}; обновляет cache, good и st
    // путь из настройки не проверяется (paths.vault не строкой — path.join бросает): тоже NO_VAULT, не 500 в /api/health
    // (EXT-116, повторное ревью Голема, Мелочь 1)
    let p;
    try { p = file(); } catch { p = null; }
    if (!p) { fail('NO_VAULT', 'NO_VAULT'); return 'не задан путь к Vault (paths.vault или vault_root реестра проектов)'; }
    let s;
    try { s = fs.statSync(p); } catch (e) {
      const code = e?.code ?? 'ERR';
      fail(`stat:${code}`, code);
      return code === 'ENOENT' ? `файла нет (${SOURCE})` : `файл не читается (${code})`;
    }
    if (!(cache && cache.path === p && cache.mtimeMs === s.mtimeMs && cache.size === s.size)) {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch (e) {
        const code = e?.code ?? 'ERR';
        fail(`read:${s.mtimeMs}:${s.size}:${code}`, code); // ошибка чтения не кэшируется: следующий вызов читает снова
        return code === 'ENOENT' ? `файла нет (${SOURCE})` : `файл не читается (${code})`;
      }
      cache = { path: p, mtimeMs: s.mtimeMs, size: s.size };
      try { cache.parsed = parseRoles(text); } catch (e) {
        // сбой самого разборщика (не ParseError) — тоже ошибка файла, а не исключение наружу: /api/health читают проба
        // «чья витрина» (port.mjs), tools/update.ps1 и MCP — 500 там значит «чужая витрина» (EXT-116, ревью Голема,
        // Важно 1). Кэшируется по файлу, как ошибка разбора; текста реестра в ошибке нет — только имя исключения.
        if (e instanceof ParseError) { cache.error = e.message; cache.code = e.code; }
        else { cache.error = `сбой разбора реестра (PARSE_BUG: ${e?.name ?? 'ошибка'})`; cache.code = 'PARSE_BUG'; }
      }
    }
    if (cache.error) { fail(`parse:${cache.mtimeMs}:${cache.size}:${cache.code}`, cache.code); return cache.error; }
    good = { parsed: cache.parsed, mtimeMs: cache.mtimeMs };
    ok();
    return null;
  }

  return {
    get() {
      const error = check();
      const parsed = good?.parsed ?? { roles: [], summary: [], legend: null, problems: [] };
      let drifts = 0;
      let defUnread = 0;
      let roleProblems = 0;
      const roles = parsed.roles.map((r) => {
        const fact = r.status === 'proposal' || r.label === null ? null : defs(r.label) ?? null;
        const { check: c, drift } = checkRole(r, fact);
        drifts += drift.length;
        if (fact?.def === null) defUnread++;
        roleProblems += r.problems.length;
        return { ...r, fact, check: c, drift };
      });
      st.roles = roles.length; st.problems = roleProblems + parsed.problems.length; st.defUnread = defUnread;
      return {
        source: SOURCE,
        updatedAt: good ? iso(good.mtimeMs) : null,
        error,
        failingSince: st.failingSince,
        problems: parsed.problems,
        legend: parsed.legend,
        form: { fields: [...FORM_FIELDS], sections: [...FORM_SECTIONS] },
        drifts,
        roles,
        summary: parsed.summary,
      };
    },
    // /api/health → readers.roles (Р1 «Health»): состояние после get()
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError, failingSince: st.failingSince,
      mtimeMs: good?.mtimeMs ?? null, roles: st.roles, problems: st.problems, defUnread: st.defUnread }),
  };
}

export const NO_ROLES = {
  get: () => ({ source: SOURCE, updatedAt: null, error: 'реестр ролей не подключён', failingSince: null, problems: [], legend: null,
    form: { fields: [...FORM_FIELDS], sections: [...FORM_SECTIONS] }, drifts: 0, roles: [], summary: [] }),
  state: () => ({ lastOkAt: null, errors: 0, lastError: null, failingSince: null, mtimeMs: null, roles: 0, problems: 0, defUnread: 0 }),
};
