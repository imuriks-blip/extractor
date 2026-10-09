// EXT-87 проба п.5: вес четырёх чисел usage против прироста five_hour.utilization по потокам прогонов прораба.
// Только чтение C:/projects/_foreman/runs/*/stream.jsonl.
//   node probe/ext87-weights.mjs [папка прогонов] [--points <файл.json>]
// Точка — пара соседних rate_limit_event одного потока с одним five_hour.resetsAt: Δu = u2 − u1 против суммы usage строк
// ассистента между ними по позиции в потоке (ключ дубля — message.id, по каждому полю берётся максимум из дублей;
// сообщение относится к интервалу, где встретилось впервые). Подгонка — наименьшие квадраты без свободного члена с весами ≥ 0
// (перебор подмножеств: 4 переменные — 15 подмножеств); готовые веса — один масштаб k ≥ 0 (Δu ≈ k·взвешенная сумма).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'C:/projects/_foreman/runs';
const pi = process.argv.indexOf('--points');
const F = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export function pointsOf(lines) {
  const pts = [];
  let prev = null; // {u, u7, reset}
  let acc = [0, 0, 0, 0], msgs = 0;
  const seen = new Map(); // id → {usage, bucket}
  let bucket = []; // ids в текущем интервале
  for (const raw of lines) {
    if (!raw.includes('"rate_limit_event"') && !raw.includes('"assistant"')) continue;
    let j; try { j = JSON.parse(raw); } catch { continue; }
    if (j.type === 'rate_limit_event') {
      const w = j.rate_limit_info?.unifiedWindows ?? {};
      const cur = { u: w.five_hour?.utilization, u7: w.seven_day?.utilization, reset: w.five_hour?.resetsAt };
      if (prev && cur.reset === prev.reset && Number.isFinite(cur.u) && Number.isFinite(prev.u)) {
        const x = [0, 0, 0, 0];
        for (const id of bucket) { const us = seen.get(id); F.forEach((k, i) => { x[i] += us[k] ?? 0; }); }
        pts.push({ du: +(cur.u - prev.u).toFixed(4), du7: +((cur.u7 ?? NaN) - (prev.u7 ?? NaN)).toFixed(4), x, msgs: bucket.length, u: cur.u });
      }
      prev = cur; bucket = [];
      continue;
    }
    if (j.type === 'assistant' && j.message?.usage) {
      const id = j.message.id ?? j.uuid;
      const us = j.message.usage;
      if (!seen.has(id)) { seen.set(id, {}); bucket.push(id); }
      const s = seen.get(id);
      for (const k of F) s[k] = Math.max(s[k] ?? 0, us[k] ?? 0);
    }
  }
  return pts;
}

// решение нормальных уравнений для подмножества столбцов (Гаусс)
function ols(X, y, cols) {
  const n = cols.length;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let a = 0; a < n; a++) { for (let b = 0; b < n; b++) A[a][b] += X[r][cols[a]] * X[r][cols[b]]; A[a][n] += X[r][cols[a]] * y[r]; }
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-30) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row, i) => row[n] / A[i][i]);
}

const sse = (X, y, w) => X.reduce((s, x, r) => s + (y[r] - x.reduce((t, v, i) => t + v * w[i], 0)) ** 2, 0);

export function nnls(X, y) {
  let best = null;
  for (let mask = 1; mask < 16; mask++) {
    const cols = [0, 1, 2, 3].filter((i) => mask & (1 << i));
    const b = ols(X, y, cols);
    if (!b || b.some((v) => v < 0)) continue;
    const w = [0, 0, 0, 0]; cols.forEach((c, i) => { w[c] = b[i]; });
    const e = sse(X, y, w);
    if (!best || e < best.sse) best = { w, sse: e };
  }
  return best;
}

export function stats(X, y, w) {
  const pred = X.map((x) => x.reduce((t, v, i) => t + v * w[i], 0));
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  const e = y.reduce((s, v, r) => s + (v - pred[r]) ** 2, 0);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const sst0 = y.reduce((s, v) => s + v * v, 0);
  const mae = y.reduce((s, v, r) => s + Math.abs(v - pred[r]), 0) / y.length;
  return { r2: sst ? 1 - e / sst : null, r2Uncentered: 1 - e / sst0, mae };
}

// масштаб k ≥ 0 для готовых весов: Δu ≈ k·(x·w)
export function fixed(X, y, w) {
  const s = X.map((x) => x.reduce((t, v, i) => t + v * w[i], 0));
  const k = Math.max(0, s.reduce((a, v, r) => a + v * y[r], 0) / s.reduce((a, v) => a + v * v, 0));
  const ww = w.map((v) => v * k);
  // разброс «токенов взвешенных на 1 % окна» по точкам с Δu = 0.01 — чем меньше CV, тем ровнее мера
  const per = s.filter((_, r) => Math.abs(y[r] - 0.01) < 1e-9);
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  const cv = Math.sqrt(per.reduce((a, b) => a + (b - mean) ** 2, 0) / per.length) / mean;
  const sorted = [...per].sort((a, b) => a - b);
  return { k, perPercent: { n: per.length, mean: Math.round(mean), median: Math.round(sorted[Math.floor(per.length / 2)]), cv: +cv.toFixed(3) }, ...stats(X, y, ww) };
}

function main() {
  const all = [];
  const perRun = [];
  for (const run of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, run, 'stream.jsonl');
    if (!fs.existsSync(f)) continue;
    const pts = pointsOf(fs.readFileSync(f, 'utf8').split('\n'));
    perRun.push({ run, points: pts.length, du: pts.map((p) => p.du) });
    all.push(...pts.map((p) => ({ run, ...p })));
  }
  const X = all.map((p) => p.x), y = all.map((p) => p.du);
  const fit = nnls(X, y);
  const out = {
    runs: perRun.length, points: all.length,
    duHistogram: Object.fromEntries([...new Set(y)].sort().map((v) => [v, y.filter((t) => t === v).length])),
    totals: Object.fromEntries(F.map((k, i) => [k, X.reduce((s, x) => s + x[i], 0)])),
    nnls: fit && { w: fit.w.map((v) => +v.toExponential(3)), relToInput: fit.w[0] ? fit.w.map((v) => +(v / fit.w[0]).toFixed(3)) : null, ...stats(X, y, fit.w) },
    "price_1_5_0.1_1.25": fixed(X, y, [1, 5, 0.1, 1.25]),
    noCacheRead_1_1_0_1: fixed(X, y, [1, 1, 0, 1]),
    allFour_1_1_1_1: fixed(X, y, [1, 1, 1, 1]),
    // вес чтения кэша при ценовых 1 / 5 / · / 1,25: где разброс «на 1 %» меньше
    cacheReadSweep: [0, 0.02, 0.05, 0.1, 0.2, 0.5, 1].map((r) => ({ r, cv: fixed(X, y, [1, 5, r, 1.25]).perPercent.cv })),
    // без шумных точек: только Δu = 0.01 (событие на каждый шаг 1 %; Δu = 0 и 0.03 — смена статуса/скачок от чужих тредов)
    perRun,
  };
  if (pi > 0) fs.writeFileSync(process.argv[pi + 1], JSON.stringify(all, null, 1));
  console.log(JSON.stringify(out, null, 2));
}
main();
