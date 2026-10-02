// Ход зеркала для «Прогони зеркало» (спека пульта §1.7): .mirror/status.json и .mirror/run.lock доски, только чтение.
// running — по правилу пульса §5 спеки доски: progress.at моложе 5 мин или живой run.lock (pid жив, та же загрузка
// системы и пульс замка моложе 5 мин — правило 4: живой pid при стоящем пульсе — замок мёртвый; пульс замка —
// progress.at, если progress начат не раньше замка, иначе at замка, как pulseAge в mirror.mjs; неразобранный
// замок — живой до 10 с). pidAlive и otherBoot — из tools/lib/lock.mjs
// доски (одно место правды). Поля прохода (фаза, числа) — только пока проход идёт.
import fs from 'node:fs';
import path from 'node:path';

export const PULSE_MS = 5 * 60000;
const RAW_LOCK_MS = 10000;

const EMPTY = { running: false, kind: null, phase: null, cardsDone: null, cardsTotal: null, requests: null, rpm: null, startedAt: null, at: null, lastOk: null, lastFullOk: null, lastError: null };

export function readMirror({ dir, now = Date.now(), lock = null }) {
  if (!dir) return { ...EMPTY };
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')) ?? {}; } catch { /* нет файла или пишется */ }
  const p = st.progress && typeof st.progress === 'object' ? st.progress : null;
  const beat = p ? Date.parse(p.at) : NaN;
  const pulse = Number.isFinite(beat) && now - beat < PULSE_MS;
  let lk = null;
  let lockLive = false;
  const lockFile = path.join(dir, 'run.lock');
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    try {
      lk = JSON.parse(raw);
      const lockAt = Date.parse(lk?.at);
      const pAt = p ? Date.parse(p.at) : NaN;
      const lockBeat = p && Date.parse(p.started_at) >= lockAt && Number.isFinite(pAt) ? Math.max(lockAt, pAt) : lockAt;
      lockLive = !!lock && Number.isInteger(lk?.pid) && lk.pid > 0 && !lock.otherBoot(lk.boot) && lock.pidAlive(lk.pid)
        && Number.isFinite(lockBeat) && now - lockBeat < PULSE_MS;
    } catch {
      lockLive = now - fs.statSync(lockFile).mtimeMs < RAW_LOCK_MS;
    }
  } catch { /* замка нет */ }
  const running = pulse || lockLive;
  const n = (v) => (Number.isFinite(v) ? v : null);
  return {
    running,
    kind: (lockLive ? lk?.kind : null) ?? st.kind ?? null,
    phase: running ? p?.phase ?? null : null,
    cardsDone: running ? n(p?.cards_done) : null,
    cardsTotal: running ? n(p?.cards_total) : null,
    requests: running ? n(p?.requests) : null,
    rpm: running ? n(p?.rpm) : null,
    startedAt: running ? p?.started_at ?? lk?.at ?? null : null,
    at: st.at ?? null,
    lastOk: st.lastOk ?? null,
    lastFullOk: st.lastFullOk ?? null,
    lastError: typeof st.lastError === 'string' ? st.lastError.split('\n')[0] : null,
  };
}
