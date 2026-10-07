// Инструменты MCP Экстрактора (спека пульта §5, ПТ10, EXT-82): только чтение. Данные — одним способом: GET к ручкам витрины
// (127.0.0.1:4317 с Host). Тексты витрина маскирует сама (6.2: preSerialization и maskRow) до того, как они дойдут сюда;
// сервер MCP сырых текстов не получает и ничего не пишет — ни в витрину, ни на доску.
// Ответы MCP висят в контексте (замер 25.09: в ~6 раз тяжелее скрипта) — пределы ниже, тест держит каждый.
// подпись исхода — та же, что на странице «Мои слова» (чистый модуль web/src/pultData.js): Иван и тред читают одни слова
import { outcomeText } from '../web/src/pultData.js';

export const LIMITS = {
  waitingChars: 600, waitingRows: 5, waitingRowChars: 70,
  wordsChars: 900, wordsRows: 10, wordTextChars: 40,
  healthChars: 600, healthErrChars: 60, healthErrRows: 2,
  fetchTimeoutMs: 5000,
  defaultSinceMs: 24 * 3600000,
};

export const DEFAULT_URL = 'http://127.0.0.1:4317';
const DAY_UNIT = { m: 60000, h: 3600000, d: 86400000 };

// подпись слова — как в таблице 1.3 (для шести слов — WORD_LABEL витрины, тест сверяет)
export const WORD_LABELS = { yes: 'да', go: 'го', merge: 'сливай', deploy: 'выкатывай', no: 'нет', reply: 'ответ', accept: 'принято', return: 'вернуть', take: 'в работу', reread: 'перечитай правила' };
const WITH_TEXT = new Set(['no', 'reply']);
const CODE_RE = /^[A-Z]{2,6}$/;

class Down extends Error {}
class Http extends Error {}

export const cut = (s, n) => {
  const a = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return a.length <= n ? a.join('') : a.slice(0, n - 1).join('') + '…';
};
// общий потолок ответа: строки целиком, пока влезают; лишнюю строку не режем посреди — отбрасываем; первая строка режется
export const clip = (lines, max) => {
  const out = [];
  let len = 0;
  for (const l of lines) {
    const add = (out.length ? 1 : 0) + l.length;
    if (len + add > max) { if (!out.length) out.push(cut(l, max)); break; }
    out.push(l);
    len += add;
  }
  return out.join('\n');
};

