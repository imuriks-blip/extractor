// Вывод витрины при скрытом запуске (В9, tools/vitrina-hidden.js → node server.mjs --console-log): консоли нет,
// поэтому console.log/error и неперехваченная ошибка дописываются в data/vitrina/console.log. Каждая строка —
// отдельным appendFileSync (файл не держится открытым): второй запуск пишет в тот же файл и не упирается в замок
// (перенаправление `>>` через cmd запиралось первым экземпляром — проба В9). Сбой записи сервер не роняет.
import fs from 'node:fs';
import { format } from 'node:util';

export function redirectConsole({ file, target = console, proc = process }) {
  const write = (line) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* вывод не роняет сервер */ }
  };
  target.log = (...a) => write(format(...a));
  target.error = (...a) => write(format(...a));
  // неперехваченная ошибка: имя и кадры стека, без текста сообщения — там может оказаться кусок журнала (вердикт Голема на В9)
  proc.on('uncaughtException', (e) => {
    const frames = String(e?.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l));
    write([`uncaught: ${e?.name ?? typeof e}`, ...frames].join('\n'));
    proc.exit(1);
  });
}
