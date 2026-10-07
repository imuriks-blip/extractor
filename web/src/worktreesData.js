// «Прибери отслужившие рабочие копии» (EXT-83, ПТ8б; спека пульта §1.3, §1.5, §1.7) — выбор данных без разметки,
// чтобы проверялось тестом (test/ext83-view.test.mjs). Ручки: GET /api/worktrees?project=, POST /api/act {action: 'cleanup'}.

export const WT_CONFIRM_MS = 5 * 60000; // подтверждение живёт 5 мин (спека §1.1 п.7, сервер держит те же 5)
export const WT_URL = (project) => `/api/worktrees${project ? `?project=${encodeURIComponent(project)}` : ''}`;
export const wtName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

// «разбери руками» — просьба к человеку (ссылка внутри, игнорируемые файлы): показывается заметнее обычной причины
export const isManual = (x) => !x?.eligible && /разбери руками/.test(x?.reason ?? '');

// строки списка: подпись «годна» / «разбери руками» / без подписи (обычный отказ) — словом, не только цветом
export function wtRows(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.path).map((x) => ({
    key: x.path, path: x.path, name: wtName(x.path), branch: x.branch ?? '', card: x.card ?? null,
    eligible: x.eligible === true, manual: isManual(x),
    badge: x.eligible ? 'годна' : isManual(x) ? 'разбери руками' : null,
    reason: x.reason ?? '', ignored: Array.isArray(x.ignored) ? x.ignored : [],
  }));
}
export const wtCounts = (list) => { const r = wtRows(list); return { total: r.length, ok: r.filter((x) => x.eligible).length }; };

// выбор галочками (§1.3 «снятые галочки не трогаются»): отмеченные пути в порядке списка сервера; чужой путь не уходит
export const pickedPaths = (candidates, sel) => (Array.isArray(candidates) ? candidates : []).map((c) => c?.path).filter((p) => typeof p === 'string' && !!sel?.has(p));

// тело POST cleanup: первый щелчок — без confirm и paths; второй — confirm и выбранные пути (сервер берёт пересечение со списком первого)
export function cleanupBody({ intentId, confirm = null, project = null, picked = null }) {
  return { action: 'cleanup', intentId, ...(confirm ? { confirm } : {}), ...(project ? { project } : {}), ...(confirm && Array.isArray(picked) ? { paths: picked } : {}) };
}

// ответ на первый щелчок (без confirm): окно подтверждения или строка-итог
export function firstAnswer(status, body) {
  const b = body ?? {};
  if (status === 200 && b.outcome === 'need-confirm' && b.confirm && b.id) {
    const cands = Array.isArray(b.confirm.candidates) ? b.confirm.candidates : [];
    return { kind: 'confirm', id: b.id, what: b.confirm.what ?? '', follows: b.confirm.follows ?? '', mirrorAt: b.confirm.mirrorAt ?? null,
      candidates: cands.map((c) => ({ name: wtName(c.path), path: c.path, branch: c.branch ?? '', card: c.card ?? null })) };
  }
  return { kind: 'done', ...finalAnswer(status, b) };
}

// итог (первого щелчка «убирать нечего» и второго): класс цвета + текст
export function finalAnswer(status, body) {
  const b = body ?? {};
  if (b.outcome === 'refused') {
    if (b.refusal === 'cleanup-running' || status === 409) return { cls: 'pamb', text: 'уборка уже идёт — подожди' };
    if (b.refusal === 'confirm-expired') return { cls: 'pamb', text: 'подтверждение просрочено — нажми заново' };
    if (b.refusal === 'bad-confirm') return { cls: 'pamb', text: 'подтверждение не подошло — нажми заново' };
    return { cls: 'pbad', text: b.message || 'отказано' };
  }
  if (status >= 200 && status < 300 && (b.outcome === 'ok' || b.outcome === 'partial')) {
    return { cls: b.outcome === 'ok' ? 'pmark' : 'pamb', text: b.message || (b.outcome === 'ok' ? 'готово' : 'сделано частично') };
  }
  return { cls: 'pbad', text: b.message ? `не вышло: ${b.message}` : `не вышло: HTTP ${status}` };
}