export function createTools({ base = DEFAULT_URL, env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const u = new URL(base);
  const host = u.host;
  const downLine = `витрина не запущена (${host})`;

  // единственный выход наружу: метод GET зашит здесь, другого вызова fetch в сервере нет
  async function get(path) {
    let r;
    try {
      r = await fetchImpl(u.origin + path, { method: 'GET', headers: { host }, signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs) });
    } catch { throw new Down(); }
    if (!r.ok) throw new Http(`витрина ответила ${r.status}`);
    try { return await r.json(); } catch { throw new Http('витрина ответила не JSON'); }
  }

  // пусто и null — «все»; строчный код — в заглавные
  const normProject = (p) => (typeof p === 'string' ? p.trim().toUpperCase() || undefined : p === null ? undefined : p);
  const badProject = (p) => (p !== undefined && p !== null && p !== '' && (typeof p !== 'string' || !CODE_RE.test(p)) ? 'project: код проекта заглавными (CAR, EXT…)' : null);

  async function waiting({ project } = {}) {
    project = normProject(project);
    const bad = badProject(project);
    if (bad) return bad;
    const j = await get('/api/ceh');
    const w = j?.waiting ?? {};
    const open = (a) => (Array.isArray(a) ? a : []).filter((x) => (!project || x.project === project) && x.answered !== true);
    const t = open(w.threads), y = open(w.yes), v = open(w.review);
    const rows = [
      ...t.map((x) => `а · ${[x.project, x.text ?? x.title].filter(Boolean).join(' · ')}`),
      ...y.map((x) => `б · ${x.id} · ${x.mark} · ${x.title}`),
      ...v.map((x) => `в · ${x.id} · ${x.title}`),
    ].slice(0, LIMITS.waitingRows).map((l) => '- ' + cut(l, LIMITS.waitingRowChars - 2));
    const head = `Ждёт Ивана${project ? ' по ' + project : ''}: (а) тред ждёт ответа ${t.length}, (б) нужно «да» ${y.length}, (в) Review ${v.length}.`;
    return clip([head, ...rows], LIMITS.waitingChars);
  }

  const hhmm = (at) => {
    const s = String(at ?? '');
    if (!/Z$/i.test(s)) { const m = s.match(/T(\d{2}:\d{2})/); if (m) return m[1]; }
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--';
  };
    const statusOf = (r) => r.ring ?? (r.withdrawnBy ? 'отозвано' : outcomeText(r));

  function sinceOf(v) {
    if (v === undefined || v === null || v === '') return { iso: new Date(now() - LIMITS.defaultSinceMs).toISOString() };
    const s = String(v).trim();
    const rel = s.match(/^(\d{1,4})\s*([mhd])$/i);
    if (rel) return { iso: new Date(now() - Number(rel[1]) * DAY_UNIT[rel[2].toLowerCase()]).toISOString() };
    const t = Date.parse(s);
    return Number.isFinite(t) ? { iso: new Date(t).toISOString() } : { err: `since: не понял «${cut(s, 20)}» (время ISO или 30m, 6h, 2d)` };
  }

  // проект вызывающего треда: сессия — из окружения сервера (CLAUDE_CODE_SESSION_ID), проект — по живым тредам витрины
  async function threadProject() {
    const sid = String(env.CLAUDE_CODE_SESSION_ID ?? '').trim().toLowerCase();
    if (!sid) return null;
    const j = await get('/api/ceh');
    const t = (j?.workers?.threads ?? []).find((x) => String(x?.sessionId ?? '').toLowerCase() === sid);
    return typeof t?.project === 'string' && CODE_RE.test(t.project) ? t.project : null;
  }

  async function words({ project, since } = {}) {
    project = normProject(project);
    const bad = badProject(project);
    if (bad) return bad;
    const s = sinceOf(since);
    if (s.err) return s.err;
    // явный project из входа сильнее умолчания (проекта треда); нет ни того, ни другого — все проекты
    const scope = project ?? (await threadProject());
    const qs = new URLSearchParams({ since: s.iso, ...(scope ? { project: scope } : {}) });
    const all = await get('/api/actions?' + qs);
    if (!Array.isArray(all)) throw new Http('витрина ответила не списком');
    const rows = all.filter((r) => r && Object.hasOwn(WORD_LABELS, r.action));
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (!rows.length) return `слов Ивана нет${scope ? ' по ' + scope : ''} за период`;
    const lines = rows.slice(0, LIMITS.wordsRows).map((r) => {
      const word = WORD_LABELS[r.action] + (WITH_TEXT.has(r.action) && r.text ? `: ${cut(r.text, LIMITS.wordTextChars)}` : '');
      return `${r.id} · ${hhmm(r.at)} · ${r.card ?? '—'} · «${word}» · ${statusOf(r)}`;
    });
    return clip(lines, LIMITS.wordsChars);
  }

  const firstLine = (v) => String(v).split(String.fromCharCode(10))[0];
  const age = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'нет';
    const m = Math.max(0, Math.round((now() - t) / 60000));
    return m < 60 ? `${m}м` : m < 2880 ? `${Math.round(m / 60)}ч` : `${Math.round(m / 1440)}д`;
  };

  async function health() {
    const [h, m] = await Promise.all([get('/api/health'), get('/api/mirror').catch((e) => { if (e instanceof Down) throw e; return null; })]);
    const rd = Object.entries(h?.readers ?? {}).filter(([, v]) => v && typeof v === 'object' && 'lastOkAt' in v);
    const errRows = rd.filter(([, v]) => v.errors > 0 && typeof v.lastError === 'string').slice(0, LIMITS.healthErrRows)
      .map(([k, v]) => `  ${k}: ${cut(firstLine(v.lastError), LIMITS.healthErrChars)}`);
    const readers = `Читатели: ${rd.map(([k, v]) => `${k} ${age(v.lastOkAt)}${v.errors > 0 ? ` ош${v.errors}` : ''}`).join(', ') || 'нет данных'}`;
    const mirror = m
      ? `Зеркало: ${age(m.lastOk)} назад, полное ${age(m.lastFullOk)} назад, идёт ${m.running ? 'да' : 'нет'}${m.lastError ? `, ошибка: ${cut(firstLine(m.lastError), LIMITS.healthErrChars)}` : ''}`
      : 'Зеркало: нет данных';
    const b = h?.bell;
    const bell = b ? `Звонок: ${b.on ? 'вкл' : 'выкл'}, ждущих ${b.waiters ?? '?'}, слов в очереди ${b.queued ?? '?'}` : 'Звонок: нет данных';
    const q = h?.planeQueue;
    const plane = q && Number.isFinite(q.running) && Number.isFinite(q.queued) ? `Очередь Plane: идёт ${q.running}, ждёт ${q.queued}` : 'Очередь Plane: нет данных';
    return clip([readers, ...errRows, mirror, bell, plane], LIMITS.healthChars);
  }

  const TOOLS = [
    {
      name: 'waiting',
      description: 'Что ждёт Ивана сейчас (витрина Экстрактора): счёт (а) тред ждёт ответа / (б) нужно «да» / (в) Review и до 5 первых строк. Только чтение.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Код проекта (CAR, EXT…); пусто — все' } } },
      run: waiting,
    },
    {
      name: 'words',
      description: 'Слова Ивана с кнопок витрины и их статус (записано · положено · доставлено · прочитано…): до 10 строк. По умолчанию — проекта этого треда, не определён — все. Справка, не проверка подлинности. Только чтение.',
      inputSchema: { type: 'object', properties: {
        project: { type: 'string', description: 'Код проекта; пусто — проект этого треда, а если не определён — все' },
        since: { type: 'string', description: 'С какого времени: ISO или 30m, 6h, 2d; по умолчанию 24 ч' } } },
      run: words,
    },
    {
      name: 'health',
      description: 'Здоровье витрины: читатели, зеркало доски, звонок, очередь Plane. Только чтение.',
      inputSchema: { type: 'object', properties: {} },
      run: health,
    },
  ];

  // → {text, isError}; витрина не отвечает — одна строка
  async function call(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { text: `нет такого инструмента: ${cut(name, 40)}`, isError: true };
    try {
      return { text: await tool.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {}), isError: false };
    } catch (e) {
      if (e instanceof Down) return { text: downLine, isError: false };
      if (e instanceof Http) return { text: cut(e.message, 120), isError: true };
      return { text: 'ошибка сервера MCP', isError: true };
    }
  }

  return { tools: TOOLS.map(({ run, ...t }) => t), call, downLine };
}
