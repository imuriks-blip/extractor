// Штатная остановка по просьбе (мелочь 5 Голема на В10, EXT-53). На Windows Stop-Process без -Force сигналов node
// не шлёт, а -Force рвёт процесс до stop(): теряются последняя строка stats и незаписанный индекс. Поэтому
// tools/update.ps1 (tools/vitrina-stop.ps1) кладёт в data/vitrina/stop.request pid витрины, которую останавливает;
// витрина раз в everyMs читает файл: свой pid — убирает файл и зовёт onStop (server.mjs: stop() и выход 0),
// чужой pid (просьба к прежней витрине, оставшаяся после -Force) — только убирает файл.
// Почему файл, а не ручка HTTP: ни одной новой ручки на 127.0.0.1 (спека 6.1, защита пульта §4.1 не расширяется);
// положить файл в data/vitrina может только тот, кто и так может убить процесс (тот же пользователь).
import nodeFs from 'node:fs';

export const STOP_FILE = 'stop.request';

export function watchStopRequest({ file, pid, onStop, everyMs = 1000, fs = nodeFs }) {
  const check = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; } // нет файла — обычный случай
    try { fs.unlinkSync(file); } catch { /* уже убран */ }
    if (Number.parseInt(String(text).trim(), 10) !== pid) return;
    clearInterval(timer);
    onStop();
  };
  const timer = setInterval(check, everyMs);
  timer.unref?.();
  return { close() { clearInterval(timer); } };
}
