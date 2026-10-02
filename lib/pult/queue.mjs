// Одна очередь записей в Plane на весь сервер (спека пульта §3.1): один дочерний `plane.py` за раз, по порядку.
// Исполнитель — снаружи: run(args) → Promise (код выхода, вывод). ПТ1 — только механизм; исполнитель по умолчанию
// отказывает, ничего не запуская (настоящий plane.py подключает ПТ3). Упавший вызов очередь не держит.
export const notConnected = async () => {
  throw Object.assign(new Error('plane.py не подключён'), { code: 'NOT_CONNECTED' });
};

export function createPlaneQueue({ run = notConnected } = {}) {
  const waiting = [];
  let running = 0;
  const next = () => {
    if (running || !waiting.length) return;
    const { args, resolve, reject } = waiting.shift();
    running = 1;
    Promise.resolve()
      .then(() => run(args))
      .then(resolve, reject)
      .finally(() => { running = 0; next(); });
  };
  return {
    push(args) {
      return new Promise((resolve, reject) => { waiting.push({ args, resolve, reject }); next(); });
    },
    state: () => ({ running, queued: waiting.length }),
  };
}
