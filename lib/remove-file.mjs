// Удаление файла, которого может не быть (EXT-62). Не fs.rmSync: на Node 24.13 под Windows он молча не удаляет файл
// с кириллицей в имени — ни удаления, ни ошибки, и с force, и без; unlinkSync удаляет. Нет файла — не ошибка (как rmSync
// с force); прочее бросается. fs подменяется (тесты копии журнала).
import nodeFs from 'node:fs';

export function removeFile(p, fs = nodeFs) {
  try { fs.unlinkSync(p); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
}
