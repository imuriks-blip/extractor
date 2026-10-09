// EXT-85 probe, takt A: start a probe vitrina and a control node, both hidden, both watched by probe/ext85-sleep.mjs.
//   node probe/ext85-start.mjs [--port=4385]
// What it does (nothing outside its own temp folder is written; the live vitrina on 4317 is never asked):
//   1. %TEMP%\ext85-<random>\root\ - a probe root: copies of server.mjs and config.default.json (byte-equal, checked),
//      lib\ as a junction to this working copy's lib\ (so lib\start.mjs, node_modules and web\dist are the working
//      copy's own). server.mjs keeps its data in <its folder>\data\vitrina (not configurable, gate G7) - so the data
//      of the probe lands in the temp root, not in the working copy.
//   2. root\data\vitrina\config.json: own port, "toasts": false (no duplicate toasts for Ivan), backup.dir inside the
//      temp root. The port must be free and is never 4317.
//   3. Starts, through wscript.exe + probe\ext85-hidden.js (window style 0, the way tools\vitrina-hidden.js starts the
//      live one):
//        vitrina: node --import <probe\ext85-sleep.mjs> root\server.mjs --console-log --ext85-out=vitrina-pulse.jsonl
//        control: node probe\ext85-sleep.mjs --ext85-control --ext85-out=control-pulse.jsonl
//      The random folder name is in both command lines - the label that proves the processes are the probe's.
//   4. Waits for the "start" line of both and for the vitrina's "start" line in its server.log, writes probe.json
//      (pids, ppids, port, paths) next to the pulse files and prints it.
// Stop (the probe does not stop itself): take vitrina.pid and control.pid from probe.json, check that each is node.exe
// with the random folder name in its command line, then stop each as a tree by pid:
//   taskkill /T /F /PID <vitrina.pid>    taskkill /T /F /PID <control.pid>
// never by image name or by a command-line pattern; then delete %TEMP%\ext85-<random>.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PORT = 4317;
const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 4385);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === LIVE_PORT) throw new Error(`port ${port}: an integer 1024..65535, never ${LIVE_PORT}`);

const listening = (p) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
if (await listening(port)) throw new Error(`port ${port} is taken: choose another --port`);

const token = `ext85-${randomBytes(4).toString('hex')}`;
const base = path.join(os.tmpdir(), token);
const root = path.join(base, 'root');
const dataDir = path.join(root, 'data', 'vitrina');
fs.mkdirSync(dataDir, { recursive: true });
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const f of ['server.mjs', 'config.default.json']) {
  fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  if (sha(path.join(REPO, f)) !== sha(path.join(root, f))) throw new Error(`copy of ${f} differs`);
}
fs.symlinkSync(path.join(REPO, 'lib'), path.join(root, 'lib'), 'junction');
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port, toasts: false, backup: { dir: path.join(dataDir, 'backup') + path.sep } }, null, 2) + '\n');

const pulse = { vitrina: path.join(base, 'vitrina-pulse.jsonl'), control: path.join(base, 'control-pulse.jsonl') };
const sleepJs = path.join(REPO, 'probe', 'ext85-sleep.mjs');
const hidden = path.join(REPO, 'probe', 'ext85-hidden.js');
const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
const runHidden = (workdir, nodeArgs) => new Promise((res, rej) => {
  const w = spawn(wscript, ['//B', '//Nologo', '//E:JScript', hidden, process.execPath, workdir, ...nodeArgs], { windowsHide: true, stdio: 'ignore' });
  w.once('error', rej);
  w.once('exit', (code) => (code === 0 ? res(w.pid) : rej(new Error(`wscript exited ${code}`))));
});
const wscriptPids = {
  vitrina: await runHidden(root, ['--import', pathToFileURL(sleepJs).href, path.join(root, 'server.mjs'), '--console-log', `--ext85-out=${pulse.vitrina}`]),
  control: await runHidden(base, [sleepJs, '--ext85-control', `--ext85-out=${pulse.control}`]),
};

const firstLine = (f, kind) => {
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((j) => j.kind === kind) ?? null;
};
const serverStart = () => {
  const f = path.join(dataDir, 'server.log');
  return fs.existsSync(f) && fs.readFileSync(f, 'utf8').split('\n').find((l) => l.split(' ')[1] === 'start' && l.includes(` port=${port} `)) || null;
};
const deadline = Date.now() + 90000;
let v, c, s;
while (Date.now() < deadline) {
  v = firstLine(pulse.vitrina, 'start'); c = firstLine(pulse.control, 'start'); s = serverStart();
  if (v && c && s) break;
  await new Promise((r) => setTimeout(r, 500));
}
const info = {
  token, port, base, root, dataDir, pulse,
  vitrina: v && { pid: v.pid, ppid: v.ppid, wscriptPid: wscriptPids.vitrina, at: v.t },
  control: c && { pid: c.pid, ppid: c.ppid, wscriptPid: wscriptPids.control, at: c.t },
  serverLogStart: s ? s.trim() : null,
};
fs.writeFileSync(path.join(base, 'probe.json'), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info, null, 2));
if (!v || !c || !s) { console.log('NOT READY: see', base); process.exitCode = 2; }
