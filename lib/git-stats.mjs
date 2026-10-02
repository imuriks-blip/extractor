// Счёт вызовов git по репозиториям (гейт этапа Г3: «пик меньше 20 в минуту» по server.log).
// Ключ — полный путь репозитория; минута — календарная (по часам машины).
import path from 'node:path';

// ключ — path.resolve(...).toLowerCase(): «C:/x», «C:\x» и «c:\X\» — один репозиторий (Г3, вердикт Голема на В5)
export const statsKey = (p) => path.resolve(String(p)).toLowerCase();

export function createGitStats(now = Date.now) {
  const repos = new Map(); // путь → {total, peakPerMin, minute, inMinute}
  return {
    onCall(raw) {
      const repo = statsKey(raw);
      const minute = Math.floor(now() / 60000);
      let r = repos.get(repo);
      if (!r) { r = { total: 0, peakPerMin: 0, minute, inMinute: 0 }; repos.set(repo, r); }
      if (r.minute !== minute) { r.minute = minute; r.inMinute = 0; }
      r.total++;
      r.inMinute++;
      if (r.inMinute > r.peakPerMin) r.peakPerMin = r.inMinute;
    },
    snapshot() {
      const out = {};
      for (const [repo, r] of repos) out[repo] = { total: r.total, peakPerMin: r.peakPerMin };
      return out;
    },
  };
}
