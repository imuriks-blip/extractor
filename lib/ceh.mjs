// Ответ /api/ceh (спека витрины 1.6, 2.5, 3.1). В1 наполняет projects[] числами доски;
// waiting (В4), workers (В3), фаза и следующий шаг (читатель карточек проектов) — следующие такты;
// activityAt — самое свежее `updated` шапок проекта (2.5), время записей журнала добавит читатель журналов доски.
// Порядок проектов — ключи board_codes реестра (решение Ивана 5, В0-реестр); коды доски без записи
// в реестре — следом, в порядке projects.md, с inRegistry: false («проект не описан в реестре»).
// Код реестра, которого нет в projects.md доски, не показывается: ручки проекта его не примут (1.6).
export function buildCeh({ board, registry, freshness }) {
  const boardCodes = board.codes();
  const byCode = new Map(boardCodes.map((p) => [p.code, p]));
  const order = [];
  for (const r of registry.codes) if (byCode.has(r.code) && !order.includes(r.code)) order.push(r.code);
  const inRegistry = new Set(order);
  for (const p of boardCodes) if (!order.includes(p.code)) order.push(p.code);

  const projects = order.map((code) => ({
    code,
    name: byCode.get(code).name,
    inRegistry: inRegistry.has(code),
    phase: null,
    next: null,
    ...board.counts(code),
    activityAt: board.activity(code),
  }));

  return {
    waiting: { threads: [], yes: [], review: [] },
    projects,
    workers: { threads: [], subagentsCount: 0, marksCount: 0 },
    freshness,
  };
}
