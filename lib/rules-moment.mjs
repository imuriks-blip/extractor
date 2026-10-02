// Момент «правила обновлены» (спека витрины 2.3, «Старые правила»; такт В4). Источник — хроника Vault
// (unorbis/Хроника/<год>-<месяц>.md, только чтение, по mtime): последняя строка с «· правила обновлены:».
// Время — коммит из хеша последнего сегмента строки (`git log` через обёртку git-read; репозитории по порядку —
// board_shared_repos: Vault, затем ~/.claude); хешей несколько — самый поздний из найденных; хеша нет или он
// не найден — по дате строки (00:00 местного времени; ТЗ В4).
import nodeFs from 'node:fs';
import path from 'node:path';

const FILE_RE = /^(\d{4})-(\d{2})\.md$/;
const LINE_RE = /^(\d{2})\.(\d{2}) · .*· правила обновлены:/;
const HASH_RE = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g;

// files: [{name, text}] → {year, month, day, hashes} последней строки или null
export function parseChronicle(files) {
  let best = null;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const fm = f.name.match(FILE_RE);
    if (!fm) continue;
    for (const raw of String(f.text).replace(/\r\n?/g, '\n').split('\n')) {
      const m = raw.match(LINE_RE);
      if (!m) continue;
      const cur = { year: Number(fm[1]), month: Number(m[2]), day: Number(m[1]) };
      const segs = raw.split(' · ');
      cur.hashes = segs.length > 1 ? [...segs.at(-1).matchAll(HASH_RE)].map((x) => x[0]) : [];
      const k = (x) => x.year * 10000 + x.month * 100 + x.day;
      if (!best || k(cur) >= k(best)) best = cur;
    }
  }
  return best;
}

export function createRulesMoment({ dir, git, repos = [], fs = nodeFs }) {
  const st = { sig: null, value: null, lastOkAt: null, errors: 0, lastError: null };

  async function commitTime(hash) {
    for (const repo of repos) {
      try {
        const out = (await git(repo, ['log', '-1', '--format=%cI', hash, '--'])).trim();
        if (Number.isFinite(Date.parse(out))) return Date.parse(out);
      } catch { /* нет такого коммита в этом репозитории — следующий */ }
    }
    return NaN;
  }

  return {
    async refresh() {
      try {
        const names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n));
        const sig = names.map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`).sort().join('|');
        if (sig !== st.sig) {
          const last = parseChronicle(names.map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') })));
          let value = null;
          if (last) {
            const times = [];
            for (const h of last.hashes) { const t = await commitTime(h); if (Number.isFinite(t)) times.push({ t, h }); }
            if (times.length) {
              const top = times.reduce((a, b) => (b.t > a.t ? b : a));
              value = { at: new Date(top.t).toISOString(), by: 'commit', hash: top.h };
            } else value = { at: new Date(last.year, last.month - 1, last.day).toISOString(), by: 'date', hash: null };
          }
          st.value = value;
          st.sig = sig;
        }
        st.lastOkAt = new Date().toISOString();
      } catch (e) { st.errors++; st.lastError = e.code ?? 'ERR'; }
    },
    get: () => st.value,
    state: () => ({ lastOkAt: st.lastOkAt, errors: st.errors, lastError: st.lastError }),
  };
}
