// «Прогони зеркало» (спека пульта, таблица 1.3; §0 «Рестарт витрины»; EXT-42): обычный проход `mirror.mjs --changed`
// той же обёрткой, что у Планировщика (спека доски §5, «Без окна»): wscript → tools/mirror-hidden.js доски → node.
// Отсоединённо (detached, stdio ignore, unref) и без --exit-with-parent: рестарт витрины проход не убивает.
// --root — корень доски явно, как у install-mirror-task.ps1: иначе mirror.mjs взял бы BOARD_ROOT из окружения витрины,
// а «уже идёт» витрина читает по config.paths.board.
// Конца прохода витрина не ждёт: ход и итог — /api/mirror (.mirror/status.json, run.lock), журнал — .mirror/runs.log.
// «Уже идёт» — правило пульса (mirror-status.mjs) плюс своя память запуска: wscript запущен, а run.lock проход ещё
// не взял — второе нажатие в эти секунды не запускает второй wscript (замок mirror.mjs отбил бы и его, но позже).
// Полный проход (второй щелчок) — ПТ8: здесь только changed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { readMirror } from './mirror-status.mjs';

// своя память запуска: пока проход не отметился в status.json, но не дольше минуты (первый пульс — сразу при старте)
export const LAUNCH_HOLD_MS = 60000;

// полным путём: не поиск по PATH
export const wscriptPath = (env = process.env) => path.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'wscript.exe');

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const fail = (code) => Object.assign(new Error(code), { code });

// boardRoot — config.paths.board; logFile — журнал задачи (--log, пишет сам mirror.mjs); now — часы своей памяти
export function createMirrorRunner({ boardRoot, mirrorDir, lock, logFile, now = Date.now, spawn = nodeSpawn, execPath = process.execPath, wscript = wscriptPath() }) {
  let launched = null; // {at, kind}

  // форма /api/mirror (§1.7); своя память запуска — running, вид и время запуска, полей прохода ещё нет
  function state() {
    const m = readMirror({ dir: mirrorDir ?? null, now: Date.now(), lock: lock ?? null });
    if (m.running || !launched) return m;
    const seen = Date.parse(m.at) >= launched.at;
    if (seen || now() - launched.at >= LAUNCH_HOLD_MS) return m;
    return { ...m, running: true, kind: launched.kind, startedAt: new Date(launched.at).toISOString() };
  }

  // обработчик действия: проверка и запоминание — синхронно, до первого await (два нажатия разом — один запуск)
  async function act({ kind = 'changed' }) {
    if (kind !== 'changed') throw fail('KIND');
    const s = state();
    if (s.running) {
      const since = hhmm(s.startedAt);
      return { outcome: 'refused', refusal: 'mirror-running', message: `зеркало уже идёт (${s.kind ?? 'вид неизвестен'}${since ? ` с ${since}` : ''})` };
    }
    const hidden = boardRoot ? path.join(boardRoot, 'tools', 'mirror-hidden.js') : null;
    if (!hidden || !fs.existsSync(hidden)) throw fail('NO_LAUNCHER');
    if (!logFile) throw fail('NO_LOG');
    launched = { at: now(), kind };
    try {
      const child = spawn(wscript, ['//B', '//Nologo', '//E:JScript', hidden, execPath, `--${kind}`, '--root', boardRoot, '--log', logFile],
        { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return { outcome: 'ok', message: 'зеркало запущено', result: { pid: child.pid } };
    } catch (e) {
      launched = null;
      throw e;
    }
  }

  return { state, act };
}
