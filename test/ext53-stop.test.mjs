// EXT-53, такт 2 — мелочь 5 Голема на В10: tools/update.ps1 останавливает витрину штатно (stop(): последняя строка stats,
// индекс, строка stop), -Force — только если она не вышла за отведённое время. Просьба об остановке — файл
// data/vitrina/stop.request с pid витрины; витрина проверяет его раз в секунду (lib/stop-request.mjs, server.mjs).
// Процессы тестов — node с windowsHide; PowerShell — -NonInteractive с windowsHide (окон нет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchStopRequest, STOP_FILE } from '../lib/stop-request.mjs';
import { tmpDir } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOP_PS1 = path.join(HERE, '..', 'tools', 'vitrina-stop.ps1');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('мелочь 5 (В10): stop.request со своим pid — onStop один раз, файл убран; с чужим pid — onStop нет, файл убран; нет файла — ничего', async () => {
  assert.equal(STOP_FILE, 'stop.request');
  const dir = tmpDir('stop-');
  const file = path.join(dir, STOP_FILE);
  let stops = 0;
  const w = watchStopRequest({ file, pid: 4242, everyMs: 20, onStop: () => { stops++; } });
  try {
    await wait(80);
    assert.equal(stops, 0, 'исправный случай: файла нет — витрина работает');
    fs.writeFileSync(file, '777\r\n');
    await wait(80);
    assert.equal(stops, 0, 'чужой pid (просьба к прежней витрине) — не остановка');
    assert.equal(fs.existsSync(file), false, 'чужая просьба убрана');
    fs.writeFileSync(file, '4242\r\n');
    await wait(80);
    assert.equal(stops, 1);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '4242');
    await wait(80);
    assert.equal(stops, 1, 'после остановки наблюдатель снят');
  } finally { w.close(); }
});

// update.ps1 → Stop-VitrinaGracefully из tools/vitrina-stop.ps1
function stopPs(dataDir, pid, timeoutSec) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${STOP_PS1}'; Stop-VitrinaGracefully -DataDir '${dataDir}' -ProcessId ${pid} -TimeoutSec ${timeoutSec}`], { encoding: 'utf8', windowsHide: true }).trim();
}
const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r({ code: child.exitCode, signal: child.signalCode }) : child.once('exit', (code, signal) => r({ code, signal }))));

test('мелочь 5 (В10): Stop-VitrinaGracefully — витрина со своим наблюдателем выходит сама (graceful, код 0), без -Force', async () => {
  const dataDir = tmpDir('stopd-');
  const mod = pathToFileURL(path.join(HERE, '..', 'lib', 'stop-request.mjs')).href;
  const src = `import { watchStopRequest } from '${mod}'; watchStopRequest({ file: ${JSON.stringify(path.join(dataDir, 'stop.request'))}, pid: process.pid, everyMs: 100, onStop: () => process.exit(0) }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { windowsHide: true, stdio: 'ignore' });
  const t0 = Date.now();
  const out = stopPs(dataDir, child.pid, 10);
  assert.equal(out, 'graceful');
  assert.ok(Date.now() - t0 < 10000);
  assert.deepEqual(await exited(child), { code: 0, signal: null }, 'вышла сама с кодом 0');
  assert.equal(fs.existsSync(path.join(dataDir, 'stop.request')), false);
});

test('мелочь 5 (В10): Stop-VitrinaGracefully — процесс не вышел за TimeoutSec → forced (Stop-Process -Force), просьба убрана; процесса нет — gone', async () => {
  const dataDir = tmpDir('stopd-');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const t0 = Date.now();
  assert.equal(stopPs(dataDir, child.pid, 1), 'forced');
  assert.ok(Date.now() - t0 >= 1000, 'ждала отведённое время');
  const e = await exited(child);
  assert.notEqual(e.code, 0, JSON.stringify(e));
  assert.equal(fs.existsSync(path.join(dataDir, 'stop.request')), false, 'просьба не осталась висеть');
  assert.equal(stopPs(dataDir, child.pid, 1), 'gone');
  assert.equal(fs.existsSync(path.join(dataDir, 'stop.request')), false);
});
