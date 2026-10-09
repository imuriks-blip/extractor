// EXT-87 проба п.1 и п.6: где лежит claude.exe десктопа, какая версия у findLatestBin, какие флаги в --help.
// Только чтение файловой системы и запуск `claude.exe --help` / `--version` без окна. Файлы учётных данных НЕ открываются —
// только существование и размер через fs.statSync.
// Запуск: node probe/ext87-bin.mjs [--help-out <файл>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findLatestBin } from '../../_foreman/foreman-launch.mjs';

const out = {};
const env = process.env;
out.env = { APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, USERPROFILE: env.USERPROFILE };

// Прямые пути (грабля Т4: внутри пакета десктопа %APPDATA%\Claude подменяется на LocalCache пакета)
const roaming = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code');
const pkgRoot = path.join(os.homedir(), 'AppData', 'Local', 'Packages');
const list = (base) => {
  const found = [];
  let vers = [];
  try { vers = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return { base, error: e.code }; }
  for (const v of vers) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(base, v), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const h of subs) {
      const p = path.join(base, v, h, 'claude.exe');
      if (fs.existsSync(p)) { const s = fs.statSync(p); found.push({ p, size: s.size, mtime: s.mtime.toISOString() }); }
    }
  }
  return { base, found };
};
out.roamingDirect = list(roaming);
let pkgs = [];
try { pkgs = fs.readdirSync(pkgRoot).filter((n) => /^Claude_/.test(n)); } catch (e) { out.pkgError = e.code; }
out.packages = pkgs.map((n) => list(path.join(pkgRoot, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code')));

try { out.findLatestBin = findLatestBin(env.APPDATA); } catch (e) { out.findLatestBinError = e.message; }

// Учётные данные — только существование и размер, без чтения
const credCandidates = [
  path.join(os.homedir(), '.claude', '.credentials.json'),
  path.join(os.homedir(), '.claude.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'config.json'),
  ...pkgs.map((n) => path.join(pkgRoot, n, 'LocalCache', 'Roaming', 'Claude', 'config.json')),
];
out.credentials = credCandidates.map((p) => { try { const s = fs.statSync(p); return { p, exists: true, size: s.size }; } catch { return { p, exists: false }; } });

if (out.findLatestBin) {
  const bin = out.findLatestBin;
  const v = spawnSync(bin, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  out.version = (v.stdout || '').trim() || (v.stderr || '').trim();
  const h = spawnSync(bin, ['--help'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const i = process.argv.indexOf('--help-out');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], h.stdout || '');
  const want = /--model|--max-turns|--tools|--allowedTools|--allowed-tools|--disallowedTools|--disallowed-tools|--strict-mcp-config|--mcp-config|--settings|--no-session-persistence|session|persist|--output-format|--verbose|--setting-sources/i;
  out.helpLines = (h.stdout || '').split(/\r?\n/).filter((l) => want.test(l)).map((l) => l.trimEnd());
}
console.log(JSON.stringify(out, null, 2));
